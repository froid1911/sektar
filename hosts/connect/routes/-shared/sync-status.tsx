import { useDrives } from "@powerhousedao/reactor-browser";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cx, Icon } from "../../../../editors/sektar/kit/ui.js";
import {
  sortRows,
  syncRow,
  syncSummary,
  type SyncRow,
} from "../../../../editors/sektar/kit/sync-status.js";
import {
  useIntegrations,
  useSyncNow,
  useTriggerStates,
} from "../../../../editors/sektar/kit/use-sync.js";
import { findDrive } from "../../../../processors/drives/index.js";

/**
 * The top bar's sync status (design system: Patterns · Integrations · Sync
 * status): every integration in one line, the worst state first, and a
 * panel behind it with a row each and Sync all. Below 900px it is an icon
 * with a dot; on the phone, pull to refresh says it instead (app.css).
 * Nothing while there are no integrations.
 */
export function SyncStatus() {
  const docs = useIntegrations();
  const triggers = useTriggerStates();
  const { syncing, sync } = useSyncNow();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const drives = useDrives();
  // "4 min ago" moves on between trigger reads
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(
    () =>
      sortRows(
        docs
          .map((d) =>
            syncRow(
              d.id,
              d.name || "Integration",
              d.state,
              d.state.resources.liveWorkflowId
                ? triggers.get(d.state.resources.liveWorkflowId)
                : undefined,
              now,
            ),
          )
          .filter((r): r is SyncRow => r !== null),
      ),
    [docs, triggers, now],
  );
  const busy = rows.some((r) => r.workflowId && syncing.has(r.workflowId));
  const summary = syncSummary(rows, triggers, busy, now);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!summary) return null;
  const live = rows
    .map((r) => r.workflowId)
    .filter((id): id is string => Boolean(id));
  const openIntegrations = (id?: string) => {
    setOpen(false);
    void navigate({
      to: "/d/$driveSlug/{-$nodeSlug}",
      params: { driveSlug: "integrations" },
      hash: id ? `i/${id}` : undefined,
    }).then(() => {
      // The page follows the hash (useHashStep); a push does not announce it
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  };

  return (
    <div
      className={cx("sk-menu-host sk-sync-chip", open && "is-open")}
      ref={host}
    >
      <button
        type="button"
        className={cx(
          "sk-sync-status sk-sync-chip__full",
          summary.attention &&
            summary.dot === "error" &&
            "sk-sync-status--error",
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={cx("sk-sync-dot", `sk-sync-dot--${summary.dot}`)} />
        {summary.attention ? <b>{summary.label}</b> : summary.label}
      </button>
      <button
        type="button"
        className="sk-btn sk-btn--icon sk-btn--ghost sk-sync-chip__icon"
        aria-label={`Sync status: ${summary.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sync" />
        <span
          className={cx(
            "sk-sync-dot sk-sync-chip__dot",
            `sk-sync-dot--${summary.dot}`,
          )}
        />
      </button>
      {open && (
        <div
          className="sk-menu sk-menu--popover sk-menu--end sk-sync-panel"
          role="dialog"
          aria-label="Sync status"
        >
          <div className="sk-sync-panel__head">
            <div>
              <div className="sk-weight-medium">Sync</div>
              <div className="sk-caption sk-text-muted">{summary.counts}</div>
            </div>
            <Button
              size="sm"
              icon="sync"
              disabled={live.length === 0 || busy}
              onClick={() => void sync(live)}
            >
              {busy ? "Syncing…" : "Sync all"}
            </Button>
          </div>
          <ul className="sk-sync-panel__list">
            {rows.map((r) => {
              const running = Boolean(
                r.workflowId && syncing.has(r.workflowId),
              );
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="sk-sync-panel__item"
                    onClick={() => openIntegrations(r.id)}
                  >
                    {running ? (
                      <span
                        className="sk-spinner"
                        style={{ width: 12, height: 12 }}
                      />
                    ) : (
                      <span
                        className={cx("sk-sync-dot", `sk-sync-dot--${r.dot}`)}
                      />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div className="sk-sync-panel__name">{r.name}</div>
                      <div className="sk-sync-panel__meta">
                        {running ? "Checking for changes" : r.meta}
                      </div>
                    </div>
                    <span className="sk-sync-panel__when">
                      {running ? "now" : r.when}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="sk-sync-panel__foot">
            <button
              type="button"
              className="sk-btn sk-btn--link sk-btn--sm"
              onClick={() => openIntegrations()}
            >
              Manage integrations <Icon name="chevron-right" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
