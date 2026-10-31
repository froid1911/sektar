// @vitest-environment happy-dom
import type * as ReactorBrowser from "@powerhousedao/reactor-browser";
import type * as ReactorChat from "@powerhousedao/reactor-browser/ai";
import type {
  AiConnection,
  UseAiGatewayResult,
} from "@powerhousedao/reactor-browser/ai";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUserName } from "../../../../editors/sektar/kit/user-name.js";
import { AssistantChatHolder } from "./assistant-chat.js";
import { AssistantPage } from "./assistant-page.js";
import { Conversation } from "./assistant.js";

// The real chat: only the model and the tools are scripted. ChatPanel is a
// stand-in with the same keep-your-own-draft state, because its icons come from
// a package outside this project, with a React of their own.
const app = vi.hoisted(() => ({
  address: undefined as string | undefined,
  listeners: new Set<() => void>(),
  useReactorChat: { spy: undefined as unknown },
  tools: [] as unknown[],
}));

vi.mock("@powerhousedao/reactor-browser", async (original) => ({
  ...(await original<typeof ReactorBrowser>()),
  useUser: () => {
    const address = useSyncExternalStore(
      (listener) => {
        app.listeners.add(listener);
        return () => app.listeners.delete(listener);
      },
      () => app.address,
    );
    return address ? { address } : undefined;
  },
}));

vi.mock("@powerhousedao/reactor-browser/ai", async (original) => {
  const real = await original<typeof ReactorChat>();
  const { useState } = await import("react");
  const spy = vi.fn(real.useReactorChat);
  app.useReactorChat.spy = spy;
  function ChatPanel({ chat, emptyState }: ReactorChat.ChatPanelProps) {
    const [draft, setDraft] = useState("");
    return (
      <div className="ph-chat">
        <div className="ph-chat-list">
          {chat.messages.length === 0 && emptyState}
          {chat.messages.flatMap((message) =>
            message.parts.map((part, index) =>
              part.type === "text" ? (
                <p key={`${message.id}-${index}`}>{part.text}</p>
              ) : part.type === "tool" && part.state === "awaiting-approval" ? (
                <button
                  key={part.toolCallId}
                  onClick={() => chat.approve(part.toolCallId)}
                >
                  Approve
                </button>
              ) : null,
            ),
          )}
        </div>
        <textarea
          className="ph-chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          aria-label="Send message"
          onClick={() => {
            setDraft("");
            chat.send(draft);
          }}
        />
      </div>
    );
  }
  return {
    ...real,
    ChatPanel,
    getHostAiTools: () => Promise.resolve(app.tools),
    useReactorChat: spy,
  };
});

const chatHook = () => app.useReactorChat.spy as ReturnType<typeof vi.fn>;

function signIn(address: string | undefined) {
  app.address = address;
  for (const listener of app.listeners) listener();
}

const sseEvent = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "reply",
    created: 1,
    model: "a-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const content = (text: string) =>
  sseEvent({ role: "assistant", content: text });

const toolCall = (name: string) =>
  sseEvent({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "call-1",
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  });

/** One model reply, written by the test while the chat reads it. */
function reply() {
  const encoder = new TextEncoder();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => (writer = controller),
  });
  return {
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    write: (event: string) => writer.enqueue(encoder.encode(event)),
    end: (finish: "stop" | "tool_calls" = "stop") => {
      writer.enqueue(encoder.encode(sseEvent({}, finish)));
      writer.enqueue(encoder.encode("data: [DONE]\n\n"));
      writer.close();
    },
  };
}

type Reply = ReturnType<typeof reply>;

/** Each request the model gets takes the next reply; bodies are kept. */
function model(...replies: Reply[]) {
  const requests: { system: string; signal?: AbortSignal | null }[] = [];
  const connection: AiConnection = {
    baseUrl: "http://localhost/ai/v1",
    model: "a-model",
    fetch: ((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: { role: string; content: string }[];
      };
      requests.push({
        signal: init.signal,
        system: body.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n"),
      });
      const next = replies.shift();
      if (!next) throw new Error("The model was not scripted for this");
      return Promise.resolve(next.response);
    }) as typeof fetch,
  };
  return { connection, requests };
}

/** Lets the chat's stream, timers and lazy chunk catch up. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

let root: Root;
/** Runs `work` and lets React finish what it set off. */
const during = (work: () => void) => act(() => Promise.resolve().then(work));

const render = (node: ReactNode) => during(() => root.render(node));

/** The app: the shell's holder always, the page only when `page` is given. */
const shell = (page?: ReactNode) => (
  <AssistantChatHolder>{page}</AssistantChatHolder>
);

const welcome = (connection: AiConnection) => (
  <Conversation connection={connection} model="a-model" />
);

const panel = () => document.querySelector(".ph-chat");
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>(".ph-chat-input")!;

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonNamed(name: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  );
  if (!button) throw new Error(`No ${name} button`);
  return button;
}

function type(text: string) {
  const value = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(textarea()),
    "value",
  );
  act(() => {
    value?.set?.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendTyped(text: string) {
  type(text);
  click(document.querySelector('[aria-label="Send message"]')!);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  app.address = "0xadmin";
  app.listeners.clear();
  app.tools = [
    {
      name: "aWrite",
      description: "Changes something",
      inputSchema: {},
      callback: () =>
        Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
    },
  ];
  chatHook().mockClear();
  localStorage.clear();
  document.body.innerHTML = "<div id='app'></div>";
  root = createRoot(document.getElementById("app")!);
});

afterEach(async () => {
  vi.useRealTimers();
  await during(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("the held conversation", () => {
  it("is still there after leaving the page and coming back", async () => {
    const answer = reply();
    const { connection } = model(answer);
    await render(shell(welcome(connection)));
    await settle();

    sendTyped("Which invoices are overdue?");
    await settle();
    await during(() => {
      answer.write(content("Two invoices."));
      answer.end();
    });
    await settle();
    expect(document.body.textContent).toContain("Two invoices.");

    await render(shell());
    expect(panel()).toBeNull();

    await render(shell(welcome(connection)));
    expect(document.body.textContent).toContain("Which invoices are overdue?");
    expect(document.body.textContent).toContain("Two invoices.");
    expect(buttonNamed("Clear").disabled).toBe(false);
  });

  it("keeps answering while the user is on another screen", async () => {
    const answer = reply();
    const { connection } = model(answer);
    await render(shell(welcome(connection)));
    await settle();

    sendTyped("Which invoices are overdue?");
    await settle();
    await during(() => answer.write(content("Two ")));
    await settle();

    await render(shell());
    await during(() => {
      answer.write(content("invoices."));
      answer.end();
    });
    await settle();

    await render(shell(welcome(connection)));
    expect(document.body.textContent).toContain("Two invoices.");
    expect(
      document.querySelector('[aria-label="Send message"]'),
    ).not.toBeNull();
  });

  it("keeps an approval waiting for the user", async () => {
    const ask = reply();
    const done = reply();
    const { connection, requests } = model(ask, done);
    await render(shell(welcome(connection)));
    await settle();

    sendTyped("Change it");
    await settle();
    await during(() => {
      ask.write(toolCall("aWrite"));
      ask.end("tool_calls");
    });
    await settle();
    expect(buttonNamed("Approve")).toBeTruthy();

    await render(shell());
    await settle();
    expect(requests).toHaveLength(1);

    await render(shell(welcome(connection)));
    expect(requests).toHaveLength(1);
    click(buttonNamed("Approve"));
    await settle();
    expect(requests).toHaveLength(2);
    await during(() => {
      done.write(content("Changed."));
      done.end();
    });
    await settle();
    expect(document.body.textContent).toContain("Changed.");
  });

  it("keeps the unsent text", async () => {
    const { connection } = model();
    await render(shell(welcome(connection)));
    await settle();
    type("Half a question");

    await render(shell());
    await render(shell(welcome(connection)));
    expect(textarea().value).toBe("Half a question");
  });

  it("is cleared by Clear, gone for good", async () => {
    const answer = reply();
    const { connection } = model(answer);
    await render(shell(welcome(connection)));
    await settle();
    sendTyped("Which invoices are overdue?");
    await settle();
    await during(() => {
      answer.write(content("Two invoices."));
      answer.end();
    });
    await settle();

    await render(shell());
    await render(shell(welcome(connection)));
    click(buttonNamed("Clear"));
    await settle();
    expect(document.body.textContent).not.toContain("Two invoices.");
    expect(buttonNamed("Clear").disabled).toBe(true);

    await render(shell());
    await render(shell(welcome(connection)));
    expect(document.body.textContent).not.toContain("Two invoices.");
  });

  it("follows a name changed in the user menu", async () => {
    const answer = reply();
    const { connection, requests } = model(answer);
    setUserName("Marit");
    await render(shell(welcome(connection)));
    await settle();
    expect(panel()?.textContent).toContain("Hi Marit. ");

    await render(shell());
    act(() => setUserName("Anna"));
    await render(shell(welcome(connection)));
    expect(panel()?.textContent).toContain("Hi Anna. ");

    sendTyped("Hello");
    await settle();
    expect(requests[0].system).toContain("The user's name is Anna");
  });

  it("states the new date when the tab outlives midnight", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      now: new Date(2026, 9, 30, 23, 59),
    });
    const answer = reply();
    const { connection, requests } = model(answer);
    await render(shell(welcome(connection)));
    await settle();

    await render(shell());
    await during(() => vi.advanceTimersByTime(2 * 60_000));
    await render(shell(welcome(connection)));

    sendTyped("What is today?");
    await settle();
    expect(requests[0].system).toContain("Today is Saturday, 31 October 2026");
  });

  it("lives and ends with the page under another Connect's layout", async () => {
    const answer = reply();
    const { connection } = model(answer);
    await render(welcome(connection));
    await settle();
    sendTyped("Which invoices are overdue?");
    await settle();
    await during(() => {
      answer.write(content("Two invoices."));
      answer.end();
    });
    await settle();
    expect(document.body.textContent).toContain("Two invoices.");

    await render(null);
    await render(welcome(connection));
    await settle();
    expect(document.body.textContent).not.toContain("Two invoices.");
  });

  it("ends when the user signs out, answer in flight too", async () => {
    const answer = reply();
    const { connection, requests } = model(answer);
    await render(shell(welcome(connection)));
    await settle();
    sendTyped("Which invoices are overdue?");
    await settle();
    await during(() => answer.write(content("Two invoices.")));
    await settle();

    await render(shell());
    await during(() => signIn(undefined));
    await settle();
    expect(requests[0].signal?.aborted).toBe(true);

    // Nothing left to come back to, and no chat running behind the screen
    signIn("0xsomeone-else");
    await render(shell(welcome(connection)));
    await settle();
    expect(document.body.textContent).not.toContain("Two invoices.");
    expect(document.body.textContent).not.toContain("overdue?");
    expect(textarea().disabled).toBe(false);
  });

  it("waits for a sign-in that loads after the gateway has answered", async () => {
    app.address = undefined;
    const { connection } = model();
    await render(shell(welcome(connection)));
    await settle();
    type("Half a question");

    await during(() => signIn("0xadmin"));
    await settle();
    expect(textarea().value).toBe("Half a question");
  });
});

describe("who gets the chat", () => {
  const gateway = (over: Partial<UseAiGatewayResult>): UseAiGatewayResult => ({
    gateway: undefined,
    connection: undefined,
    setKey: () => Promise.resolve(),
    setDemoKey: () => Promise.resolve(),
    resetKey: () => Promise.resolve(),
    ...over,
  });

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("has nothing running on a screen without the chat", async () => {
    await render(shell(<main>Invoices</main>));
    await settle();
    expect(chatHook()).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives a non-admin no chat", async () => {
    await render(
      shell(
        <AssistantPage gateway={gateway({ gateway: { access: "none" } })} />,
      ),
    );
    await settle();
    expect(chatHook()).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not start while the gateway has not answered", async () => {
    await render(shell(<AssistantPage gateway={gateway({})} />));
    await settle();
    expect(chatHook()).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it("calls nothing for an admin until a message is sent", async () => {
    const { connection, requests } = model();
    await render(shell(welcome(connection)));
    await settle();
    expect(chatHook()).toHaveBeenCalled();
    expect(panel()).not.toBeNull();
    expect(requests).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
