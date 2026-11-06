// The switchboard's workflow runtime, as the integrations UI needs it: where
// it is (the selected drive's sync channel, else the default drive's, as
// Workflow Studio finds it) and the two OAuth2 calls of a sign-in. Requests
// carry the signed-in user's Renown token.
import {
  DriveCollectionId,
  type GqlRequestChannel,
} from "@powerhousedao/reactor";
import {
  DEFAULT_SWITCHBOARD_URL,
  parseDriveUrl,
  subgraphUrlFromGraphqlUrl,
  useDefaultDrivesUrl,
  useSelectedDriveSafe,
  useSyncList,
} from "@powerhousedao/reactor-browser";
import { ambientRenownTokenProvider } from "@powerhousedao/reactor-browser/graphql-client";
import { useMemo } from "react";
import type { RunRecord } from "./integration-detail.js";

const SUBGRAPH = "workflow-runtime";

function baseFromChannelUrl(channelUrl: string): string | undefined {
  try {
    const url = new URL(channelUrl);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/r\/?$/, "");
    return url.toString();
  } catch {
    return undefined;
  }
}

/** The workflow-runtime subgraph of the switchboard behind the selected drive. */
export function useWorkflowRuntimeUrl(): string {
  const [drive] = useSelectedDriveSafe();
  const remotes = useSyncList();
  const defaultDrivesUrl = useDefaultDrivesUrl();
  const driveId = drive?.header.id;
  return useMemo(() => {
    let base: string | undefined;
    if (driveId) {
      const remote = remotes.find((entry) =>
        entry.meta.collectionId.equals(DriveCollectionId.forDrive(driveId)),
      );
      const url = (remote?.channel as GqlRequestChannel | undefined)?.config
        .url;
      if (typeof url === "string") base = baseFromChannelUrl(url);
    }
    if (!base && defaultDrivesUrl) {
      try {
        base = parseDriveUrl(defaultDrivesUrl).graphqlEndpoint.replace(
          /\/r$/,
          "",
        );
      } catch {
        // a malformed default drive URL: the constant below
      }
    }
    return subgraphUrlFromGraphqlUrl(base ?? DEFAULT_SWITCHBOARD_URL, SUBGRAPH);
  }, [driveId, remotes, defaultDrivesUrl]);
}

async function gql<T>(
  url: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const token = await ambientRenownTokenProvider();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  if (!body.data)
    throw new Error(`The switchboard answered ${response.status}`);
  return body.data;
}

export type OAuthStart = { state: string; authorizationUrl: string };
export type OAuthAttempt = {
  status: "PENDING" | "EXCHANGING" | "OK" | "ERROR";
  error: string | null;
};

/** Opens a sign-in for the connection: the provider's page to send the user to. */
export async function startSignIn(
  url: string,
  connectionId: string,
): Promise<OAuthStart> {
  const data = await gql<{ workflowRuntime: { startOAuth: OAuthStart } }>(
    url,
    `mutation StartOAuth($connectionId: String!) {
      workflowRuntime { startOAuth(connectionId: $connectionId) { state authorizationUrl } }
    }`,
    { connectionId },
  );
  return data.workflowRuntime.startOAuth;
}

/**
 * How a sign-in to an OAuth app would go from this switchboard, as
 * startOAuth decides it: DESKTOP (the provider sends it back to this
 * machine), WEB (the host's own web client), RELAY (through the publisher's
 * relay), NONE (no client for it here). UNKNOWN when the switchboard cannot
 * say: a framework without the query, or any other failure.
 */
export type SignInMode = "DESKTOP" | "WEB" | "RELAY" | "NONE" | "UNKNOWN";

const SIGN_IN_MODES = new Set<string>(["DESKTOP", "WEB", "RELAY", "NONE"]);

export async function signInMode(
  url: string,
  appId: string,
): Promise<SignInMode> {
  try {
    const data = await gql<{
      workflowRuntime: { oauthSignIn: string | null } | null;
    }>(
      url,
      `query OAuthSignIn($appId: String!) {
        workflowRuntime { oauthSignIn(appId: $appId) }
      }`,
      { appId },
    );
    const mode = data.workflowRuntime?.oauthSignIn;
    return mode && SIGN_IN_MODES.has(mode) ? (mode as SignInMode) : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/** How a sign-in stands; null when the switchboard no longer knows it. */
export async function signInStatus(
  url: string,
  state: string,
): Promise<OAuthAttempt | null> {
  const data = await gql<{
    workflowRuntime: { oauthAttempt: OAuthAttempt | null };
  }>(
    url,
    `query OAuthAttempt($state: String!) {
      workflowRuntime { oauthAttempt(state: $state) { status error } }
    }`,
    { state },
  );
  return data.workflowRuntime.oauthAttempt;
}

/** How the runtime holds one workflow's trigger: when it last looked, and whether that worked. */
export type TriggerState = {
  workflowId: string;
  /** ENABLED | DISABLED | ERROR | PARKED */
  status: string;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
};

/** The triggers of the workflows this person may read. */
export async function triggerStates(url: string): Promise<TriggerState[]> {
  const data = await gql<{
    workflowRuntime: { triggerStates: TriggerState[] };
  }>(
    url,
    `query TriggerStates {
      workflowRuntime { triggerStates { workflowId status lastPollAt nextPollAt lastError } }
    }`,
    {},
  );
  return data.workflowRuntime.triggerStates;
}

export type RerunResult = {
  runId: string | null;
  status: string;
  error: string | null;
};

export type RunSummary = {
  id: string;
  status: string;
  error: string | null;
  /** What the trigger fired it with (for a backfill: its slice) */
  triggerPayload?: unknown;
  /** rerun, manual, or the trigger's own kind */
  triggerKind?: string;
};

/** How a run the runtime skipped because its workflow was parked begins its error. */
const SKIPPED_PARKED = "Skipped: this workflow is PARKED";

/** Runs an operator started (Try again's own reruns and fires); they never end a park. */
const OPERATOR_KINDS = new Set(["rerun", "manual"]);

/**
 * What "Try again" runs again after a park: the failed run that parked the
 * workflow (rerun: it resumes where it failed; see retryFailedRun), then
 * every firing the runtime refused while parked, oldest first (fired again
 * with its payload: a refused firing never ran, so it cannot be rerun; for a
 * backfill each is a slice that would otherwise be missing). An earlier Try
 * again's runs are looked past, and what they already brought in is left out,
 * so pressing it again picks up where the last one stopped. Null when the
 * newest outcome of the trigger is not a failure.
 */
export function runsToRetry(
  newestFirst: readonly RunSummary[],
): { failed: RunSummary | null; skipped: RunSummary[] } | null {
  const done = new Set<string>();
  const skipped: RunSummary[] = [];
  const key = (run: RunSummary) => JSON.stringify(run.triggerPayload ?? null);
  for (const run of newestFirst) {
    if (run.triggerKind && OPERATOR_KINDS.has(run.triggerKind)) {
      if (run.status === "SUCCEEDED") done.add(key(run));
      continue;
    }
    if (run.status === "CANCELLED" && run.error?.startsWith(SKIPPED_PARKED)) {
      if (!done.has(key(run))) skipped.push(run);
      continue;
    }
    if (run.status !== "FAILED") return null;
    return {
      failed: done.has(key(run)) ? null : run,
      skipped: skipped.reverse(),
    };
  }
  return null;
}

/** A workflow's latest runs, newest first (test runs left out). */
export async function latestRuns(
  url: string,
  workflowId: string,
  limit = 200,
): Promise<RunSummary[]> {
  const data = await gql<{ workflowRuntime: { runs: RunSummary[] } }>(
    url,
    `query Runs($workflowId: String!, $limit: Int) {
      workflowRuntime { runs(workflowId: $workflowId, limit: $limit, excludeTriggerKinds: ["test"]) { id status error triggerKind triggerPayload } }
    }`,
    { workflowId, limit },
  );
  return data.workflowRuntime.runs;
}

/** Runs one run again, with the payload it had (for a backfill: its slice). */
export async function rerun(url: string, runId: string): Promise<RerunResult> {
  const data = await gql<{ workflowRuntime: { rerun: RerunResult } }>(
    url,
    `mutation Rerun($runId: String!) {
      workflowRuntime { rerun(runId: $runId) { runId status error } }
    }`,
    { runId },
  );
  return data.workflowRuntime.rerun;
}

/** Fires a workflow by hand with a payload, as its trigger would have (an operator run: a park does not hold it). */
export async function fireWith(
  url: string,
  workflowId: string,
  payload: unknown,
): Promise<RerunResult> {
  const data = await gql<{ workflowRuntime: { fire: RerunResult } }>(
    url,
    `mutation Fire($workflowId: String!, $payload: Unknown) {
      workflowRuntime { fire(workflowId: $workflowId, payload: $payload) { runId status error } }
    }`,
    { workflowId, payload },
  );
  return data.workflowRuntime.fire;
}

/**
 * How the runtime ends a rerun it cannot resume from the run journal: a step
 * output it journaled redacted (a field named like a credential, such as
 * Google Calendar's nextSyncToken or an email's DKIM-Signature header) or
 * capped, which a later step reads.
 */
const FIRE_AGAIN = "fire the workflow again instead of rerunning it";

/** Whether a rerun ended because the runtime cannot replay the run, and says to fire it again. */
export function cannotReplay(result: RerunResult): boolean {
  return (
    result.status !== "SUCCEEDED" &&
    (result.error?.toLowerCase().includes(FIRE_AGAIN) ?? false)
  );
}

/**
 * Runs a failed run again: resumed where it failed, or, when the runtime
 * cannot replay it, fired again with the payload it had. Firing runs every
 * step again; an integration's steps read and upsert, so that brings in the
 * same items once.
 */
export async function retryFailedRun(
  url: string,
  workflowId: string,
  run: Pick<RunSummary, "id" | "triggerPayload">,
): Promise<RerunResult> {
  const result = await rerun(url, run.id);
  return cannotReplay(result)
    ? fireWith(url, workflowId, run.triggerPayload)
    : result;
}

/**
 * Sets a workflow's status through the switchboard (its Workflow mutations,
 * beside the runtime's subgraph), so the runtime sees it as its own write.
 */
export async function setWorkflowStatus(
  url: string,
  workflowId: string,
  status: "ENABLED" | "DISABLED",
): Promise<void> {
  const supergraph = url.replace(/\/workflow-runtime\/?$/, "");
  await gql(
    supergraph,
    `mutation SetStatus($id: String!, $input: Workflow_SetWorkflowStatusInput!) {
      Workflow { setWorkflowStatus(documentIdOrSlug: $id, input: $input) { __typename } }
    }`,
    { id: workflowId, input: { status } },
  );
}

/** Whether the runtime holds a workflow's trigger parked. */
export async function isParked(
  url: string,
  workflowId: string,
): Promise<boolean> {
  const states = await triggerStates(url);
  return states.find((t) => t.workflowId === workflowId)?.status === "PARKED";
}

export type RuntimeConnection = {
  id: string;
  name: string;
  connectorId: string;
  status: string;
  accountLabel: string | null;
};

/** The connections this person may use, as the runtime holds them. */
export async function runtimeConnections(
  url: string,
): Promise<RuntimeConnection[]> {
  const data = await gql<{
    workflowRuntime: { connections: RuntimeConnection[] };
  }>(
    url,
    `query Connections { workflowRuntime { connections { id name connectorId status accountLabel } } }`,
    {},
  );
  return data.workflowRuntime.connections;
}

export type BlockRef = {
  pieceName: string;
  pieceVersion: string;
  name: string;
  kind: "action" | "trigger";
};

export type DropdownOptions = {
  options: { label: string; value: unknown }[];
  placeholder?: string;
  disabled?: boolean;
};

/** A piece's dropdown, resolved by the runtime on a connection (no workflow needed). */
export async function blockOptions(
  url: string,
  block: BlockRef,
  propName: string,
  input: Record<string, unknown>,
  connectionId: string,
): Promise<DropdownOptions> {
  const data = await gql<{
    workflowRuntime: { blockOptions: DropdownOptions | null };
  }>(
    url,
    `query BlockOptions($block: BlockInput!, $prop: String!, $input: Unknown, $connectionId: String) {
      workflowRuntime { blockOptions(block: $block, propName: $prop, input: $input, connectionId: $connectionId) }
    }`,
    { block, prop: propName, input, connectionId },
  );
  return data.workflowRuntime.blockOptions ?? { options: [] };
}

/**
 * Runs a workflow's trigger now, as its schedule or poll would ("sync now").
 * False when it has no armed trigger (live updates off, stopped, failing).
 */
export async function pollNow(
  url: string,
  workflowId: string,
): Promise<boolean> {
  const data = await gql<{ workflowRuntime: { pollNow: boolean } }>(
    url,
    `mutation PollNow($workflowId: String!) {
      workflowRuntime { pollNow(workflowId: $workflowId) }
    }`,
    { workflowId },
  );
  return data.workflowRuntime.pollNow;
}

/**
 * Runs a workflow now with `payload` as its trigger payload, and waits for the
 * run to end. Unlike pollNow, the steps see what this call passes (a manual
 * bank refresh passes the person on screen). True when the run succeeded.
 */
export async function fireWorkflow(
  url: string,
  workflowId: string,
  payload: unknown,
): Promise<boolean> {
  const data = await gql<{
    workflowRuntime: { fire: { status?: string } | null };
  }>(
    url,
    `mutation Fire($workflowId: String!, $payload: Unknown) {
      workflowRuntime { fire(workflowId: $workflowId, payload: $payload) { status } }
    }`,
    { workflowId, payload },
  );
  return data.workflowRuntime.fire?.status === "SUCCEEDED";
}

/** The latest runs of a workflow with their steps' outputs, newest first (test runs left out). */
export async function runsWithSteps(
  url: string,
  workflowId: string,
  limit = 10,
): Promise<RunRecord[]> {
  const data = await gql<{ workflowRuntime: { runs: RunRecord[] } }>(
    url,
    `query RunsWithSteps($workflowId: String!, $limit: Int) {
      workflowRuntime { runs(workflowId: $workflowId, limit: $limit, excludeTriggerKinds: ["test"]) {
        id status error startedAt endedAt triggerKind workflowName steps { stepKey status output }
      } }
    }`,
    { workflowId, limit },
  );
  return data.workflowRuntime.runs;
}

/**
 * A workflow's run history without step outputs, newest first, a page at a
 * time up to `max` runs: the plain listing stops at 100, and a backfill
 * has thousands.
 */
export async function runHistory(
  url: string,
  workflowId: string,
  max = 1000,
): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let cursor: string | null = null;
  while (runs.length < max) {
    const data: {
      workflowRuntime: {
        runsPage: {
          items: Omit<RunRecord, "steps">[];
          hasNextPage: boolean;
          cursor: string | null;
        };
      };
    } = await gql(
      url,
      `query RunHistory($workflowId: String!, $cursor: String) {
        workflowRuntime { runsPage(workflowId: $workflowId, excludeTriggerKinds: ["test"], paging: { limit: 100, cursor: $cursor }) {
          items { id status error startedAt endedAt triggerKind triggerPayload workflowName }
          hasNextPage cursor
        } }
      }`,
      { workflowId, cursor },
    );
    const page = data.workflowRuntime.runsPage;
    runs.push(...page.items.map((run) => ({ ...run, steps: [] })));
    if (!page.hasNextPage || !page.cursor) break;
    cursor = page.cursor;
  }
  return runs;
}
