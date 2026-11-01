/**
 * Keeps the key index in step with the documents that carry keys.
 *
 * Rows come off the operations themselves: the action that sets a key
 * carries its value in the input, so the index never reads a document. That
 * is what makes it cheap on a history replay too — the first install walks
 * every past operation once and writes one small row per key, bodies never
 * loaded.
 *
 * Idempotent by construction: the primary key is (document, key), and a
 * repeated operation inserts nothing new. A document that is deleted loses
 * its rows, so a lookup never points at a tombstone.
 */
import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import { KEYED_TYPES, valueAt, type KeyedType } from "./keys.js";
import { up } from "./migrations.js";
import type { DB, KeyRow } from "./schema.js";

/** Rows per INSERT: three columns, so far under any bind-parameter cap. */
const INSERT_BATCH = 500;

export class KeyIndex extends RelationalDbProcessor<DB> {
  private types: readonly KeyedType[] = KEYED_TYPES;
  /** Writes are serialised: two batches must not interleave. */
  private queue: Promise<void> = Promise.resolve();

  withTypes(types: readonly KeyedType[]): this {
    this.types = types;
    return this;
  }

  onOperations(operations: OperationWithContext[]): Promise<void> {
    const next = this.queue.then(() => this.index(operations));
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

  private async index(operations: OperationWithContext[]): Promise<void> {
    const { rows, deleted } = rowsFor(operations, this.types);
    for (const documentId of deleted) {
      await this.relationalDb
        .deleteFrom("key_index")
        .where("document_id", "=", documentId)
        .execute();
    }
    for (let at = 0; at < rows.length; at += INSERT_BATCH) {
      await this.relationalDb
        .insertInto("key_index")
        .values(rows.slice(at, at + INSERT_BATCH))
        .onConflict((oc) => oc.columns(["document_id", "key"]).doNothing())
        .execute();
    }
  }
}

/**
 * The rows a batch of operations adds, and the documents it removes.
 *
 * A key is read as text; a number is accepted since ids often are. Anything
 * else is not a key and is left out, as is an empty string.
 */
export function rowsFor(
  operations: OperationWithContext[],
  types: readonly KeyedType[],
): { rows: KeyRow[]; deleted: string[] } {
  const rows = new Map<string, KeyRow>();
  const deleted = new Set<string>();
  for (const { operation, context } of operations) {
    const type = operation.action.type;
    if (type === "DELETE_DOCUMENT" || type === "PURGE_DOCUMENT") {
      const input = operation.action.input as { documentId?: string } | null;
      const documentId = input?.documentId ?? context.documentId;
      deleted.add(documentId);
      // Rows this batch added for it are void too.
      for (const id of [...rows.keys()]) {
        if (id.startsWith(`${documentId}\u0000`)) rows.delete(id);
      }
      continue;
    }
    if (context.scope !== "global") continue;
    const keyed = types.find((t) => t.documentType === context.documentType);
    if (!keyed) continue;
    for (const action of keyed.actions) {
      if (action.type !== type) continue;
      const raw = valueAt(operation.action.input, action.path);
      const key =
        typeof raw === "string"
          ? raw.trim()
          : typeof raw === "number" && Number.isFinite(raw)
            ? String(raw)
            : "";
      if (key === "") continue;
      rows.set(`${context.documentId}\u0000${key}`, {
        document_type: context.documentType,
        key,
        document_id: context.documentId,
      });
    }
  }
  return { rows: [...rows.values()], deleted: [...deleted] };
}
