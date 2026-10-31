// Reading the integrations, their backfill queues and their connections
// through the integration index (processors/integration-index) rather than
// their documents. Behind a remote drive the switchboard answers over
// GraphQL; with the drive in the tab's own reactor the same queries run live
// on its database. The chip, the cards and the lists show rows; a queue
// document is loaded only when it is opened in Backfills.
//
// The three types live in three drives, found by slug from the drive
// headers: "integrations", "backfills" and "workflows". A drive's nodes are
// never read, so a legacy drive and a reactor-drive read the same.
import { findDrive } from "../../../processors/drives/index.js";
import {
  useDrives,
  useReactorClient,
  useRelationalQuery,
} from "@powerhousedao/reactor-browser";
import type { DocumentDriveDocument } from "@powerhousedao/shared/document-drive";
import type { IntegrationState } from "document-models/integration";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cleanIds,
  connectionsQuery,
  CONNECTION_DOCUMENT_TYPE,
  INTEGRATION_DOCUMENT_TYPE,
  IntegrationIndex,
  integrationsQuery,
  QUEUE_DOCUMENT_TYPE,
  queuesQuery,
  toConnectionRow,
  toIntegrationRow,
  toQueueRow,
  type ConnectionIndexRow,
  type ConnectionListRow,
  type DB,
  type IntegrationIndexRow,
  type IntegrationListRow,
  type QueueIndexRow,
  type QueueListRow,
} from "../../../processors/integration-index/index.js";
import type { QueueProgress } from "../../backfills/progress.js";
import { indexGql as gql } from "./index-gql.js";
import { useMailIndexMode } from "./mail-index.js";

export type { ConnectionListRow, QueueListRow };

/** The drives the three types live in (hosts/switchboard seeds them by slug). */
export type HubSlug = "integrations" | "backfills" | "workflows";

/** An integration as the screens read it: the index row, its state parsed. */
export interface IntegrationItem {
  id: string;
  /** The document's name; "" when it has none. */
  name: string;
  state: IntegrationState;
  updatedAt: string;
}

const REFRESH_DEBOUNCE_MS = 600;
const REFRESH_INTERVAL_MS = 30_000;
const RETRY_MS = 5_000;
/** How long a switch this tab flipped wins over an index that has not caught up. */
const PATCH_FOR_MS = 20_000;

const TYPES = [
  INTEGRATION_DOCUMENT_TYPE,
  QUEUE_DOCUMENT_TYPE,
  CONNECTION_DOCUMENT_TYPE,
] as const;

/**
 * A hub drive by slug, from the drive headers alone.
 */
export function useHubDrive(slug: HubSlug): DocumentDriveDocument | undefined {
  const drives = useDrives();
  return useMemo(() => findDrive(drives, slug), [drives, slug]);
}

/* ------------------------------------------------------------ changes */

/**
 * Integration, queue or connection documents changed (edited, added,
 * removed): `onChange` is called once the burst has settled. The index
 * follows the documents a beat later, which the settling covers.
 */
function useIntegrationChanges(enabled: boolean, onChange: () => void): void {
  const client = useReactorClient();
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!enabled || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ref.current(), REFRESH_DEBOUNCE_MS);
    };
    const stops: (() => void)[] = [];
    for (const type of TYPES) {
      try {
        stops.push(client.subscribe({ type }, settle));
      } catch {
        // no realtime channel: the poll still follows
      }
    }
    return () => {
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [enabled, client]);
}

/* ------------------------------------------------------------- remote */

/** Answers by key, shared by every mount: the chip and a page ask once between them. */
const answers = new Map<string, unknown>();
const asking = new Map<string, Promise<unknown>>();
const ANSWERS_MAX = 32;

function remember(key: string, value: unknown): void {
  answers.delete(key);
  answers.set(key, value);
  while (answers.size > ANSWERS_MAX) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
  }
}

function ask<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const pending = asking.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const request = fetch()
    .then((value) => {
      remember(key, value);
      return value;
    })
    .finally(() => asking.delete(key));
  asking.set(key, request);
  return request;
}

/**
 * One index answer, asked when `key` changes, again shortly after one of the
 * three types changes, and every half minute while the tab is visible. The
 * previous answer stays while a new key is on its way. Undefined until known.
 */
function useRemoteAnswer<T>(
  key: string,
  enabled: boolean,
  fetch: () => Promise<T>,
): T | undefined {
  const [answer, setAnswer] = useState<{ key: string; value: T } | null>(() =>
    answers.has(key) ? { key, value: answers.get(key) as T } : null,
  );
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    ask(key, () => fetchRef.current())
      .then((value) => {
        if (active) setAnswer({ key, value });
      })
      .catch(() => {
        // keep what was known; ask again shortly
        if (active) retry = setTimeout(() => setTick((n) => n + 1), RETRY_MS);
      });
    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [key, enabled, tick]);

  const again = useCallback(() => setTick((n) => n + 1), []);
  useIntegrationChanges(enabled, again);
  useEffect(() => {
    if (!enabled) return;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") again();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(poll);
  }, [enabled, again]);

  if (answer?.key === key) return answer.value;
  if (answers.has(key)) return answers.get(key) as T;
  return answer?.value;
}

const INTEGRATIONS_QUERY = `query ($d: String!) {
  integrationIndex { integrations(driveId: $d) {
    id name kind provider archived liveEnabled backfillEnabled liveWorkflowId backfillWorkflowId connectionId mailbox address queueIds state updatedAt
  } }
}`;

const QUEUES_QUERY = `query ($d: String!, $ids: [String!]) {
  integrationIndex { queues(driveId: $d, ids: $ids) {
    id name status description loops total progress iteration done finished awaitingValues errorCount lastError searchText updatedAt
  } }
}`;

const CONNECTIONS_QUERY = `query ($d: String!, $ids: [String!]!) {
  integrationIndex { connections(driveId: $d, ids: $ids) {
    id name connectorId accountLabel status lastCheckedAt lastError updatedAt
  } }
}`;

/* -------------------------------------------------------------- local */

type IntegrationQB = Parameters<
  Parameters<typeof useRelationalQuery<DB, IntegrationIndexRow, undefined>>[2]
>[0];

type IdParams = { ids: string[] | null };

function useLocalIntegrations(
  enabled: boolean,
  driveId: string | null,
): IntegrationListRow[] | undefined {
  const build = useCallback(
    (db: IntegrationQB) => integrationsQuery(db).compile(),
    [],
  );
  const q = useRelationalQuery<DB, IntegrationIndexRow, undefined>(
    IntegrationIndex,
    enabled ? (driveId ?? "") : "",
    build,
  );
  return useMemo(
    () => (enabled && q.result ? q.result.rows.map(toIntegrationRow) : undefined),
    [enabled, q.result],
  );
}

function useLocalQueues(
  enabled: boolean,
  driveId: string | null,
  ids: string[] | null,
): QueueListRow[] | undefined {
  const params = useMemo<IdParams>(() => ({ ids }), [ids]);
  // An empty list asks for nothing, so nothing is queried.
  const asks = enabled && (ids === null || ids.length > 0);
  const build = useCallback(
    (db: IntegrationQB, p?: IdParams) =>
      queuesQuery(db, (p ?? params).ids).compile(),
    [params],
  );
  const q = useRelationalQuery<DB, QueueIndexRow, IdParams>(
    IntegrationIndex,
    asks ? (driveId ?? "") : "",
    build,
    params,
  );
  return useMemo(() => {
    if (!enabled) return undefined;
    if (!asks) return [];
    return q.result ? q.result.rows.map(toQueueRow) : undefined;
  }, [enabled, asks, q.result]);
}

function useLocalConnections(
  enabled: boolean,
  driveId: string | null,
  ids: string[],
): ConnectionListRow[] | undefined {
  const params = useMemo<IdParams>(() => ({ ids }), [ids]);
  const asks = enabled && ids.length > 0;
  const build = useCallback(
    (db: IntegrationQB, p?: IdParams) =>
      connectionsQuery(db, (p ?? params).ids ?? []).compile(),
    [params],
  );
  const q = useRelationalQuery<DB, ConnectionIndexRow, IdParams>(
    IntegrationIndex,
    asks ? (driveId ?? "") : "",
    build,
    params,
  );
  return useMemo(() => {
    if (!enabled) return undefined;
    if (!asks) return [];
    return q.result ? q.result.rows.map(toConnectionRow) : undefined;
  }, [enabled, asks, q.result]);
}

/* ---------------------------------------------------- optimistic patch */

type Patch = { apply: (s: IntegrationState) => IntegrationState; since: string; at: number };

/** Switches this tab flipped, by integration id, until the index says so too. */
const patches = new Map<string, Patch[]>();
const patchListeners = new Set<() => void>();

/**
 * Shows a change this tab just dispatched on an integration before the index
 * has it: the switch flips at once. It stands until a row newer than
 * `since` (the row's updatedAt when the change was made) arrives, or 20 s.
 */
export function patchIntegration(
  item: Pick<IntegrationItem, "id" | "updatedAt">,
  apply: (s: IntegrationState) => IntegrationState,
): void {
  const list = patches.get(item.id) ?? [];
  patches.set(item.id, [...list, { apply, since: item.updatedAt, at: Date.now() }]);
  for (const l of patchListeners) l();
}

function usePatchVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((n) => n + 1);
    patchListeners.add(listener);
    // an expired patch drops out on the next look
    const timer = setInterval(listener, PATCH_FOR_MS / 2);
    return () => {
      patchListeners.delete(listener);
      clearInterval(timer);
    };
  }, []);
  return version;
}

/** Parsed states by row, so an unchanged row keeps its object (memoised views stay put). */
const parsed = new Map<string, { text: string; state: IntegrationState }>();

function stateOf(row: IntegrationListRow): IntegrationState {
  const known = parsed.get(row.id);
  if (known?.text === row.state) return known.state;
  // The column holds the document's own global state (rows.ts).
  const state = JSON.parse(row.state) as IntegrationState;
  parsed.set(row.id, { text: row.state, state });
  return state;
}

function withPatches(row: IntegrationListRow, now: number): IntegrationItem {
  const base: IntegrationItem = {
    id: row.id,
    name: row.name ?? "",
    state: stateOf(row),
    updatedAt: row.updatedAt,
  };
  const list = patches.get(row.id);
  if (!list) return base;
  const live = list.filter((p) => row.updatedAt <= p.since && now - p.at < PATCH_FOR_MS);
  if (live.length === 0) {
    patches.delete(row.id);
    return base;
  }
  if (live.length !== list.length) patches.set(row.id, live);
  return {
    ...base,
    state: live.reduce((s, p) => p.apply(structuredClone(s)), base.state),
  };
}

/** Stable empty answers: an empty question is answered without asking. */
const NO_QUEUES: QueueListRow[] = [];
const NO_CONNECTIONS: ConnectionListRow[] = [];

/* ---------------------------------------------------------------- api */

/**
 * The integrations in a drive (the "integrations" drive unless one is
 * given), by name; undefined until the index has answered.
 */
export function useIntegrationItems(
  drive?: DocumentDriveDocument,
): IntegrationItem[] | undefined {
  const hub = useHubDrive("integrations");
  const target = drive ?? hub;
  const mode = useMailIndexMode(target);
  const driveId = target?.header.id ?? null;
  const base = mode.kind === "remote" ? mode.base : null;
  const remote = useRemoteAnswer<IntegrationListRow[]>(
    JSON.stringify(["integrations", base, driveId]),
    base !== null && driveId !== null,
    async () =>
      (
        await gql<{ integrationIndex: { integrations: IntegrationListRow[] } }>(
          base ?? "",
          INTEGRATIONS_QUERY,
          { d: driveId },
        )
      ).integrationIndex.integrations,
  );
  const local = useLocalIntegrations(mode.kind === "local", driveId);
  const rows = mode.kind === "local" ? local : remote;
  const version = usePatchVersion();
  return useMemo(() => {
    if (!rows) return undefined;
    const now = Date.now();
    return rows.map((r) => withPatches(r, now));
    // `version` re-applies the patches when one is added or runs out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, version]);
}

/** A stable list of ids for a hook's key: sorted and distinct. */
function useIdKey(ids: readonly string[] | null): string[] | null {
  const key = ids === null ? null : cleanIds(ids).sort().join(",");
  return useMemo(() => (key === null ? null : key ? key.split(",") : []), [key]);
}

/**
 * The backfill queues in a drive (the "backfills" drive unless one is
 * given): every one with `ids` null, else those of `ids`. Undefined until
 * the index has answered.
 */
export function useQueueRows(
  ids: readonly string[] | null,
  drive?: DocumentDriveDocument,
): QueueListRow[] | undefined {
  const hub = useHubDrive("backfills");
  const target = drive ?? hub;
  const mode = useMailIndexMode(target);
  const driveId = target?.header.id ?? null;
  const base = mode.kind === "remote" ? mode.base : null;
  const asked = useIdKey(ids);
  const none = asked !== null && asked.length === 0;
  const remote = useRemoteAnswer<QueueListRow[]>(
    JSON.stringify(["queues", base, driveId, asked]),
    base !== null && driveId !== null && !none,
    async () =>
      (
        await gql<{ integrationIndex: { queues: QueueListRow[] } }>(
          base ?? "",
          QUEUES_QUERY,
          { d: driveId, ids: asked },
        )
      ).integrationIndex.queues,
  );
  const local = useLocalQueues(mode.kind === "local", driveId, asked);
  if (none) return NO_QUEUES;
  return mode.kind === "local" ? local : remote;
}

/** How far each queue of `ids` has walked, by id, for the cards and the detail. */
export function useQueueProgress(
  ids: readonly string[],
): ReadonlyMap<string, QueueProgress> | undefined {
  const rows = useQueueRows(ids);
  return useMemo(
    () =>
      rows
        ? new Map(
            rows.map((r) => [
              r.id,
              { done: r.done, total: r.total, finished: r.finished },
            ]),
          )
        : undefined,
    [rows],
  );
}

const ON_SCREEN_QUERY = `query ($d: String!) {
  integrationIndex { onScreen(driveId: $d) { ipAddress userAgent } }
}`;

/** The person on screen as a bank sees them: public address and browser. */
export interface OnScreen {
  ipAddress: string;
  userAgent: string;
}

/**
 * Asks the switchboard who is on screen (subgraphs/integration-index/on-screen.ts):
 * the address it sees the request come from. Null where it sees no public
 * address (localhost, the LAN) or where the tab runs its own reactor.
 */
export function useOnScreen(): () => Promise<OnScreen | null> {
  const hub = useHubDrive("integrations");
  const mode = useMailIndexMode(hub);
  const driveId = hub?.header.id ?? null;
  const base = mode.kind === "remote" ? mode.base : null;
  return useCallback(async () => {
    if (!base || !driveId) return null;
    try {
      // The subgraph's own endpoint: the gateway does not pass the
      // request's X-Forwarded-For and User-Agent on to a subgraph
      const data = await gql<{ integrationIndex: { onScreen: OnScreen | null } }>(
        base,
        ON_SCREEN_QUERY,
        { d: driveId },
        "/graphql/integration-index",
      );
      return data.integrationIndex.onScreen;
    } catch {
      return null;
    }
  }, [base, driveId]);
}

/** The connections of `ids`, by id, from the "workflows" drive. Undefined until known. */
export function useConnectionRows(
  ids: readonly string[],
): ReadonlyMap<string, ConnectionListRow> | undefined {
  const target = useHubDrive("workflows");
  const mode = useMailIndexMode(target);
  const driveId = target?.header.id ?? null;
  const base = mode.kind === "remote" ? mode.base : null;
  const asked = useIdKey(ids) ?? [];
  const none = asked.length === 0;
  const remote = useRemoteAnswer<ConnectionListRow[]>(
    JSON.stringify(["connections", base, driveId, asked]),
    base !== null && driveId !== null && !none,
    async () =>
      (
        await gql<{ integrationIndex: { connections: ConnectionListRow[] } }>(
          base ?? "",
          CONNECTIONS_QUERY,
          { d: driveId, ids: asked },
        )
      ).integrationIndex.connections,
  );
  const local = useLocalConnections(mode.kind === "local", driveId, asked);
  const rows = none ? NO_CONNECTIONS : mode.kind === "local" ? local : remote;
  return useMemo(
    () => (rows ? new Map(rows.map((r) => [r.id, r])) : undefined),
    [rows],
  );
}
