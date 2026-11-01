// Listing a Files drive through its index rather than its nodes and
// documents (processors/files-index). Behind a remote drive the switchboard
// answers over GraphQL; with the drive in the tab's own reactor the same
// queries run live on its database. Either way the list is paged where the
// reader is (kit/paged.ts) and a File document is loaded only when opened.
// The folder tree (with its counts) and the drive's folder syncs come from
// the same index: no screen reads the drive's node list or loads every
// mapping document.
import { useReactorClient, useRelationalQuery } from "@powerhousedao/reactor-browser";
import { indexGql as gql } from "./index-gql.js";
import type { DocumentDriveDocument } from "@powerhousedao/shared/document-drive";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  childCountsQuery,
  FILES_PAGE,
  FilesIndex,
  folderTreeQuery,
  foldersQuery,
  foldFolderTree,
  listingCountQuery,
  listingQuery,
  listsFilesOnly,
  scopeFor,
  searchWords,
  syncMappingsQuery,
  toListRow,
  toSyncMapping,
  type DB,
  type FileListPage,
  type FileListRow,
  type FilesFilter,
  type FolderRow,
  type FolderTree,
  type SyncMappingRow,
  type SyncMappingSummary,
} from "../../../processors/files-index/index.js";
import { useMailIndexMode } from "./mail-index.js";
import { usePagedList, type PagedList } from "./paged.js";

export type { FileListRow, FolderRow, FolderTree, SyncMappingSummary };
export { folderPaths } from "../../../processors/files-index/index.js";

export interface FilesListFilter {
  /** The open folder; null at the drive's root. */
  folderId: string | null;
  /** The folder and every folder below it, documents only unless searching. */
  deep: boolean;
  /** The top bar's search, raw. */
  query: string;
  /** Group by sync status: the changes a folder sync found on disk come first. */
  syncFirst?: boolean;
}

const LISTING_QUERY = `query ($d: String!, $f: String, $deep: Boolean, $q: String, $o: Int, $l: Int, $s: Boolean) {
  filesIndex { listing(driveId: $d, folderId: $f, deep: $deep, query: $q, offset: $o, limit: $l, syncFirst: $s) {
    total
    items { id kind name parentId documentType title description tags { id label color } sourceKind sourceMime sourceName sourceSize sourceDocumentType sourceDocumentName renditionCount thumbRef diskChange }
  } }
}`;

const FOLDERS_QUERY = `query ($d: String!) {
  filesIndex { folders(driveId: $d) {
    rootItems rootFolders syncFolderId
    folders { id name parentId items folders files }
  } }
}`;

const MAPPINGS_QUERY = `query ($d: String!) {
  filesIndex { syncMappings(driveId: $d) {
    id name driveId folderId folderPath localPath enabled trigger includeSubfolders status requestedAt
    lastRun { startedAt finishedAt status placeholders error }
    issueCount pullCount hostName
  } }
}`;

const SYNC_TYPE = "sektar/folder-sync";
/** A burst of changes asks the index once. */
const REFRESH_DEBOUNCE_MS = 800;
/** A failed ask is asked again after this long. */
const RETRY_MS = 5_000;
/** The index follows a write a beat later: a change is asked about again after this long. */
const SETTLE_MS = 2_500;

/* --------------------------------------------------------------- local */

type LocalParams = { filter: FilesFilter; offset: number; limit: number; syncFirst: boolean };
type LocalQB = Parameters<Parameters<typeof useRelationalQuery<DB, FileListRow, LocalParams>>[2]>[0];
type FolderSource = { id: string; parent_id: string | null };

/** Every folder with its parent, live over the tab's own database: a deep listing's scope. */
function useLocalFolders(enabled: boolean, driveId: string): FolderSource[] {
  const build = useCallback((db: LocalQB) => foldersQuery(db).compile(), []);
  const q = useRelationalQuery<DB, FolderSource, undefined>(FilesIndex, enabled ? driveId : "", build, undefined);
  return useMemo(() => (enabled && q.result ? q.result.rows : []), [enabled, q.result]);
}

/** The listing over the tab's own database: a live window, a page either side. */
function useLocalFiles(
  enabled: boolean,
  drive: DocumentDriveDocument | undefined,
  filter: FilesListFilter,
): PagedList<FileListRow> {
  const driveId = drive?.header.id ?? "";
  const folders = useLocalFolders(enabled && filter.deep, driveId);
  const syncFirst = Boolean(filter.syncFirst);
  const key = JSON.stringify([driveId, filter.folderId, filter.deep, filter.query, syncFirst]);
  const [range, setRange] = useState({ key, offset: 0 });
  const offset = range.key === key ? range.offset : 0;
  const limit = enabled ? FILES_PAGE * 3 : 1;
  const params = useMemo<LocalParams>(() => {
    const words = searchWords(filter.query);
    return {
      filter: {
        scope: scopeFor(folders, filter.folderId, filter.deep),
        filesOnly: listsFilesOnly(filter.deep, words),
        words,
      },
      offset,
      limit,
      syncFirst,
    };
  }, [folders, filter.folderId, filter.deep, filter.query, offset, limit, syncFirst]);
  const build = useCallback(
    (db: LocalQB, p?: LocalParams) => {
      const q = p ?? params;
      return listingQuery(db, q.filter, { offset: q.offset, limit: q.limit }, { syncFirst: q.syncFirst }).compile();
    },
    [params],
  );
  const buildCount = useCallback(
    (db: LocalQB, p?: LocalParams) => listingCountQuery(db, (p ?? params).filter).compile(),
    [params],
  );
  const rowsQ = useRelationalQuery<DB, Parameters<typeof toListRow>[0], LocalParams>(FilesIndex, driveId, build, params);
  const countQ = useRelationalQuery<DB, { n: number | string }, LocalParams>(FilesIndex, driveId, buildCount, params);
  const result = rowsQ.result;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const [shown, setShown] = useState<{ offset: number; rows: FileListRow[] }>({ offset: 0, rows: [] });
  useEffect(() => {
    if (result) setShown({ offset: offsetRef.current, rows: result.rows.map(toListRow) });
  }, [result]);
  const total = Number(countQ.result?.rows[0]?.n ?? shown.rows.length);
  const ensure = useCallback(
    (start: number) => {
      const want = Math.max(0, Math.floor(start / FILES_PAGE) - 1) * FILES_PAGE;
      setRange((prev) => (prev.key === key && prev.offset === want ? prev : { key, offset: want }));
    },
    [key],
  );
  const rowAt = useCallback(
    (index: number): FileListRow | undefined => {
      const at = index - shown.offset;
      return at >= 0 && at < shown.rows.length ? shown.rows[at] : undefined;
    },
    [shown],
  );
  const noop = useCallback(() => {}, []);
  return {
    total,
    rowAt,
    ensure,
    loaded: enabled && Boolean(result),
    stale: false,
    busy: enabled && rowsQ.isLoading,
    error: rowsQ.error?.message ?? null,
    version: total,
    // live queries follow the database themselves
    refreshSoon: noop,
    invalidate: noop,
  };
}

type CountSource = { parent_id: string | null; items: number | string | null; folders: number | string | null };

/** The tree over the tab's own database: two live queries, folded. */
function useLocalFolderTree(enabled: boolean, driveId: string): FolderTree | null {
  const buildFolders = useCallback((db: LocalQB) => folderTreeQuery(db).compile(), []);
  const buildCounts = useCallback((db: LocalQB) => childCountsQuery(db).compile(), []);
  const id = enabled ? driveId : "";
  const folders = useRelationalQuery<DB, { id: string; name: string; parent_id: string | null }, undefined>(FilesIndex, id, buildFolders, undefined);
  const counts = useRelationalQuery<DB, CountSource, undefined>(FilesIndex, id, buildCounts, undefined);
  return useMemo(
    () => (enabled && folders.result && counts.result ? foldFolderTree(folders.result.rows, counts.result.rows) : null),
    [enabled, folders.result, counts.result],
  );
}

function useLocalMappings(enabled: boolean, driveId: string): SyncMappingSummary[] | null {
  const build = useCallback((db: LocalQB) => syncMappingsQuery(db).compile(), []);
  const q = useRelationalQuery<DB, SyncMappingRow, undefined>(FilesIndex, enabled ? driveId : "", build, undefined);
  return useMemo(() => (enabled && q.result ? q.result.rows.map(toSyncMapping) : null), [enabled, q.result]);
}

/* -------------------------------------------------------------- remote */

/** Calls `onChange` (settled) when a document of one of these types changes. */
function useTypeChanges(enabled: boolean, types: readonly string[], onChange: () => void): void {
  const client = useReactorClient();
  const ref = useRef(onChange);
  ref.current = onChange;
  const key = types.join(",");
  useEffect(() => {
    if (!enabled || !client || !key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ref.current(), REFRESH_DEBOUNCE_MS);
    };
    const stops: (() => void)[] = [];
    for (const type of key.split(",")) {
      try {
        stops.push(client.subscribe({ type }, settle));
      } catch {
        // no realtime channel: the poll still follows
      }
    }
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [enabled, client, key]);
}

/**
 * One small index answer (the tree, the mappings): asked when the key
 * changes, again a beat after a change to documents of `types` or a bump of
 * `trigger` (and once more when the index has had time to follow), and every
 * half minute while the tab is visible. While a new key is on its way the
 * previous answer stays, so nothing blanks. `null` until known.
 */
function useRemoteValue<T>(options: {
  base: string | null;
  driveId: string | null;
  query: string;
  pick: (data: never) => T;
  types: readonly string[];
  trigger?: unknown;
}): T | null {
  const { base, driveId, query, types, trigger } = options;
  const enabled = base !== null && driveId !== null;
  const key = JSON.stringify([base, driveId, query]);
  const [answer, setAnswer] = useState<{ key: string; value: T } | null>(null);
  const [tick, setTick] = useState(0);
  const pickRef = useRef(options.pick);
  pickRef.current = options.pick;
  useEffect(() => {
    if (!enabled || !base || !driveId) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    gql<never>(base, query, { d: driveId })
      .then((data) => {
        if (active) setAnswer({ key, value: pickRef.current(data) });
      })
      .catch(() => {
        // keep what was known; ask again shortly
        if (active) retry = setTimeout(() => setTick((n) => n + 1), RETRY_MS);
      });
    return () => {
      active = false;
      clearTimeout(retry);
    };
    // the key says what is asked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick]);

  // A change asks now and once more when the index has followed it.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const changed = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [setTimeout(() => setTick((n) => n + 1), 300), setTimeout(() => setTick((n) => n + 1), SETTLE_MS)];
  }, []);
  useTypeChanges(enabled, types, changed);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (enabled) changed();
  }, [trigger, enabled, changed]);
  useEffect(() => {
    if (!enabled) return;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, 30_000);
    return () => {
      clearInterval(poll);
      for (const t of timers.current) clearTimeout(t);
    };
  }, [enabled]);
  return answer?.key === key ? answer.value : null;
}

/* ---------------------------------------------------------------- api */

/** A Files drive's folder, listed through the index: sized to the whole set, paged where the reader is. */
export function useFilesList(
  drive: DocumentDriveDocument | undefined,
  filter: FilesListFilter,
): PagedList<FileListRow> & { mode: "remote" | "local" | "unknown" } {
  const mode = useMailIndexMode(drive);
  const driveId = drive?.header.id ?? null;
  const base = mode.kind === "remote" ? mode.base : null;
  const syncFirst = Boolean(filter.syncFirst);
  const key = JSON.stringify([base, driveId, filter.folderId, filter.deep, filter.query.trim().toLowerCase(), syncFirst]);
  const fetchPage = useCallback(
    async (page: number) => {
      if (!base || !driveId) throw new Error("No switchboard for this drive");
      const data = await gql<{ filesIndex: { listing: FileListPage } }>(base, LISTING_QUERY, {
        d: driveId,
        f: filter.folderId,
        deep: filter.deep,
        q: filter.query.trim() || null,
        o: page * FILES_PAGE,
        l: FILES_PAGE,
        s: syncFirst,
      });
      return data.filesIndex.listing;
    },
    [base, driveId, filter.folderId, filter.deep, filter.query, syncFirst],
  );
  const remote = usePagedList<FileListRow>({
    kind: "files",
    key,
    enabled: mode.kind === "remote" && driveId !== null,
    pageSize: FILES_PAGE,
    fetchPage,
  });
  const local = useLocalFiles(mode.kind === "local", drive, filter);
  return { ...(mode.kind === "local" ? local : remote), mode: mode.kind };
}

/**
 * The drive's folders with what each holds directly, and the root's counts:
 * the tree, its counts and its paths. The `.sync` folder is left out (its id
 * is given, for a new mapping). `null` until known. `trigger` (the drive's
 * last change) asks again.
 */
export function useFolderTree(drive: DocumentDriveDocument | undefined, trigger?: unknown): FolderTree | null {
  const mode = useMailIndexMode(drive);
  const driveId = drive?.header.id ?? null;
  const remote = useRemoteValue<FolderTree>({
    base: mode.kind === "remote" ? mode.base : null,
    driveId,
    query: FOLDERS_QUERY,
    pick: (data: { filesIndex: { folders: FolderTree } }) => data.filesIndex.folders,
    types: [],
    trigger,
  });
  const local = useLocalFolderTree(mode.kind === "local", driveId ?? "");
  return mode.kind === "local" ? local : remote;
}

/** The folder syncs filed in the drive, each with how it stands; `null` until known. */
export function useSyncMappings(drive: DocumentDriveDocument | undefined, trigger?: unknown): SyncMappingSummary[] | null {
  const mode = useMailIndexMode(drive);
  const driveId = drive?.header.id ?? null;
  const remote = useRemoteValue<SyncMappingSummary[]>({
    base: mode.kind === "remote" ? mode.base : null,
    driveId,
    query: MAPPINGS_QUERY,
    pick: (data: { filesIndex: { syncMappings: SyncMappingSummary[] } }) => data.filesIndex.syncMappings,
    types: [SYNC_TYPE],
    trigger,
  });
  const local = useLocalMappings(mode.kind === "local", driveId ?? "");
  return mode.kind === "local" ? local : remote;
}
