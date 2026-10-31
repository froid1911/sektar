import type {
  AiGatewayStatus,
  UseAiGatewayResult,
} from "@powerhousedao/reactor-browser/ai";
import { Link, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import {
  count,
  percentLabel,
  percentOf,
  plural,
  STATUS,
  statusOf,
} from "../../../../editors/backfills/lib.js";
import {
  useHubDrive,
  useIntegrationItems,
  useQueueRows,
  type QueueListRow,
} from "../../../../editors/sektar/kit/integration-index.js";
import { addHashFor, kindInfo } from "../../../../editors/sektar/kit/integrations.js";
import {
  Badge,
  Card,
  Icon,
  IconTile,
  ListItem,
  ProgressRow,
} from "../../../../editors/sektar/kit/ui.js";
import {
  missingKinds,
  unfinishedBackfills,
} from "../../../../editors/sektar/kit/welcome-status.js";
import { KeyCard } from "./assistant.js";

/**
 * What sits beside the conversation: a side pane on a wide screen, the sheet
 * behind the three dots on a narrow one. Everything but the key comes from
 * the integration index, polled by the same hooks as the Integrations and
 * Backfills pages; until the index has answered, those boxes show nothing.
 */
export function AssistantSidebar({
  status,
  gateway,
}: {
  status: AiGatewayStatus;
  gateway: UseAiGatewayResult;
}) {
  return (
    <div className="sk-assistant-side sk-stack sk-stack--4">
      <KeyCard status={status} gateway={gateway} />
      <Suspense fallback={null}>
        <SetupCard />
        <BackfillsCard />
      </Suspense>
    </div>
  );
}

/** The accounts still to connect; gone once all three exist. */
function SetupCard() {
  const items = useIntegrationItems();
  const drive = useHubDrive("integrations");
  const navigate = useNavigate();
  const missing = missingKinds(items);
  if (!drive || missing.length === 0) return null;
  return (
    <Card compact title="Connect your accounts">
      <p className="sk-small sk-text-muted">
        Your mail, bank accounts and calendars, kept up to date in Sektar.
      </p>
      <ul className="sk-list sk-assistant-side__kinds">
        {missing.map((kind) => {
          const info = kindInfo(kind);
          if (!info) return null;
          return (
            <li key={kind}>
              <ListItem
                icon={<IconTile name={info.icon} size="sm" />}
                title={info.label}
                meta={info.lead}
                chevron
                onClick={() =>
                  void navigate({
                    to: "/d/$driveSlug/{-$nodeSlug}",
                    params: { driveSlug: drive.header.id },
                    hash: addHashFor(kind),
                  })
                }
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The backfills still running or waiting, with how far each has got. */
function BackfillsCard() {
  const rows = useQueueRows(null);
  const drive = useHubDrive("backfills");
  const unfinished = unfinishedBackfills(rows);
  if (!drive || unfinished.length === 0) return null;
  return (
    <Card
      compact
      title="Backfills"
      actions={
        <Link
          to="/d/$driveSlug/{-$nodeSlug}"
          params={{ driveSlug: drive.header.id }}
          className="sk-btn sk-btn--link sk-btn--sm"
        >
          Open Backfills
          <Icon name="chevron-right" />
        </Link>
      }
    >
      {unfinished.map((row) => (
        <BackfillRow key={row.id} row={row} />
      ))}
    </Card>
  );
}

/** One backfill, in the words and the bar of its row on the Backfills page. */
function BackfillRow({ row }: { row: QueueListRow }) {
  const status = STATUS[statusOf(row)];
  const started = statusOf(row) !== "DRAFT" && row.total > 0;
  return (
    <div className="sk-integration__row">
      <div>
        <div className="sk-integration__label">
          {row.name || "Untitled backfill"}
        </div>
        <div className="sk-integration__meta">
          {started && `${count(row.iteration)} of ${count(row.total)}`}
          {row.awaitingValues && <span> · waiting for values</span>}
          {row.errorCount > 0 && (
            <span className="sk-text-danger">
              {" "}
              · {plural(row.errorCount, "failure")}
            </span>
          )}
        </div>
      </div>
      <Badge tone={status.tone} dot pill>
        {status.label}
      </Badge>
      {started && (
        <ProgressRow value={percentOf(row)} label={percentLabel(row)} />
      )}
    </div>
  );
}
