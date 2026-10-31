import { desktopShell, dispatchActions } from "@powerhousedao/reactor-browser";
import { actions } from "document-models/integration";
import { generateId } from "document-model";
import { useEffect, useRef, useState } from "react";
import type { IntegrationItem } from "../../sektar/kit/integration-index.js";
import { providerInfo } from "../../sektar/kit/integrations.js";
import {
  explainSignInFailure,
  useSignInPlace,
  type SignInFailure,
} from "../../sektar/kit/sign-in-place.js";
import { Button } from "../../sektar/kit/ui.js";
import {
  signInStatus,
  startSignIn,
  useWorkflowRuntimeUrl,
} from "../../sektar/kit/workflow-runtime.js";

const POLL_MS = 1500;
const GIVE_UP_MS = 10 * 60 * 1000;

type Phase = "idle" | "waiting" | "done" | "stopped";

/**
 * The sign-in on a card (and the detail page) that waits for one. On the
 * computer that runs Sektar it is the button. In an environment whose
 * switchboard finishes the sign-in itself (the cloud flow, sign-in-place.ts)
 * it is the button too, and says that the sign-in finishes in this
 * environment (through the relay: that the provider sends the person back
 * through Sektar's website, which passes it on and keeps nothing). Anywhere else a
 * small "sign in here" for someone who is on that computer through another
 * address (the provider sends the sign-in back to that computer, so from any
 * other device it cannot finish). The provider's page opens in a window;
 * when the switchboard has the token, the card asks the reconciler to look
 * again. A start that fails says why in plain words, the switchboard's own
 * text below it.
 *
 * A provider that refuses (an account the app does not allow, a cancelled
 * consent) often never sends the browser back, so the switchboard never
 * hears of it: the card stops waiting when the window closes, and Try again
 * and Cancel are there all along.
 */
export function SignIn({
  integration,
}: {
  integration: Pick<IntegrationItem, "id" | "state">;
}) {
  const url = useWorkflowRuntimeUrl();
  const s = integration.state;
  const provider = providerInfo(s.provider)?.label ?? "the provider";
  const connectionId = s.resources.connectionId;
  const { place, mode } = useSignInPlace();
  // The sign-in finishes from this browser: on the runner, or in the cloud
  const runner = place === "local" || place === "cloud";
  const cloud = place === "cloud";
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<SignInFailure | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popup = useRef<Window | null>(null);
  // Each attempt's number: a poll of an older attempt does nothing.
  const attempt = useRef(0);

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopPolling, []);

  if (!connectionId) {
    return (
      <span className="sk-small sk-text-muted">Getting the sign-in ready…</span>
    );
  }

  const stop = (text: string | SignInFailure | null) => {
    attempt.current += 1;
    stopPolling();
    setPhase("stopped");
    setMessage(typeof text === "string" ? { text, detail: null } : text);
  };

  const cancel = () => {
    popup.current?.close();
    stop(null);
    setPhase("idle");
  };

  const begin = async () => {
    const mine = ++attempt.current;
    stopPolling();
    setMessage(null);
    // A desktop window holds no popup: the system browser takes the sign-in,
    // and the poll below sees it finish.
    const shell = desktopShell();
    // Opened now, inside the click, so no popup blocker stops it; a retry
    // reuses the window by name.
    const win = shell
      ? null
      : window.open("", "sektar-sign-in", "popup,width=520,height=680");
    popup.current = win;
    try {
      const started = await startSignIn(url, connectionId);
      if (mine !== attempt.current) return;
      if (shell) await shell.openExternal(started.authorizationUrl);
      else if (win) win.location.href = started.authorizationUrl;
      else window.location.assign(started.authorizationUrl);
      setPhase("waiting");
      const until = Date.now() + GIVE_UP_MS;
      const poll = async () => {
        if (mine !== attempt.current) return;
        const state = await signInStatus(url, started.state).catch(() => null);
        if (mine !== attempt.current) return;
        if (state?.status === "OK") {
          setPhase("done");
          await dispatchActions(
            [
              actions.requestCheck({
                id: generateId(),
                requestedAt: new Date().toISOString(),
                requestedBy: "sign-in",
              }),
            ],
            integration.id,
          );
          return;
        }
        if (state?.status === "ERROR") {
          stop(state.error ?? `${provider} refused the sign-in`);
          return;
        }
        if (win?.closed) {
          stop("The sign-in window closed before it finished.");
          return;
        }
        if (Date.now() > until) {
          stop("The sign-in took too long.");
          return;
        }
        timer.current = setTimeout(() => void poll(), POLL_MS);
      };
      timer.current = setTimeout(() => void poll(), POLL_MS);
    } catch (e) {
      if (mine !== attempt.current) return;
      win?.close();
      stop(explainSignInFailure(e, provider));
    }
  };

  if (phase === "done") {
    return <span className="sk-small">Signed in. Setting up…</span>;
  }

  if (phase === "waiting") {
    return (
      <div className="sk-intg-waiting" role="status">
        <span className="sk-spinner" aria-hidden="true" />
        <div>
          <div className="sk-intg-waiting__title">Waiting for {provider}</div>
          <div className="sk-small sk-text-muted">
            Finish signing in, in the window that opened.
          </div>
          <div className="sk-intg-waiting__actions">
            <button type="button" onClick={() => void begin()}>
              Try again
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const label =
    phase === "stopped"
      ? "Try again"
      : runner
        ? `Sign in with ${provider}`
        : `On ${s.runner?.label ?? "that computer"}? Sign in here`;
  return (
    <div className="sk-stack sk-stack--2 sk-intg-signin-next">
      {message && (
        <span className="sk-small sk-text-danger">
          {message.text}
          {message.detail && (
            <span
              className="sk-text-muted"
              style={{ display: "block", fontSize: "0.85em" }}
            >
              {message.detail}
            </span>
          )}
        </span>
      )}
      {runner || phase === "stopped" ? (
        <Button
          variant={runner ? "primary" : "secondary"}
          size="sm"
          className={phase === "stopped" ? "sk-intg-retry" : undefined}
          onClick={() => void begin()}
        >
          {label}
        </Button>
      ) : (
        <button
          type="button"
          className="sk-btn sk-btn--link sk-btn--sm sk-intg-signin-here"
          onClick={() => void begin()}
        >
          {label}
        </button>
      )}
      {cloud && phase !== "stopped" && (
        <span className="sk-small sk-text-muted">
          The sign-in finishes here, in this environment.
          {mode === "RELAY" &&
            ` ${provider} sends you back through Sektar's website, which passes the sign-in on and keeps nothing.`}
        </span>
      )}
    </div>
  );
}
