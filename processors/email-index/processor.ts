/**
 * Keeps the mailbox index in step with the email documents.
 *
 * Rows come off the operations: an operation that carries its resulting
 * state gives the exact row, and one that does not is applied to the row the
 * way the reducer applies it to the document (`rows.ts`). Either way no
 * document is ever loaded, which is what makes the first install cheap too —
 * a history replay walks every past operation once and writes one small row
 * per message, bodies never read.
 *
 * Idempotent by construction: a row is the document's whole contribution and
 * is replaced wholesale, so a batch that holds a document twice (a replay
 * holds one entry per past operation) writes the same row twice.
 */
import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import { up } from "./migrations.js";
import { applyAction, emptyRow, parseState, rowFromState } from "./rows.js";
import type { DB, EmailRow } from "./schema.js";

export const EMAIL_DOCUMENT_TYPE = "sektar/email";

/**
 * Rows per INSERT. Twenty-two columns, so 200 rows is 4,400 bind parameters:
 * an order of magnitude under PostgreSQL's 65,535 and under what the driver
 * builds comfortably (see the osc-index processor for how that fails).
 */
const UPSERT_BATCH = 200;

export class EmailIndex extends RelationalDbProcessor<DB> {
  /** Writes are serialised: two batches for one document must not interleave. */
  private queue: Promise<void> = Promise.resolve();

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
    // One row per document however many operations arrived for it; null
    // marks a document the batch deletes.
    const pending = new Map<string, EmailRow | null>();
    for (const { operation, context } of operations) {
      const type = operation.action.type;
      if (type === "DELETE_DOCUMENT" || type === "PURGE_DOCUMENT") {
        const input = operation.action.input as { documentId?: string } | null;
        const documentId = input?.documentId ?? context.documentId;
        if (this.isNamespaceDrive(documentId)) {
          await this.dropNamespace();
          return;
        }
        pending.set(documentId, null);
        continue;
      }
      if (context.scope !== "global") continue;
      // A refused operation (a duplicate attachment, a mismatched id) left
      // the document as it was.
      if (operation.error) continue;
      const { documentId } = context;
      if (pending.get(documentId) === null) continue;
      const at = timeOf(operation);
      const state = parseState(context.resultingState);
      if (state) {
        pending.set(documentId, rowFromState(documentId, state, at));
        continue;
      }
      const current =
        pending.get(documentId) ??
        (await this.rowOf(documentId)) ??
        emptyRow(documentId, at);
      pending.set(
        documentId,
        applyAction(current, type, operation.action.input, at),
      );
    }

    const rows: EmailRow[] = [];
    for (const [documentId, row] of pending) {
      if (row === null) {
        await this.relationalDb
          .deleteFrom("email_index")
          .where("document_id", "=", documentId)
          .execute();
      } else {
        rows.push(row);
      }
    }
    for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
      await this.relationalDb
        .insertInto("email_index")
        .values(rows.slice(at, at + UPSERT_BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            captured: eb.ref("excluded.captured"),
            account_address: eb.ref("excluded.account_address"),
            account_name: eb.ref("excluded.account_name"),
            account_provider: eb.ref("excluded.account_provider"),
            subject: eb.ref("excluded.subject"),
            from_name: eb.ref("excluded.from_name"),
            from_address: eb.ref("excluded.from_address"),
            snippet: eb.ref("excluded.snippet"),
            when_at: eb.ref("excluded.when_at"),
            sent_at: eb.ref("excluded.sent_at"),
            received_at: eb.ref("excluded.received_at"),
            read: eb.ref("excluded.read"),
            flagged: eb.ref("excluded.flagged"),
            status: eb.ref("excluded.status"),
            attachments: eb.ref("excluded.attachments"),
            attachment_count: eb.ref("excluded.attachment_count"),
            labels: eb.ref("excluded.labels"),
            thread_id: eb.ref("excluded.thread_id"),
            participants: eb.ref("excluded.participants"),
            search_text: eb.ref("excluded.search_text"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }

  private async rowOf(documentId: string): Promise<EmailRow | undefined> {
    return this.relationalDb
      .selectFrom("email_index")
      .selectAll()
      .where("document_id", "=", documentId)
      .executeTakeFirst();
  }
}

/** When an operation happened, as the index's fallback instant. */
function timeOf(operation: OperationWithContext["operation"]): string {
  const stamped = operation as { timestampUtcMs?: unknown };
  if (typeof stamped.timestampUtcMs === "string" && stamped.timestampUtcMs)
    return stamped.timestampUtcMs;
  const action = operation.action as { timestampUtcMs?: unknown };
  if (typeof action.timestampUtcMs === "string" && action.timestampUtcMs)
    return action.timestampUtcMs;
  return new Date().toISOString();
}
