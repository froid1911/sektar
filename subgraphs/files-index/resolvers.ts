/**
 * Reading the Files index. Read-only: the drive and the File documents are
 * changed through their own operations, and the processor follows.
 *
 * Access is declared in index.ts and applied by the subgraph wrapper: the
 * listing and its count go through `restrict`, which passes folder rows
 * and narrows file rows to the caller's readable documents; the tree's
 * counts likewise, before they are counted; the folder syncs to the
 * mappings the caller may read.
 */
import type { IndexQuery } from "@powerhousedao/reactor-api";
import {
  childCountsQuery,
  FILES_PAGE,
  FILES_PAGE_MAX,
  type FilesIndex,
  folderTreeQuery,
  foldFolderTree,
  foldersQuery,
  listingCountQuery,
  listingQuery,
  listsFilesOnly,
  scopeFor,
  searchWords,
  syncMappingsQuery,
  toListRow,
  toSyncMapping,
  type FileListPage,
  type FolderTree,
  type SyncMappingSummary,
} from "processors/files-index";

type Db = FilesIndex["query"];

interface ListingArgs {
  driveId: string;
  folderId?: string | null;
  deep?: boolean | null;
  query?: string | null;
  offset?: number | null;
  limit?: number | null;
  syncFirst?: boolean | null;
}

async function listing({
  db,
  args,
  restrict,
}: IndexQuery<Db, ListingArgs>): Promise<FileListPage> {
  const deep = Boolean(args.deep);
  const folderId = args.folderId ?? null;
  // A deep listing below a folder needs its descendants; the folders are
  // a small table, read once per request.
  const folders = deep && folderId ? await foldersQuery(db).execute() : [];
  const words = searchWords(args.query);
  const filter = {
    scope: scopeFor(folders, folderId, deep),
    filesOnly: listsFilesOnly(deep, words),
    words,
  };
  const limit = Math.min(Math.max(args.limit ?? FILES_PAGE, 1), FILES_PAGE_MAX);
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const [rows, count] = await Promise.all([
    restrict(
      listingQuery(
        db,
        filter,
        { offset, limit },
        { syncFirst: Boolean(args.syncFirst) },
      ),
    ).execute(),
    restrict(listingCountQuery(db, filter)).executeTakeFirst(),
  ]);
  return { items: rows.map(toListRow), total: Number(count?.n ?? 0) };
}

/** The tree: every folder, and what each holds directly (counted over what the caller may read). */
async function folderTree({ db, restrict }: IndexQuery<Db, { driveId: string }>): Promise<FolderTree> {
  const [rows, counts] = await Promise.all([
    restrict(folderTreeQuery(db)).execute(),
    restrict(childCountsQuery(db)).execute(),
  ]);
  return foldFolderTree(rows, counts);
}

async function syncMappings({ db, restrict }: IndexQuery<Db, { driveId: string }>): Promise<SyncMappingSummary[]> {
  return (await restrict(syncMappingsQuery(db)).execute()).map(toSyncMapping);
}

export const resolvers = {
  Query: { filesIndex: () => ({}) },
};

export const queries = {
  "FilesIndexQueries.listing": listing,
  "FilesIndexQueries.folders": folderTree,
  "FilesIndexQueries.syncMappings": syncMappings,
};
