import { dispatchActions, openTarget } from "@powerhousedao/reactor-browser";
import { generateId } from "document-model";
import { actions } from "document-models/integration";
import { useCallback, useState, type ReactNode } from "react";
import type { QueueProgress } from "../../backfills/progress.js";
import type {
  ConnectionListRow,
  IntegrationItem,
} from "../../sektar/kit/integration-index.js";
import {
  aboutDuration,
  backfillPace,
  backfillRows,
  checkedAgo,
  clock,
  frequency,
  lastSynced,
  missedSlices,
  nextCheck,
  paceLine,
  runFeed,
  setupRows,
  sliceLabel,
  slicesLeft,
  sourceBadge,
  stuckSince,
  type FeedRow,
  type RunRecord,
} from "../../sektar/kit/integration-detail.js";
import {
  cardView,
  historyView,
  kindInfo,
  liveLine,
  providerInfo,
  sliceUnit,
} from "../../sektar/kit/integrations.js";
import { Menu } from "../../sektar/kit/menu.js";
import {
  speaksOfEnvironment,
  useSignInPlace,
} from "../../sektar/kit/sign-in-place.js";
import {
  Badge,
  Button,
  DetailHeader,
  Dl,
  Icon,
  ProgressRow,
  Ring,
  Switch,
} from "../../sektar/kit/ui.js";
import { useSyncNow, useTriggerStates } from "../../sektar/kit/use-sync.js";
import {
  fireWith,
  runHistory,
  runsWithSteps,
  useWorkflowRuntimeUrl,
} from "../../sektar/kit/workflow-runtime.js";
import { AccountLabel, setSwitch } from "./CardRows.js";
import { RemoveDialog } from "./IntegrationCard.js";
import { Grant } from "./Grant.js";
import { SignIn } from "./SignIn.js";
import { TryAgain } from "./TryAgain.js";
import { useRuns } from "./use-runs.js";

/** The live runs the feed shows */
const RECENT_RUNS = 10;
/**
 * How far back the backfill's history is read for skipped slices and the
 * pace. Each run costs the runtime an access check per document it wrote
 * (about 70 ms a run for a mail backfill), so the page reads two pages, in
 * the background, every few minutes.
 */
const HISTORY_RUNS = 200;
const HISTORY_EVERY_MS = 5 * 60_000;

const recentRuns = (url: string, id: string) =>
  runsWithSteps(url, id, RECENT_RUNS);
const history = (url: string, id: string) => runHistory(url, id, HISTORY_RUNS);

/**
 * One integration on its own page (design system: Patterns · Integrations ·
 * Detail): live updates and backfill side by side, and below them what the
 * reconciler found. While it waits for a sign-in, the same sign-in as on the
 * card sits under the header. The switches write the wish, as on the card; Sync now
 * runs the live check; the workflows open in Workflow Studio. Everything on
 * it comes from the integration index; the switches and Check now write to
 * the document by id.
 */
export function IntegrationDetail({
  integration,
  progress,
  connections,
  onBack,
}: {
  integration: IntegrationItem;
  /** Its backfill queues' progress by queue id; undefined while the index is read */
  progress?: ReadonlyMap<string, QueueProgress>;
  /** The connections by id, from the index */
  connections?: ReadonlyMap<string, ConnectionListRow>;
  onBack: () => void;
}) {
  const s = integration.state;
  const { place, hostname } = useSignInPlace();
  const view = cardView(s, {
    environment: speaksOfEnvironment(place, s.runner?.label, hostname),
  });
  const kind = kindInfo(s.kind);
  const provider = providerInfo(s.provider);
  const name = integration.name || kind?.label || "Integration";
  const triggers = useTriggerStates();
  const { syncing, sync } = useSyncNow();
  const liveId = s.resources.liveWorkflowId;
  const live = useRuns(liveId, recentRuns);
  const [removing, setRemoving] = useState(false);
  const busy = liveId ? syncing.has(liveId) : false;
  const canSync =
    Boolean(liveId) && s.intent.live.enabled && view.state !== "removing";
  const source = sourceBadge(s);
  const mailbox = (s.intent.source as { mailbox?: string } | null)?.mailbox;
  const account = [provider?.lead, kind?.label].filter(Boolean).join(" · ");

  return (
    <div className="sk-stack sk-stack--6 sk-intg-detail">
      <nav className="sk-breadcrumb" aria-label="Breadcrumb">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          Integrations
        </a>{" "}
        <span aria-hidden="true">/</span> <span>{name}</span>
      </nav>
      <DetailHeader
        media={
          <span className="sk-icon-tile sk-icon-tile--lg">
            <Icon name={kind?.icon ?? "sync"} />
          </span>
        }
        name={name}
        sub={
          s.resources.connectionId && s.kind !== "TRANSACTIONS" ? (
            <AccountLabel
              connection={connections?.get(s.resources.connectionId)}
              fallback={account}
            />
          ) : (
            account
          )
        }
        tags={
          <>
            <Badge tone={view.badge.tone} dot={view.badge.dot}>
              {view.badge.label}
            </Badge>
            {source && <Badge>{source}</Badge>}
            {s.kind === "EMAIL" && mailbox && <Badge>Mail · {mailbox}</Badge>}
          </>
        }
        actions={
          <>
            <Button
              icon="sync"
              disabled={!canSync || busy}
              onClick={() => {
                if (liveId) void sync([liveId]).then(live.reload);
              }}
            >
              {busy ? "Syncing…" : "Sync now"}
            </Button>
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
          </>
        }
      />
      {view.state === "attention" && (
        <p className="sk-small sk-text-danger" style={{ margin: 0 }}>
          {view.line}
        </p>
      )}
      {/* The sign-in it waits for, as on the card: a first one, lost
          tokens, more access, another account */}
      {view.state === "waiting-for-sign-in" && (
        <div className="sk-stack sk-stack--2">
          <p className="sk-small" style={{ margin: 0 }}>
            {view.line}
          </p>
          <SignIn integration={integration} />
        </div>
      )}
      {integration.state.check?.issues.some(
        (i) => i.code === "NEEDS_GRANT",
      ) && <Grant integration={integration} />}
      <div className="sk-grid sk-grid--2 sk-intg-detail__grid">
        <LiveCard
          integration={integration}
          connections={connections}
          runs={live.runs}
          trigger={liveId ? triggers.get(liveId) : undefined}
        />
        <BackfillCard integration={integration} progress={progress} />
      </div>
      <SetupCard integration={integration} />
      {removing && (
        <RemoveDialog
          integration={integration}
          name={name}
          onClose={() => setRemoving(false)}
          onRemoved={onBack}
        />
      )}
    </div>
  );
}

function CardHead({
  title,
  lead,
  control,
}: {
  title: string;
  lead: string;
  control?: ReactNode;
}) {
  return (
    <div className="sk-card__header">
      <div>
        <h3 className="sk-card__title">{title}</h3>
        <p className="sk-small sk-text-muted sk-mt-1">{lead}</p>
      </div>
      {control}
    </div>
  );
}

/** Opens a workflow in Workflow Studio (the Workflows drive) */
function WorkflowLink({ id, name }: { id: string; name: string }) {
  return (
    <a
      href={`/d/workflows/${id}`}
      className="sk-row sk-row--2"
      style={{ display: "inline-flex", color: "inherit" }}
      onClick={(e) => {
        e.preventDefault();
        openTarget({ driveSlug: "workflows", nodeSlug: id });
      }}
    >
      {name}
      <Icon name="arrow-up-right" size={16} mono />
    </a>
  );
}

function RunsFeed({ rows }: { rows: FeedRow[] }) {
  return (
    <ul className="sk-feed">
      {rows.map((row) => (
        <li key={row.key} className="sk-feed__item">
          <span
            className={
              row.problem ? "sk-feed__icon sk-text-danger" : "sk-feed__icon"
            }
          >
            <Icon name={row.icon} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="sk-feed__text">
              {row.bold ? <b>{row.text}</b> : row.text}
            </div>
            {row.sub && <div className="sk-feed__sub">{row.sub}</div>}
          </div>
          {row.time && <span className="sk-feed__time">{row.time}</span>}
        </li>
      ))}
    </ul>
  );
}

function LiveCard({
  integration,
  connections,
  runs,
  trigger,
}: {
  integration: IntegrationItem;
  connections?: ReadonlyMap<string, ConnectionListRow>;
  runs: RunRecord[] | null;
  trigger: ReturnType<ReturnType<typeof useTriggerStates>["get"]>;
}) {
  const s = integration.state;
  const liveId = s.resources.liveWorkflowId;
  const line = liveLine(s, trigger);
  const stuck = runs ? stuckSince(runs) : null;
  const synced = lastSynced(trigger?.lastPollAt, runs ?? [], s.kind);
  const next = s.intent.live.enabled ? nextCheck(trigger?.nextPollAt) : "";
  const parked = s.check?.issues.find((i) => i.code === "LIVE_WORKFLOW_PARKED");
  const lead =
    s.kind === "EMAIL"
      ? "New mail as it arrives"
      : s.kind === "CALENDAR"
        ? "Changes to events as they happen"
        : s.kind === "TRANSACTIONS"
          ? "New payments as the bank books them"
          : "What is new, as it comes";
  const rows = [
    {
      label: "Status",
      value: (
        <span className="sk-row sk-row--2" style={{ display: "inline-flex" }}>
          {stuck ? (
            <>
              <span className="sk-sync-dot sk-sync-dot--error" />
              Stuck since {stuck.since}
              {stuck.waiting > 0 ? ` · ${stuck.waiting} waiting` : ""}
            </>
          ) : (
            <>
              {line.dot && (
                <span className={`sk-sync-dot sk-sync-dot--${line.dot}`} />
              )}
              {line.dot === "ok" ? "Up to date" : line.line.split(" · ")[0]}
            </>
          )}
        </span>
      ),
    },
    ...(synced
      ? [
          {
            label: "Last synced",
            value: (
              <>
                {synced.when}{" "}
                <span className="sk-text-muted">· {synced.detail}</span>
              </>
            ),
          },
        ]
      : []),
    ...(next ? [{ label: "Next check", value: next }] : []),
    ...(liveId
      ? [
          {
            label: "Workflow",
            value: (
              <WorkflowLink
                id={liveId}
                name={runs?.[0]?.workflowName || "Live updates"}
              />
            ),
          },
        ]
      : []),
    { label: "Frequency", value: frequency(s) },
    ...(s.resources.connectionId
      ? [
          {
            label: "Connection",
            value: connections ? (
              <ConnectionFacts
                connection={connections.get(s.resources.connectionId)}
              />
            ) : (
              "…"
            ),
          },
        ]
      : []),
  ];
  return (
    <section className="sk-card">
      <CardHead
        title="Live updates"
        lead={lead}
        control={
          <Switch
            label="Live updates"
            checked={s.intent.live.enabled}
            onChange={(enabled) =>
              setSwitch(
                integration,
                [actions.setLiveEnabled({ enabled })],
                (x) => ({
                  ...x,
                  intent: { ...x.intent, live: { ...x.intent.live, enabled } },
                }),
              )
            }
          />
        }
      />
      <Dl rows={rows} />
      {parked?.subject && (
        <div className="sk-mt-4">
          <TryAgain integration={integration} workflowId={parked.subject} />
        </div>
      )}
      {liveId && (
        <>
          <p className="sk-eyebrow sk-mt-6 sk-mb-3">Recent runs</p>
          {runs === null ? (
            <p className="sk-small sk-text-muted">Reading the runs…</p>
          ) : runs.length === 0 ? (
            <p className="sk-small sk-text-muted">No runs yet</p>
          ) : (
            <RunsFeed rows={runFeed(runs, s.kind)} />
          )}
        </>
      )}
    </section>
  );
}

/** "wouter@… · works, checked 14:04", or what went wrong */
function ConnectionFacts({
  connection: g,
}: {
  connection: ConnectionListRow | undefined;
}) {
  if (!g) return <>Signed in</>;
  const who = g.accountLabel ?? "Signed in";
  if (g.lastError) {
    return (
      <>
        {who} <span className="sk-text-danger">· {g.lastError}</span>
      </>
    );
  }
  return (
    <>
      {who}
      {g.lastCheckedAt && (
        <span className="sk-text-muted">
          {" "}
          · works, checked {clock(g.lastCheckedAt)}
        </span>
      )}
    </>
  );
}

function BackfillCard({
  integration,
  progress,
}: {
  integration: IntegrationItem;
  progress?: ReadonlyMap<string, QueueProgress>;
}) {
  const s = integration.state;
  const items = s.intent.backfill.items;
  const control = (
    <Switch
      label="Backfill"
      checked={s.intent.backfill.enabled}
      onChange={(enabled) =>
        setSwitch(
          integration,
          [actions.setBackfillEnabled({ enabled })],
          (x) => ({
            ...x,
            intent: {
              ...x.intent,
              backfill: { ...x.intent.backfill, enabled },
            },
          }),
        )
      }
    />
  );
  const lead = "Older history. One backfill runs at a time";
  if (items.length === 0) {
    return (
      <section className="sk-card">
        <CardHead title="Backfill" lead={lead} />
        <p className="sk-small sk-text-muted">
          Nothing older is brought in: this integration starts from when it was
          added.
        </p>
      </section>
    );
  }
  return (
    <section className="sk-card">
      <CardHead title="Backfill" lead={lead} control={control} />
      {progress ? (
        <BackfillBody integration={integration} progress={progress} />
      ) : (
        <p className="sk-small sk-text-muted">…</p>
      )}
    </section>
  );
}

function BackfillBody({
  integration,
  progress,
}: {
  integration: IntegrationItem;
  progress: ReadonlyMap<string, QueueProgress>;
}) {
  const s = integration.state;
  const workflowId = s.resources.backfillWorkflowId;
  const { runs, reload } = useRuns(workflowId, history, HISTORY_EVERY_MS);
  const summary = historyView(s, progress);
  const steps = s.intent.backfill.items
    .map((i) => (i.request as { stepSeconds?: number } | null)?.stepSeconds)
    .filter((x): x is number => typeof x === "number");
  const step = steps[0] ?? null;
  const unit = step ? sliceUnit(step) : "slices";
  const rows = backfillRows(s, progress, unit);
  const pace = runs ? backfillPace(runs) : null;
  const left = slicesLeft(s, progress);
  const totals = [...progress.values()].reduce(
    (t, p) => ({ done: t.done + p.done, total: t.total + p.total }),
    { done: 0, total: 0 },
  );
  const missed = runs ? missedSlices(runs) : [];
  const parked = s.check?.issues.find(
    (i) => i.code === "BACKFILL_WORKFLOW_PARKED",
  );
  const plugged = s.intent.backfill.items.findIndex(
    (i) => i.id === s.resources.pluggedItemId,
  );
  const after = rows
    .slice(plugged + 1)
    .find((r) => r.status === "waiting" || r.status === "starting");
  const summaryLine = [
    rows.length > 1 ? `All ${rows.length} backfills` : null,
    summary?.complete
      ? "complete"
      : !s.intent.backfill.enabled
        ? "paused"
        : pace && left > 0
          ? `${aboutDuration(pace.msPerSlice * left)} left at the current pace`
          : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="sk-row sk-row--4 sk-mb-4">
        <Ring small value={summary?.percent ?? 0} />
        <div>
          <div className="sk-weight-medium">
            {totals.done.toLocaleString("en-GB")} of{" "}
            {totals.total.toLocaleString("en-GB")} {unit}
          </div>
          {summaryLine && (
            <div className="sk-small sk-text-muted">{summaryLine}</div>
          )}
        </div>
      </div>
      {parked?.subject && (
        <div className="sk-mb-4">
          <TryAgain integration={integration} workflowId={parked.subject} />
        </div>
      )}
      {missed.length > 0 && (
        <MissedSlices
          workflowId={workflowId as string}
          missed={missed}
          onDone={reload}
        />
      )}
      <ul className="sk-list sk-list--divided">
        {rows.map((row) => (
          <li key={row.id} className="sk-list-item sk-intg-backfill">
            <div style={{ minWidth: 0 }}>
              <div className="sk-list-item__title">
                {row.label}{" "}
                <Badge
                  tone={row.badge === "Gap" ? "warning" : "outline"}
                  className="sk-intg-backfill__kind"
                >
                  {row.badge}
                </Badge>
              </div>
              <div className="sk-list-item__meta">{row.meta}</div>
            </div>
            {row.status === "active" ? (
              <Badge tone="info" dot>
                {s.intent.backfill.enabled ? "Active" : "Paused"}
              </Badge>
            ) : row.status === "done" ? (
              <Badge tone="success">Done</Badge>
            ) : (
              <Badge>
                {row.status === "starting" ? "Starting" : "Waiting"}
              </Badge>
            )}
            <div style={{ gridColumn: "1 / -1" }}>
              <ProgressRow value={row.percent} />
            </div>
          </li>
        ))}
      </ul>
      <Dl
        rows={[
          ...(workflowId
            ? [
                {
                  label: "Workflow",
                  value: (
                    <WorkflowLink
                      id={workflowId}
                      name={runs?.[0]?.workflowName || "Backfill"}
                    />
                  ),
                },
              ]
            : []),
          ...(pace
            ? [{ label: "Pace", value: paceLine(pace.msPerSlice, step) }]
            : []),
          ...(after ? [{ label: "After this one", value: after.label }] : []),
        ]}
      />
    </>
  );
}

/**
 * Slices the runtime never ran (skipped while the workflow was stopped,
 * expired waiting in the queue) and nothing brought in since. The backfill
 * has moved past them, so they stay missing unless they are run again,
 * oldest first, each with the window it had.
 */
function MissedSlices({
  workflowId,
  missed,
  onDone,
}: {
  workflowId: string;
  missed: RunRecord[];
  onDone: () => void;
}) {
  const url = useWorkflowRuntimeUrl();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = sliceLabel(missed[0]);
  const last = sliceLabel(missed.at(-1) as RunRecord);
  const bring = useCallback(async () => {
    setError(null);
    try {
      for (const [i, run] of missed.entries()) {
        setProgress(`Bringing in… ${i + 1} of ${missed.length}`);
        const result = await fireWith(url, workflowId, run.triggerPayload);
        if (result.status !== "SUCCEEDED") {
          setError(
            `${sliceLabel(run) ?? "A slice"}: ${result.error ?? result.status.toLowerCase()}`,
          );
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      onDone();
    }
  }, [missed, url, workflowId, onDone]);
  return (
    <div className="sk-intg-missed sk-mb-4">
      <div style={{ minWidth: 0 }}>
        <div className="sk-weight-medium">
          {missed.length} {missed.length === 1 ? "slice was" : "slices were"}{" "}
          skipped
        </div>
        <div className="sk-small sk-text-muted">
          {first && last && first !== last ? `${first} – ${last}` : first}
          {" · "}never brought in
        </div>
        {error && (
          <div className="sk-small sk-text-danger">Stopped at {error}</div>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={progress !== null}
        onClick={() => void bring()}
      >
        {progress ?? "Bring them in"}
      </Button>
    </div>
  );
}

function SetupCard({ integration }: { integration: IntegrationItem }) {
  const s = integration.state;
  const [asked, setAsked] = useState<string | null>(null);
  const waiting = asked !== null && s.check?.request !== asked;
  const rows = setupRows(s);
  const checked = checkedAgo(s);
  return (
    <section className="sk-card">
      <CardHead
        title="Setup"
        lead={[
          "Sektar keeps the workflows in line with what you set here",
          checked,
        ]
          .filter(Boolean)
          .join(" · ")}
        control={
          <Button
            size="sm"
            icon="sync"
            disabled={waiting}
            onClick={() => {
              const id = generateId();
              setAsked(id);
              void dispatchActions(
                [
                  actions.requestCheck({
                    id,
                    requestedAt: new Date().toISOString(),
                  }),
                ],
                integration.id,
              );
            }}
          >
            {waiting ? "Checking…" : "Check now"}
          </Button>
        }
      />
      {rows.length === 0 ? (
        <p className="sk-small sk-text-muted">Not checked yet</p>
      ) : (
        <RunsFeed rows={rows.map((r) => ({ ...r, bold: false }))} />
      )}
    </section>
  );
}
