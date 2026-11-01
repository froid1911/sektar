import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import { applyAction, rowsFromState } from "./index-rows.js";
import { up } from "./migrations.js";
import type { DB, SearchEntry } from "./schema.js";

/**
 * Keeps `search_entries` in step with every Sektar document on the drive:
 * one row per document, plus one per bank transaction. Runs wherever the
 * reactor runs — the switchboard and the tab's in-process reactor — so the
 * top-bar search works offline and the switchboard can answer the same query.
 */
export class SearchIndex extends RelationalDbProcessor<DB> {
  async onOperations(operations: OperationWithContext[]): Promise<void> {
    // Several operations for one document arrive together (the seed, an
    // import); collapse them to one rebuild per document.
    const pending = new Map<
      string,
      { documentType: string; rows: SearchEntry[] | null }
    >();
    for (const { operation, context } of operations) {
      if (
        operation.action.type === "DELETE_DOCUMENT" ||
        operation.action.type === "PURGE_DOCUMENT"
      ) {
        const input = operation.action.input as { documentId?: string };
        const documentId = input.documentId ?? context.documentId;
        if (this.isNamespaceDrive(documentId)) {
          await this.dropNamespace();
          return;
        }
        pending.delete(documentId);
        await this.deleteDocumentRows(documentId);
        continue;
      }
      if (context.scope !== "global") continue;
      const { documentId, documentType } = context;
      const state = parseState(context.resultingState);
      if (state) {
        pending.set(documentId, {
          documentType,
          rows: rowsFromState(documentId, documentType, state),
        });
        continue;
      }
      const current =
        pending.get(documentId)?.rows ?? (await this.rowsOf(documentId));
      pending.set(documentId, {
        documentType,
        rows: applyAction(
          current,
          documentId,
          documentType,
          operation.action.type,
          (operation.action.input ?? {}) as Record<string, unknown>,
        ),
      });
    }
    for (const [documentId, { rows }] of pending) {
      if (!rows) continue;
      await this.relationalDb
        .deleteFrom("search_entries")
        .where("document_id", "=", documentId)
        .execute();
      const unique = uniqueEntries(rows);
      for (let at = 0; at < unique.length; at += INSERT_BATCH) {
        await this.relationalDb
          .insertInto("search_entries")
          .values(unique.slice(at, at + INSERT_BATCH))
          // The delete above cleared the document; a conflict can only be a
          // row another batch wrote meanwhile, and the newer one wins.
          .onConflict((oc) =>
            oc.columns(["document_id", "entity_id"]).doUpdateSet((eb) => ({
              document_type: eb.ref("excluded.document_type"),
              kind: eb.ref("excluded.kind"),
              title: eb.ref("excluded.title"),
              subtitle: eb.ref("excluded.subtitle"),
              body: eb.ref("excluded.body"),
              amount: eb.ref("excluded.amount"),
              status: eb.ref("excluded.status"),
              at: eb.ref("excluded.at"),
            })),
          )
          .execute();
      }
    }
  }

  private async rowsOf(documentId: string): Promise<SearchEntry[]> {
    return this.relationalDb
      .selectFrom("search_entries")
      .selectAll()
      .where("document_id", "=", documentId)
      .execute();
  }

  onDisconnect(): Promise<void> {
    return Promise.resolve();
  }

  static override getNamespace(driveId: string): string {
    // Default namespace: `${this.name}_${driveId.replaceAll("-", "_")}`
    return super.getNamespace(driveId);
  }

  override async initAndUpgrade(): Promise<void> {
    await up(this.relationalDb);
  }
}

/** Rows per INSERT: ten columns, so far under any bind-parameter cap. */
const INSERT_BATCH = 500;

/**
 * One row per (document, entity). A document can name an entity twice — a
 * bank account imported with two transactions under one id — and a second
 * row with the same key made the whole insert fail, which stopped the index
 * at that operation in every drive. The last row for a key wins, as the last
 * transaction would in a list read top to bottom.
 */
export function uniqueEntries(rows: readonly SearchEntry[]): SearchEntry[] {
  const byKey = new Map<string, SearchEntry>();
  for (const row of rows) byKey.set(`${row.document_id}\u0000${row.entity_id}`, row);
  return [...byKey.values()];
}

function parseState(json: string | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") {
      // resultingState is the scope's state; some transports wrap it per scope.
      const obj = parsed as Record<string, unknown>;
      return obj.global && typeof obj.global === "object"
        ? (obj.global as Record<string, unknown>)
        : obj;
    }
  } catch {
    // not JSON: fall back to the action-input path
  }
  return null;
}
