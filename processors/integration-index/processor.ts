/**
 * Keeps the integration index in step with the integration, queue and
 * connection documents of a drive.
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
import {
  CONNECTION_DOCUMENT_TYPE,
  connectionRow,
  INTEGRATION_DOCUMENT_TYPE,
  integrationRow,
  parseResulting,
  QUEUE_DOCUMENT_TYPE,
  queueRow,
} from "./rows.js";
import type {
  ConnectionIndexRow,
  DB,
  IntegrationIndexRow,
  QueueIndexRow,
} from "./schema.js";
import { statelessWarning } from "../stateless-warning.js";

export {
  CONNECTION_DOCUMENT_TYPE,
  INTEGRATION_DOCUMENT_TYPE,
  QUEUE_DOCUMENT_TYPE,
} from "./rows.js";

export const INTEGRATION_INDEX_TYPES = [
  INTEGRATION_DOCUMENT_TYPE,
  QUEUE_DOCUMENT_TYPE,
  CONNECTION_DOCUMENT_TYPE,
] as const;

const TABLE_OF: Partial<Record<string, keyof DB>> = {
  [INTEGRATION_DOCUMENT_TYPE]: "integration_index",
  [QUEUE_DOCUMENT_TYPE]: "queue_index",
  [CONNECTION_DOCUMENT_TYPE]: "connection_index",
};

/** Rows per INSERT: a drive holds tens of these documents, so one batch is the usual case. */
const UPSERT_BATCH = 100;

export class IntegrationIndex extends RelationalDbProcessor<DB> {
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
    const integrations = new Map<string, IntegrationIndexRow | null>();
    const queues = new Map<string, QueueIndexRow | null>();
    const connections = new Map<string, ConnectionIndexRow | null>();
    const deleted = new Set<string>();
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
        deleted.add(documentId);
        integrations.set(documentId, null);
        queues.set(documentId, null);
        connections.set(documentId, null);
        continue;
      }
      if (context.scope !== "global") continue;
      // A refused operation left the document as it was.
      if (operation.error) continue;
      const table = TABLE_OF[context.documentType];
      if (!table) continue;
      const { documentId } = context;
      if (deleted.has(documentId)) continue;
      const result = parseResulting(context.resultingState);
      if (!result) {
        missing.set(documentId, (missing.get(documentId) ?? 0) + 1);
        continue;
      }
      const at = timeOf(operation);
      if (table === "integration_index") {
        integrations.set(documentId, integrationRow(documentId, result.state, result.name, at));
      } else if (table === "queue_index") {
        queues.set(documentId, queueRow(documentId, result.state, result.name, at));
      } else {
        connections.set(documentId, connectionRow(documentId, result.state, result.name, at));
      }
    }
    const warning = statelessWarning("integration-index", missing);
    if (warning) console.warn(warning);

    if (deleted.size > 0) {
      const ids = [...deleted];
      await this.relationalDb.deleteFrom("integration_index").where("document_id", "in", ids).execute();
      await this.relationalDb.deleteFrom("queue_index").where("document_id", "in", ids).execute();
      await this.relationalDb.deleteFrom("connection_index").where("document_id", "in", ids).execute();
    }
    await this.writeIntegrations(
      await keepNames(integrations, (ids) =>
        this.relationalDb.selectFrom("integration_index").select(["document_id", "name"]).where("document_id", "in", ids).execute(),
      ),
    );
    await this.writeQueues(
      await keepNames(queues, (ids) =>
        this.relationalDb.selectFrom("queue_index").select(["document_id", "name"]).where("document_id", "in", ids).execute(),
      ),
    );
    await this.writeConnections(
      await keepNames(connections, (ids) =>
        this.relationalDb.selectFrom("connection_index").select(["document_id", "name"]).where("document_id", "in", ids).execute(),
      ),
    );
  }

  private async writeIntegrations(rows: IntegrationIndexRow[]): Promise<void> {
    for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
      await this.relationalDb
        .insertInto("integration_index")
        .values(rows.slice(at, at + UPSERT_BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            kind: eb.ref("excluded.kind"),
            provider: eb.ref("excluded.provider"),
            archived: eb.ref("excluded.archived"),
            live_enabled: eb.ref("excluded.live_enabled"),
            backfill_enabled: eb.ref("excluded.backfill_enabled"),
            live_workflow_id: eb.ref("excluded.live_workflow_id"),
            backfill_workflow_id: eb.ref("excluded.backfill_workflow_id"),
            connection_id: eb.ref("excluded.connection_id"),
            mailbox: eb.ref("excluded.mailbox"),
            address: eb.ref("excluded.address"),
            queue_ids: eb.ref("excluded.queue_ids"),
            state: eb.ref("excluded.state"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }

  private async writeQueues(rows: QueueIndexRow[]): Promise<void> {
    for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
      await this.relationalDb
        .insertInto("queue_index")
        .values(rows.slice(at, at + UPSERT_BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            status: eb.ref("excluded.status"),
            description: eb.ref("excluded.description"),
            loops: eb.ref("excluded.loops"),
            total: eb.ref("excluded.total"),
            progress: eb.ref("excluded.progress"),
            iteration: eb.ref("excluded.iteration"),
            done: eb.ref("excluded.done"),
            finished: eb.ref("excluded.finished"),
            awaiting_values: eb.ref("excluded.awaiting_values"),
            error_count: eb.ref("excluded.error_count"),
            last_error: eb.ref("excluded.last_error"),
            search_text: eb.ref("excluded.search_text"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }

  private async writeConnections(rows: ConnectionIndexRow[]): Promise<void> {
    for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
      await this.relationalDb
        .insertInto("connection_index")
        .values(rows.slice(at, at + UPSERT_BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            connector_id: eb.ref("excluded.connector_id"),
            account_label: eb.ref("excluded.account_label"),
            status: eb.ref("excluded.status"),
            last_checked_at: eb.ref("excluded.last_checked_at"),
            last_error: eb.ref("excluded.last_error"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }
}

/** The rows to write; one whose state came without a header keeps the name it has. */
async function keepNames<R extends { document_id: string; name: string | null }>(
  pending: ReadonlyMap<string, R | null>,
  known: (ids: string[]) => Promise<{ document_id: string; name: string | null }[]>,
): Promise<R[]> {
  const rows = [...pending.values()].filter((r): r is R => r !== null);
  const nameless = rows.filter((r) => r.name === null).map((r) => r.document_id);
  if (nameless.length === 0) return rows;
  const names = new Map((await known(nameless)).map((k) => [k.document_id, k.name]));
  return rows.map((r) => (r.name === null ? { ...r, name: names.get(r.document_id) ?? null } : r));
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
