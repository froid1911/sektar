// sektarMoveInFiles over a reactor client that holds the drive's nodes as the
// projection does: a MOVE_NODE moves one, and one it refuses changes nothing
// while the job still completes. The index answers through the real schema.
import type { PhAiToolDescriptor } from "@powerhousedao/shared/document-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStore, serve, unreachable } from "./test-index.js";
import { aiTools } from "./tools.js";

const DRIVE = "id-of-files";

interface Node {
  id: string;
  kind: "folder" | "file";
  name: string;
  parentFolder: string | null;
}

const folder = (id: string, name: string, parentFolder: string | null = null): Node => ({
  id,
  kind: "folder",
  name,
  parentFolder,
});

const file = (id: string, name: string, parentFolder: string | null = null): Node => ({
  id,
  kind: "file",
  name,
  parentFolder,
});

const NODES = [
  folder("q3", "2026-Q3"),
  folder("q4", "2026-Q4"),
  folder("ap", "accounts-payable", "q4"),
  file("invoice", "heroku_1.pdf", "q3"),
  file("taken", "heroku_1.pdf", "ap"),
  file("loose", "notes.txt"),
];

const row = ({ id, kind, name, parentFolder }: Node) => ({
  id,
  kind,
  name,
  parentId: parentFolder,
  tags: [],
  renditionCount: 0,
});

/** The Files index and a drive over `nodes`; what was sent is on `sent`. */
function world(nodes: Node[] = NODES.map((node) => ({ ...node }))) {
  const sent: { driveId: string; branch: string; actions: unknown[] }[] = [];
  const applies = { value: true };
  const calls = serve({
    filesIndex: {
      listing: ({ folderId }: { folderId: string | null }) => {
        const items = nodes.filter((node) => node.parentFolder === folderId);
        return { total: items.length, items: items.map(row) };
      },
      folders: () => ({
        folders: nodes
          .filter((node) => node.kind === "folder")
          .map(({ id, name, parentFolder }) => ({ id, name, parentId: parentFolder })),
      }),
    },
  });
  const execute = vi.fn(
    (
      driveId: string,
      branch: string,
      actions: { input: { srcFolder: string; targetParentFolder?: string } }[],
    ) => {
      sent.push({ driveId, branch, actions });
      if (applies.value) {
        for (const { input } of actions) {
          const node = nodes.find(({ id }) => id === input.srcFolder);
          if (!node) continue;
          const target = input.targetParentFolder ?? null;
          const taken = nodes.some(
            (other) => other.parentFolder === target && other.name === node.name,
          );
          node.parentFolder = target;
          if (taken) node.name = `${node.name} (2)`;
        }
      }
      return Promise.resolve({ readable: Promise.resolve() });
    },
  );
  installStore({
    reactorClient: {
      write: { execute },
      read: {
        drives: {
          getNode: (_drive: string, id: string) => {
            const node = nodes.find((candidate) => candidate.id === id);
            return node ? Promise.resolve({ ...node }) : Promise.reject(new Error("gone"));
          },
        },
      },
    },
  });
  return { nodes, sent, execute, calls, applies };
}

function tool(name: string): PhAiToolDescriptor {
  const found = aiTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found;
}

const move = (paths: string[], to: string) =>
  tool("sektarMoveInFiles").callback({ paths, to } as never) as Promise<
    Record<string, unknown>
  >;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 100 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sektarMoveInFiles", () => {
  it("asks for approval, as a write that destroys nothing", () => {
    expect(tool("sektarMoveInFiles").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("moves a file, with a name the index's word search would not find", async () => {
    const { nodes, sent } = world();
    const answer = await move(["2026-Q3/heroku_1.pdf"], "2026-Q4");

    expect(sent).toEqual([
      {
        driveId: DRIVE,
        branch: "main",
        actions: [
          expect.objectContaining({
            type: "MOVE_NODE",
            input: expect.objectContaining({
              srcFolder: "invoice",
              targetParentFolder: "q4",
            }) as unknown,
          }),
        ],
      },
    ]);
    expect(nodes.find(({ id }) => id === "invoice")?.parentFolder).toBe("q4");
    expect(answer).toEqual({
      moved: [{ from: "2026-Q3/heroku_1.pdf", to: "2026-Q4/heroku_1.pdf" }],
      alreadyThere: [],
      to: "2026-Q4",
    });
  });

  it("moves a folder and a file to the top level, in one write", async () => {
    const { nodes, sent } = world();
    const answer = await move(["2026-Q4/accounts-payable", "notes.txt"], "");
    expect(sent).toHaveLength(1);
    expect(nodes.find(({ id }) => id === "ap")?.parentFolder).toBeNull();
    expect(answer).toMatchObject({
      moved: [{ from: "2026-Q4/accounts-payable", to: "accounts-payable" }],
      alreadyThere: ["notes.txt"],
    });
  });

  it("moves a folder below another one", async () => {
    const { nodes } = world();
    await move(["2026-Q3"], "2026-Q4/accounts-payable");
    expect(nodes.find(({ id }) => id === "q3")?.parentFolder).toBe("ap");
  });

  it("says where a file ended up when the name was taken", async () => {
    world();
    const answer = await move(
      ["2026-Q3/heroku_1.pdf"],
      "/2026-Q4/accounts-payable/",
    );
    expect(answer.moved).toEqual([
      {
        from: "2026-Q3/heroku_1.pdf",
        to: "2026-Q4/accounts-payable/heroku_1.pdf (2)",
      },
    ]);
  });

  it("writes nothing for what is already there", async () => {
    const { sent } = world();
    const answer = await move(["2026-Q3/heroku_1.pdf"], "2026-Q3");
    expect(sent).toEqual([]);
    expect(answer).toMatchObject({
      moved: [],
      alreadyThere: ["2026-Q3/heroku_1.pdf"],
    });
  });

  it.each([
    ["a file that is not there", ["2026-Q3/nope.pdf"], "2026-Q4", /nothing at 2026-Q3\/nope.pdf/],
    ["a folder that is not there", ["nope/a.pdf"], "2026-Q4", /nothing at nope\/a.pdf/],
    ["a target that is not a folder", ["notes.txt"], "2026-Q4/nope", /no folder 2026-Q4\/nope/],
    ["a folder into itself", ["2026-Q4"], "2026-Q4", /cannot go into itself/],
    ["a folder below itself", ["2026-Q4"], "2026-Q4/accounts-payable", /cannot go into 2026-Q4\/accounts-payable/],
  ])("refuses %s, and moves nothing else", async (_case, paths, to, why) => {
    const { sent } = world();
    await expect(move([...paths, "notes.txt"], to)).rejects.toThrow(why);
    expect(sent).toEqual([]);
  });

  it("reports a move the drive did not apply, though the job completed", async () => {
    const { applies } = world();
    applies.value = false;
    await expect(move(["2026-Q3/heroku_1.pdf"], "2026-Q4")).rejects.toThrow(
      /2026-Q3\/heroku_1.pdf did not move/,
    );
  });

  it("waits for the nodes to catch up with a finished job", async () => {
    const { applies, nodes, execute } = world();
    applies.value = false;
    const moving = move(["2026-Q3/heroku_1.pdf"], "2026-Q4");
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    nodes.find(({ id }) => id === "invoice")!.parentFolder = "q4";
    await expect(moving).resolves.toMatchObject({
      moved: [{ to: "2026-Q4/heroku_1.pdf" }],
    });
  });

  it("says so when the job fails, and sends the model back to look", async () => {
    const { execute } = world();
    execute.mockRejectedValueOnce(new Error("the drive is busy"));
    await expect(move(["notes.txt"], "2026-Q4")).rejects.toThrow(
      /did not finish: the drive is busy.*sektarFindFiles/,
    );
  });

  it("fails on an unreadable index, before it writes", async () => {
    const { sent } = world();
    unreachable();
    await expect(move(["notes.txt"], "2026-Q4")).rejects.toThrow(
      /could not be read/,
    );
    expect(sent).toEqual([]);
  });
});
