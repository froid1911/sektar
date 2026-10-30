/**
 * What a batch write does, item by item.
 *
 * The cases that matter are the ones a count would hide: an item with no key,
 * two items with the same key, a rerun over documents that already exist,
 * and a failure in the middle of a batch. The reactor is a fake that records
 * every call, so the tests say exactly what was written and in what order.
 *
 * `.spec.ts` so codegen never claims the filename.
 */
import { describe, expect, it } from "vitest";
import { compileTemplate } from "./template.js";
import {
  asKey,
  asList,
  indexByKey,
  indexByRemote,
  indexBySlug,
  planUpsert,
  runUpsert,
  slugFor,
  type DocumentLike,
  type UpsertReactor,
} from "./upsert.js";

const TYPE = "sektar/email";
const DRIVE = "drive-1";

interface Call {
  method: string;
  target: string;
  actions?: { type: string; input?: unknown }[];
  slugs?: string[];
  variables?: unknown;
}

interface Fake extends UpsertReactor {
  calls: Call[];
  documents: Map<string, DocumentLike>;
}

function fakeReactor(
  existing: { id: string; state: Record<string, unknown>; slug?: string }[] = [],
  options: {
    failOn?: string;
    pageSize?: number;
    nodes?: unknown[];
    /** How the key index answers; absent, it knows nothing. */
    query?: UpsertReactor["query"];
  } = {},
): Fake {
  const documents = new Map<string, DocumentLike>();
  for (const doc of existing) {
    documents.set(doc.id, {
      header: { id: doc.id, name: `doc ${doc.id}`, documentType: TYPE, slug: doc.slug },
      state: { global: doc.state },
    });
  }
  const drive: DocumentLike = {
    header: { id: DRIVE, name: "Mail", documentType: "powerhouse/document-drive" },
    state: { global: { nodes: options.nodes ?? [] } },
  };
  const calls: Call[] = [];
  let created = 0;
  const pageSize = options.pageSize ?? 100;
  return {
    calls,
    documents,
    get(id) {
      calls.push({ method: "get", target: id });
      const found = id === DRIVE ? drive : documents.get(id);
      if (!found) return Promise.reject(new Error(`no document ${id}`));
      return Promise.resolve(found);
    },
    find(search, _view, paging) {
      calls.push({ method: "find", target: `${search.type ?? ""}@${search.parentId ?? ""}`, slugs: search.slugs });
      const all = [...documents.values()].filter(
        (doc) =>
          doc.header.documentType === search.type &&
          (!search.slugs || (doc.header.slug !== undefined && search.slugs.includes(doc.header.slug))),
      );
      const start = paging.cursor === "" ? 0 : Number(paging.cursor);
      const results = all.slice(start, start + Math.min(paging.limit, pageSize));
      const end = start + results.length;
      return Promise.resolve({
        results,
        ...(end < all.length ? { nextCursor: String(end) } : {}),
      });
    },
    create(document, parent) {
      calls.push({ method: "create", target: `${document.header.name}@${parent ?? ""}` });
      if (options.failOn && document.header.name === options.failOn) {
        return Promise.reject(new Error(`refused ${document.header.name}`));
      }
      created += 1;
      // The slug the draft carried is what the reactor stores and indexes.
      const stored: DocumentLike = {
        header: { ...document.header, id: `new-${created}` },
        state: { global: {} },
      };
      documents.set(stored.header.id, stored);
      return Promise.resolve(stored);
    },
    execute(id, _branch, actions) {
      calls.push({
        method: "execute",
        target: id,
        actions: actions.map((a) => ({ type: a.type, input: a.input })),
      });
      const found = id === DRIVE ? drive : documents.get(id);
      if (!found) return Promise.reject(new Error(`no document ${id}`));
      // Enough of the reducers to make a rerun observable: the key lands in
      // state, and a folder lands in the drive's nodes.
      for (const action of actions) {
        const input = action.input as Record<string, unknown> | undefined;
        if (action.type === "CAPTURE_MESSAGE" && input) {
          (found.state as { global: Record<string, unknown> }).global.externalId =
            input.externalId;
        }
        if (action.type === "ADD_FOLDER" && input) {
          (drive.state as { global: { nodes: unknown[] } }).global.nodes.push({
            kind: "folder",
            id: input.id,
            name: input.name,
            parentFolder: input.parentFolder,
          });
        }
      }
      return Promise.resolve(found);
    },
    getDocumentModelModule(documentType) {
      calls.push({ method: "module", target: documentType });
      return Promise.resolve({
        documentModel: { global: { id: documentType } },
        utils: {
          createDocument: () => ({
            header: { id: "", name: "", documentType },
            state: { global: {} },
          }),
        },
      });
    },
    query(request) {
      calls.push({ method: "query", target: request.subgraph, variables: request.variables });
      return options.query
        ? options.query(request)
        : Promise.resolve({ data: { keyIndex: { find: [] } } });
    },
  };
}

const message = (id: string, subject = `Mail ${id}`) => ({
  key: `gmail:${id}`,
  name: subject,
  actions: [
    { type: "CAPTURE_MESSAGE", input: { externalId: `gmail:${id}`, subject } },
    { type: "ADD_ATTACHMENT", input: { ref: `attachment://v1:${id}` } },
  ],
  updateActions: [
    { type: "CAPTURE_MESSAGE", input: { externalId: `gmail:${id}`, subject } },
  ],
});

/** A key index that knows these keys, as the host would answer the query. */
function fakeIndex(known: Record<string, string>, fail?: string) {
  const calls: { subgraph: string; variables: unknown }[] = [];
  const query: UpsertReactor["query"] = (request) => {
    calls.push({ subgraph: request.subgraph, variables: request.variables });
    if (fail) return Promise.resolve({ errors: [{ message: fail }] });
    const k = (request.variables as { k: string[] }).k;
    const find = k.filter((key) => key in known).map((key) => ({ key, documentId: known[key] }));
    return Promise.resolve({ data: { keyIndex: { find } } });
  };
  return { query, calls };
}

const baseOptions = {
  documentType: TYPE,
  driveId: DRIVE,
  lookup: "slug" as const,
  itemKeyPath: "key",
  documentKeyPath: "externalId",
  name: compileTemplate("$item.name", "name"),
  createActions: compileTemplate("$item.actions", "create"),
  updateActions: compileTemplate("$item.updateActions", "update"),
};

describe("planning", () => {
  it("keys every item and reports the ones it cannot", () => {
    const plan = planUpsert(
      [{ id: "a" }, { nope: 1 }, { id: 7 }, { id: "a" }, { id: "  " }],
      "id",
      "gmail:",
      10,
    );
    expect(plan.entries.map((e) => [e.index, e.key])).toEqual([
      [0, "gmail:a"],
      [2, "gmail:7"],
    ]);
    expect(plan.skipped).toEqual([
      { index: 1, reason: 'no key at "id"' },
      { index: 3, reason: "duplicate of item 0 (gmail:a)" },
      { index: 4, reason: 'no key at "id"' },
    ]);
  });

  it("stops at the limit and says so", () => {
    const plan = planUpsert([{ id: 1 }, { id: 2 }, { id: 3 }], "id", undefined, 2);
    expect(plan.entries).toHaveLength(2);
    expect(plan.skipped).toEqual([{ index: 2, reason: "beyond the limit of 2" }]);
  });

  it("reads a list however the prop delivered it", () => {
    expect(asList(undefined)).toEqual([]);
    expect(asList({ id: 1 })).toEqual([{ id: 1 }]);
    expect(asList('[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(asList("not json")).toEqual(["not json"]);
    expect(asKey(true)).toBeUndefined();
    expect(asKey(12)).toBe("12");
  });
});

describe("the lookup", () => {
  it("makes a slug that is readable, stable and unique per drive and key", () => {
    const slug = slugFor(DRIVE, "gmail:1a0f2fea08d25027");
    expect(slug).toMatch(/^gmail-1a0f2fea08d25027-[0-9a-f]{10}$/);
    expect(slugFor(DRIVE, "gmail:1a0f2fea08d25027")).toBe(slug);
    // Two keys that sanitise alike stay apart, as do two drives.
    expect(slugFor(DRIVE, "gmail-1a0f2fea08d25027")).not.toBe(slug);
    expect(slugFor("other", "gmail:1a0f2fea08d25027")).not.toBe(slug);
    // A long key keeps a bounded readable part and the hash.
    expect(slugFor(DRIVE, "x".repeat(400)).length).toBeLessThan(80);
  });

  it("finds a batch by its slugs, one indexed read, never the whole drive", async () => {
    const reactor = fakeReactor([
      { id: "d1", state: { externalId: "gmail:1" }, slug: slugFor(DRIVE, "gmail:1") },
      { id: "d2", state: { externalId: "gmail:2" }, slug: slugFor(DRIVE, "gmail:2") },
      { id: "d3", state: { externalId: "gmail:3" }, slug: slugFor(DRIVE, "gmail:3") },
    ]);
    const index = await indexBySlug(reactor, TYPE, DRIVE, ["gmail:1", "gmail:3", "gmail:9"]);
    expect([...index.keys()]).toEqual(["gmail:1", "gmail:3"]);
    const finds = reactor.calls.filter((c) => c.method === "find");
    expect(finds).toHaveLength(1);
    expect(finds[0].slugs).toEqual(["gmail:1", "gmail:3", "gmail:9"].map((k) => slugFor(DRIVE, k)));
  });

  it("ignores a document created before slugs unless asked to scan", async () => {
    const reactor = fakeReactor([{ id: "old", state: { externalId: "gmail:1" } }]);
    expect((await indexBySlug(reactor, TYPE, DRIVE, ["gmail:1"])).size).toBe(0);
    expect((await indexByKey(reactor, TYPE, DRIVE, "externalId")).size).toBe(1);
  });

  it("asks the key index for a batch, one query through the reactor, and trusts its answer", async () => {
    const { query, calls } = fakeIndex({ "gmail:1": "d1", "gmail:3": "d3" });
    const index = await indexByRemote({
      reactor: { query },
      driveId: DRIVE,
      documentType: TYPE,
      keys: ["gmail:1", "gmail:2", "gmail:3", "gmail:1"],
    });
    expect([...index.keys()]).toEqual(["gmail:1", "gmail:3"]);
    expect(index.get("gmail:3")?.header.id).toBe("d3");
    expect(calls).toHaveLength(1);
    expect(calls[0].subgraph).toBe("key-index");
    expect(calls[0].variables).toEqual({ d: DRIVE, t: TYPE, k: ["gmail:1", "gmail:2", "gmail:3"] });
  });

  it("fails loudly when the key index cannot answer, rather than creating twins", async () => {
    const { query } = fakeIndex({}, "no such drive");
    await expect(
      indexByRemote({ reactor: { query }, driveId: DRIVE, documentType: TYPE, keys: ["gmail:1"] }),
    ).rejects.toThrow(/key index refused the lookup: no such drive/);
    const down: UpsertReactor["query"] = () => Promise.reject(new Error("host serves no indexes"));
    await expect(
      indexByRemote({ reactor: { query: down }, driveId: DRIVE, documentType: TYPE, keys: ["gmail:1"] }),
    ).rejects.toThrow(/could not be asked \(host serves no indexes\); nothing was written/);
  });

  it("names a refusal as one, without guessing at a missing subgraph", async () => {
    const refused: UpsertReactor["query"] = () =>
      Promise.reject(new Error("Forbidden: authentication required"));
    const failure = await indexByRemote({
      reactor: { query: refused },
      driveId: DRIVE,
      documentType: TYPE,
      keys: ["gmail:1"],
    }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toMatch(
      /key index refused this run \(Forbidden: authentication required\); nothing was written/,
    );
    expect((failure as Error).message).not.toMatch(/installed/);
  });

  it("treats a refused read as a failure, so a granter who left creates no twins", async () => {
    const refused: UpsertReactor["query"] = () =>
      Promise.resolve({
        data: null,
        errors: [
          { message: "Forbidden: 0xgone is not an admin of this host, so it reads no index" },
        ],
      });
    await expect(
      indexByRemote({
        reactor: { query: refused },
        driveId: DRIVE,
        documentType: TYPE,
        keys: ["gmail:1"],
      }),
    ).rejects.toThrow(/refused the lookup: Forbidden/);
  });

  it("finds an existing document for a run acting as a person", async () => {
    const { query } = fakeIndex({ "gmail:1": "d1" });
    const index = await indexByRemote({
      reactor: { query },
      driveId: DRIVE,
      documentType: TYPE,
      keys: ["gmail:1"],
    });
    expect(index.get("gmail:1")?.header.id).toBe("d1");
  });

  it("pages through every document of the type and keys them by state", async () => {
    const reactor = fakeReactor(
      [
        { id: "d1", state: { externalId: "gmail:1" } },
        { id: "d2", state: { externalId: "gmail:2" } },
        { id: "d3", state: {} },
      ],
      { pageSize: 2 },
    );
    const index = await indexByKey(reactor, TYPE, DRIVE, "externalId");
    expect([...index.keys()]).toEqual(["gmail:1", "gmail:2"]);
    expect(reactor.calls.filter((c) => c.method === "find")).toHaveLength(2);
  });
});

describe("writing a batch", () => {
  it("creates what is new, files it, and sends the create actions", async () => {
    const reactor = fakeReactor();
    const result = await runUpsert(reactor, {
      ...baseOptions,
      items: [message("1"), message("2")],
      folderId: "folder-x",
    });
    expect(result.counts).toEqual({ items: 2, created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(result.created.map((w) => [w.key, w.documentId, w.name])).toEqual([
      ["gmail:1", "new-1", "Mail 1"],
      ["gmail:2", "new-2", "Mail 2"],
    ]);
    // One lookup, then per item: create, ADD_FILE on the drive, actions on the document.
    const [find, ...rest] = reactor.calls.filter((c) => c.method !== "module");
    expect(find.method).toBe("find");
    expect(rest.slice(0, 3).map((c) => [c.method, c.target])).toEqual([
      ["create", `Mail 1@${DRIVE}`],
      ["execute", DRIVE],
      ["execute", "new-1"],
    ]);
    expect(rest[1].actions).toEqual([
      {
        type: "ADD_FILE",
        input: { id: "new-1", name: "Mail 1", documentType: TYPE, parentFolder: "folder-x" },
      },
    ]);
    expect(rest[2].actions?.map((a) => a.type)).toEqual(["CAPTURE_MESSAGE", "ADD_ATTACHMENT"]);
  });

  it("updates what exists with the update actions, never creating a twin", async () => {
    const reactor = fakeReactor([
      { id: "d1", state: { externalId: "gmail:1" }, slug: slugFor(DRIVE, "gmail:1") },
    ]);
    const result = await runUpsert(reactor, {
      ...baseOptions,
      items: [message("1", "Renamed"), message("2")],
    });
    expect(result.counts).toEqual({ items: 2, created: 1, updated: 1, skipped: 0, failed: 0 });
    expect(result.updated[0]).toMatchObject({ key: "gmail:1", documentId: "d1", index: 0 });
    const update = reactor.calls.find((c) => c.method === "execute" && c.target === "d1");
    // The attachment is not re-added: that is what updateActions is for.
    expect(update?.actions?.map((a) => a.type)).toEqual(["CAPTURE_MESSAGE"]);
    expect(reactor.calls.filter((c) => c.method === "create")).toHaveLength(1);
  });

  it("converges on a rerun, finding its own documents by slug", async () => {
    const reactor = fakeReactor();
    const items = [message("1"), message("2")];
    await runUpsert(reactor, { ...baseOptions, items });
    const created = [...reactor.documents.values()].map((d) => d.header.slug);
    expect(created).toEqual([slugFor(DRIVE, "gmail:1"), slugFor(DRIVE, "gmail:2")]);
    const again = await runUpsert(reactor, { ...baseOptions, items });
    expect(again.counts).toMatchObject({ created: 0, updated: 2 });
    expect(reactor.documents.size).toBe(2);
  });

  it("updates a document the key index knows, whatever created it", async () => {
    // A document from before slugs: no slug, but the index saw its capture.
    const { query } = fakeIndex({ "gmail:1": "old" });
    const reactor = fakeReactor([{ id: "old", state: { externalId: "gmail:1" } }], { query });
    const result = await runUpsert(reactor, {
      ...baseOptions,
      lookup: "index",
      items: [message("1"), message("2")],
    });
    expect(result.counts).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect(result.updated[0]).toMatchObject({ key: "gmail:1", documentId: "old" });
    // No drive scan happened: the only find is none at all.
    expect(reactor.calls.filter((c) => c.method === "find")).toHaveLength(0);
    expect(reactor.calls.filter((c) => c.method === "query")).toHaveLength(1);
  });

  it("writes nothing when the key index cannot be asked", async () => {
    const reactor = fakeReactor([], {
      query: () => Promise.reject(new Error("host serves no indexes")),
    });
    await expect(
      runUpsert(reactor, { ...baseOptions, lookup: "index", items: [message("1")] }),
    ).rejects.toThrow(/could not be asked/);
    expect(reactor.calls.filter((c) => c.method === "create")).toHaveLength(0);
  });

  it("can still scan for documents created before slugs", async () => {
    const reactor = fakeReactor([{ id: "old", state: { externalId: "gmail:1" } }]);
    const result = await runUpsert(reactor, { ...baseOptions, items: [message("1")], lookup: "scan" });
    expect(result.counts).toMatchObject({ created: 0, updated: 1 });
  });

  it("files into a folder by name, creating it once per batch", async () => {
    const reactor = fakeReactor([], {
      nodes: [{ kind: "folder", id: "f-old", name: "Old", parentFolder: null }],
    });
    const items = [
      { ...message("1"), box: "Jane" },
      { ...message("2"), box: "Jane" },
      { ...message("3"), box: "Old" },
    ];
    const result = await runUpsert(reactor, {
      ...baseOptions,
      items,
      folderName: compileTemplate("$item.box", "folder"),
    });
    expect(result.counts.created).toBe(3);
    const folders = reactor.calls.filter(
      (c) => c.method === "execute" && c.actions?.[0]?.type === "ADD_FOLDER",
    );
    expect(folders).toHaveLength(1);
    const files = reactor.calls
      .flatMap((c) => (c.method === "execute" ? (c.actions ?? []) : []))
      .filter((a) => a.type === "ADD_FILE")
      .map((a) => (a.input as { parentFolder: string }).parentFolder);
    expect(files[0]).toBe(files[1]);
    expect(files[2]).toBe("f-old");
    // The drive was read once, not once per item.
    expect(reactor.calls.filter((c) => c.method === "get")).toHaveLength(1);
  });

  it("applies the prefix and falls back to the key for a name", async () => {
    const reactor = fakeReactor();
    const result = await runUpsert(reactor, {
      documentType: TYPE,
      driveId: DRIVE,
      lookup: "slug",
      itemKeyPath: "id",
      keyPrefix: "gmail:",
      documentKeyPath: "externalId",
      items: [{ id: "abc" }],
    });
    expect(result.created[0]).toMatchObject({ key: "gmail:abc", name: "gmail:abc" });
    // No actions configured: nothing beyond the create and the filing.
    expect(reactor.calls.filter((c) => c.method === "execute")).toHaveLength(1);
  });

  it("reports a failing item and carries on", async () => {
    const reactor = fakeReactor([], { failOn: "Mail 2" });
    const result = await runUpsert(reactor, {
      ...baseOptions,
      items: [message("1"), message("2"), message("3")],
    });
    expect(result.counts).toMatchObject({ created: 2, failed: 1 });
    expect(result.failed).toEqual([{ index: 1, key: "gmail:2", error: "refused Mail 2" }]);
  });

  it("stops at the first failure when asked, naming it", async () => {
    const reactor = fakeReactor([], { failOn: "Mail 2" });
    await expect(
      runUpsert(reactor, {
        ...baseOptions,
        items: [message("1"), message("2"), message("3")],
        stopOnError: true,
      }),
    ).rejects.toThrow(/Item 1 \(gmail:2\) failed: refused Mail 2\. 1 created/);
    expect(reactor.calls.filter((c) => c.method === "create")).toHaveLength(2);
  });

  it("files a document under a name the drive accepts, whatever the subject held", async () => {
    const reactor = fakeReactor();
    const result = await runUpsert(reactor, {
      ...baseOptions,
      items: [message("1", "Still here?\r\nCrypto has a\u0000moment"), message("2", "\u001f\u001f")],
    });
    expect(result.created.map((w) => w.name)).toEqual(["Still here? Crypto has a moment", "gmail:2"]);
  });

  it("rejects a template that does not yield actions before writing anything", async () => {
    const reactor = fakeReactor();
    const result = await runUpsert(reactor, {
      ...baseOptions,
      items: [message("1")],
      createActions: compileTemplate("$item.name", "create"),
    });
    expect(result.failed[0].error).toMatch(/createActions\[0\] is not an action/);
    expect(reactor.calls.filter((c) => c.method === "create")).toHaveLength(0);
  });

  it("does nothing for an empty list", async () => {
    const reactor = fakeReactor();
    const result = await runUpsert(reactor, { ...baseOptions, items: [] });
    expect(result.counts.items).toBe(0);
    expect(reactor.calls).toEqual([]);
  });
});
