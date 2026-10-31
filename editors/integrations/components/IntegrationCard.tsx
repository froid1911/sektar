import {
  deleteNode,
  dispatchActions,
  useSelectedDrive,
} from "@powerhousedao/reactor-browser";
import { actions } from "document-models/integration";
import { useState } from "react";
import type { QueueProgress } from "../../backfills/progress.js";
import {
  patchIntegration,
  type ConnectionListRow,
  type IntegrationItem,
} from "../../sektar/kit/integration-index.js";
import {
  cardView,
  kindInfo,
  providerInfo,
  removalPlan,
} from "../../sektar/kit/integrations.js";
import { Menu } from "../../sektar/kit/menu.js";
import {
  speaksOfEnvironment,
  useSignInPlace,
} from "../../sektar/kit/sign-in-place.js";
import { Alert, Badge, Button, cx, Icon, Modal } from "../../sektar/kit/ui.js";
import { AccountLabel, CardRows } from "./CardRows.js";
import { Grant } from "./Grant.js";
import type { TriggerState } from "../../sektar/kit/workflow-runtime.js";
import { SignIn } from "./SignIn.js";
import { TryAgain } from "./TryAgain.js";

/**
 * One integration on the page (design system: Patterns · Integrations ·
 * card). While it waits for the sign-in on the runner there is nothing to
 * switch yet, so the card shows the state and what to do; once it is set up,
 * the Live updates and Backfill rows follow (CardRows). Its menu
 * removes it, through a confirmation that says what removing does.
 */
export function IntegrationCard({
  integration,
  triggers,
  progress,
  connections,
  onOpen,
}: {
  integration: IntegrationItem;
  /** The runtime's trigger states by workflow id (useTriggerStates) */
  triggers?: ReadonlyMap<string, TriggerState>;
  /** Its backfill queues' progress by queue id, from the index; undefined while it is read */
  progress?: ReadonlyMap<string, QueueProgress>;
  /** The connections by id, from the index */
  connections?: ReadonlyMap<string, ConnectionListRow>;
  /** Opens its detail page: a tap on the card outside its controls */
  onOpen?: (id: string) => void;
}) {
  const s = integration.state;
  const { place, hostname } = useSignInPlace();
  const view = cardView(s, {
    environment: speaksOfEnvironment(place, s.runner?.label, hostname),
  });
  const kind = kindInfo(s.kind);
  const provider = providerInfo(s.provider);
  const linked = (s.intent.source as { accounts?: unknown[] } | null)?.accounts;
  const account =
    s.kind === "TRANSACTIONS" && linked
      ? `${linked.length} ${linked.length === 1 ? "account" : "accounts"} · ${provider?.lead ?? "Bank"}`
      : ([provider?.lead, kind?.label].filter(Boolean)[0] ?? "Not set up");
  // A bank's key names nobody's account: the account count says more
  const [removing, setRemoving] = useState(false);
  const name = integration.name || kind?.label || "Integration";
  // All well (Live, Paused): the rows below say it, and the badge sits in
  // the head as in the design system; otherwise a Status row says what is up.
  const quiet = view.state === "live" || view.state === "paused";
  // A workflow the runtime parked: the card offers to try again
  const parked = s.check?.issues.find((i) =>
    i.code.endsWith("_WORKFLOW_PARKED"),
  );
  const needsGrant = s.check?.issues.some((i) => i.code === "NEEDS_GRANT");
  return (
    <article
      className={cx(
        "sk-card sk-integration",
        view.state === "attention" && "sk-integration--attention",
        onOpen && "sk-integration--opens",
      )}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (
          !onOpen ||
          target.closest(
            "button, a, input, label, select, textarea, [role='menu'], .sk-modal, .sk-modal-backdrop",
          )
        ) {
          return;
        }
        onOpen(integration.id);
      }}
    >
      <header
        className={
          quiet
            ? "sk-integration__head sk-integration__head--menu sk-integration__head--badge"
            : "sk-integration__head sk-integration__head--menu"
        }
      >
        <span className="sk-icon-tile">
          <Icon name={kind?.icon ?? "sync"} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="sk-integration__name">
            {onOpen ? (
              <a
                href={`#i/${integration.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(integration.id);
                }}
              >
                {name}
              </a>
            ) : (
              name
            )}
          </div>
          <div className="sk-integration__account">
            {s.resources.connectionId && s.kind !== "TRANSACTIONS" ? (
              <AccountLabel
                connection={connections?.get(s.resources.connectionId)}
                fallback={account}
              />
            ) : (
              account
            )}
          </div>
        </div>
        {quiet && (
          <Badge tone={view.badge.tone} dot={view.badge.dot}>
            {view.badge.label}
          </Badge>
        )}
        <Menu
          label={`${name}: more`}
          items={[
            {
              label: "Remove…",
              icon: "close",
              danger: true,
              disabled: view.state === "removing",
              onSelect: () => setRemoving(true),
            },
          ]}
          trigger={(open, toggle) => (
            <button
              type="button"
              className="sk-more"
              aria-label={`${name}: more`}
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        />
      </header>
      {!quiet && (
        <div className="sk-integration__row">
          <div>
            <div className="sk-integration__label">
              {view.state === "waiting-for-sign-in" ||
              view.state === "incomplete"
                ? "Next"
                : "Status"}
            </div>
            <div className="sk-integration__meta">{view.line}</div>
          </div>
          <Badge tone={view.badge.tone} dot={view.badge.dot}>
            {view.badge.label}
          </Badge>
        </div>
      )}
      {view.state === "waiting-for-sign-in" && (
        <SignIn integration={integration} />
      )}
      {needsGrant && <Grant integration={integration} />}
      {parked?.subject && (
        <TryAgain integration={integration} workflowId={parked.subject} />
      )}
      {(view.state === "live" ||
        view.state === "paused" ||
        view.state === "applying" ||
        view.state === "attention") && (
        <CardRows
          integration={integration}
          progress={progress}
          liveTrigger={
            s.resources.liveWorkflowId
              ? triggers?.get(s.resources.liveWorkflowId)
              : undefined
          }
        />
      )}
      {removing && (
        <RemoveDialog
          integration={integration}
          name={name}
          onClose={() => setRemoving(false)}
        />
      )}
    </article>
  );
}

/**
 * Confirms a removal and says what it does. Something built (a sign-in,
 * workflows, backfills) is taken down by the reconciler on the runner first,
 * so the app records the wish (ARCHIVE) and the card shows Removing; an
 * integration that never built anything is deleted right away.
 */
export function RemoveDialog({
  integration,
  name,
  onClose,
  onRemoved,
}: {
  integration: IntegrationItem;
  name: string;
  onClose: () => void;
  /** After a removal that deletes it right away (the detail page leaves) */
  onRemoved?: () => void;
}) {
  const [drive] = useSelectedDrive();
  const { place, hostname } = useSignInPlace();
  const plan = removalPlan(integration.state, {
    environment: speaksOfEnvironment(
      place,
      integration.state.runner?.label,
      hostname,
    ),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (plan.immediate) {
        if (!drive) throw new Error("The Integrations drive is not open");
        await deleteNode(drive.header.id, integration.id);
        onRemoved?.();
      } else {
        await dispatchActions([actions.archive({})], integration.id);
        // The card says Removing now, not when the index catches up
        patchIntegration(integration, (s) => ({
          ...s,
          intent: { ...s.intent, archived: true },
        }));
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Remove ${name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      <div className="sk-stack sk-stack--3">
        {plan.steps.length === 1 ? (
          <p>{plan.steps[0]}</p>
        ) : (
          <ol className="sk-intg-remove-steps">
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        <p className="sk-small sk-text-muted">{plan.keeps}</p>
        {error && (
          <Alert tone="danger" title="Could not remove it">
            {error}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
