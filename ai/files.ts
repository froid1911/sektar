// Moving things around in Files, and where they sit. The Files drive is a
// reactor-drive: a file's folder lives on a link the built-in addActions cannot
// write, and the drive's model has no MOVE_NODE for addActions to accept. Its
// node projection and the Files index still follow a MOVE_NODE sent to the
// drive, as Connect's drag and drop sends one, so that is what goes out here.
//
// Entries are named by their path, never by an id: a model cannot copy a long
// id, and the user approves the call by reading its arguments.
import {
  getDriveNode,
  getPHStore,
  markLocalDriveWrite,
} from "@powerhousedao/reactor-browser";
import { moveNode } from "@powerhousedao/shared/document-drive";
import type { PhAiToolContext } from "@powerhousedao/shared/document-model";
import { FILES_PAGE_MAX, folderPaths } from "../processors/files-index/queries.js";
import { driveIdOf, messageOf, readIndex } from "./read.js";

/** The most entries one approved call moves. */
export const MAX_MOVED = 50;

const NOTHING_MOVED = "Nothing was moved, so say so.";

/** The folders of Files, without the folder syncs' own, for a query on $d. */
export const FOLDERS_FIELD =
  "folders(driveId: $d) { folders { id name parentId } }";

export interface TreeFolder {
  id: string;
  name: string;
  parentId: string | null;
}

/** Where an entry sits; null below a folder the tree does not show. */
export function pathIn(
  paths: ReadonlyMap<string, string>,
  entry: { name: string; parentId: string | null },
): string | null {
  if (entry.parentId === null) return entry.name;
  const parent = paths.get(entry.parentId);
  return parent === undefined ? null : `${parent}/${entry.name}`;
}

interface ListedEntry {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
}

const FOLDER_QUERY = `query ($d: String!, $f: String, $o: Int, $l: Int) {
  filesIndex { listing(driveId: $d, folderId: $f, offset: $o, limit: $l) { total items { id kind name parentId } } }
}`;

/** What a folder holds directly, read to the end: a word search drops some characters of a name. */
async function entriesIn(folderId: string | null): Promise<ListedEntry[]> {
  const entries: ListedEntry[] = [];
  for (;;) {
    const data = await readIndex<{
      filesIndex: { listing: { total: number; items: ListedEntry[] } };
    }>("files", FOLDER_QUERY, {
      f: folderId,
      o: entries.length,
      l: FILES_PAGE_MAX,
    });
    const { items, total } = data.filesIndex.listing;
    entries.push(...items);
    if (items.length === 0 || entries.length >= total) return entries;
  }
}

/** A path as a person or a model may write it, without the slashes around it. */
const cleanPath = (path: string) => path.trim().replace(/^\/+|\/+$/g, "");

/** How long the drive's nodes may take to show a move the job says is done. */
const SETTLE_TRIES = 8;
const SETTLE_MS = 500;

export interface MoveInFilesInput {
  paths: string[];
  to: string;
}

/**
 * Moves files and folders in one approved call: all of them or, when one can't
 * be found or can't go there, none. A folder takes what it holds along. The
 * drive skips a move it won't make without failing the job, so the answer comes
 * from where the nodes are afterwards.
 */
export async function moveInFiles(
  input: MoveInFilesInput,
  context?: PhAiToolContext,
) {
  const driveId = driveIdOf("files");
  const data = await readIndex<{
    filesIndex: { folders: { folders: TreeFolder[] } };
  }>("files", `query ($d: String!) { filesIndex { ${FOLDERS_FIELD} } }`);
  const folders = data.filesIndex.folders.folders;
  const paths = folderPaths(folders);
  const folderAt = new Map([...paths].map(([id, path]) => [path, id]));

  const to = cleanPath(input.to);
  const target = to === "" ? null : folderAt.get(to);
  if (target === undefined) {
    throw new Error(`Files has no folder ${to}. ${NOTHING_MOVED}`);
  }

  const listed = new Map<string | null, Promise<ListedEntry[]>>();
  const listedIn = (folderId: string | null) => {
    const known = listed.get(folderId);
    if (known) return known;
    const reading = entriesIn(folderId);
    listed.set(folderId, reading);
    return reading;
  };

  const entryAt = async (raw: string) => {
    const path = cleanPath(raw);
    const folderId = folderAt.get(path);
    const folder = folders.find(({ id }) => id === folderId);
    if (folder) {
      if (to === path || to.startsWith(`${path}/`)) {
        throw new Error(
          `The folder ${path} cannot go into ${to === path ? "itself" : to}. ${NOTHING_MOVED}`,
        );
      }
      return { id: folder.id, path, parentId: folder.parentId };
    }
    const cut = path.lastIndexOf("/");
    const parent = cut < 0 ? null : folderAt.get(path.slice(0, cut));
    const file =
      parent === undefined
        ? undefined
        : (await listedIn(parent)).find(
            ({ kind, name }) => kind === "file" && name === path.slice(cut + 1),
          );
    if (!file) {
      throw new Error(`Files has nothing at ${path}. ${NOTHING_MOVED}`);
    }
    return { id: file.id, path, parentId: file.parentId };
  };

  const entries = await Promise.all(input.paths.map(entryAt));
  const moving = entries.filter((entry) => entry.parentId !== target);
  const alreadyThere = entries
    .filter((entry) => entry.parentId === target)
    .map((entry) => entry.path);
  if (moving.length === 0) return { moved: [], alreadyThere, to };

  const client = getPHStore()?.reactorClient;
  if (!client) {
    throw new Error(`Files cannot be changed in this session. ${NOTHING_MOVED}`);
  }
  markLocalDriveWrite(driveId);
  try {
    const handle = await client.write.execute(
      driveId,
      "main",
      moving.map(({ id }) =>
        moveNode({ srcFolder: id, targetParentFolder: target ?? undefined }),
      ),
      context?.signal,
    );
    await handle.readable;
  } catch (error) {
    throw new Error(
      `The move did not finish: ${messageOf(error)}. Read the folders again with sektarFindFiles before you say where anything is.`,
      { cause: error },
    );
  }

  const landed = await Promise.all(
    moving.map(async (entry) => {
      for (let tries = 1; ; tries += 1) {
        const node = await getDriveNode(driveId, entry.id, { refresh: true });
        const there = node !== undefined && (node.parentFolder ?? null) === target;
        if (there || tries === SETTLE_TRIES) return { ...entry, node, there };
        await new Promise((settle) => setTimeout(settle, SETTLE_MS));
      }
    }),
  );
  const stayed = landed.filter(({ there }) => !there).map(({ path }) => path);
  if (stayed.length > 0) {
    throw new Error(
      `${stayed.join(", ")} did not move: the drive did not apply it. Read the folders again with sektarFindFiles before you say where anything is.`,
    );
  }
  return {
    moved: landed.map(({ path, node }) => ({
      from: path,
      to: pathIn(paths, { name: node?.name ?? "", parentId: target }),
    })),
    alreadyThere,
    to,
  };
}
