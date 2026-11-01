/**
 * The Files index over a reactor-drive: node rows replayed from the drive's
 * folder and relationship operations (and the legacy node actions it also
 * takes), a File's name from its own header, and the tree and folder-sync
 * answers built on them. The processor runs on a real Postgres (PGlite in
 * memory), in a schema of its own as a drive's namespace is.
 *
 * `.spec.ts` so codegen never claims the filename.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IRelationalDb } from "@powerhousedao/reactor-browser";
import type { OperationWithContext } from "document-model";
import {
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { FilesIndex } from "./processor.js";
import {
  childCountsQuery,
  folderPaths,
  folderTreeQuery,
  foldFolderTree,
  listingQuery,
  listsFilesOnly,
  syncMappingsQuery,
  toSyncMapping,
} from "./queries.js";
import { DriveTree, headerNameOf, resolveCollision, syncMappingRow } from "./rows.js";
import type { DB, FileNodeRow } from "./schema.js";

const DRIVE = "drive-1";
const REACTOR = "powerhouse/reactor-drive";
const FILE = "sektar/file";
const SYNC = "sektar/folder-sync";

const meta = (parentFolderId: string | null, name?: string) => ({
  kind: "file",
  parentFolderId,
  documentType: FILE,
  ...(name ? { name } : {}),
});
const link = (targetId: string, parentFolderId: string | null, name?: string) => ({
  sourceId: DRIVE,
  targetId,
  relationshipType: "drive/child",
  metadata: meta(parentFolderId, name),
});
const unlink = (targetId: string) => ({ sourceId: DRIVE, targetId, relationshipType: "drive/child" });

/** The tree's rows as [id, name, parent], by id. */
function shape(rows: Iterable<FileNodeRow>): [string, string, string | null][] {
  return [...rows].map((r) => [r.id, r.name, r.parent_id] as [string, string, string | null]).sort((a, b) => a[0].localeCompare(b[0]));
}

describe("a reactor-drive's node rows, replayed", () => {
  it("adds folders and files, renames, moves and removes them", () => {
    const tree = new DriveTree([], () => undefined);
    tree.apply("ADD_FOLDER", { folderId: "f1", parentFolderId: null, name: "facturen" });
    tree.apply("ADD_FOLDER", { folderId: "f2", parentFolderId: "f1", name: "2024" });
    tree.apply("ADD_RELATIONSHIP", link("d1", "f2", "q2.pdf"));
    tree.apply("ADD_RELATIONSHIP", link("d2", null, "notes.txt"));
    expect(shape(tree.rows.values())).toEqual([
      ["d1", "q2.pdf", "f2"],
      ["d2", "notes.txt", null],
      ["f1", "facturen", null],
      ["f2", "2024", "f1"],
    ]);
    expect(tree.rows.get("d1")).toMatchObject({ kind: "file", document_type: FILE, name_sort: "q2.pdf" });
    expect(tree.rows.get("f1")).toMatchObject({ kind: "folder", document_type: null });

    // A rename, and a move of a folder to the root
    tree.apply("UPDATE_FOLDER", { folderId: "f2", name: "2025" });
    tree.apply("UPDATE_FOLDER", { folderId: "f2", parentFolderId: null });
    expect(tree.rows.get("f2")).toMatchObject({ name: "2025", parent_id: null });
    // A file moves as the client moves it: unlinked, then linked elsewhere, without a name
    tree.apply("REMOVE_RELATIONSHIP", unlink("d1"));
    tree.apply("ADD_RELATIONSHIP", link("d1", "f1"));
    expect(tree.rows.get("d1")).toMatchObject({ name: "q2.pdf", parent_id: "f1" });
    // A document's own new name
    tree.rename("d1", "Q2 return.pdf");
    expect(tree.rows.get("d1")?.name).toBe("Q2 return.pdf");
    // A folder goes alone: the client unlinks what was in it first
    tree.apply("REMOVE_FOLDER", { folderId: "f1" });
    expect(tree.rows.has("f1")).toBe(false);
    expect(tree.rows.get("d1")?.parent_id).toBe("f1");
    tree.apply("REMOVE_RELATIONSHIP", unlink("d1"));
    tree.drop("d2");
    expect(shape(tree.rows.values())).toEqual([["f2", "2025", null]]);
  });

  it("makes a clashing name unique as the drive does, and resolves again from the name asked for", () => {
    expect(resolveCollision("a", new Set())).toBe("a");
    expect(resolveCollision("a", new Set(["a", "a (2)"]))).toBe("a (3)");
    const tree = new DriveTree([], () => undefined);
    tree.apply("ADD_FOLDER", { folderId: "x", parentFolderId: null, name: "Q3" });
    tree.apply("ADD_FOLDER", { folderId: "y", parentFolderId: null, name: "Q3" });
    tree.apply("ADD_FOLDER", { folderId: "p", parentFolderId: null, name: "elsewhere" });
    expect(tree.rows.get("y")).toMatchObject({ name: "Q3 (2)", requested_name: "Q3" });
    // Moved away from the clash, it takes its name back.
    tree.apply("UPDATE_FOLDER", { folderId: "y", parentFolderId: "p" });
    expect(tree.rows.get("y")?.name).toBe("Q3");
    // Siblings of either kind clash.
    tree.apply("ADD_RELATIONSHIP", link("d", null, "Q3"));
    expect(tree.rows.get("d")?.name).toBe("Q3 (2)");
  });

  it("names a file from its document when the link names none, and skips a link without file metadata", () => {
    const tree = new DriveTree([], (id) => (id === "d1" ? "From header.pdf" : undefined));
    tree.apply("ADD_RELATIONSHIP", link("d1", null));
    tree.apply("ADD_RELATIONSHIP", link("d2", null));
    tree.apply("ADD_RELATIONSHIP", { sourceId: DRIVE, targetId: "d3", relationshipType: "drive/child", metadata: { kind: "folder" } });
    tree.apply("ADD_RELATIONSHIP", { sourceId: DRIVE, targetId: "d4", relationshipType: "other", metadata: meta(null, "x") });
    expect(tree.rows.get("d1")?.name).toBe("From header.pdf");
    // Not known yet: the File's own operation names it when it comes.
    expect(tree.rows.get("d2")?.name).toBe("");
    tree.rename("d2", "later.pdf");
    expect(tree.rows.get("d2")?.name).toBe("later.pdf");
    expect(tree.rows.has("d3")).toBe(false);
    expect(tree.rows.has("d4")).toBe(false);
  });

  it("projects the legacy node actions sent to a reactor-drive", () => {
    const tree = new DriveTree([], () => undefined);
    tree.apply("ADD_FOLDER", { id: "f1", name: "a", parentFolder: null });
    tree.apply("ADD_FOLDER", { id: "f2", name: "b", parentFolder: "f1" });
    tree.apply("ADD_FILE", { id: "d1", name: "doc", documentType: FILE, parentFolder: "f2" });
    tree.apply("ADD_FILE", { id: "bad", name: "no type" });
    expect(tree.rows.has("bad")).toBe(false);
    tree.apply("UPDATE_NODE", { id: "d1", name: "renamed" });
    tree.apply("UPDATE_FILE", { id: "d1", parentFolder: "f1" });
    // UPDATE_FILE never moves
    expect(tree.rows.get("d1")).toMatchObject({ name: "renamed", parent_id: "f2" });
    tree.apply("UPDATE_NODE", { id: "d1", parentFolder: null });
    expect(tree.rows.get("d1")?.parent_id).toBeNull();
    tree.apply("MOVE_NODE", { srcFolder: "d1", targetParentFolder: "f1" });
    expect(tree.rows.get("d1")?.parent_id).toBe("f1");
    // A folder never moves below itself
    tree.apply("MOVE_NODE", { srcFolder: "f1", targetParentFolder: "f2" });
    expect(tree.rows.get("f1")?.parent_id).toBeNull();
    tree.apply("COPY_NODE", { srcId: "d1", targetId: "d1c", targetParentFolder: "f1" });
    expect(tree.rows.get("d1c")).toMatchObject({ name: "renamed (2)", document_type: FILE, parent_id: "f1" });
    // A delete takes the subtree
    tree.apply("DELETE_NODE", { id: "f1" });
    expect(tree.rows.size).toBe(0);
  });

  it("reads a document's name out of a resulting state", () => {
    expect(headerNameOf(JSON.stringify({ global: {}, header: { name: "x.pdf" } }))).toBe("x.pdf");
    expect(headerNameOf(JSON.stringify({ global: {} }))).toBeNull();
    expect(headerNameOf("nope")).toBeNull();
    expect(headerNameOf(undefined)).toBeNull();
  });
});

describe("the tree and the folder syncs", () => {
  it("folds folders and counts into a tree without the .sync folder", () => {
    const tree = foldFolderTree(
      [
        { id: "s", name: ".sync", parent_id: null },
        { id: "s1", name: "inner", parent_id: "s" },
        { id: "b", name: "b 10", parent_id: null },
        { id: "a", name: "b 9", parent_id: null },
        { id: "c", name: "c", parent_id: "a" },
      ],
      [
        { parent_id: null, items: 5, folders: "3" },
        { parent_id: "a", items: "4", folders: 1 },
        { parent_id: "s", items: 2, folders: 1 },
      ],
    );
    expect(tree.syncFolderId).toBe("s");
    expect(tree.rootItems).toBe(4);
    expect(tree.rootFolders).toBe(2);
    expect(tree.folders.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(tree.folders[0]).toEqual({ id: "a", name: "b 9", parentId: null, items: 4, folders: 1, files: 3 });
    expect(tree.folders[1]).toMatchObject({ items: 0, folders: 0, files: 0 });
    expect(folderPaths(tree.folders)).toEqual(new Map([["a", "b 9"], ["b", "b 10"], ["c", "b 9/c"]]));
  });

  it("summarises a mapping's state for its badge", () => {
    const row = syncMappingRow(
      "m1",
      "Q3",
      {
        driveId: DRIVE,
        folderId: "f1",
        folderPath: "kwartaal/Q3",
        localPath: "D:\\KSDC\\Q3",
        enabled: true,
        options: { trigger: "ON_CHANGE", includeSubfolders: true },
        status: "OK",
        request: { id: "r", requestedAt: "2026-10-28T10:00:00.000Z" },
        host: { name: "pc" },
        runs: [{ id: "run", startedAt: "2026-10-28T10:00:01.000Z", finishedAt: "2026-10-28T10:00:05.000Z", status: "OK", placeholders: 2, error: null }],
        issues: [{ id: "i" }],
        pulls: [],
      },
      "2026-10-28T10:00:06.000Z",
    );
    expect(toSyncMapping(row)).toEqual({
      id: "m1",
      name: "Q3",
      driveId: DRIVE,
      folderId: "f1",
      folderPath: "kwartaal/Q3",
      localPath: "D:\\KSDC\\Q3",
      enabled: true,
      trigger: "ON_CHANGE",
      includeSubfolders: true,
      status: "OK",
      requestedAt: "2026-10-28T10:00:00.000Z",
      lastRun: { startedAt: "2026-10-28T10:00:01.000Z", finishedAt: "2026-10-28T10:00:05.000Z", status: "OK", placeholders: 2, error: null },
      issueCount: 1,
      pullCount: 0,
      hostName: "pc",
    });
    expect(toSyncMapping(syncMappingRow("m2", "", {}, "x"))).toMatchObject({ enabled: false, status: "NEVER", trigger: "MANUAL", lastRun: null, issueCount: 0 });
  });
});

/* ------------------------------------------------- the processor, on PGlite */

/** Kysely over PGlite: one connection, queries passed straight through. */
class PGliteDriver implements Driver {
  constructor(private readonly pg: PGlite) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    const pg = this.pg;
    return {
      async executeQuery<R>(query: { sql: string; parameters: readonly unknown[] }): Promise<QueryResult<R>> {
        const result = await pg.query<R>(query.sql, [...query.parameters]);
        return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) };
      },
      streamQuery() {
        throw new Error("not used");
      },
    };
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

const pg = new PGlite();
const base = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PGliteDriver(pg),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const db = base.withSchema("files_ns");
// The processor only queries its own namespace; the namespace calls are the host's.
const store = Object.assign(db, {
  createNamespace: () => Promise.reject(new Error("not used")),
  queryNamespace: () => db,
}) as unknown as IRelationalDb<DB>;

let ordinal = 0;
function op(documentType: string, documentId: string, type: string, input: unknown, scope = "document", state?: object): OperationWithContext {
  ordinal += 1;
  return {
    operation: { id: `op-${ordinal}`, index: ordinal, skip: 0, timestampUtcMs: "2026-10-29T12:00:00.000Z", hash: "", action: { id: `a-${ordinal}`, type, scope, input, timestampUtcMs: "2026-10-29T12:00:00.000Z" } },
    context: { documentId, documentType, scope, branch: "main", ordinal, ...(state ? { resultingState: JSON.stringify(state) } : {}) },
  } as unknown as OperationWithContext;
}
const fileOp = (id: string, name: string, title: string) =>
  op(FILE, id, "SET_TITLE", { title }, "global", { global: { title, tags: [], renditions: [] }, header: { name } });

describe("the processor on a reactor-drive", () => {
  const index = new FilesIndex(FilesIndex.getNamespace(DRIVE), { documentId: [DRIVE] }, store, DRIVE).forDrive(REACTOR);

  beforeAll(async () => {
    await base.schema.createSchema("files_ns").execute();
    await index.initAndUpgrade();
  });

  const nodes = async () => shape(await db.selectFrom("file_nodes").selectAll().execute());

  it("builds the rows from the drive's operations and the Files' own names, in either order", async () => {
    // A File seen before the drive links it: its name waits for the link.
    await index.onOperations([fileOp("d1", "invoice.pdf", "Invoice")]);
    await index.onOperations([
      op(REACTOR, DRIVE, "ADD_FOLDER", { folderId: "f1", parentFolderId: null, name: "facturen" }),
      op(REACTOR, DRIVE, "ADD_FOLDER", { folderId: "s", parentFolderId: null, name: ".sync" }),
      op(REACTOR, DRIVE, "ADD_RELATIONSHIP", link("d1", "f1")),
      op(REACTOR, DRIVE, "ADD_RELATIONSHIP", link("d2", "f1")),
      op(REACTOR, DRIVE, "ADD_RELATIONSHIP", { sourceId: DRIVE, targetId: "m1", relationshipType: "drive/child", metadata: { kind: "file", parentFolderId: "s", documentType: SYNC } }),
      // Another drive's operations are not this one's
      op(REACTOR, "drive-2", "ADD_FOLDER", { folderId: "zz", parentFolderId: null, name: "other" }),
    ]);
    // A File linked before it was seen: its own operation names it.
    await index.onOperations([fileOp("d2", "receipt.pdf", "Receipt")]);
    expect(await nodes()).toEqual([
      ["d1", "invoice.pdf", "f1"],
      ["d2", "receipt.pdf", "f1"],
      ["f1", "facturen", null],
      ["m1", "", "s"],
      ["s", ".sync", null],
    ]);
    const listed = await listingQuery(db, { scope: { parents: ["f1"], root: false }, filesOnly: false, words: ["receipt"] }, { offset: 0, limit: 10 }).execute();
    expect(listed.map((r) => [r.id, r.title])).toEqual([["d2", "Receipt"]]);
  });

  it("finds a folder in a search of every folder, and lists none without a search", async () => {
    const deep = async (words: string[]) =>
      (
        await listingQuery(
          db,
          { scope: { all: true }, filesOnly: listsFilesOnly(true, words), words },
          { offset: 0, limit: 10 },
        ).execute()
      ).map((r) => r.id);
    expect(await deep(["factu"])).toEqual(["f1"]);
    expect(await deep(["receipt"])).toEqual(["d2"]);
    expect(await deep([])).toEqual(["d1", "d2"]);
    // The folder syncs' own folder stays out of a search as out of a listing.
    expect(await deep(["sync"])).toEqual([]);
  });

  it("follows a rename, a move and a removal", async () => {
    await index.onOperations([
      fileOp("d1", "invoice 2026.pdf", "Invoice"),
      op(REACTOR, DRIVE, "ADD_FOLDER", { folderId: "f2", parentFolderId: "f1", name: "2026" }),
      op(REACTOR, DRIVE, "REMOVE_RELATIONSHIP", unlink("d2")),
      op(REACTOR, DRIVE, "ADD_RELATIONSHIP", link("d2", "f2")),
      op(REACTOR, DRIVE, "UPDATE_FOLDER", { folderId: "f1", name: "invoices" }),
    ]);
    expect(await nodes()).toEqual([
      ["d1", "invoice 2026.pdf", "f1"],
      ["d2", "receipt.pdf", "f2"],
      ["f1", "invoices", null],
      ["f2", "2026", "f1"],
      ["m1", "", "s"],
      ["s", ".sync", null],
    ]);
    // A File deleted takes its node; its listing row goes with it.
    await index.onOperations([op(FILE, "d1", "DELETE_DOCUMENT", { documentId: "d1" })]);
    expect((await nodes()).map(([id]) => id)).toEqual(["d2", "f1", "f2", "m1", "s"]);
    expect(await db.selectFrom("file_docs").select("document_id").execute()).toEqual([{ document_id: "d2" }]);
  });

  it("answers the tree and the folder syncs", async () => {
    await index.onOperations([
      op(SYNC, "m1", "SET_TARGET", {}, "global", {
        global: { driveId: DRIVE, folderId: "f1", folderPath: "invoices", localPath: "D:\\x", enabled: true, options: { trigger: "MANUAL" }, status: "NEVER", runs: [], issues: [] },
        header: { name: "invoices" },
      }),
      // A mapping that is not filed in this drive is not this drive's.
      op(SYNC, "m9", "SET_TARGET", {}, "global", { global: { status: "NEVER" }, header: { name: "elsewhere" } }),
    ]);
    const tree = foldFolderTree(await folderTreeQuery(db).execute(), await childCountsQuery(db).execute());
    expect(tree).toMatchObject({ rootItems: 1, rootFolders: 1, syncFolderId: "s" });
    expect(tree.folders).toEqual([
      { id: "f2", name: "2026", parentId: "f1", items: 1, folders: 0, files: 1 },
      { id: "f1", name: "invoices", parentId: null, items: 1, folders: 1, files: 0 },
    ]);
    const mappings = (await syncMappingsQuery(db).execute()).map(toSyncMapping);
    expect(mappings.map((m) => [m.id, m.name, m.folderId, m.enabled, m.status])).toEqual([["m1", "invoices", "f1", true, "NEVER"]]);
    // The mapping's node takes its document's name.
    expect((await nodes()).find(([id]) => id === "m1")?.[1]).toBe("invoices");
  });
});
