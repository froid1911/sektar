// The questions a Files listing asks, as queries over the index. Shared by
// the subgraph (the switchboard answers Connect) and a tab whose own reactor
// runs the processor (live queries), so both list a folder the same way.
// The declarations name kysely's builder types (these queries return them):
// importing the package lets tsc refer to "kysely", not to a path into .pnpm.
import type {} from "kysely";
import type { IRelationalDb } from "@powerhousedao/reactor-browser";
import type { DB, FileDocRow, FileNodeRow, SyncMappingRow } from "./schema.js";

export type FilesQueryBuilder = Pick<IRelationalDb<DB>, "selectFrom">;

/** The folder syncs keep their mappings in this root folder, which no listing shows. */
const SYNC_FOLDER = ".sync";
const SYNC_TYPE = "sektar/folder-sync";

/** Which nodes a listing covers. */
export type FilesScope =
  /** every node of the drive */
  | { all: true }
  /** the nodes directly in these folders, and at the root when `root` */
  | { all?: false; parents: readonly string[]; root: boolean };

export interface FilesFilter {
  scope: FilesScope;
  /** Leave folders out: see {@link listsFilesOnly}. */
  filesOnly: boolean;
  /** Lower-cased words, each matched against the name and the File's search text. */
  words: readonly string[];
}

/**
 * A listing that includes subfolders lists documents only, or every folder
 * would sit among them. A search does not: a folder can be what was asked for.
 */
export function listsFilesOnly(deep: boolean, words: readonly string[]): boolean {
  return deep && words.length === 0;
}

export const FILES_PAGE = 60;
export const FILES_PAGE_MAX = 500;

export interface FileTagLite {
  id: string;
  label: string;
  color: string;
}

/** A listing row: the node, and what the File it names says about itself. */
export interface FileListRow {
  id: string;
  kind: "folder" | "file";
  name: string;
  parentId: string | null;
  documentType: string | null;
  title: string | null;
  description: string | null;
  tags: FileTagLite[];
  sourceKind: string | null;
  sourceMime: string | null;
  sourceName: string | null;
  sourceSize: number | null;
  sourceDocumentType: string | null;
  sourceDocumentName: string | null;
  renditionCount: number;
  thumbRef: string | null;
  /** A change a folder sync found on disk, waiting to be pulled: CREATE | UPDATE | DELETE */
  diskChange: string | null;
}

export interface FileListPage {
  items: FileListRow[];
  total: number;
}

export function searchWords(query: string | null | undefined, max = 6): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, max);
}

const likeWord = (w: string) => `%${w.replace(/[%_\\]/g, "")}%`;

function filtered(db: FilesQueryBuilder, f: FilesFilter) {
  let q = db
    .selectFrom("file_nodes as n")
    .leftJoin("file_docs as d", "d.document_id", "n.id");
  const scope = f.scope;
  if (!scope.all) {
    const parents = [...scope.parents];
    q = q.where((eb) => {
      const parts = [];
      if (scope.root) parts.push(eb("n.parent_id", "is", null));
      if (parents.length > 0) parts.push(eb("n.parent_id", "in", parents));
      // An empty scope lists nothing.
      return parts.length > 0 ? eb.or(parts) : eb.val(false);
    });
  }
  // The folder syncs' own folder and documents (editors/sektar/kit/folder-sync.ts).
  q = q
    .where((eb) => eb.not(eb.and([eb("n.kind", "=", "folder"), eb("n.parent_id", "is", null), eb("n.name", "=", SYNC_FOLDER)])))
    .where((eb) => eb.or([eb("n.document_type", "is", null), eb("n.document_type", "!=", SYNC_TYPE)]));
  if (f.filesOnly) q = q.where("n.kind", "=", "file");
  for (const word of f.words) {
    if (!word) continue;
    const pattern = likeWord(word);
    q = q.where((eb) => eb.or([eb("n.name_sort", "like", pattern), eb("d.search_text", "like", pattern)]));
  }
  return q;
}

/** How a listing orders its entries. */
export interface FilesOrder {
  /** Group by sync status: what a folder sync found changed on disk comes first. */
  syncFirst?: boolean;
}

/** One page: folders first, then by name; with `syncFirst`, the disk changes before both. */
export function listingQuery(
  db: FilesQueryBuilder,
  f: FilesFilter,
  page: { offset: number; limit: number },
  order: FilesOrder = {},
) {
  let q = filtered(db, f)
    .select([
      "n.id",
      "n.kind",
      "n.name",
      "n.name_sort",
      "n.parent_id",
      "n.document_type",
      "d.title",
      "d.description",
      "d.tags",
      "d.source_kind",
      "d.source_mime",
      "d.source_name",
      "d.source_size",
      "d.source_document_type",
      "d.source_document_name",
      "d.rendition_count",
      "d.thumb_ref",
      "d.disk_change",
    ]);
  if (order.syncFirst) {
    q = q.orderBy((eb) => eb.case().when("d.disk_change", "is not", null).then(0).else(1).end());
  }
  return q
    // "folder" sorts after "file": descending puts folders first.
    .orderBy("n.kind", "desc")
    .orderBy("n.name_sort")
    .orderBy("n.id")
    .offset(Math.max(0, page.offset))
    .limit(page.limit);
}

export function listingCountQuery(db: FilesQueryBuilder, f: FilesFilter) {
  return filtered(db, f).select((eb) => eb.fn.countAll<number>().as("n"));
}

/** Every folder with its parent: enough to find a folder's descendants. */
export function foldersQuery(db: FilesQueryBuilder) {
  return db.selectFrom("file_nodes").select(["id", "parent_id"]).where("kind", "=", "folder");
}

/* ---------------------------------------------------------------- tree */

/** Every folder with its name and parent: the tree. */
export function folderTreeQuery(db: FilesQueryBuilder) {
  return db
    .selectFrom("file_nodes as n")
    .select(["n.id", "n.name", "n.parent_id"])
    .where("n.kind", "=", "folder");
}

/**
 * What each folder (and the root, `parent_id` null) holds directly: every
 * entry, and the folders among them. The folder syncs' documents are left
 * out, as the listing leaves them out.
 */
export function childCountsQuery(db: FilesQueryBuilder) {
  return db
    .selectFrom("file_nodes as n")
    .select((eb) => [
      "n.parent_id",
      eb.fn.countAll<number>().as("items"),
      eb.fn.sum<number>(eb.case().when("n.kind", "=", "folder").then(1).else(0).end()).as("folders"),
    ])
    .where((eb) => eb.or([eb("n.document_type", "is", null), eb("n.document_type", "!=", SYNC_TYPE)]))
    .groupBy("n.parent_id");
}

/** A folder of the tree, with what it holds directly. */
export interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  /** Every entry directly in it */
  items: number;
  /** The folders among them */
  folders: number;
  /** The documents among them */
  files: number;
}

export interface FolderTree {
  /** Every folder but the folder syncs' own, by name within a parent */
  folders: FolderRow[];
  /** What the drive's root holds directly */
  rootItems: number;
  rootFolders: number;
  /** The root folder the mappings are kept in, when there is one */
  syncFolderId: string | null;
}

/** The tree out of the folder rows and the counts, without the `.sync` folder and what is below it. */
export function foldFolderTree(
  folders: readonly { id: string; name: string; parent_id: string | null }[],
  counts: readonly { parent_id: string | null; items: number | string | null; folders: number | string | null }[],
): FolderTree {
  const sync = folders.find((f) => f.parent_id === null && f.name === SYNC_FOLDER);
  const hidden = new Set<string>(sync ? [sync.id, ...descendantsOf(folders, sync.id)] : []);
  const byParent = new Map(counts.map((c) => [c.parent_id, { items: Number(c.items ?? 0), folders: Number(c.folders ?? 0) }]));
  const root = byParent.get(null) ?? { items: 0, folders: 0 };
  // The `.sync` folder is an entry of the root that no one sees.
  const rootItems = Math.max(0, root.items - (sync ? 1 : 0));
  const rootFolders = Math.max(0, root.folders - (sync ? 1 : 0));
  return {
    folders: folders
      .filter((f) => !hidden.has(f.id))
      .map((f) => {
        const c = byParent.get(f.id) ?? { items: 0, folders: 0 };
        return { id: f.id, name: f.name, parentId: f.parent_id, items: c.items, folders: c.folders, files: c.items - c.folders };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id)),
    rootItems,
    rootFolders,
    syncFolderId: sync?.id ?? null,
  };
}

/** Each folder's path from the drive's root, e.g. kwartaalaangiftes/2026-Q3. */
export function folderPaths(folders: readonly { id: string; name: string; parentId: string | null }[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  const pathOf = (id: string, seen: Set<string>): string => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const f = byId.get(id);
    if (!f) return "";
    seen.add(id);
    const parent = f.parentId && !seen.has(f.parentId) ? pathOf(f.parentId, seen) : "";
    const path = parent ? `${parent}/${f.name}` : f.name;
    out.set(id, path);
    return path;
  };
  for (const f of folders) pathOf(f.id, new Set());
  return out;
}

/* ------------------------------------------------------- folder syncs */

/** The folder syncs filed in this drive (their documents are nodes of it). */
export function syncMappingsQuery(db: FilesQueryBuilder) {
  return db
    .selectFrom("sync_mappings as m")
    .innerJoin("file_nodes as n", "n.id", "m.document_id")
    .selectAll("m")
    .orderBy("m.folder_path")
    .orderBy("m.document_id");
}

/** A folder sync as the Files app shows it: enough for its badge and its line. */
export interface SyncMappingSummary {
  id: string;
  name: string;
  driveId: string | null;
  folderId: string | null;
  folderPath: string | null;
  localPath: string | null;
  enabled: boolean;
  /** MANUAL | ON_CHANGE */
  trigger: string;
  includeSubfolders: boolean;
  /** NEVER | REQUESTED | RUNNING | OK | PARTIAL | ERROR */
  status: string;
  requestedAt: string | null;
  lastRun: {
    startedAt: string | null;
    finishedAt: string | null;
    status: string | null;
    placeholders: number;
    error: string | null;
  } | null;
  issueCount: number;
  pullCount: number;
  hostName: string | null;
}

export function toSyncMapping(r: SyncMappingRow): SyncMappingSummary {
  const ran = r.last_run_started_at !== null || r.last_run_status !== null;
  return {
    id: r.document_id,
    name: r.name,
    driveId: r.drive_id,
    folderId: r.folder_id,
    folderPath: r.folder_path,
    localPath: r.local_path,
    enabled: Boolean(r.enabled),
    trigger: r.trigger,
    includeSubfolders: Boolean(r.include_subfolders),
    status: r.status,
    requestedAt: r.requested_at,
    lastRun: ran
      ? {
          startedAt: r.last_run_started_at,
          finishedAt: r.last_run_finished_at,
          status: r.last_run_status,
          placeholders: Number(r.last_run_placeholders ?? 0),
          error: r.last_run_error,
        }
      : null,
    issueCount: Number(r.issue_count ?? 0),
    pullCount: Number(r.pull_count ?? 0),
    hostName: r.host_name,
  };
}

/** Every folder below `id` (below the root when null). */
export function descendantsOf(
  folders: readonly { id: string; parent_id: string | null }[],
  id: string | null,
): string[] {
  const kids = new Map<string | null, string[]>();
  for (const f of folders) kids.set(f.parent_id, [...(kids.get(f.parent_id) ?? []), f.id]);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...(kids.get(id) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(kids.get(next) ?? []));
  }
  return out;
}

/** The scope a folder listing covers: the folder, or (deep) it and everything below. */
export function scopeFor(
  folders: readonly { id: string; parent_id: string | null }[],
  folderId: string | null,
  deep: boolean,
): FilesScope {
  if (!deep) return folderId ? { parents: [folderId], root: false } : { parents: [], root: true };
  if (!folderId) return { all: true };
  return { parents: [folderId, ...descendantsOf(folders, folderId)], root: false };
}

/** A node joined to its File row; every File column is null for a node without one. */
interface ListingRow {
  id: FileNodeRow["id"];
  kind: FileNodeRow["kind"];
  name: FileNodeRow["name"];
  parent_id: FileNodeRow["parent_id"];
  document_type: FileNodeRow["document_type"];
  title: FileDocRow["title"];
  description: FileDocRow["description"];
  tags: string | null;
  source_kind: FileDocRow["source_kind"];
  source_mime: FileDocRow["source_mime"];
  source_name: FileDocRow["source_name"];
  source_size: number | string | null;
  source_document_type: FileDocRow["source_document_type"];
  source_document_name: FileDocRow["source_document_name"];
  rendition_count: number | string | null;
  thumb_ref: FileDocRow["thumb_ref"];
  disk_change: FileDocRow["disk_change"];
}

function parseTags(text: string | null | undefined): FileTagLite[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as FileTagLite[]) : [];
  } catch {
    return [];
  }
}

export function toListRow(r: ListingRow): FileListRow {
  return {
    id: r.id,
    kind: r.kind === "folder" ? "folder" : "file",
    name: r.name,
    parentId: r.parent_id,
    documentType: r.document_type,
    title: r.title ?? null,
    description: r.description ?? null,
    tags: parseTags(r.tags),
    sourceKind: r.source_kind ?? null,
    sourceMime: r.source_mime ?? null,
    sourceName: r.source_name ?? null,
    sourceSize: r.source_size === null ? null : Number(r.source_size),
    sourceDocumentType: r.source_document_type ?? null,
    sourceDocumentName: r.source_document_name ?? null,
    renditionCount: Number(r.rendition_count ?? 0),
    thumbRef: r.thumb_ref ?? null,
    diskChange: r.disk_change ?? null,
  };
}
