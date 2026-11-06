/**
 * One reconcile pass over an integration, with its IO injected so it runs
 * the same in tests: claim the integration for this switchboard, make sure
 * its connection exists and asks for what the user chose, and report what
 * is left for the user (the sign-in). Later pilot steps add the workflows
 * and backfills here. Design: workspace/integrations-design.md, section 3.3.
 *
 * Every write is the reconciler's own operation (RECORD_*), never intent,
 * and a check is only written when what it says changed: the processor sees
 * its own writes, and an unchanged check must not make another pass.
 */
import type { OriginalSourceQueueAction } from "document-models/original-source-queue";
import type { QueueState } from "../../editors/backfills/progress.js";
import {
  OSQ_TYPE,
  queueProgress,
  queueSetup,
  rangeOf,
  SLICE_RANGE,
} from "./backfill-osq.js";
import { coverageGaps, itemSpan, spanLabel, type Span } from "./coverage.js";
import { backfillWorkflowSpec, liveWorkflowSpec } from "./backfill-workflow.js";
import {
  providerFor,
  type ConnectionSpec,
  type ProviderAdapter,
  type ProviderContext,
} from "./providers/index.js";
import type { ReconcileGrant } from "./grant.js";
import {
  buildWorkflow,
  disableAction,
  managedByAction,
  runtimeIssue,
  withPublish,
  workflowDrift,
  type Drift,
  type RuntimeHealth,
  type WorkflowAction,
  type WorkflowFacts,
} from "./workflow-spec.js";
import {
  actions,
  type IntegrationAction,
  type IntegrationIssue,
  type IntegrationState,
} from "document-models/integration";

export type Host = { reactorId: string; label: string };

/** What a connection is, as far as a pass needs to know. */
export type ConnectionFacts = {
  /** The connection document's status: OK once a sign-in worked */
  status: string;
  /** It holds a token: someone signed in */
  signedIn: boolean;
  /** The scopes it asks for (config oauth_scopes) */
  scopes: string[];
  /** The scopes its sign-in was granted (config oauth_granted_scopes); null: not recorded */
  granted?: string[] | null;
  /** Who it is (accountLabel), e.g. the signed-in address */
  accountLabel?: string | null;
};

export type { ConnectionSpec } from "./providers/index.js";
export { GOOGLE_APP } from "./providers/google-calendar.js";

/** Why a provider's drive blocks the live workflow, in the user's words. */
const DRIVE_MISSING: Record<"mail" | "calendar", string> = {
  mail: "The Mail drive the messages go into is not on this computer yet",
  calendar: "The Calendar drive the events go into is not on this computer yet",
};

/** The same, said by a runner that is an environment rather than a computer. */
const DRIVE_MISSING_HERE: Record<"mail" | "calendar", string> = {
  mail: "The Mail drive the messages go into is not in this environment yet",
  calendar:
    "The Calendar drive the events go into is not in this environment yet",
};

export interface ReconcileIO {
  me: Host;
  /**
   * The runner is an environment at a public address (runner.ts), not
   * someone's computer: the texts say "in this environment", and a sign-in
   * finishes with the card's button wherever the person is.
   */
  environment?: boolean;
  /** Who publishes for this integration on this pass (grant.ts) */
  grant: ReconcileGrant;
  now(): string;
  /** Null when the document is gone */
  readConnection(id: string): Promise<ConnectionFacts | null>;
  /** Creates the connection document; returns its id */
  createConnection(spec: ConnectionSpec): Promise<string>;
  /** Sets these config values on the connection, leaving the others (new scopes after an access change) */
  setConnectionConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<void>;
  dispatch(actions: IntegrationAction[]): Promise<void>;
  /** Deletes a document this integration built (its connection, its workflows) */
  deleteDocument(id: string): Promise<void>;
  /** Deletes the integration document itself, once everything it built is gone */
  deleteIntegration(): Promise<void>;
  /** A new object id */
  newId(): string;
  /** The switchboard's own reactor connection, for steps that write documents */
  findReactorConnection(): Promise<string | null>;
  /** The id of the drive under a slug; null while it has none */
  drive(slug: string): Promise<string | null>;
  /** Null when the workflow document is gone */
  readWorkflow(id: string): Promise<WorkflowFacts | null>;
  /** Creates a workflow document in the Workflows drive and applies the actions; returns its id */
  createWorkflow(name: string, actions: WorkflowAction[]): Promise<string>;
  updateWorkflow(id: string, actions: WorkflowAction[]): Promise<void>;
  /** How the workflow runtime holds the workflow; null where no runtime runs */
  workflowHealth(id: string): Promise<RuntimeHealth | null>;
  /** Creates a backfill queue in the Backfills drive and applies its setup; returns its id */
  createQueue(
    name: string,
    actions: OriginalSourceQueueAction[],
  ): Promise<string>;
  /** Null when the queue document is gone */
  readQueue(id: string): Promise<QueueState | null>;
}

/** The connection an integration needs, from its provider; null when no provider here serves it. */
export function connectionFor(
  name: string,
  state: IntegrationState,
): ConnectionSpec | null {
  return providerFor(state)?.connection(name, state) ?? null;
}

const sameScopes = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

/** The issues a check reports, compared on what the user sees. */
function sameIssues(
  a: readonly Pick<IntegrationIssue, "code" | "message" | "severity">[],
  b: readonly Pick<IntegrationIssue, "code" | "message" | "severity">[],
): boolean {
  const key = (i: Pick<IntegrationIssue, "code" | "message" | "severity">) =>
    `${i.code}|${i.severity}|${i.message}`;
  return a.map(key).sort().join("\n") === b.map(key).sort().join("\n");
}

export async function reconcileIntegration(
  doc: { id: string; name: string; state: IntegrationState },
  io: ReconcileIO,
): Promise<void> {
  const s = doc.state;
  // The user removed it: on its runner (or with none yet), take down what
  // it built, then the integration itself. The data it brought in stays.
  if (s.intent.archived) {
    if (s.runner && s.runner.reactorId !== io.me.reactorId) return;
    // A connection it was given (an API key shared with others) stays.
    const ownsConnection = providerFor(s)?.auth !== "apiKey";
    const built = [
      s.resources.liveWorkflowId,
      s.resources.backfillWorkflowId,
      ...s.intent.backfill.items.map((item) => item.documentId),
      ownsConnection ? s.resources.connectionId : null,
    ].filter((id): id is string => Boolean(id));
    for (const id of built) await io.deleteDocument(id);
    await io.deleteIntegration();
    return;
  }
  // Not set up yet.
  if (!s.kind) return;

  // Ours, or nobody's yet: claim it. Another switchboard's: leave it alone.
  if (s.runner && s.runner.reactorId !== io.me.reactorId) return;
  if (!s.runner || s.runner.label !== io.me.label) {
    await io.dispatch([actions.recordRunner(io.me)]);
  }

  const provider = providerFor(s);
  const issues: IntegrationIssue[] = [];
  const fixes: {
    at: string;
    code: string;
    subject?: string;
    message: string;
  }[] = [];
  let built = false;
  const since = (code: string) =>
    s.check?.issues.find((i) => i.code === code)?.since ?? io.now();

  if (!provider) {
    issues.push({
      code: "PROVIDER_UNSUPPORTED",
      severity: "BLOCKING",
      subject: null,
      message: `${s.provider ?? "This provider"} is not supported ${io.environment ? "in this environment" : "on this computer"} yet`,
      fixable: false,
      since: since("PROVIDER_UNSUPPORTED"),
    });
  } else {
    const connection = await readyConnection(doc, provider, io, issues, since);
    if (connection && io.grant.kind === "needed") {
      await stopForGrant(doc, io.grant, io, issues, since);
    } else if (connection) {
      built = await reconcileLiveWorkflow(
        doc,
        provider,
        connection,
        io,
        issues,
        fixes,
        since,
      );
      if (built) {
        built = await reconcileBackfill(
          doc,
          provider,
          connection,
          io,
          issues,
          fixes,
          since,
        );
      }
    }
  }

  const pending = s.checkRequest?.id ?? null;
  const last = s.check;
  // Everything this pass can do for the generation is done: commit it.
  const committed = built && issues.every((i) => i.severity !== "BLOCKING");
  const unchanged =
    !!last &&
    last.generation === s.intent.generation &&
    sameIssues(last.issues, issues) &&
    pending === null &&
    fixes.length === 0 &&
    (s.applied?.generation === s.intent.generation) === committed;
  if (unchanged) return;
  await io.dispatch([
    actions.recordCheck({
      at: io.now(),
      host: io.me.label,
      generation: s.intent.generation,
      request: pending,
      issues: issues.map((i) => ({ ...i, subject: i.subject ?? undefined })),
      fixes,
      committed,
    }),
  ]);
}

/**
 * Builds the live workflow, or puts it back to what the integration asks
 * for. A difference the user's own change explains (a generation not yet
 * committed) is applied quietly; one nobody asked for is put back and
 * logged. Returns whether the workflow now is what the spec says.
 */
async function reconcileLiveWorkflow(
  doc: { id: string; name: string; state: IntegrationState },
  provider: ProviderAdapter,
  connection: ReadyConnection,
  io: ReconcileIO,
  issues: IntegrationIssue[],
  fixes: { at: string; code: string; subject?: string; message: string }[],
  since: (code: string) => string,
): Promise<boolean> {
  const s = doc.state;
  const reactorConnectionId = await io.findReactorConnection();
  if (!reactorConnectionId) {
    issues.push(grantIssue("missing", io, since));
    return false;
  }
  const driveId = provider.drive ? await io.drive(provider.drive) : "";
  if (driveId === null) {
    const code = `NO_${(provider.drive ?? "").toUpperCase()}_DRIVE`;
    issues.push({
      code,
      severity: "BLOCKING",
      subject: null,
      message: (io.environment ? DRIVE_MISSING_HERE : DRIVE_MISSING)[
        provider.drive ?? "mail"
      ],
      fixable: false,
      since: since(code),
    });
    return false;
  }
  const ctx: ProviderContext = {
    name: doc.name,
    state: s,
    connectionId: connection.connectionId,
    accountLabel: connection.accountLabel,
    reactorConnectionId,
    driveId,
  };
  const spec = liveWorkflowSpec(provider, ctx);
  const id = s.resources.liveWorkflowId;
  const facts = id ? await io.readWorkflow(id) : null;
  if (!id || !facts) {
    const workflowId = await io.createWorkflow(
      spec.name,
      buildWorkflow(spec, () => io.newId(), io.now()),
    );
    await io.dispatch([
      actions.recordResources({ liveWorkflowId: workflowId }),
    ]);
    await markManaged(io, workflowId, null, doc);
    return true;
  }
  await markManaged(io, id, facts, doc);
  const drift = forThePerson(
    workflowDrift(spec, facts, io.now(), () => io.newId()),
    facts,
    io,
  );
  if (drift.actions.length === 0) {
    // The workflow is what the integration asks for: is it running?
    const problem = runtimeIssue(await io.workflowHealth(id));
    if (problem) {
      issues.push({
        ...problem,
        subject: id,
        fixable: false,
        since: since(problem.code),
      });
    }
    return true;
  }
  await io.updateWorkflow(id, drift.actions);
  // Asked for: the user changed the integration and this applies it.
  const asked = s.applied?.generation !== s.intent.generation;
  if (!asked) {
    const at = io.now();
    for (const difference of drift.differences) {
      fixes.push({
        at,
        code: "LIVE_WORKFLOW_DRIFT",
        subject: id,
        message: `Put back: ${difference}`,
      });
    }
  }
  return true;
}

/**
 * Brings in the history: a queue per backfill item (made again if it was
 * deleted), the item to walk plugged in (the pinned one unless it is done,
 * else the first unfinished), and the backfill workflow built or put back
 * to walk it. Moving on to the next queue and switching off once all are
 * done are this pass's own doing, never logged as a put-back. Returns
 * whether the backfill is what the integration asks for.
 */
async function reconcileBackfill(
  doc: { id: string; name: string; state: IntegrationState },
  provider: ProviderAdapter,
  connection: ReadyConnection,
  io: ReconcileIO,
  issues: IntegrationIssue[],
  fixes: { at: string; code: string; subject?: string; message: string }[],
  since: (code: string) => string,
): Promise<boolean> {
  const s = doc.state;
  const reactorConnectionId = await io.findReactorConnection();
  // The live pass has said so already
  if (!reactorConnectionId) return false;
  const asked = s.applied?.generation !== s.intent.generation;
  const items = s.intent.backfill.items;
  // A provider without backfills (an aggregator that keeps its own history)
  if (provider.backfillPollSeconds === undefined) return true;
  const driveId = provider.drive ? await io.drive(provider.drive) : "";
  // The live pass has said so already
  if (driveId === null) return false;
  const ctx: ProviderContext = {
    name: doc.name,
    state: s,
    connectionId: connection.connectionId,
    accountLabel: connection.accountLabel,
    reactorConnectionId,
    driveId,
  };

  const queues = new Map<string, { id: string; state: QueueState }>();
  for (const item of items) {
    const existing = item.documentId
      ? await io.readQueue(item.documentId)
      : null;
    if (item.documentId && existing) {
      queues.set(item.id, { id: item.documentId, state: existing });
      continue;
    }
    const setup = queueSetup(doc.name, item, io.newId());
    // A kind this adapter does not make (an attached document that is gone)
    if (!setup) continue;
    const id = await io.createQueue(setup.name, setup.actions);
    await io.dispatch([
      actions.recordBackfillDocument({ itemId: item.id, documentId: id }),
    ]);
    if (item.documentId && !asked) {
      fixes.push({
        at: io.now(),
        code: "BACKFILL_QUEUE_DELETED",
        subject: id,
        message: `Put back: the backfill "${item.label}" was deleted; it starts again`,
      });
    }
    const made = await io.readQueue(id);
    if (made) queues.set(item.id, { id, state: made });
  }

  // Coverage: a hole between the backfills is filled with one more, newest
  // first, which the next pass makes a queue for and walks after the others.
  const gaps = coverageGaps(
    items
      .map((item) => itemSpan(item, queues.get(item.id)?.state))
      .filter((span): span is Span => span !== null),
  );
  if (gaps.length > 0 && provider.backfillSliceSeconds) {
    const at = io.now();
    await io.dispatch(
      gaps.map((gap) =>
        actions.addDateRangeBackfill({
          id: io.newId(),
          label: `Gap: ${spanLabel(gap)}`,
          documentType: OSQ_TYPE,
          from: new Date(gap.from).toISOString(),
          to: new Date(gap.to).toISOString(),
          stepSeconds: provider.backfillSliceSeconds!,
          direction: "BACKWARD",
        }),
      ),
    );
    for (const gap of gaps) {
      fixes.push({
        at,
        code: "COVERAGE_GAP",
        message: `Filled a gap in the history: ${spanLabel(gap)}`,
      });
    }
  }

  const unfinished = (item: (typeof items)[number]) => {
    const q = queues.get(item.id);
    return !!q && !queueProgress(q.state).finished;
  };
  const pinned = items.find(
    (i) => i.id === s.intent.backfill.pinnedId && unfinished(i),
  );
  const plug = pinned ?? items.find(unfinished) ?? null;
  if (plug && plug.id !== s.resources.pluggedItemId) {
    await io.dispatch([actions.recordResources({ pluggedItemId: plug.id })]);
  }
  const plugged = plug ? queues.get(plug.id)! : null;

  const workflowId = s.resources.backfillWorkflowId;
  const facts = workflowId ? await io.readWorkflow(workflowId) : null;
  if (!workflowId || !facts) {
    // Nothing left to bring in: no workflow needed
    if (!plugged) return true;
    const spec = backfillWorkflowSpec(
      provider,
      ctx,
      plugged.id,
      s.intent.backfill.enabled,
      rangeOf(plugged.state),
    );
    const created = await io.createWorkflow(
      spec.name,
      buildWorkflow(spec, () => io.newId(), io.now()),
    );
    await io.dispatch([
      actions.recordResources({ backfillWorkflowId: created }),
    ]);
    await markManaged(io, created, null, doc);
    return true;
  }
  await markManaged(io, workflowId, facts, doc);

  // All done, it keeps pointing at the queue it walked last, switched off
  const walking =
    typeof facts.triggerConfig?.documentId === "string"
      ? facts.triggerConfig.documentId
      : null;
  const queueId = plugged?.id ?? walking;
  if (!queueId) return true;
  const walked = [...queues.values()].find((q) => q.id === queueId);
  const range = walked ? rangeOf(walked.state) : SLICE_RANGE;
  const spec = backfillWorkflowSpec(
    provider,
    ctx,
    queueId,
    s.intent.backfill.enabled && plugged !== null,
    range,
  );
  const drift = forThePerson(
    workflowDrift(spec, facts, io.now(), () => io.newId()),
    facts,
    io,
  );
  if (drift.actions.length === 0) {
    if (spec.enabled) {
      const problem = runtimeIssue(
        await io.workflowHealth(workflowId),
        "backfill",
      );
      if (problem) {
        issues.push({
          ...problem,
          subject: workflowId,
          fixable: false,
          since: since(problem.code),
        });
      }
    }
    return true;
  }
  await io.updateWorkflow(workflowId, drift.actions);
  const ours =
    walking !== queueId || (plugged === null && facts.status === "ENABLED");
  if (!asked && !ours) {
    const at = io.now();
    for (const difference of drift.differences) {
      fixes.push({
        at,
        code: "BACKFILL_WORKFLOW_DRIFT",
        subject: workflowId,
        message: `Put back: ${difference}`,
      });
    }
  }
  return true;
}

/** What the card says for a gap in the grant. Its button fixes every one. */
function grantIssue(
  gap: Extract<ReconcileGrant, { kind: "needed" }>["gap"],
  io: ReconcileIO,
  since: (code: string) => string,
  endedAt?: string,
): IntegrationIssue {
  const where = io.environment ? "in this environment" : "on this computer";
  const message = {
    missing: `Sektar needs your approval to write documents ${where}`,
    ended: `Your approval ended${endedAt ? ` on ${endedAt.slice(0, 10)}` : ""}. Approve again to carry on`,
    revoked: "Your sign-in was withdrawn. Approve again to carry on",
    invalid: `Your approval does not fit ${io.environment ? "this environment" : "this computer"} any more. Approve again to carry on`,
  }[gap];
  return {
    code: "NEEDS_GRANT",
    severity: "BLOCKING",
    subject: null,
    message,
    fixable: true,
    since: since("NEEDS_GRANT"),
  };
}

/**
 * Nobody stands behind this integration: nothing is published, and what a
 * person's approval kept running stops. Workflows that never had one are left
 * as they are, and the next grant republishes them.
 */
async function stopForGrant(
  doc: { state: IntegrationState },
  grant: Extract<ReconcileGrant, { kind: "needed" }>,
  io: ReconcileIO,
  issues: IntegrationIssue[],
  since: (code: string) => string,
): Promise<void> {
  if (grant.gap !== "missing") {
    const { liveWorkflowId, backfillWorkflowId } = doc.state.resources;
    for (const id of [liveWorkflowId, backfillWorkflowId]) {
      const facts = id ? await io.readWorkflow(id) : null;
      if (id && facts?.status === "ENABLED") {
        await io.updateWorkflow(id, [disableAction()]);
      }
    }
  }
  issues.push(grantIssue(grant.gap, io, since, grant.endedAt));
}

/**
 * A drift, with a publish added when someone other than the person who granted
 * this integration published last, so the person becomes the run user.
 */
function forThePerson(
  drift: Drift,
  facts: WorkflowFacts,
  io: ReconcileIO,
): Drift {
  if (io.grant.kind !== "delegated") return drift;
  const person = io.grant.person.address.toLowerCase();
  if (facts.publisher?.toLowerCase() === person) return drift;
  return { ...drift, actions: withPublish(drift.actions, io.now()) };
}

/**
 * Marks a workflow this integration keeps (managedBy), so Workflow Studio
 * shows it read-only. Quietly: a runtime whose workflow model has no
 * SET_MANAGED_BY yet refuses it, and the next pass after an upgrade marks it.
 */
async function markManaged(
  io: ReconcileIO,
  workflowId: string,
  facts: WorkflowFacts | null,
  doc: { id: string; name: string },
): Promise<void> {
  if (facts && facts.managedBy === doc.id) return;
  try {
    await io.updateWorkflow(workflowId, [managedByAction(doc)]);
  } catch {
    // An older workflow model: unmarked until it knows the operation
  }
}

type ReadyConnection = { connectionId: string; accountLabel: string | null };

/**
 * The connection a pass can build with, or null with the issue that says
 * what is missing. oauth: the reconciler makes one and asks for a sign-in
 * that covers the scopes the integration needs. apiKey: it uses the one it
 * was given and only checks that it works.
 */
async function readyConnection(
  doc: { id: string; name: string; state: IntegrationState },
  provider: ProviderAdapter,
  io: ReconcileIO,
  issues: IntegrationIssue[],
  since: (code: string) => string,
): Promise<ReadyConnection | null> {
  const s = doc.state;
  if (provider.auth === "apiKey") {
    const connectionId = s.resources.connectionId ?? s.intent.connectionId;
    const facts = connectionId ? await io.readConnection(connectionId) : null;
    if (!connectionId || !facts) {
      issues.push({
        code: "NO_CONNECTION",
        severity: "BLOCKING",
        subject: connectionId ?? null,
        message: io.environment
          ? `Pick the ${provider.label} connection to use in this environment`
          : `Pick the ${provider.label} connection to use on ${io.me.label}`,
        fixable: false,
        since: since("NO_CONNECTION"),
      });
      return null;
    }
    if (facts.status !== "OK") {
      issues.push({
        code: "CONNECTION_NOT_WORKING",
        severity: "BLOCKING",
        subject: connectionId,
        message: `The ${provider.label} connection ${io.environment ? "in this environment" : `on ${io.me.label}`} is not working; check it in Workflows`,
        fixable: false,
        since: since("CONNECTION_NOT_WORKING"),
      });
      return null;
    }
    if (s.resources.connectionId !== connectionId) {
      await io.dispatch([actions.recordResources({ connectionId })]);
    }
    return { connectionId, accountLabel: facts.accountLabel ?? null };
  }

  const spec = provider.connection(doc.name, s);
  if (!spec) {
    issues.push({
      code: "PROVIDER_UNSUPPORTED",
      severity: "BLOCKING",
      subject: null,
      message: `${s.provider ?? "This provider"} is not supported ${io.environment ? "in this environment" : "on this computer"} yet`,
      fixable: false,
      since: since("PROVIDER_UNSUPPORTED"),
    });
    return null;
  }
  let connectionId = s.resources.connectionId;
  let facts = connectionId ? await io.readConnection(connectionId) : null;
  // None yet, or deleted: make one and record it before anything else, so
  // a pass that fails later never makes a second one.
  if (!connectionId || !facts) {
    connectionId = await io.createConnection(spec);
    await io.dispatch([actions.recordResources({ connectionId })]);
    facts = {
      status: "UNCONFIGURED",
      signedIn: false,
      scopes: spec.config.oauth_scopes as string[],
    };
  }
  const wanted = spec.config.oauth_scopes as string[];
  // The access changed: ask for the new scopes. The token in hand stays
  // in use until the person signs in again; it just does not reach them.
  if (!sameScopes(facts.scopes, wanted)) {
    await io.setConnectionConfig(connectionId, spec.config);
  }
  // Signed in for what the integration asks: a sign-in recorded before
  // grants were (granted null) is taken as not reaching the new scopes.
  const granted = facts.granted;
  const covered = !!granted && wanted.every((scope) => granted.includes(scope));
  if (!facts.signedIn || facts.status !== "OK" || !covered) {
    // Signed in for too little, or signed in and then refused (the runtime
    // records ERROR when the provider refuses the sign-in: revoked, expired).
    const more = facts.signedIn && facts.status === "OK";
    const refused = facts.signedIn && facts.status === "ERROR";
    issues.push({
      code: "NEEDS_SIGN_IN",
      severity: "BLOCKING",
      subject: connectionId,
      // In an environment the card's button signs in from wherever the
      // person is; on a computer, only there.
      message: io.environment
        ? more
          ? `Sign in with ${provider.label} again to finish: it needs more access`
          : refused
            ? `Sign in with ${provider.label} again: ${provider.label} no longer accepts the sign-in`
            : `Sign in with ${provider.label} to finish`
        : more
          ? `Sign in to ${provider.label} again on ${io.me.label}: it needs more access`
          : refused
            ? `Sign in to ${provider.label} again on ${io.me.label}: ${provider.label} no longer accepts the sign-in`
            : `Sign in to ${provider.label} on ${io.me.label} to finish`,
      fixable: false,
      since: since("NEEDS_SIGN_IN"),
    });
    return null;
  }
  // Signed in as the account this integration is for: another account's
  // data must not land in its place. The old workflows keep running.
  const expected = provider.expectedAccount?.(s) ?? null;
  const label = facts.accountLabel?.trim().toLowerCase() ?? null;
  if (expected && label && label !== expected) {
    issues.push({
      code: "NEEDS_SIGN_IN",
      severity: "BLOCKING",
      subject: connectionId,
      message: io.environment
        ? `Signed in to ${provider.label} as ${facts.accountLabel}; sign in with ${provider.label} again as ${expected}`
        : `Signed in to ${provider.label} as ${facts.accountLabel}; sign in again on ${io.me.label} as ${expected}`,
      fixable: false,
      since: since("NEEDS_SIGN_IN"),
    });
    return null;
  }
  return { connectionId, accountLabel: facts.accountLabel ?? null };
}
