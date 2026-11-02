/**
 * A workflow the reconciler owns, as data: a trigger, a chain of steps, on
 * or off. One builder makes the actions that create it; one drift check says
 * what to change so the published workflow is the spec again, in words a
 * person reads in the fixes log. Providers (providers/*) supply the trigger
 * and the steps; the reconciler core supplies the rest. Pure.
 */
import { actions as wf } from "@powerhousedao/workflow/document-models/workflow";

export type WorkflowAction = ReturnType<
  | typeof wf.setWorkflowName
  | typeof wf.setWorkflowStatus
  | typeof wf.setTrigger
  | typeof wf.setTriggerConfig
  | typeof wf.setTriggerConnection
  | typeof wf.addStep
  | typeof wf.addEdge
  | typeof wf.updateStep
  | typeof wf.publishWorkflow
  | typeof wf.setManagedBy
  | typeof wf.setPolicy
>;

export type StepRetry = {
  maxAttempts: number;
  backoff: "FIXED" | "EXPONENTIAL";
  initialDelaySeconds: number;
  maxDelaySeconds: number;
  retryOn: string[];
};

/**
 * What every workflow the reconciler builds retries: a step whose piece the
 * runtime could not fetch yet, which is what the first runs after a
 * switchboard start meet while npm answers slowly, and a request that never
 * got an answer (the network dropped, the provider's gateway was briefly
 * down). Any other failed step still parks the workflow at once. Without it,
 * each restart parked the backfills, and one dropped connection to a bank's
 * API stopped its live updates until someone pressed "Try again".
 *
 * Matched anywhere in the error's message, case-insensitively. Kept to
 * failures where nothing was answered: a refusal (4xx, a sign-in that no
 * longer works) still parks, since retrying it only repeats the refusal.
 */
export const STEP_RETRY: StepRetry = {
  maxAttempts: 4,
  backoff: "EXPONENTIAL",
  initialDelaySeconds: 30,
  maxDelaySeconds: 120,
  retryOn: [
    "No source could be asked for",
    "fetch failed",
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "socket hang up",
    "returned 502",
    "returned 503",
    "returned 504",
  ],
};

export type TriggerSpec = {
  pieceName: string;
  pieceVersion: string;
  triggerName: string;
  config: Record<string, unknown>;
  /** The sign-in the trigger polls with; absent: none checked */
  connectionId?: string;
  /** The reactor connection a trigger that writes documents uses; absent: none checked */
  reactorConnectionId?: string;
};

export type StepSpec = {
  key: string;
  name: string;
  pieceName: string;
  pieceVersion: string;
  actionName: string;
  config: Record<string, unknown>;
  /** The sign-in the step uses; checked for drift when set */
  connectionId?: string;
  reactorConnectionId?: string;
};

/** How drift reads in the fixes log. */
export type DriftWords = {
  /** "the workflow", "the history workflow" */
  subject: string;
  /** Whose sign-in: "Google" */
  provider: string;
  /** What changed in the trigger's config, in words */
  config(
    actual: Record<string, unknown> | null,
    wanted: Record<string, unknown>,
  ): string;
};

export type WorkflowSpec = {
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  /** Run in this order, one after the other */
  steps: StepSpec[];
  /**
   * The trigger only works with every step in place (a for-every that only
   * reads needs the step that moves the queue): steps it lacks at the end are
   * added, and the trigger is not changed while they cannot be.
   */
  triggerNeedsSteps?: boolean;
  words: DriftWords;
};

/** What the published workflow looks like, as far as a spec goes. */
export type WorkflowFacts = {
  status: string;
  /** null: never published */
  publishedVersion: number | null;
  version: number;
  triggerName: string | null;
  triggerConnectionId: string | null;
  triggerConfig: Record<string, unknown> | null;
  /** The trigger's reactor connection (a trigger that writes documents) */
  triggerReactorConnectionId?: string | null;
  /** The published steps: their connections and settings */
  steps?: {
    id: string;
    key: string;
    connectionId: string | null;
    config?: Record<string, unknown> | null;
  }[];
  /** The document that manages it (managedBy.documentId); null: nobody */
  managedBy?: string | null;
  /** The published policy's retry for a failed step; absent: not read */
  defaultRetry?: StepRetry | null;
  /** Who signed the latest publish as a person; null: the host or nobody. Absent: not read */
  publisher?: string | null;
};

/** Switches a workflow off, leaving who published it as it is. */
export function disableAction() {
  return wf.setWorkflowStatus({ status: "DISABLED" });
}

/**
 * `actions` with a publish in it: what makes the person granting an integration
 * the run user of a workflow someone else published. The same policy goes in
 * first, because it raises the version and a park only gives way to a newer
 * version: a workflow parked for want of a person starts again by itself. The
 * status stays last.
 */
export function withPublish(
  actions: WorkflowAction[],
  now: string,
): WorkflowAction[] {
  if (actions.some((a) => a.type === "PUBLISH_WORKFLOW")) return actions;
  const publish = [
    wf.setPolicy({ defaultRetry: STEP_RETRY }),
    wf.publishWorkflow({ publishedAt: now }),
  ];
  const status = actions.findIndex((a) => a.type === "SET_WORKFLOW_STATUS");
  if (status < 0) return [...actions, ...publish];
  return [...actions.slice(0, status), ...publish, ...actions.slice(status)];
}

/** Marks a workflow as kept by an integration (Studio shows it read-only). */
export function managedByAction(integration: { id: string; name: string }) {
  return wf.setManagedBy({
    documentId: integration.id,
    documentType: "sektar/integration",
    label: integration.name,
  });
}

/**
 * Everything a new workflow document needs, in the order the runtime wants:
 * name, trigger, steps, the edges that chain them, publish, status.
 */
export function buildWorkflow(
  spec: WorkflowSpec,
  newId: () => string,
  now: string,
): WorkflowAction[] {
  const triggerId = newId();
  const stepIds = spec.steps.map(() => newId());
  const chain = [triggerId, ...stepIds];
  return [
    wf.setWorkflowName({ name: spec.name }),
    wf.setTrigger({ id: triggerId, ...spec.trigger }),
    ...spec.steps.map((step, i) => wf.addStep({ id: stepIds[i], ...step })),
    ...stepIds.map((to, i) =>
      wf.addEdge({ id: newId(), from: chain[i], to, port: "next" }),
    ),
    wf.setPolicy({ defaultRetry: STEP_RETRY }),
    wf.publishWorkflow({ publishedAt: now }),
    wf.setWorkflowStatus({ status: spec.enabled ? "ENABLED" : "DISABLED" }),
  ];
}

export type Drift = {
  /** In the user's words, for the fixes log */
  differences: string[];
  actions: WorkflowAction[];
};

/**
 * What to change so the published workflow is the spec again: the trigger's
 * config and connections, steps the spec ends with that it lacks, the steps'
 * sign-ins and settings, the step retry (then a re-publish), and its status.
 * Empty when it already is.
 */
export function workflowDrift(
  spec: WorkflowSpec,
  facts: WorkflowFacts,
  now: string,
  newId: () => string,
): Drift {
  const { subject, provider } = spec.words;
  const differences: string[] = [];
  const edits: WorkflowAction[] = [];
  const t = spec.trigger;
  const missing = spec.triggerNeedsSteps ? missingSteps(spec, facts) : null;
  if (missing === "stuck") {
    differences.push(
      `${subject} is missing steps that cannot be added in place`,
    );
  } else if (!sameJson(facts.triggerConfig, t.config)) {
    differences.push(spec.words.config(facts.triggerConfig, t.config));
    edits.push(wf.setTriggerConfig({ config: t.config }));
  }
  if (
    t.connectionId !== undefined &&
    facts.triggerConnectionId !== t.connectionId
  ) {
    differences.push(`${subject} used another ${provider} sign-in`);
    edits.push(wf.setTriggerConnection({ connectionId: t.connectionId }));
  }
  if (
    t.reactorConnectionId !== undefined &&
    (facts.triggerReactorConnectionId ?? null) !== t.reactorConnectionId
  ) {
    differences.push(`${subject} wrote with another connection`);
    edits.push(
      wf.setTriggerConnection({ reactorConnectionId: t.reactorConnectionId }),
    );
  }
  for (const step of spec.steps) {
    const published = facts.steps?.find((s) => s.key === step.key);
    if (!published) continue;
    if (
      step.connectionId !== undefined &&
      published.connectionId !== step.connectionId
    ) {
      differences.push(`${subject} used another ${provider} sign-in`);
      edits.push(
        wf.updateStep({ id: published.id, connectionId: step.connectionId }),
      );
    }
    // Its settings: a renamed account or folder reaches the workflow
    if (
      published.config !== undefined &&
      !sameJson(published.config, step.config)
    ) {
      differences.push(`${subject}'s step "${step.name}" was changed`);
      edits.push(wf.updateStep({ id: published.id, config: step.config }));
    }
  }
  if (missing && missing !== "stuck") {
    let from = missing.after;
    for (const step of missing.steps) {
      const id = newId();
      differences.push(`${subject} had no step "${step.name}"`);
      edits.push(wf.addStep({ id, ...step }));
      edits.push(wf.addEdge({ id: newId(), from, to: id, port: "next" }));
      from = id;
    }
  }
  if (
    facts.defaultRetry !== undefined &&
    !sameJson(facts.defaultRetry, STEP_RETRY)
  ) {
    differences.push(`${subject} did not retry a piece it could not fetch`);
    edits.push(wf.setPolicy({ defaultRetry: STEP_RETRY }));
  }
  const unpublished =
    facts.publishedVersion === null || facts.publishedVersion !== facts.version;
  if (edits.length > 0 || unpublished) {
    if (unpublished && edits.length === 0) {
      differences.push(`${subject} had unpublished changes`);
    }
    edits.push(wf.publishWorkflow({ publishedAt: now }));
  }
  const status = spec.enabled ? "ENABLED" : "DISABLED";
  if (facts.status !== status) {
    differences.push(spec.enabled ? `${subject} was off` : `${subject} was on`);
    edits.push(wf.setWorkflowStatus({ status }));
  }
  return { differences, actions: edits };
}

/**
 * The steps the spec ends with that the published workflow lacks, and the
 * published step to chain them after: how a history workflow gets the step
 * that moves its queue. Only a missing tail is added in place, after the
 * workflow's last step; anything else is "stuck". null: nothing missing, or
 * the steps were not read.
 */
function missingSteps(
  spec: WorkflowSpec,
  facts: WorkflowFacts,
): { after: string; steps: StepSpec[] } | "stuck" | null {
  const published = facts.steps;
  if (!published) return null;
  const has = (step: StepSpec) => published.some((p) => p.key === step.key);
  const first = spec.steps.findIndex((step) => !has(step));
  if (first < 0) return null;
  const tail = spec.steps.slice(first);
  const last = published.at(-1);
  if (
    first === 0 ||
    tail.some(has) ||
    last?.key !== spec.steps[first - 1]?.key
  ) {
    return "stuck";
  }
  return { after: last.id, steps: tail };
}

export const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function humanSeconds(s: number): string {
  if (s % 86400 === 0) return s === 86400 ? "day" : `${s / 86400} days`;
  if (s % 3600 === 0) return s === 3600 ? "hour" : `${s / 3600} hours`;
  if (s % 60 === 0) return s === 60 ? "minute" : `${s / 60} minutes`;
  return `${s} seconds`;
}

/**
 * How the workflow runtime on this switchboard holds a workflow's trigger
 * (Powerhouse: WorkflowHealth, read through the workflow-triggers read
 * model). Live facts: never written into the integration, only turned into
 * issues.
 */
export type RuntimeHealth = {
  trigger: {
    status: string;
    lastError: string | null;
    consecutiveFailures: number;
  } | null;
  park: { reason: string; parkedAt: string } | null;
};

/**
 * What the runtime's view of a workflow means for the person: a park stops
 * it until someone acts, so it blocks; a trigger that keeps failing may
 * recover by itself, so it warns.
 */
export function runtimeIssue(
  health: RuntimeHealth | null,
  which: "live" | "backfill" = "live",
): { code: string; severity: "BLOCKING" | "WARNING"; message: string } | null {
  if (!health) return null;
  const prefix = which === "live" ? "LIVE" : "BACKFILL";
  const what = which === "live" ? "Live updates" : "Bringing in history";
  if (health.park) {
    return {
      code: `${prefix}_WORKFLOW_PARKED`,
      severity: "BLOCKING",
      message: `${what} stopped after a failed run: ${health.park.reason}`,
    };
  }
  const t = health.trigger;
  if (t && t.status === "ERROR" && t.lastError) {
    return {
      code: `${prefix}_WORKFLOW_FAILING`,
      severity: "WARNING",
      message: `${what} ${which === "live" ? "are" : "is"} failing: ${t.lastError}`,
    };
  }
  return null;
}
