/**
 * Keeps the Files index in step with a drive and the File documents.
 *
 * Node rows mirror the drive's nodes. On a legacy drive every drive
 * operation carries the drive's resulting state, so the rows are taken from
 * its node list rather than replayed from the action: a name the drive
 * changed on a collision, or the descendants a folder delete took along,
 * come out right by construction. Each batch with a drive operation
 * reconciles the rows with the drive's last node list, against the rows as
 * stored: an unchanged node is not rewritten, and a replay that skips
 * operations (or one after a clear) still ends at the drive's truth.
 *
 * A reactor-drive's state has no node list: its folders are its own
 * ADD_FOLDER / UPDATE_FOLDER / REMOVE_FOLDER operations and its files are
 * `drive/child` relationships, and a file node shows its document's name.
 * Its rows are replayed from those operations over the stored rows
 * (DriveTree, as the reactor's node projection does), and a document's new
 * name renames its node.
 *
 * The processor keeps no rows in memory; the database is the only record of
 * what it wrote.
 *
 * Node rows come from this drive's operations only; File and mapping rows
 * come from any such document, and a listing joins them to this drive's
 * nodes.
 */
import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import { up } from "./migrations.js";
import { DriveTree, fileDocRow, globalOf, headerNameOf, nodeRows, sameNode, syncMappingRow } from "./rows.js";
import type { DB, FileDocRow, FileNodeRow, SyncMappingRow } from "./schema.js";

export const DRIVE_DOCUMENT_TYPE = "powerhouse/document-drive";
export const REACTOR_DRIVE_DOCUMENT_TYPE = "powerhouse/reactor-drive";
/** Both drive types: the Files drive is either. */
export const DRIVE_DOCUMENT_TYPES = [DRIVE_DOCUMENT_TYPE, REACTOR_DRIVE_DOCUMENT_TYPE];
export const FILE_DOCUMENT_TYPE = "sektar/file";
export const SYNC_DOCUMENT_TYPE = "sektar/folder-sync";

/** Rows per statement: well under any bind-parameter cap at these widths. */
const BATCH = 300;

/**
 * The factory registers one processor for the drive's operations and one for
 * the File and mapping documents' (two filters) over one namespace; their
 * writes must not interleave.
 */
const queueByNamespace = new Map<string, Promise<void>>();

interface DriveOp {
  type: string;
  input: unknown;
}

export class FilesIndex extends RelationalDbProcessor<DB> {
  /** Whether the drive is a reactor-drive (set by the factory, from the drive's header). */
  private reactorDrive = false;

  forDrive(documentType: string): this {
    this.reactorDrive = documentType === REACTOR_DRIVE_DOCUMENT_TYPE;
    return this;
  }

  onOperations(operations: OperationWithContext[]): Promise<void> {
    const namespace = this._namespace;
    const previous = queueByNamespace.get(namespace) ?? Promise.resolve();
    const next = previous.then(() => this.index(operations));
    // Keep the chain alive after a failure, or one bad batch stalls every
    // later one behind a rejected promise.
    queueByNamespace.set(
      namespace,
      next.catch(() => undefined),
    );
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
    const driveId = this._driveId;
    let lastDriveState: ReturnType<typeof globalOf> = null;
    const docs = new Map<string, FileDocRow | null>();
    const mappings = new Map<string, SyncMappingRow | null>();
    /** A reactor-drive's own operations, in order */
    const driveOps: DriveOp[] = [];
    /** Documents' names, as their latest operation in the batch carries them */
    const names = new Map<string, string>();
    /** Documents deleted: a reactor-drive drops their nodes */
    const deleted = new Set<string>();

    for (const { operation, context } of operations) {
      const type = operation.action.type;
      if (type === "DELETE_DOCUMENT" || type === "PURGE_DOCUMENT") {
        const input = operation.action.input as { documentId?: string } | null;
        const id = input?.documentId ?? context.documentId;
        if (this.isNamespaceDrive(id)) {
          await this.dropNamespace();
          return;
        }
        if (context.documentType === FILE_DOCUMENT_TYPE) docs.set(id, null);
        if (context.documentType === SYNC_DOCUMENT_TYPE) mappings.set(id, null);
        deleted.add(id);
        names.delete(id);
        continue;
      }
      if (operation.error) continue;

      if (context.documentType === DRIVE_DOCUMENT_TYPE) {
        if (context.documentId !== driveId || context.scope !== "global") continue;
        const state = globalOf(context.resultingState);
        if (state) lastDriveState = state;
        continue;
      }
      if (context.documentType === REACTOR_DRIVE_DOCUMENT_TYPE) {
        // Folders and relationships are document-scope operations; the
        // legacy node actions a reactor-drive also takes are global ones.
        if (context.documentId === driveId) driveOps.push({ type, input: operation.action.input });
        continue;
      }

      const isFile = context.documentType === FILE_DOCUMENT_TYPE;
      const isMapping = context.documentType === SYNC_DOCUMENT_TYPE;
      if (!isFile && !isMapping) continue;
      if (deleted.has(context.documentId)) continue;
      // Every operation carries the header: its name is what a
      // reactor-drive's file node shows.
      const name = headerNameOf(context.resultingState);
      if (name !== null) names.set(context.documentId, name);
      if (context.scope !== "global") continue;
      const state = globalOf(context.resultingState);
      if (!state) continue;
      if (isFile) docs.set(context.documentId, fileDocRow(context.documentId, state, timeOf(operation)));
      else mappings.set(context.documentId, syncMappingRow(context.documentId, name ?? "", state, timeOf(operation)));
    }

    if (lastDriveState) await this.writeNodes(nodeRows(lastDriveState));
    if (this.reactorDrive && (driveOps.length > 0 || names.size > 0 || deleted.size > 0)) {
      await this.replayDrive(driveOps, names, deleted);
    }
    await this.writeDocs(docs);
    await this.writeMappings(mappings);
  }

  /**
   * A reactor-drive's batch: its operations replayed over the stored rows,
   * its documents' new names applied, its deleted documents' nodes dropped;
   * then the difference written.
   */
  private async replayDrive(
    driveOps: readonly DriveOp[],
    names: ReadonlyMap<string, string>,
    deleted: ReadonlySet<string>,
  ): Promise<void> {
    const named = [...names].map(([document_id, name]) => ({ document_id, name }));
    for (let at = 0; at < named.length; at += BATCH) {
      await this.relationalDb
        .insertInto("doc_names")
        .values(named.slice(at, at + BATCH))
        .onConflict((oc) => oc.column("document_id").doUpdateSet((eb) => ({ name: eb.ref("excluded.name") })))
        .execute();
    }
    const gone = [...deleted];
    for (let at = 0; at < gone.length; at += BATCH) {
      await this.relationalDb.deleteFrom("doc_names").where("document_id", "in", gone.slice(at, at + BATCH)).execute();
    }

    // A link that names no document name takes the document's own: the
    // names it may need are read once, for the files the batch links.
    const known = new Map(names);
    const wanted = new Set<string>();
    for (const op of driveOps) {
      if (op.type !== "ADD_RELATIONSHIP") continue;
      const target = (op.input as { targetId?: unknown } | null)?.targetId;
      if (typeof target === "string" && !known.has(target)) wanted.add(target);
    }
    const ids = [...wanted];
    for (let at = 0; at < ids.length; at += BATCH) {
      const rows = await this.relationalDb
        .selectFrom("doc_names")
        .select(["document_id", "name"])
        .where("document_id", "in", ids.slice(at, at + BATCH))
        .execute();
      for (const r of rows) known.set(r.document_id, r.name);
    }

    const stored = driveOps.length > 0 ? await this.relationalDb.selectFrom("file_nodes").selectAll().execute() : await this.nodesAround(names, deleted);
    const tree = new DriveTree(stored, (id) => known.get(id));
    for (const op of driveOps) tree.apply(op.type, op.input);
    for (const [id, name] of names) tree.rename(id, name);
    for (const id of deleted) tree.drop(id);
    await this.writeNodes(tree.rows, stored);
  }

  /**
   * The rows a rename or a delete of these documents can touch: their nodes
   * and those nodes' siblings (a new name is checked against them). A
   * batch of File edits reads a few folders, not the whole drive.
   */
  private async nodesAround(names: ReadonlyMap<string, string>, deleted: ReadonlySet<string>): Promise<FileNodeRow[]> {
    const ids = [...names.keys(), ...deleted];
    const found: FileNodeRow[] = [];
    for (let at = 0; at < ids.length; at += BATCH) {
      found.push(...(await this.relationalDb.selectFrom("file_nodes").selectAll().where("id", "in", ids.slice(at, at + BATCH)).execute()));
    }
    // Most edits leave the name as it was: nothing more to read.
    const own = found.filter((r) => deleted.has(r.id) || (r.kind === "file" && names.has(r.id) && r.requested_name !== names.get(r.id)));
    if (own.length === 0) return [];
    const parents = [...new Set(own.map((r) => r.parent_id).filter((p): p is string => p !== null))];
    const atRoot = own.some((r) => r.parent_id === null);
    const out = new Map(own.map((r) => [r.id, r]));
    for (let at = 0; at < parents.length; at += BATCH) {
      const rows = await this.relationalDb.selectFrom("file_nodes").selectAll().where("parent_id", "in", parents.slice(at, at + BATCH)).execute();
      for (const r of rows) out.set(r.id, r);
    }
    if (atRoot) {
      for (const r of await this.relationalDb.selectFrom("file_nodes").selectAll().where("parent_id", "is", null).execute()) out.set(r.id, r);
    }
    return [...out.values()];
  }

  /** Brings the node rows to the drive's nodes, writing only the difference. */
  private async writeNodes(truth: ReadonlyMap<string, FileNodeRow>, stored?: readonly FileNodeRow[]): Promise<void> {
    const rows = stored ?? (await this.relationalDb.selectFrom("file_nodes").selectAll().execute());
    const current = new Map(rows.map((r) => [r.id, r]));
    const upserts: FileNodeRow[] = [];
    const deletes: string[] = [];
    for (const id of current.keys()) {
      if (!truth.has(id)) deletes.push(id);
    }
    for (const [id, want] of truth) {
      const have = current.get(id);
      if (!have || !sameNode(have, want)) upserts.push(want);
    }
    for (let at = 0; at < deletes.length; at += BATCH) {
      await this.relationalDb
        .deleteFrom("file_nodes")
        .where("id", "in", deletes.slice(at, at + BATCH))
        .execute();
    }
    for (let at = 0; at < upserts.length; at += BATCH) {
      await this.relationalDb
        .insertInto("file_nodes")
        .values(upserts.slice(at, at + BATCH))
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            kind: eb.ref("excluded.kind"),
            name: eb.ref("excluded.name"),
            name_sort: eb.ref("excluded.name_sort"),
            parent_id: eb.ref("excluded.parent_id"),
            document_type: eb.ref("excluded.document_type"),
            requested_name: eb.ref("excluded.requested_name"),
          })),
        )
        .execute();
    }
  }

  private async writeDocs(docs: Map<string, FileDocRow | null>): Promise<void> {
    const deletes = [...docs].filter(([, row]) => row === null).map(([id]) => id);
    const rows = [...docs.values()].filter((r): r is FileDocRow => r !== null);
    if (deletes.length > 0) {
      await this.relationalDb.deleteFrom("file_docs").where("document_id", "in", deletes).execute();
    }
    for (let at = 0; at < rows.length; at += BATCH) {
      await this.relationalDb
        .insertInto("file_docs")
        .values(rows.slice(at, at + BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            description: eb.ref("excluded.description"),
            tags: eb.ref("excluded.tags"),
            source_kind: eb.ref("excluded.source_kind"),
            source_mime: eb.ref("excluded.source_mime"),
            source_name: eb.ref("excluded.source_name"),
            source_size: eb.ref("excluded.source_size"),
            source_document_type: eb.ref("excluded.source_document_type"),
            source_document_name: eb.ref("excluded.source_document_name"),
            rendition_count: eb.ref("excluded.rendition_count"),
            thumb_ref: eb.ref("excluded.thumb_ref"),
            disk_change: eb.ref("excluded.disk_change"),
            search_text: eb.ref("excluded.search_text"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }

  private async writeMappings(mappings: Map<string, SyncMappingRow | null>): Promise<void> {
    const deletes = [...mappings].filter(([, row]) => row === null).map(([id]) => id);
    const rows = [...mappings.values()].filter((r): r is SyncMappingRow => r !== null);
    if (deletes.length > 0) {
      await this.relationalDb.deleteFrom("sync_mappings").where("document_id", "in", deletes).execute();
    }
    for (let at = 0; at < rows.length; at += BATCH) {
      await this.relationalDb
        .insertInto("sync_mappings")
        .values(rows.slice(at, at + BATCH))
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            drive_id: eb.ref("excluded.drive_id"),
            folder_id: eb.ref("excluded.folder_id"),
            folder_path: eb.ref("excluded.folder_path"),
            local_path: eb.ref("excluded.local_path"),
            enabled: eb.ref("excluded.enabled"),
            trigger: eb.ref("excluded.trigger"),
            include_subfolders: eb.ref("excluded.include_subfolders"),
            status: eb.ref("excluded.status"),
            requested_at: eb.ref("excluded.requested_at"),
            last_run_started_at: eb.ref("excluded.last_run_started_at"),
            last_run_finished_at: eb.ref("excluded.last_run_finished_at"),
            last_run_status: eb.ref("excluded.last_run_status"),
            last_run_placeholders: eb.ref("excluded.last_run_placeholders"),
            last_run_error: eb.ref("excluded.last_run_error"),
            issue_count: eb.ref("excluded.issue_count"),
            pull_count: eb.ref("excluded.pull_count"),
            host_name: eb.ref("excluded.host_name"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }
}

function timeOf(operation: OperationWithContext["operation"]): string {
  const stamped = operation as { timestampUtcMs?: unknown };
  if (typeof stamped.timestampUtcMs === "string" && stamped.timestampUtcMs) return stamped.timestampUtcMs;
  return new Date().toISOString();
}
