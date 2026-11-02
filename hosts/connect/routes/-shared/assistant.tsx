import { useUser } from "@powerhousedao/reactor-browser";
import {
  ChatPanel,
  getHostAiTools,
  useReactorChat,
  type AiConnection,
  type AiGatewayStatus,
  type UseAiGatewayResult,
} from "@powerhousedao/reactor-browser/ai";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { assistantInstructions } from "../../../../ai/instructions.js";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
} from "../../../../editors/sektar/kit/ui.js";
import { useUserName } from "../../../../editors/sektar/kit/user-name.js";
import { Pane } from "../../../../editors/sektar/kit/workspace.js";
import { useAutoApprove } from "./auto-approve.js";
import {
  useHeldChat,
  WithChatHolder,
  type ChatSlots,
} from "./assistant-chat.js";

const SUGGESTIONS = [
  "Which invoices are overdue?",
  "Which invoices are still drafts?",
  "What is on my calendar this week?",
];

/** Under the welcome, when the gateway could not say who is asking. */
export function AssistantUnavailable({ message }: { message: string }) {
  return (
    <div className="sk-assistant">
      <Alert tone="warning" title="The assistant is not available">
        {message}
      </Alert>
    </div>
  );
}

/**
 * Today, following the local date: a tab can outlive it, and the instruction
 * states it. Checked each minute, so the first minute of a day can lag.
 */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => {
      const now = new Date();
      setToday((day) =>
        day.toDateString() === now.toDateString() ? day : now,
      );
    }, 60_000);
    return () => clearInterval(tick);
  }, []);
  return today;
}

/**
 * The tab's one conversation (assistant-chat.tsx holds it), rendered into the
 * page's slots whether or not the page is there.
 */
export function HeldChat({
  connection,
  slots,
  release,
}: {
  connection: AiConnection;
  slots: ChatSlots;
  /** Drops this component: the conversation has ended for good */
  release: () => void;
}) {
  const userName = useUserName();
  const today = useToday();
  const [autoApprove] = useAutoApprove();
  const chat = useReactorChat(getHostAiTools, {
    connection,
    autoApprove,
    instructions: assistantInstructions(today, userName),
  });

  // It is one user's: signing out or switching ends it, answer in flight too.
  // The sign-in can load after the gateway has answered, so the first address
  // seen is the owner.
  const { clear } = chat;
  const address = useUser()?.address;
  const owner = useRef(address);
  useEffect(() => {
    owner.current ??= address;
    if (address === owner.current) return;
    clear();
    release();
  }, [address, clear, release]);

  return (
    <>
      {createPortal(
        <Button
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={chat.messages.length === 0}
        >
          Clear
        </Button>,
        slots.clear,
      )}
      {createPortal(
        <ChatPanel
          chat={chat}
          allowImages
          suggestions={SUGGESTIONS}
          emptyState={
            <p>
              {userName && `Hi ${userName}. `}
              Ask about your invoices, mail, calendar, files or trips, or attach
              a photo of a receipt.{" "}
              {autoApprove
                ? "Auto-approve is on, so changes to your data are made without asking."
                : "Anything that changes your data asks you first."}
            </p>
          }
        />,
        slots.panel,
      )}
    </>
  );
}

interface ConversationProps {
  connection: AiConnection;
  model: string;
  /** After Clear in the pane's header */
  trailing?: ReactNode;
}

/** The conversation as a pane: its input stays put, only the messages scroll. */
export function Conversation(props: ConversationProps) {
  return (
    <WithChatHolder>
      <ConversationPane {...props} />
    </WithChatHolder>
  );
}

function ConversationPane({ connection, model, trailing }: ConversationProps) {
  const held = useHeldChat(connection);
  return (
    <Pane
      className="sk-assistant sk-assistant__conversation"
      title="Assistant"
      titleDisplay
      flush
      header={
        <>
          <Badge tone="success" dot>
            Ready
          </Badge>
          <span className="sk-caption sk-assistant__model">{model}</span>
        </>
      }
      trailing={
        <>
          {held.clear}
          {trailing}
        </>
      }
    >
      {held.panel}
    </Pane>
  );
}

export function KeyCard({
  status,
  gateway,
}: {
  status: AiGatewayStatus;
  gateway: UseAiGatewayResult;
}) {
  const [replacing, setReplacing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [autoApprove, setAutoApprove] = useAutoApprove();

  const showForm = !status.configured || replacing;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setValue("");
      setReplacing(false);
      setResetting(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => gateway.setKey(value));
  };

  return (
    <Card
      compact
      className="sk-assistant__key"
      title="OpenRouter key"
      actions={
        status.configured ? (
          <Badge tone="success">Configured</Badge>
        ) : (
          <Badge tone="warning">Not configured</Badge>
        )
      }
    >
      {status.configured ? (
        <p className="sk-caption">
          <code>{status.keyHint}</code>
          {status.keySetAt &&
            ` · set ${new Date(status.keySetAt).toLocaleDateString()}`}
        </p>
      ) : (
        <p>The assistant needs an OpenRouter key before it can start.</p>
      )}
      {showForm && status.demoKeyAvailable && (
        // A cloud Sektar comes with a key of its own (Vetra's, capped at the
        // plan's budget); the switchboard calls it a demo key. One click
        // stores it like a typed key, so Replace and Reset work as ever.
        <div className="sk-assistant__key-included">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void run(gateway.setDemoKey)}
          >
            {busy ? "Testing…" : "Use the key included with your Sektar"}
          </Button>
          <p className="sk-hint">
            Or use your own OpenRouter key below. You can switch at any time.
          </p>
        </div>
      )}
      {showForm ? (
        <form className="sk-assistant__key-form" onSubmit={submit}>
          <Field
            label={status.configured ? "New key" : "Key"}
            hint="Tested with OpenRouter, then stored encrypted on the server. It is never shown again."
            error={error}
          >
            <Input
              type="password"
              name="openrouter-key"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="sk-or-v1-…"
            />
          </Field>
          <div className="sk-assistant__key-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || value.trim() === ""}
            >
              {busy ? "Testing…" : "Save and test"}
            </Button>
            {replacing && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setReplacing(false);
                  setValue("");
                  setError(undefined);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="sk-assistant__key-actions">
          <Button size="sm" onClick={() => setReplacing(true)}>
            Replace key
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResetting(true)}>
            Reset key
          </Button>
        </div>
      )}
      {status.configured && (
        <>
          <label className="sk-check">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(event) => setAutoApprove(event.target.checked)}
            />
            Auto-approve
          </label>
          <p className="sk-caption">
            The assistant changes your data without asking you first.
          </p>
        </>
      )}
      {resetting && (
        <Modal
          title="Reset the OpenRouter key?"
          onClose={() => setResetting(false)}
          footer={
            <>
              <Button disabled={busy} onClick={() => setResetting(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void run(gateway.resetKey)}
              >
                Reset key
              </Button>
            </>
          }
        >
          <p>The assistant stops working until a new key is set.</p>
          {error && <p className="sk-hint">{error}</p>}
        </Modal>
      )}
    </Card>
  );
}
