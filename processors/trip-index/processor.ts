/**
 * Keeps the trip index in step with the trip documents.
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
import type { DB, TripRow } from "./schema.js";
import { statelessWarning } from "../stateless-warning.js";

export const TRIP_DOCUMENT_TYPE = "sektar/trip";

/** Rows per INSERT: 22 columns, so 200 rows is 4,400 bind parameters. */
const UPSERT_BATCH = 200;

export class TripIndex extends RelationalDbProcessor<DB> {
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
    const pending = new Map<string, TripRow | null>();
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
      pending.set(
        documentId,
        rowFromState(documentId, state, timeOf(operation)),
      );
    }
    const warning = statelessWarning("trip-index", missing);
    if (warning) console.warn(warning);

    const rows: TripRow[] = [];
    for (const [documentId, row] of pending) {
      if (row === null) {
        await this.relationalDb
          .deleteFrom("trip_index")
          .where("document_id", "=", documentId)
          .execute();
      } else {
        rows.push(row);
      }
    }
    for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
      await this.relationalDb
        .insertInto("trip_index")
        .values(rows.slice(at, at + UPSERT_BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            status: eb.ref("excluded.status"),
            purpose_kind: eb.ref("excluded.purpose_kind"),
            start_date: eb.ref("excluded.start_date"),
            end_date: eb.ref("excluded.end_date"),
            traveler_name: eb.ref("excluded.traveler_name"),
            destinations: eb.ref("excluded.destinations"),
            first_leg: eb.ref("excluded.first_leg"),
            flights: eb.ref("excluded.flights"),
            legs: eb.ref("excluded.legs"),
            nights: eb.ref("excluded.nights"),
            days: eb.ref("excluded.days"),
            cost_total: eb.ref("excluded.cost_total"),
            billed_total: eb.ref("excluded.billed_total"),
            cost_transport: eb.ref("excluded.cost_transport"),
            cost_stays: eb.ref("excluded.cost_stays"),
            cost_meals: eb.ref("excluded.cost_meals"),
            cost_extras: eb.ref("excluded.cost_extras"),
            currency: eb.ref("excluded.currency"),
            search_text: eb.ref("excluded.search_text"),
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
