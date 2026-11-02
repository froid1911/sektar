import type * as ReactorChat from "@powerhousedao/reactor-browser/ai";
import {
  getHostAiTools,
  ReactorChatAgent,
  type AiConnection,
  type AiSettings,
  type ChatImage,
} from "@powerhousedao/reactor-browser/ai";
import type { ReactNode } from "react";
import type * as ReactDom from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSlots } from "../hosts/connect/routes/-shared/assistant-chat.js";
import { HeldChat } from "../hosts/connect/routes/-shared/assistant.js";
import { forgetHandles, handleFor } from "./handles.js";
import { assistantInstructions } from "./instructions.js";
import { BASE, installStore, serve, unreachable } from "./test-index.js";
import { aiTools } from "./tools.js";

const chat = vi.hoisted(() => ({
  useReactorChat: vi.fn((..._args: unknown[]) => ({
    messages: [],
    clear: () => {},
  })),
}));

vi.mock("@powerhousedao/reactor-browser/ai", async (original) => ({
  ...(await original<typeof ReactorChat>()),
  ChatPanel: () => null,
  useReactorChat: chat.useReactorChat,
}));

vi.mock("react-dom", async (original) => ({
  ...(await original<typeof ReactDom>()),
  createPortal: (node: ReactNode) => node,
}));

const slots = {} as ChatSlots;

const connection: AiConnection = { baseUrl: `${BASE}/ai/v1`, model: "a-model" };

/** The instruction the conversation passed to the chat. */
function renderedInstruction(): string {
  renderToStaticMarkup(
    <HeldChat connection={connection} slots={slots} release={() => {}} />,
  );
  const [, options] = chat.useReactorChat.mock.calls.at(-1) as [
    unknown,
    { instructions: string },
  ];
  return options.instructions;
}

const sseEvent = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "reply",
    created: 1,
    model: "a-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const sse = (...events: string[]) =>
  new Response(`${events.join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

const toolCall = (name: string, args: object) =>
  sse(
    sseEvent({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call-1",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    sseEvent({}, "tool_calls"),
  );

const text = (reply: string) =>
  sse(sseEvent({ role: "assistant", content: reply }), sseEvent({}, "stop"));

interface ModelRequest {
  messages: { role: string; content: unknown }[];
  tools: {
    function: {
      name: string;
      description: string;
      parameters: { properties: Record<string, { description?: string }> };
    };
  }[];
}

/**
 * One turn against a scripted model; what it was sent, in order. The user
 * approves any write it asks for.
 */
async function turn(
  replies: Response[],
  instructions: string,
  images: ChatImage[] = [],
) {
  const requests: ModelRequest[] = [];
  const events: { type: string; state?: string; error?: string }[] = [];
  const agent: ReactorChatAgent = new ReactorChatAgent({
    settings: {} as AiSettings,
    connection: {
      ...connection,
      fetch: ((_url: string, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as ModelRequest);
        return Promise.resolve(replies.shift() ?? text("Done."));
      }) as typeof fetch,
    },
    instructions,
    tools: aiTools,
    context: {},
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval-request") {
        queueMicrotask(() => agent.approve(event.toolCallId));
      }
    },
  });
  await agent.send(
    "Is my October invoice for Powerhouse already drafted?",
    images,
  );
  return { requests, events };
}

const NOW = new Date(2026, 9, 30, 14, 0);

beforeEach(() => {
  installStore();
  chat.useReactorChat.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assistantInstructions", () => {
  const instructions = assistantInstructions(NOW);

  it("sends the model to the read models first", () => {
    expect(instructions).toContain(
      "ALWAYS use the Sektar read-model tools first",
    );
    expect(instructions).toContain(
      "built-in document and drive tools only to write something, or to get details the read models don't hold",
    );
  });

  it("says the built-in listing says nothing about business data", () => {
    expect(instructions).toContain(
      "getDrives, getDrive and getDocuments do not list Sektar's business data",
    );
    expect(instructions).toContain(
      "whether an invoice, email, event or contact exists",
    );
  });

  it("forbids claiming something does not exist on no evidence", () => {
    expect(instructions).toContain(
      "Never say something doesn't exist unless the relevant read-model tool was called and found nothing",
    );
    expect(instructions).toContain(
      "If a tool fails or is unavailable, say the answer is unknown",
    );
  });

  it("gives today's date", () => {
    expect(instructions).toContain("30 October 2026 (2026-10-30)");
    expect(assistantInstructions(new Date(2027, 0, 2))).toContain("2027-01-02");
  });

  it("asks for short answers", () => {
    expect(instructions).toContain("in a few plain sentences");
  });

  it("no longer sends the model through the drives", () => {
    expect(instructions).not.toContain("look through the drives");
  });

  it("tells the model how to read a stored file", () => {
    expect(instructions).toContain("sektarListAttachments");
    expect(instructions).toContain("sektarReadAttachment");
    expect(instructions).toContain("never guess from its name");
  });

  it("says a file reference is never typed or guessed", () => {
    expect(instructions).toContain("short handle such as file-3");
    expect(instructions).toContain("A file reference is never typed or guessed");
    expect(instructions).toContain("list the document's files again");
    expect(instructions).not.toMatch(/attachment:\/\/|[0-9a-f]{64}/i);
  });

  it("sends an invoice's files through the tool, with the role and the line", () => {
    expect(instructions).toContain("call sektarAttachToInvoice with its handle");
    expect(instructions).toContain("add lineId");
    expect(instructions).toContain(
      "sektarListAttachments on the invoice gives the lines' ids",
    );
    expect(instructions).not.toContain("addActions on the invoice");
    expect(instructions).not.toContain("$.global.lines");
  });

  it("sends Files through the tool", () => {
    expect(instructions).toContain("call sektarAddToFiles with its handle");
    expect(instructions).toContain("call sektarMoveInFiles with its path");
    expect(instructions).not.toContain("take driveId from sektarFindFiles");
    expect(instructions).not.toContain("documentType sektar/file");
  });

  it("steers attachments away from the built-in writes", () => {
    expect(instructions).toContain(
      "Never use addActions or createDocument for attachments",
    );
  });

  it("takes a chat image straight to the document", () => {
    expect(instructions).toContain("pass that straight to sektarAttachToInvoice");
    expect(instructions).toContain("in one approved step");
    expect(instructions).toContain("puts the image on no document");
  });

  it("tells the model to report a write that failed", () => {
    expect(instructions).toContain(
      "say it failed, and why, rather than that it is done",
    );
  });

  it("names only tools that exist", () => {
    const named = instructions.match(/\bsektar[A-Z]\w+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    const known = aiTools.map((tool) => tool.name);
    expect(known).toEqual(expect.arrayContaining([...new Set(named)]));
  });
});

describe("the assistant panel", () => {
  it("passes the instruction and the host's tools to the chat", () => {
    const instructions = renderedInstruction();
    expect(instructions).toBe(assistantInstructions(new Date()));
    const [provider, options] = chat.useReactorChat.mock.calls[0] as [
      unknown,
      { connection: AiConnection },
    ];
    expect(provider).toBe(getHostAiTools);
    expect(options.connection).toBe(connection);
  });
});

describe("the agent", () => {
  it("gets the instruction in its system prompt, and the tools as functions", async () => {
    const instructions = renderedInstruction();
    const { requests } = await turn([text("Yes.")], instructions);
    const [system] = requests[0].messages;
    expect(system.role).toBe("system");
    expect(system.content).toContain(instructions);
    expect(requests[0].tools.map((t) => t.function.name).sort()).toEqual(
      aiTools.map((t) => t.name).sort(),
    );
    const invoices = requests[0].tools.find(
      (t) => t.function.name === "sektarFindInvoices",
    );
    expect(invoices?.function.description).toContain("drafts included");
    expect(invoices?.function.parameters.properties.view.description).toContain(
      "SETTLED",
    );
  });

  it("runs a read tool without asking, and hands the model its result", async () => {
    const calls = serve({
      financeIndex: {
        invoices: {
          total: 0,
          hasMore: false,
          items: [],
        },
      },
    });
    const { requests, events } = await turn(
      [
        toolCall("sektarFindInvoices", { query: "Powerhouse" }),
        text("There is no draft yet."),
      ],
      assistantInstructions(NOW),
    );
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === "approval-request")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-result", state: "done" }),
    );
    const answer = requests[1].messages.at(-1);
    expect(answer?.role).toBe("tool");
    expect(JSON.stringify(answer)).toContain("was read and holds no invoices");
  });

  it("hands the model a failed read as an error, not as an empty result", async () => {
    unreachable();
    const { requests, events } = await turn(
      [
        toolCall("sektarFindInvoices", { query: "Powerhouse" }),
        text("I could not tell."),
      ],
      assistantInstructions(NOW),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-result", state: "error" }),
    );
    const answer = JSON.stringify(requests[1].messages.at(-1));
    expect(answer).toContain("could not be read");
    expect(answer).toContain("unknown");
    expect(answer).not.toContain('"found"');
  });

  describe("with a stored file", () => {
    const REF = `attachment://v${1}:${"a".repeat(64)}` as const;
    const BASE64 = "dGhlIGZpbGUncyBieXRlcw==";
    const bytes = () => Uint8Array.from(atob(BASE64), (c) => c.charCodeAt(0));

    class Reader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        this.result = `data:${blob.type};base64,${BASE64}`;
        queueMicrotask(() => this.onload?.());
      }
    }

    const storage = () => ({
      get: () =>
        Promise.resolve({
          header: {
            mimeType: "image/png",
            fileName: "receipt.png",
            sizeBytes: bytes().length,
          },
          body: new Blob([bytes()]).stream(),
        }),
      reserve: () =>
        Promise.resolve({
          send: () => Promise.resolve({ ref: REF, header: {} }),
        }),
    });

    beforeEach(() => {
      forgetHandles();
      vi.stubGlobal("FileReader", Reader);
      installStore({ attachmentService: storage() });
    });

    it("reaches the model on the wire as an image, not as text in the tool's answer", async () => {
      const handle = handleFor({
        documentId: "mail-1",
        ref: REF,
        fileName: "receipt.png",
        mimeType: "image/png",
        sizeBytes: bytes().length,
      });
      const { requests } = await turn(
        [
          toolCall("sektarReadAttachment", { handle }),
          text("It is a receipt."),
        ],
        assistantInstructions(NOW),
      );
      const sent = requests[1].messages;
      const tool = sent.find((message) => message.role === "tool");
      expect(JSON.stringify(tool)).toContain("receipt.png");
      expect(JSON.stringify(tool)).not.toContain(BASE64);

      const shown = sent.at(-1);
      expect(shown?.role).toBe("user");
      expect(shown?.content).toMatchObject([
        { type: "text" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${BASE64}` },
        },
      ]);
      expect(sent.indexOf(shown as never)).toBe(
        sent.indexOf(tool as never) + 1,
      );
    });

    it("asks before storing a chat image, then hands the model a handle", async () => {
      const { requests, events } = await turn(
        [
          toolCall("sektarSaveChatImage", { handle: "image-1" }),
          text("Saved."),
        ],
        assistantInstructions(NOW),
        [
          {
            dataUrl: `data:image/png;base64,${BASE64}`,
            mediaType: "image/png",
            name: "receipt.png",
          },
        ],
      );
      expect(JSON.stringify(requests[0].messages.at(-1))).toContain(
        "[Attached image image-1: receipt.png]",
      );
      expect(events.some((e) => e.type === "approval-request")).toBe(true);
      const answer = JSON.stringify(
        requests[1].messages.find((message) => message.role === "tool"),
      );
      expect(answer).toContain("file-1");
      expect(answer).not.toContain("attachment://");
    });

    it("takes a chat image into Files on one approval, and the model sees no reference", async () => {
      const applied: object[] = [];
      const answered = (value: object) => ({
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      });
      installStore({
        attachmentService: storage(),
        aiTools: () =>
          Promise.resolve([
            {
              name: "createDocument",
              callback: () =>
                Promise.resolve(answered({ documentId: "new-file" })),
            },
            {
              name: "addActions",
              callback: (args: object) => {
                applied.push(args);
                return Promise.resolve(
                  answered({ success: true, results: [{ index: 0 }] }),
                );
              },
            },
          ]),
      });
      const { requests, events } = await turn(
        [toolCall("sektarAddToFiles", { handle: "image-1" }), text("Added.")],
        assistantInstructions(NOW),
        [
          {
            dataUrl: `data:image/png;base64,${BASE64}`,
            mediaType: "image/png",
            name: "receipt.png",
          },
        ],
      );
      expect(events.filter((e) => e.type === "approval-request")).toHaveLength(
        1,
      );
      expect(applied).toMatchObject([
        {
          documentId: "new-file",
          actions: [
            {
              type: "SET_ATTACHMENT_SOURCE",
              input: { ref: REF, fileName: "receipt.png" },
            },
          ],
        },
      ]);
      const answer = JSON.stringify(
        requests[1].messages.find((message) => message.role === "tool"),
      );
      expect(answer).toContain('\\"added\\":true');
      expect(answer).not.toContain("attachment://");
    });

    it("hands the model a failed write as an error, not as done", async () => {
      installStore({
        reactorClient: {
          get: () =>
            Promise.resolve({
              header: { id: "invoice-1", documentType: "sektar/invoice" },
            }),
        },
        attachmentService: storage(),
        aiTools: () =>
          Promise.resolve([
            {
              name: "addActions",
              callback: () =>
                Promise.resolve({
                  structuredContent: {
                    success: false,
                    results: [
                      {
                        error: {
                          kind: "reducer-error",
                          message: "A void invoice takes no attachments",
                        },
                      },
                    ],
                  },
                }),
            },
          ]),
      });
      const handle = handleFor({
        documentId: "mail-1",
        ref: REF,
        fileName: "receipt.png",
        mimeType: "image/png",
        sizeBytes: 9,
      });
      const { requests, events } = await turn(
        [
          toolCall("sektarAttachToInvoice", {
            handle,
            invoiceId: "invoice-1",
            role: "RECEIPT",
          }),
          text("It failed."),
        ],
        assistantInstructions(NOW),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool-result", state: "error" }),
      );
      expect(JSON.stringify(requests[1].messages.at(-1))).toContain(
        "A void invoice takes no attachments",
      );
    });
  });
});
