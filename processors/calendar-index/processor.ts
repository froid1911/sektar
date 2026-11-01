/**
 * Keeps the calendar index in step with the calendar event documents.
 *
 * Rows come off `operation.context.resultingState`; no document is ever
 * loaded. An operation without a resulting state leaves the row as it is
 * (warned once per batch). A row is the document's whole contribution and is
 * replaced wholesale, so a replay that holds a document many times writes
 * the last state.
 */
import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import { up } from "./migrations.js";
import { parseState, rowFromState } from "./rows.js";
import type { CalendarRow, DB } from "./schema.js";
import { statelessWarning } from "../stateless-warning.js";

export const CALENDAR_EVENT_DOCUMENT_TYPE = "sektar/calendar-event";

/** Rows per INSERT: 30 columns, so 150 rows is 4,500 bind parameters. */
const UPSERT_BATCH = 150;

export class CalendarIndex extends RelationalDbProcessor<DB> {
  /** Writes are serialised: two batches for one document must not interleave. */
  private queue: Promise<void> = Promise.resolve();

  onOperations(operations: OperationWithContext[]): Promise<void> {
    const next = this.queue.then(() => this.index(operations));
    // Keep the chain alive after a failure.
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
    const pending = new Map<string, CalendarRow | null>();
    const missing = new Map<string, number>();
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
      // A refused operation left the document as it was.
      if (operation.error) continue;
      const { documentId } = context;
      if (pending.get(documentId) === null) continue;
      const state = parseState(context.resultingState);
      if (!state) {
        missing.set(documentId, (missing.get(documentId) ?? 0) + 1);
        continue;
      }
      pending.set(documentId, rowFromState(documentId, state, timeOf(operation)));
    }
    const warning = statelessWarning("calendar-index", missing);
    if (warning) console.warn(warning);

    const rows: CalendarRow[] = [];
    const deleted: string[] = [];
    for (const [documentId, row] of pending) {
      if (row === null) deleted.push(documentId);
      else rows.push(row);
    }
    if (deleted.length) {
      await this.relationalDb
        .deleteFrom("calendar_index")
        .where("document_id", "in", deleted)
        .execute();
    }
    for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
      await this.relationalDb
        .insertInto("calendar_index")
        .values(rows.slice(at, at + UPSERT_BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            calendar_key: eb.ref("excluded.calendar_key"),
            calendar_id: eb.ref("excluded.calendar_id"),
            calendar_account: eb.ref("excluded.calendar_account"),
            calendar_name: eb.ref("excluded.calendar_name"),
            calendar_label: eb.ref("excluded.calendar_label"),
            title: eb.ref("excluded.title"),
            location: eb.ref("excluded.location"),
            meeting_url: eb.ref("excluded.meeting_url"),
            start_at: eb.ref("excluded.start_at"),
            end_at: eb.ref("excluded.end_at"),
            start_date: eb.ref("excluded.start_date"),
            end_date: eb.ref("excluded.end_date"),
            time_zone: eb.ref("excluded.time_zone"),
            all_day: eb.ref("excluded.all_day"),
            busy: eb.ref("excluded.busy"),
            tentative: eb.ref("excluded.tentative"),
            status: eb.ref("excluded.status"),
            repeats: eb.ref("excluded.repeats"),
            recurrence: eb.ref("excluded.recurrence"),
            recurrence_id: eb.ref("excluded.recurrence_id"),
            uid: eb.ref("excluded.uid"),
            series_id: eb.ref("excluded.series_id"),
            series_end: eb.ref("excluded.series_end"),
            organizer_name: eb.ref("excluded.organizer_name"),
            organizer_email: eb.ref("excluded.organizer_email"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }
}

/** When an operation happened, as the row's update stamp. */
function timeOf(operation: OperationWithContext["operation"]): string {
  const stamped = operation as { timestampUtcMs?: unknown };
  if (typeof stamped.timestampUtcMs === "string" && stamped.timestampUtcMs)
    return stamped.timestampUtcMs;
  const action = operation.action as { timestampUtcMs?: unknown };
  if (typeof action.timestampUtcMs === "string" && action.timestampUtcMs)
    return action.timestampUtcMs;
  return new Date().toISOString();
}
