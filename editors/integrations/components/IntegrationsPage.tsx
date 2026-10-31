import { useSelectedDrive } from "@powerhousedao/reactor-browser";
import growthDark from "../../sektar/design/shapes/sektar-growth-four-column-combined-dark.svg";
import growthLight from "../../sektar/design/shapes/sektar-growth-four-column-combined-light.svg";
import { EndMark } from "../../sektar/kit/endmark.js";
import {
  useConnectionRows,
  useIntegrationItems,
  useQueueProgress,
} from "../../sektar/kit/integration-index.js";
import { KINDS } from "../../sektar/kit/integrations.js";
import {
  PullHeader,
  pullResult,
  usePullToRefresh,
} from "../../sektar/kit/pull-to-refresh.js";
import {
  syncRow,
  syncSummary,
  type SyncRow,
} from "../../sektar/kit/sync-status.js";
import { useSignInPlace } from "../../sektar/kit/sign-in-place.js";
import { Button, EmptyState, PageHeader } from "../../sektar/kit/ui.js";
import { useSyncNow, useTriggerStates } from "../../sektar/kit/use-sync.js";
import { useCallback, useMemo, useState } from "react";
import { CreateFlow, firstStep, STEPS, type CreateStep } from "./CreateFlow.js";
import { IntegrationCard } from "./IntegrationCard.js";
import { useRenewGrants } from "./use-renew-grants.js";
import { IntegrationDetail } from "./IntegrationDetail.js";
import { useHashStep } from "./use-hash-step.js";

/**
 * The Integrations page (design system: Patterns · Integrations): the cards,
 * grouped by kind, and the create flow behind "Add integration". The flow's
 * step lives in the hash, so the phone's back button walks it back. While the
 * page is empty, the empty state carries the only Add button; the header gets
 * it once cards exist.
 *
 * Everything comes from the integration index: the integrations of this
 * drive, their queues' progress and their connections, each asked once for
 * the whole page.
 */
export function IntegrationsPage() {
  const [hash, setHash] = useHashStep();
  // Asked once, as the page opens: Add integration starts where it finishes
  const { place } = useSignInPlace();
  const [drive] = useSelectedDrive();
  const items = useIntegrationItems(drive);
  const docs = useMemo(() => items ?? [], [items]);
  useRenewGrants(docs);
  const queueIds = useMemo(
    () =>
      docs.flatMap((d) =>
        d.state.intent.backfill.items
          .map((item) => item.documentId)
          .filter((id): id is string => Boolean(id)),
      ),
    [docs],
  );
  const progress = useQueueProgress(queueIds);
  const connectionIds = useMemo(
    () =>
      docs
        .map((d) => d.state.resources.connectionId)
        .filter((id): id is string => Boolean(id)),
    [docs],
  );
  const connections = useConnectionRows(connectionIds);
  const triggers = useTriggerStates();
  const step = STEPS.find((s) => s === hash);
  // An open integration: #i/<document id>
  const openId = hash?.startsWith("i/") ? hash.slice(2) : null;
  const opened = openId ? docs.find((d) => d.id === openId) : undefined;
  const open = useCallback((id: string) => setHash(`i/${id}`), [setHash]);
  // Sync now: every live update on the page (a pull, or Sync all now); never a backfill
  const { syncing, sync } = useSyncNow();
  const rows = docs
    .map((d) =>
      syncRow(
        d.id,
        d.name,
        d.state,
        d.state.resources.liveWorkflowId
          ? triggers.get(d.state.resources.liveWorkflowId)
          : undefined,
      ),
    )
    .filter((r): r is SyncRow => r !== null);
  const live = rows
    .map((r) => r.workflowId)
    .filter((id): id is string => Boolean(id));
  const busy = live.some((id) => syncing.has(id));
  const summary = syncSummary(rows, triggers, busy);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Touches bubble up from the page; whatever scrolls it (the shell or
  // Connect's frame) must be at its top for a pull to start
  const pageRef = useCallback((el: HTMLElement | null) => setScroller(el), []);
  const ptr = usePullToRefresh(scroller, async () =>
    pullResult(await sync(live)),
  );

  if (opened) {
    return (
      <div className="sk-page">
        <IntegrationDetail
          integration={opened}
          progress={progress}
          connections={connections}
          onBack={() => setHash(null)}
        />
        <EndMark margin />
      </div>
    );
  }

  if (step) {
    return (
      <div className="sk-page">
        <div className="sk-stack sk-stack--6">
          <nav className="sk-breadcrumb" aria-label="Breadcrumb">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setHash(null);
              }}
            >
              Integrations
            </a>{" "}
            <span aria-hidden="true">/</span> <span>New</span>
          </nav>
          <CreateFlow
            step={step}
            go={(next: CreateStep) => setHash(next)}
            onDone={() => setHash(null, { replace: true })}
            onCancel={() => setHash(null)}
          />
        </div>
        <EndMark margin />
      </div>
    );
  }

  const add = (
    <Button variant="primary" icon="plus" onClick={() => setHash(firstStep(place))}>
      Add integration
    </Button>
  );
  const syncAll = (
    <Button
      icon="sync"
      disabled={live.length === 0 || busy}
      onClick={() => void sync(live)}
    >
      {busy ? "Syncing…" : "Sync all now"}
    </Button>
  );
  const groups = KINDS.map((k) => ({
    info: k,
    docs: docs
      .filter((d) => d.state.kind === k.kind)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.docs.length > 0);
  const unset = docs.filter((d) => !d.state.kind);

  return (
    <div className="sk-page" ref={pageRef}>
      <PullHeader
        {...ptr}
        words={{
          idle: `Everything · ${summary?.label.toLowerCase() ?? "nothing connected"}`,
          busy: "Checking for changes…",
          busySub: "Every integration",
        }}
      />
      <div className="sk-stack sk-stack--8">
        <PageHeader
          title="Integrations"
          lead="Your mail, bank accounts and calendars, kept up to date in Sektar."
          art={{ light: growthLight, dark: growthDark }}
          actions={
            docs.length > 0 ? (
              <>
                {syncAll}
                {add}
              </>
            ) : undefined
          }
        />
        {!items ? (
          <p className="sk-small sk-text-muted">Reading your integrations…</p>
        ) : docs.length === 0 ? (
          <EmptyState icon="sync" title="Nothing connected yet" action={add}>
            Pick an account and how far back to go. Sektar brings in what is
            there and keeps it up to date.
          </EmptyState>
        ) : (
          <div className="sk-stack sk-stack--8">
            {groups.map((g) => (
              <section key={g.info.kind} className="sk-integration-group">
                <h2
                  className="sk-h4"
                  style={{ margin: "0 0 var(--sk-space-4)" }}
                >
                  {g.info.label}{" "}
                  <span className="sk-text-muted sk-weight-regular">
                    {g.docs.length}
                  </span>
                </h2>
                <div className="sk-integration-grid">
                  {g.docs.map((d) => (
                    <IntegrationCard
                      key={d.id}
                      integration={d}
                      triggers={triggers}
                      progress={progress}
                      connections={connections}
                      onOpen={open}
                    />
                  ))}
                </div>
              </section>
            ))}
            {unset.length > 0 && (
              <section className="sk-integration-group">
                <h2
                  className="sk-h4"
                  style={{ margin: "0 0 var(--sk-space-4)" }}
                >
                  Not set up
                </h2>
                <div className="sk-integration-grid">
                  {unset.map((d) => (
                    <IntegrationCard
                      key={d.id}
                      integration={d}
                      triggers={triggers}
                      progress={progress}
                      connections={connections}
                      onOpen={open}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      <EndMark margin />
    </div>
  );
}
