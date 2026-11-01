/**
 * Keeps the identifier index in step with the collections.
 *
 * Rather than replay how identifiers move — capture, alias, merge, split all
 * shift them — this re-reads the affected document and rewrites its rows
 * wholesale. That is idempotent by construction, which matters because a
 * batch is not guaranteed to hold each document once: on a history replay it
 * holds one entry per past operation, and an index built by applying deltas
 * would count each of them.
 *
 * Resolution uses the model's own `liveSource`, exported from the document
 * model for exactly this reason. A read model that resolves merges by its
 * own rules is a read model that disagrees with the documents it describes.
 */
import type { IReactorClient } from "@powerhousedao/reactor";
import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import {
  identifiersOf,
  liveSource,
  type Identified,
} from "document-models/original-source-collection";
import { up } from "./migrations.js";
import type { DB, OscIdentifier } from "./schema.js";

/** What the index needs off a source; a superset of `Identified`. */
interface IndexableSource extends Identified {
  status: string;
  title?: string | null;
  lastSeenAt: string;
}

interface CollectionState {
  title?: string | null;
  sources?: IndexableSource[];
}

/**
 * Rows per INSERT.
 *
 * 500 rows is 4,500 bind parameters at this table's nine columns — an order
 * of magnitude under PostgreSQL's 65,535, and well under whatever the driver
 * gives out at. Large enough that a big collection is a handful of
 * statements rather than thousands.
 */
const INSERT_BATCH = 500;

export class OscIndex extends RelationalDbProcessor<DB> {
  private client: IReactorClient | undefined;
  /** Writes are serialised: two batches for one document must not interleave. */
  private queue: Promise<void> = Promise.resolve();

  withClient(client: IReactorClient): this {
    this.client = client;
    return this;
  }

  onOperations(operations: OperationWithContext[]): Promise<void> {
    const next = this.queue.then(() => this.reindex(operations));
    // Keep the chain alive after a failure, or one bad batch stalls every
    // later one behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }

  onDisconnect(): Promise<void> {
    return Promise.resolve();
  }

  static override getNamespace(driveId: string): string {
    return super.getNamespace(driveId);
  }

  override async initAndUpgrade(): Promise<void> {
    await up(this.relationalDb);
  }

  private async reindex(operations: OperationWithContext[]): Promise<void> {
    const client = this.client;
    if (!client) return;

    // One pass per document however many operations arrived for it.
    const touched = new Set<string>();
    for (const entry of operations) {
      const documentId = entry.context.documentId;
      if (documentId) touched.add(documentId);
    }

    for (const documentId of touched) {
      let rows: OscIdentifier[];
      try {
        const document = await client.get(documentId);
        const state = (document.state as { global?: CollectionState } | null)
          ?.global;
        rows = rowsFor(documentId, state);
      } catch {
        // A document that cannot be read is one whose rows we can no longer
        // vouch for. Dropping them is honest: a stale hit would send a
        // capture at a collection that may not exist, and the index is only
        // ever meant to say where something lives, never whether to capture.
        rows = [];
      }

      // Replace rather than merge: the rows we just computed ARE the
      // document's full contribution, so anything else under this id is
      // stale by definition.
      await this.relationalDb
        .deleteFrom("osc_identifier")
        .where("document_id", "=", documentId)
        .execute();

      // Written in batches, because one statement per collection does not
      // survive a collection growing. A Dropbox walk reached 1,821 sources —
      // 3,642 identifiers, 32,778 bind parameters in a single INSERT — and
      // the driver gave up building the parameter array before PostgreSQL's
      // own 65,535 limit was anywhere in sight. The failure arrives as a bare
      // "Invalid array length" after a page of placeholders, which says
      // nothing about collection size, so it is worth never reaching.
      for (let at = 0; at < rows.length; at += INSERT_BATCH) {
        await this.relationalDb
          .insertInto("osc_identifier")
          .values(rows.slice(at, at + INSERT_BATCH))
          .execute();
      }
    }
  }
}

/**
 * Every identifier the collection answers to, pointing at a live source.
 *
 * Live sources are indexed first so that when a folded source and its winner
 * both carry an identifier, the row describes the winner's own claim on it
 * rather than an inherited one.
 */
export function rowsFor(
  documentId: string,
  state: CollectionState | undefined,
): OscIdentifier[] {
  const sources = state?.sources ?? [];
  const collectionTitle = state?.title ?? null;
  const byIdentifier = new Map<string, OscIdentifier>();

  const index = (source: IndexableSource, inherited: boolean) => {
    const live = liveSource(sources, source);
    identifiersOf(source).forEach((identifier, position) => {
      if (byIdentifier.has(identifier)) return;
      byIdentifier.set(identifier, {
        identifier,
        document_id: documentId,
        source_id: live.id,
        // Inherited identifiers are always aliases of the winner, whatever
        // they were on the source that brought them.
        is_alias: inherited || position > 0,
        status: live.status,
        title: live.title ?? null,
        captured_at: live.capturedAt,
        last_seen_at: live.lastSeenAt,
        collection_title: collectionTitle,
      });
    });
  };

  for (const source of sources) {
    if (!source.mergedInto) index(source, false);
  }
  for (const source of sources) {
    if (source.mergedInto) index(source, true);
  }

  return [...byIdentifier.values()];
}
