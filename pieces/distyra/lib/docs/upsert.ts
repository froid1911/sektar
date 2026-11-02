/**
 * Upsert — many documents from one list, deduplicated on a key.
 *
 * The property that makes a batch write safe at all is that a rerun
 * converges: every create is preceded by a lookup on a stable key, so a
 * retry after a timed-out write finds what the first attempt made and
 * updates it instead of filing it twice. Everything else here follows from
 * that: the lookup is done once for the whole batch, items are deduplicated
 * among themselves before anything is written, and the output reports every
 * item by outcome rather than collapsing to a count.
 *
 * Reads and writes go through the reactor client the framework hands a
 * step. executeBatch is refused to pieces, so this is one job per document
 * and one drive write for every ADD_FILE; the lookup pages through find,
 * which filters on type and parent only, so the key comparison happens here.
 */
import { createHash } from "node:crypto";
import { toGlobalAction } from "../osc/client.js";
import { asText, valueAt, type Template } from "./template.js";

export const DEFAULT_LIMIT = 100;
const PAGE = 100;
const BRANCH = "main";

/**
 * How existing documents are found.
 *
 * `index`: the switchboard's key index (processors/key-index), a table of
 * (type, key, document) kept from the operations that set a key, so it
 * knows every document whatever created it — one small query per batch.
 * `slug`: every document this step creates carries a slug derived from its
 * key, and a batch is looked up by those slugs — an indexed read of at most
 * the batch's size, but blind to documents made any other way. `scan`:
 * every document of the type in the drive is read with its state and
 * compared on the key path. The scan is what the first version did, and at
 * a thousand emails it read a hundred megabytes of bodies per run and
 * journaled every id it touched; it should not be used on a schedule.
 */
export type Lookup = "index" | "slug" | "scan";

/** The slice of a document this step reads or makes. */
export interface DocumentLike {
  header: { id: string; name: string; documentType: string; slug?: string };
  state: unknown;
}

export interface ModuleLike {
  documentModel: { global: { id: string } };
  utils: { createDocument: () => DocumentLike };
}

export interface ActionLike {
  type: string;
  input?: unknown;
}

/** The reactor calls the upsert makes, narrow enough to fake in a test. */
export interface UpsertReactor {
  get(identifier: string): Promise<DocumentLike>;
  find(
    search: { type?: string; parentId?: string; slugs?: string[] },
    view: undefined,
    paging: { cursor: string; limit: number },
  ): Promise<{ results: DocumentLike[]; nextCursor?: string }>;
  create(
    document: DocumentLike,
    parentIdentifier?: string,
  ): Promise<DocumentLike>;
  execute(
    identifier: string,
    branch: string,
    actions: ReturnType<typeof toGlobalAction>[],
  ): Promise<DocumentLike>;
  getDocumentModelModule(documentType: string): Promise<ModuleLike>;
  /** A read of a read-model index (the key index), run by the host as this run's user. */
  query(request: {
    subgraph: string;
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<{
    data?: Record<string, unknown> | null;
    errors?: { message: string }[];
  }>;
}

export interface UpsertOptions {
  items: unknown;
  documentType: string;
  driveId: string;
  /** A folder id the documents are filed in; the drive root otherwise. */
  folderId?: string;
  /** A folder by name, created under folderId (or the root) when absent; may use $item. */
  folderName?: Template;
  itemKeyPath: string;
  keyPrefix?: string;
  documentKeyPath: string;
  name?: Template;
  createActions?: Template;
  /** Sent to an existing document; defaults to the create actions. */
  updateActions?: Template;
  limit?: number;
  stopOnError?: boolean;
  lookup?: Lookup;
}

export interface Skipped {
  index: number;
  reason: string;
}

export interface Failed {
  index: number;
  key: string;
  error: string;
}

export interface Written {
  index: number;
  key: string;
  documentId: string;
  documentType: string;
  name: string;
}

export interface UpsertResult {
  created: Written[];
  updated: Written[];
  skipped: Skipped[];
  failed: Failed[];
  counts: {
    items: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
}

/** A Json prop arrives as whatever it was given; only a list can be upserted. */
export function asList(value: unknown): unknown[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("[")) {
      try {
        return asList(JSON.parse(text));
      } catch {
        return [value];
      }
    }
    return [value];
  }
  return Array.isArray(value) ? value : [value];
}

/** A key is text; a number is accepted since ids often are; nothing else. */
export function asKey(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export interface PlannedItem {
  index: number;
  item: unknown;
  key: string;
}

export interface Plan {
  entries: PlannedItem[];
  skipped: Skipped[];
}

/**
 * Keys first, before anything is written: an item without one is reported,
 * never silently dropped, and a key seen twice in one batch resolves to its
 * first item so two entries never race for the same document.
 */
export function planUpsert(
  items: unknown[],
  keyPath: string,
  prefix: string | undefined,
  limit: number,
): Plan {
  const entries: PlannedItem[] = [];
  const skipped: Skipped[] = [];
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    if (entries.length >= limit) {
      skipped.push({ index, reason: `beyond the limit of ${limit}` });
      return;
    }
    const raw = asKey(valueAt(item, keyPath));
    if (raw === undefined) {
      skipped.push({ index, reason: `no key at "${keyPath}"` });
      return;
    }
    const key = `${prefix ?? ""}${raw}`;
    const first = seen.get(key);
    if (first !== undefined) {
      skipped.push({ index, reason: `duplicate of item ${first} (${key})` });
      return;
    }
    seen.set(key, index);
    entries.push({ index, item, key });
  });
  return { entries, skipped };
}

/**
 * The slug a document carries for its key: readable, URL-safe, and unique
 * per drive and key. The hash is what keeps two keys that sanitise to the
 * same text apart ("gmail:ab" and "gmail-ab"), and what keeps the slug
 * stable however the readable part is trimmed.
 */
export function slugFor(driveId: string, key: string): string {
  const readable = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha1").update(`${driveId}\u0000${key}`).digest("hex").slice(0, 10);
  return `${readable || "doc"}-${hash}`;
}

/** The documents of a batch that already exist, by key, found by their slugs. */
export async function indexBySlug(
  reactor: UpsertReactor,
  documentType: string,
  driveId: string,
  keys: string[],
): Promise<Map<string, DocumentLike>> {
  const index = new Map<string, DocumentLike>();
  const keyOfSlug = new Map(keys.map((key) => [slugFor(driveId, key), key]));
  const slugs = [...keyOfSlug.keys()];
  for (let at = 0; at < slugs.length; at += PAGE) {
    const chunk = slugs.slice(at, at + PAGE);
    let cursor = "";
    for (;;) {
      const page = await reactor.find(
        { type: documentType, parentId: driveId, slugs: chunk },
        undefined,
        { cursor, limit: PAGE },
      );
      for (const document of page.results) {
        const key = document.header.slug
          ? keyOfSlug.get(document.header.slug)
          : undefined;
        if (key !== undefined && !index.has(key)) index.set(key, document);
      }
      if (!page.nextCursor || page.results.length === 0) break;
      cursor = page.nextCursor;
    }
  }
  return index;
}

/**
 * How the switchboard words a refusal of a run with no person behind it:
 * "authentication required" up to 6.2.3-dev.86 (the authenticated-caller
 * floor), "this run has no person behind it" from dev.87 under ADMIN_ONLY.
 * A run whose person is refused (not an admin) is not matched: that refusal
 * is the policy's answer, and the slug lookup must not route around it.
 */
const AUTHENTICATION_REQUIRED = /authentication required|has no person behind it/i;

/**
 * The key index refused the lookup because the run reached it anonymously:
 * a host-signed run (the integration reconciler publishes its workflows as
 * the host) on a host with no signed-in identity, under an authenticated
 * caller floor. That is every Vetra cloud host today. Not a missing index,
 * and not an answer: runUpsert falls back to the slug lookup for it.
 */
export class IndexUnauthenticatedError extends Error {
  override name = "IndexUnauthenticatedError";
}

/**
 * The documents of a batch that already exist, by key, asked of the key
 * index through the reactor: the host runs the query in process as this
 * run's user, so the index's own access rules decide and no URL or
 * credential is involved. A failure here is a failure: answering "nothing
 * exists" when the index could not be asked would turn every item into a
 * twin.
 */
export async function indexByRemote(options: {
  reactor: Pick<UpsertReactor, "query">;
  driveId: string;
  documentType: string;
  keys: string[];
}): Promise<Map<string, DocumentLike>> {
  const index = new Map<string, DocumentLike>();
  const keys = [...new Set(options.keys)];
  if (keys.length === 0) return index;
  let payload: {
    data?: { keyIndex?: { find?: { key: string; documentId: string }[] } } | null;
    errors?: { message: string }[];
  };
  try {
    payload = (await options.reactor.query({
      subgraph: "key-index",
      query:
        "query ($d: String!, $t: String!, $k: [String!]!) { keyIndex { find(driveId: $d, documentType: $t, keys: $k) { key documentId } } }",
      variables: { d: options.driveId, t: options.documentType, k: keys },
    })) as typeof payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (AUTHENTICATION_REQUIRED.test(message)) {
      throw new IndexUnauthenticatedError(
        `The key index refused this run as anonymous (${message}): the run has no user and the host has no signed-in identity.`,
      );
    }
    throw new Error(
      `The key index could not be asked (${message}); nothing was written. Is the key-index subgraph installed on the switchboard?`,
    );
  }
  if (payload.errors?.length) {
    const message = payload.errors.map((e) => e.message).join("; ");
    if (AUTHENTICATION_REQUIRED.test(message)) {
      throw new IndexUnauthenticatedError(
        `The key index refused this run as anonymous (${message}): the run has no user and the host has no signed-in identity.`,
      );
    }
    throw new Error(`The key index refused the lookup: ${message}`);
  }
  for (const hit of payload.data?.keyIndex?.find ?? []) {
    // First wins: two documents under one key is a problem the index cannot
    // fix, and updating one of them is the predictable choice.
    if (!index.has(hit.key)) {
      index.set(hit.key, {
        header: {
          id: hit.documentId,
          name: hit.key,
          documentType: options.documentType,
        },
        state: undefined,
      });
    }
  }
  return index;
}

/** The global state, whether the reactor wrapped it in its scope or not. */
export function globalStateOf(state: unknown): unknown {
  const outer = state as { global?: unknown } | null;
  return outer && typeof outer === "object" && "global" in outer
    ? outer.global
    : state;
}

/** Every document of the type in the drive, by the value at the key path. */
export async function indexByKey(
  reactor: UpsertReactor,
  documentType: string,
  driveId: string,
  keyPath: string,
): Promise<Map<string, DocumentLike>> {
  const index = new Map<string, DocumentLike>();
  let cursor = "";
  for (;;) {
    const page = await reactor.find(
      { type: documentType, parentId: driveId },
      undefined,
      { cursor, limit: PAGE },
    );
    for (const document of page.results) {
      const key = asKey(valueAt(globalStateOf(document.state), keyPath));
      // First wins: two documents under one key is a problem the index
      // cannot fix, and updating the older one is the predictable choice.
      if (key !== undefined && !index.has(key)) index.set(key, document);
    }
    if (!page.nextCursor || page.results.length === 0) break;
    cursor = page.nextCursor;
  }
  return index;
}

interface DriveNode {
  id: string;
  kind: string;
  name: string;
  parentFolder?: string | null;
}

function nodesOf(drive: DocumentLike): DriveNode[] {
  const state = globalStateOf(drive.state) as { nodes?: unknown } | null;
  const nodes = state && typeof state === "object" ? state.nodes : undefined;
  return Array.isArray(nodes) ? (nodes as DriveNode[]) : [];
}

/** Folders by name under a parent, created once per batch when missing. */
class Folders {
  private nodes: DriveNode[] | undefined;

  constructor(
    private readonly reactor: UpsertReactor,
    private readonly driveId: string,
  ) {}

  async resolve(
    name: string,
    parentFolder: string | undefined,
  ): Promise<string> {
    this.nodes ??= nodesOf(await this.reactor.get(this.driveId));
    const existing = this.nodes.find(
      (node) =>
        node.kind === "folder" &&
        node.name === name &&
        (node.parentFolder ?? undefined) === parentFolder,
    );
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    await this.reactor.execute(this.driveId, BRANCH, [
      toGlobalAction({
        type: "ADD_FOLDER",
        input: { id, name, parentFolder: parentFolder ?? null },
      }),
    ]);
    this.nodes.push({
      id,
      kind: "folder",
      name,
      parentFolder: parentFolder ?? null,
    });
    return id;
  }
}

function actionsFrom(value: unknown, label: string): ActionLike[] {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry, position) => {
    const candidate = entry as { type?: unknown; input?: unknown } | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.type !== "string" ||
      candidate.type.trim() === ""
    ) {
      throw new Error(
        `${label}[${position}] is not an action: expected { "type": …, "input": … }`,
      );
    }
    return { type: candidate.type, input: candidate.input };
  });
}

/**
 * A name the drive will accept: no control characters (a subject with a line
 * break in it is an ordinary email), whitespace collapsed, bounded, and never
 * empty. The key stands in for a name that sanitises to nothing.
 */
export function safeName(name: string, fallback: string): string {
  const cleaned = stripControl(name).replace(/\s+/g, " ").trim().slice(0, 200);
  return cleaned || fallback;
}

/** Control characters (C0, DEL, C1) become spaces; everything else stays. */
export function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 32 || (code >= 127 && code <= 159) ? " " : ch;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The key index, or the slugs when the index refuses the run as anonymous.
 * The slug lookup is not "nothing exists": every document this step creates
 * carries the slug of its key (see the create below), so it finds every
 * document an earlier run wrote. It is blind only to documents of the same
 * key made some other way, which is the narrower risk; any other failure of
 * the index still stops the batch before it writes.
 */
async function indexByRemoteOrSlug(
  reactor: UpsertReactor,
  options: UpsertOptions,
  keys: string[],
): Promise<Map<string, DocumentLike>> {
  try {
    return await indexByRemote({
      reactor,
      driveId: options.driveId,
      documentType: options.documentType,
      keys,
    });
  } catch (error) {
    if (!(error instanceof IndexUnauthenticatedError)) throw error;
    return indexBySlug(reactor, options.documentType, options.driveId, keys);
  }
}

export async function runUpsert(
  reactor: UpsertReactor,
  options: UpsertOptions,
): Promise<UpsertResult> {
  const items = asList(options.items);
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const plan = planUpsert(
    items,
    options.itemKeyPath,
    options.keyPrefix,
    limit,
  );
  const result: UpsertResult = {
    created: [],
    updated: [],
    skipped: [...plan.skipped],
    failed: [],
    counts: {
      items: items.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    },
  };
  if (plan.entries.length === 0) return finish(result);

  const keys = plan.entries.map((entry) => entry.key);
  const index =
    options.lookup === "scan"
      ? await indexByKey(
          reactor,
          options.documentType,
          options.driveId,
          options.documentKeyPath,
        )
      : options.lookup === "slug"
        ? await indexBySlug(
            reactor,
            options.documentType,
            options.driveId,
            keys,
          )
        : await indexByRemoteOrSlug(reactor, options, keys);
  const folders = new Folders(reactor, options.driveId);
  // Fetched lazily: a batch that only updates never needs the model.
  let module: ModuleLike | undefined;

  for (const entry of plan.entries) {
    const { index: position, item, key } = entry;
    try {
      const existing = index.get(key);
      if (existing) {
        const template = options.updateActions ?? options.createActions;
        const actions = actionsFrom(
          template?.(item, position),
          "updateActions",
        );
        if (actions.length > 0) {
          await reactor.execute(
            existing.header.id,
            BRANCH,
            actions.map(toGlobalAction),
          );
        }
        result.updated.push(written(entry, existing));
        continue;
      }

      module ??= await reactor.getDocumentModelModule(options.documentType);
      const documentType = module.documentModel.global.id;
      // Rendered before anything is written, so a bad template costs no
      // stray document.
      const actions = actionsFrom(
        options.createActions?.(item, position),
        "createActions",
      );
      const name = safeName(asText(options.name?.(item, position)), key);
      let folder = options.folderId;
      if (options.folderName) {
        const folderName = asText(options.folderName(item, position)).trim();
        if (folderName !== "") {
          folder = await folders.resolve(folderName, folder);
        }
      }

      const draft = module.utils.createDocument();
      draft.header.name = name;
      // The slug is what the next run finds this document by.
      draft.header.slug = slugFor(options.driveId, key);
      const created = await reactor.create(draft, options.driveId);
      await reactor.execute(options.driveId, BRANCH, [
        toGlobalAction({
          type: "ADD_FILE",
          input: {
            id: created.header.id,
            name: created.header.name || name,
            documentType,
            parentFolder: folder ?? null,
          },
        }),
      ]);
      if (actions.length > 0) {
        await reactor.execute(
          created.header.id,
          BRANCH,
          actions.map(toGlobalAction),
        );
      }
      // Visible to a later item in this batch, should its key repeat after
      // a prefix collision the planner could not see.
      index.set(key, created);
      result.created.push(written(entry, created));
    } catch (error) {
      result.failed.push({ index: position, key, error: errorText(error) });
      if (options.stopOnError) {
        throw new Error(
          `Item ${position} (${key}) failed: ${errorText(error)}. ` +
            `${result.created.length} created and ${result.updated.length} updated before it; the rest were not attempted.`,
        );
      }
    }
  }
  return finish(result);
}

function written(entry: PlannedItem, document: DocumentLike): Written {
  return {
    index: entry.index,
    key: entry.key,
    documentId: document.header.id,
    documentType: document.header.documentType,
    name: document.header.name,
  };
}

function finish(result: UpsertResult): UpsertResult {
  result.skipped.sort((a, b) => a.index - b.index);
  result.counts.created = result.created.length;
  result.counts.updated = result.updated.length;
  result.counts.skipped = result.skipped.length;
  result.counts.failed = result.failed.length;
  return result;
}
