import {
  reducer,
  utils,
  type IntegrationAction,
  type IntegrationDocument,
} from "document-models/integration/v1";
import {
  actions as osq,
  reducer as queueReducer,
  utils as queueUtils,
  type OriginalSourceQueueAction,
  type OriginalSourceQueueDocument,
} from "document-models/original-source-queue";
import { describe, expect, it } from "vitest";
import {
  createActions,
  defaultChoices,
} from "../../editors/sektar/kit/integrations.js";
import type { ReconcileGrant } from "./grant.js";
import {
  connectionFor,
  GOOGLE_APP,
  reconcileIntegration,
  type ConnectionFacts,
  type ReconcileIO,
} from "./reconcile.js";
import type {
  RuntimeHealth,
  WorkflowAction,
  WorkflowFacts,
} from "./workflow-spec.js";

const NOW = new Date(2026, 9, 28, 9, 30);
const PC = { reactorId: "switchboard@pc", label: "pc" };
/** A runner that is an environment at a public address (runner.ts) */
const CLOUD = {
  reactorId: "switchboard@acme.vetra.io",
  label: "acme.vetra.io",
};
const READ = "https://www.googleapis.com/auth/calendar.readonly";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";
const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

/** An integration as the create flow writes it, with the reconciler's IO faked. */
function world(
  access: "READ" | "READ_WRITE" = "READ",
  /** Another integration to start from; default: a calendar as the create flow writes it */
  start?: IntegrationAction[],
) {
  let doc: IntegrationDocument = (
    start ??
    createActions(
      { ...defaultChoices("CALENDAR", "google-calendar", NOW), access },
      NOW,
      (() => {
        let n = 0;
        return () => `bf-${++n}`;
      })(),
    )
  ).reduce((d, a) => reducer(d, a), utils.createDocument());
  const connections = new Map<
    string,
    ConnectionFacts & { config: Record<string, unknown> }
  >();
  const writes: string[] = [];
  const workflows = new Map<
    string,
    WorkflowFacts & { actions: WorkflowAction[] }
  >();
  let reactorConnection: string | null = "reactor-conn";
  let mailDrive: string | null = "mail-drive";
  const health = new Map<string, RuntimeHealth>();
  /** An older workflow model: SET_MANAGED_BY is refused */
  let refuseManaged = false;
  /** Queues as the real model keeps them, so a test can walk one */
  const queues = new Map<string, OriginalSourceQueueDocument>();
  const applyQueue = (id: string, list: OriginalSourceQueueAction[]) => {
    let q = queues.get(id)!;
    for (const a of list) {
      q = queueReducer(q, a);
      expect(q.operations.global.at(-1)?.error).toBeFalsy();
    }
    queues.set(id, q);
  };
  let n = 0;
  /** Applies workflow actions the way the workflow model would, as far as the facts go */
  const applyWorkflow = (id: string, list: WorkflowAction[]) => {
    const w = workflows.get(id)!;
    for (const a of list) {
      w.actions.push(a);
      const input = a.input as Record<string, unknown>;
      if (a.type === "SET_TRIGGER") {
        w.triggerName = input.triggerName as string;
        w.triggerConnectionId = (input.connectionId as string) ?? null;
        w.triggerReactorConnectionId =
          (input.reactorConnectionId as string) ?? null;
        w.triggerConfig = input.config as Record<string, unknown>;
        w.version++;
      } else if (a.type === "ADD_STEP") {
        w.steps = [
          ...(w.steps ?? []),
          {
            id: input.id as string,
            key: input.key as string,
            connectionId: (input.connectionId as string) ?? null,
            config: input.config as Record<string, unknown>,
          },
        ];
        w.version++;
      } else if (a.type === "UPDATE_STEP") {
        w.steps = (w.steps ?? []).map((step) =>
          step.id !== input.id
            ? step
            : {
                ...step,
                ...(input.connectionId !== undefined
                  ? { connectionId: input.connectionId as string }
                  : {}),
                ...(input.config !== undefined
                  ? { config: input.config as Record<string, unknown> }
                  : {}),
              },
        );
        w.version++;
      } else if (a.type === "SET_TRIGGER_CONFIG") {
        w.triggerConfig = input.config as Record<string, unknown>;
        w.version++;
      } else if (a.type === "SET_TRIGGER_CONNECTION") {
        // As the workflow model: undefined leaves a field, null clears it
        if (input.connectionId !== undefined) {
          w.triggerConnectionId = (input.connectionId as string) || null;
        }
        if (input.reactorConnectionId !== undefined) {
          w.triggerReactorConnectionId =
            (input.reactorConnectionId as string) || null;
        }
        w.version++;
      } else if (a.type === "SET_MANAGED_BY") {
        w.managedBy = (input.documentId as string) ?? null;
      } else if (a.type === "PUBLISH_WORKFLOW") {
        w.publishedVersion = w.version;
      } else if (a.type === "SET_WORKFLOW_STATUS") {
        w.status = input.status as string;
      }
    }
  };
  let grant: ReconcileGrant = { kind: "host" };
  const io = (me = PC, environment = false): ReconcileIO => ({
    me,
    environment,
    grant,
    now: () => "2026-10-28T10:00:00.000Z",
    readConnection: (id) => Promise.resolve(connections.get(id) ?? null),
    createConnection: (spec) => {
      const id = `conn-${++n}`;
      connections.set(id, {
        status: "UNCONFIGURED",
        signedIn: false,
        scopes: spec.config.oauth_scopes as string[],
        config: spec.config,
      });
      writes.push(`create ${id} ${spec.connectorId}`);
      return Promise.resolve(id);
    },
    setConnectionConfig: (id, config) => {
      // As the runtime: new values are asked for; the sign-in and what it
      // was granted stay as they were
      const c = connections.get(id)!;
      connections.set(id, {
        ...c,
        config: { ...c.config, ...config },
        scopes: config.oauth_scopes as string[],
      });
      writes.push(`config ${id}`);
      return Promise.resolve();
    },
    deleteDocument: (id) => {
      connections.delete(id);
      writes.push(`delete ${id}`);
      return Promise.resolve();
    },
    deleteIntegration: () => {
      writes.push("delete integration");
      return Promise.resolve();
    },
    newId: () => `id-${++n}`,
    findReactorConnection: () => Promise.resolve(reactorConnection),
    drive: (slug: string) =>
      Promise.resolve(slug === "mail" ? mailDrive : `${slug}-drive`),
    readWorkflow: (id) => {
      const w = workflows.get(id);
      return Promise.resolve(w ? { ...w } : null);
    },
    createWorkflow: (name, list) => {
      const id = `wf-${++n}`;
      workflows.set(id, {
        status: "DISABLED",
        version: 0,
        publishedVersion: null,
        triggerName: null,
        triggerConnectionId: null,
        triggerConfig: null,
        actions: [],
      });
      applyWorkflow(id, list);
      writes.push(`create workflow ${id} ${name}`);
      return Promise.resolve(id);
    },
    workflowHealth: (id) => Promise.resolve(health.get(id) ?? null),
    createQueue: (name, list) => {
      const id = `q-${++n}`;
      queues.set(id, queueUtils.createDocument());
      applyQueue(id, list);
      writes.push(`create queue ${id} ${name}`);
      return Promise.resolve(id);
    },
    readQueue: (id) => Promise.resolve(queues.get(id)?.state.global ?? null),
    updateWorkflow: (id, list) => {
      if (refuseManaged && list.some((a) => a.type === "SET_MANAGED_BY")) {
        return Promise.reject(new Error("unknown action SET_MANAGED_BY"));
      }
      applyWorkflow(id, list);
      writes.push(`update ${id} ${list.map((a) => a.type).join(",")}`);
      return Promise.resolve();
    },
    dispatch: (list: IntegrationAction[]) => {
      for (const a of list) {
        doc = reducer(doc, a);
        writes.push(a.type);
        expect(doc.operations.global.at(-1)?.error).toBeFalsy();
      }
      return Promise.resolve();
    },
  });
  const pass = (me = PC, environment = false) =>
    reconcileIntegration(
      {
        id: doc.header.id,
        name: "Personal Google Calendar",
        state: doc.state.global,
      },
      io(me, environment),
    );
  return {
    pass,
    connections,
    workflows,
    writes,
    /** A sign-in: granted what the connection asks for */
    signIn: (id = "conn-1") => {
      const c = connections.get(id)!;
      connections.set(id, {
        ...c,
        status: "OK",
        signedIn: true,
        granted: [...c.scopes],
      });
    },
    refuseManaged: () => {
      refuseManaged = true;
    },
    grantIs: (next: ReconcileGrant) => {
      grant = next;
    },
    publishedBy: (id: string, publisher: string | null) => {
      workflows.get(id)!.publisher = publisher;
    },
    noReactorConnection: () => {
      reactorConnection = null;
    },
    mailDriveIs: (id: string | null) => {
      mailDrive = id;
    },
    health,
    queues,
    /** The for-every trigger's walk: start, then a slice per call */
    walk: (id: string, slices: number) => {
      if (queues.get(id)!.state.global.status === "DRAFT") {
        applyQueue(id, [osq.start({})]);
      }
      applyQueue(
        id,
        Array.from({ length: slices }, () => osq.proceed({})),
      );
    },
    get doc() {
      return doc;
    },
    act: (a: IntegrationAction) => {
      doc = reducer(doc, a);
    },
  };
}

describe("the live workflow", () => {
  it("is built once signed in: trigger on the connection, mapping, upsert into the Calendar drive; then the integration commits", async () => {
    const w = world();
    await w.pass();
    expect(w.workflows.size).toBe(0);
    w.signIn();
    w.writes.length = 0;
    await w.pass();
    const s = w.doc.state.global;
    const id = s.resources.liveWorkflowId!;
    // Then the history: a queue per backfill, and the workflow that walks them
    expect(w.writes).toEqual([
      `create workflow ${id} Personal Google Calendar · new events`,
      "RECORD_RESOURCES",
      // Marked as the integration's, so Studio shows it read-only
      `update ${id} SET_MANAGED_BY`,
      expect.stringMatching(
        /^create queue q-\d+ Personal Google Calendar · Next 12 months$/,
      ),
      "RECORD_BACKFILL_DOCUMENT",
      expect.stringMatching(
        /^create queue q-\d+ Personal Google Calendar · Back to 1 Jan 2025$/,
      ),
      "RECORD_BACKFILL_DOCUMENT",
      "RECORD_RESOURCES",
      expect.stringMatching(
        /^create workflow wf-\d+ Personal Google Calendar · history$/,
      ),
      "RECORD_RESOURCES",
      expect.stringMatching(/^update wf-\d+ SET_MANAGED_BY$/),
      "RECORD_CHECK",
    ]);
    const wf = w.workflows.get(id)!;
    expect(wf.actions.map((a) => a.type)).toEqual([
      "SET_WORKFLOW_NAME",
      "SET_TRIGGER",
      "ADD_STEP",
      "ADD_STEP",
      "ADD_EDGE",
      "ADD_EDGE",
      "SET_POLICY",
      "PUBLISH_WORKFLOW",
      "SET_WORKFLOW_STATUS",
      "SET_MANAGED_BY",
    ]);
    expect(wf).toMatchObject({
      status: "ENABLED",
      managedBy: w.doc.header.id,
      triggerName: "new_or_updated_event",
      triggerConnectionId: "conn-1",
      triggerConfig: { calendar_id: "primary", expandRecurringEvent: false },
    });
    const upsert = wf.actions.find(
      (a) =>
        a.type === "ADD_STEP" &&
        (a.input as { actionName: string }).actionName === "upsert-documents",
    )!;
    expect(upsert.input).toMatchObject({
      reactorConnectionId: "reactor-conn",
      config: {
        documentType: "sektar/calendar-event",
        driveId: "calendar-drive",
      },
    });
    expect(s.applied?.generation).toBe(s.intent.generation);
    expect(s.check?.issues).toEqual([]);

    // Settled: the next passes write nothing
    const before = w.writes.length;
    await w.pass();
    await w.pass();
    expect(w.writes.length).toBe(before);
  });

  it("applies the user's own change quietly, and puts back one nobody asked for", async () => {
    const w = world();
    await w.pass();
    w.signIn();
    await w.pass();
    const id = w.doc.state.global.resources.liveWorkflowId!;
    const { actions } = await import("document-models/integration/v1");

    // The user turns live updates off: applied, no fix logged
    w.act(actions.setLiveEnabled({ enabled: false }));
    await w.pass();
    expect(w.workflows.get(id)?.status).toBe("DISABLED");
    expect(w.doc.state.global.fixes).toEqual([]);
    expect(w.doc.state.global.applied?.generation).toBe(
      w.doc.state.global.intent.generation,
    );

    // Someone turns the workflow on in Studio: put back, and logged
    w.workflows.get(id)!.status = "ENABLED";
    w.writes.length = 0;
    await w.pass();
    expect(w.writes).toEqual([
      `update ${id} SET_WORKFLOW_STATUS`,
      "RECORD_CHECK",
    ]);
    expect(w.workflows.get(id)?.status).toBe("DISABLED");
    expect(w.doc.state.global.fixes).toEqual([
      expect.objectContaining({
        code: "LIVE_WORKFLOW_DRIFT",
        subject: id,
        message: "Put back: the workflow was on",
      }),
    ]);
  });

  it("says so when the runtime parked it after a failed run, and stops saying so once it runs again", async () => {
    const w = world();
    await w.pass();
    w.signIn();
    await w.pass();
    const id = w.doc.state.global.resources.liveWorkflowId!;
    w.health.set(id, {
      trigger: { status: "DISABLED", lastError: null, consecutiveFailures: 0 },
      park: { reason: 'Step "map_events" failed: no action', parkedAt: "t" },
    });
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "LIVE_WORKFLOW_PARKED",
        severity: "BLOCKING",
        subject: id,
        message:
          'Live updates stopped after a failed run: Step "map_events" failed: no action',
      }),
    ]);
    // Committed before the park: it stays applied, the issue is what shows
    expect(w.doc.state.global.applied?.generation).toBe(
      w.doc.state.global.intent.generation,
    );

    // A failing poll that has not parked warns
    w.health.set(id, {
      trigger: {
        status: "ERROR",
        lastError: "registry timeout",
        consecutiveFailures: 2,
      },
      park: null,
    });
    await w.pass();
    expect(
      w.doc.state.global.check?.issues.map((i) => [i.code, i.severity]),
    ).toEqual([["LIVE_WORKFLOW_FAILING", "WARNING"]]);

    w.health.set(id, {
      trigger: { status: "ENABLED", lastError: null, consecutiveFailures: 0 },
      park: null,
    });
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([]);
  });

  it("builds and commits on a runtime that cannot mark workflows as managed yet", async () => {
    const w = world();
    w.refuseManaged();
    await w.pass();
    w.signIn();
    await w.pass();
    const s = w.doc.state.global;
    expect(w.workflows.get(s.resources.liveWorkflowId!)?.status).toBe(
      "ENABLED",
    );
    expect(s.applied?.generation).toBe(s.intent.generation);
    expect(s.check?.issues).toEqual([]);
  });

  it("is built again when its workflow was deleted", async () => {
    const w = world();
    await w.pass();
    w.signIn();
    await w.pass();
    const first = w.doc.state.global.resources.liveWorkflowId!;
    w.workflows.delete(first);
    const { actions } = await import("document-models/integration/v1");
    w.act(
      actions.requestCheck({
        id: "r1",
        requestedAt: "2026-10-28T10:01:00.000Z",
      }),
    );
    await w.pass();
    const second = w.doc.state.global.resources.liveWorkflowId!;
    expect(second).not.toBe(first);
    expect(w.workflows.has(second)).toBe(true);
  });

  it("waits, blocked, when the switchboard has no connection to write documents with", async () => {
    const w = world();
    w.noReactorConnection();
    await w.pass();
    w.signIn();
    await w.pass();
    const s = w.doc.state.global;
    expect(w.workflows.size).toBe(0);
    expect(s.applied).toBeNull();
    expect(s.check?.issues.map((i) => [i.code, i.severity])).toEqual([
      ["NEEDS_GRANT", "BLOCKING"],
    ]);
  });
});

describe("the grant", () => {
  const PERSON = "0xPerson";
  const DELEGATED: ReconcileGrant = {
    kind: "delegated",
    person: { address: PERSON, networkId: "eip155", chainId: 1 },
    statement: "a.statement",
    expiresAt: "2026-11-29T00:00:00.000Z",
  };

  async function signedIn(grant: ReconcileGrant = { kind: "host" }) {
    const w = world();
    w.grantIs(grant);
    await w.pass();
    w.signIn();
    await w.pass();
    return w;
  }
  const publishes = (w: ReturnType<typeof world>, id: string) =>
    w.workflows.get(id)!.actions.filter((a) => a.type === "PUBLISH_WORKFLOW");
  const blocking = (w: ReturnType<typeof world>) =>
    w.doc.state.global.check?.issues.map((i) => [i.code, i.fixable]);

  it("builds nothing as nobody, and says what would fix it", async () => {
    const w = await signedIn({ kind: "needed", gap: "missing" });
    expect(w.workflows.size).toBe(0);
    expect(blocking(w)).toEqual([["NEEDS_GRANT", true]]);
    expect(w.doc.state.global.check?.issues[0].message).toBe(
      "Sektar needs your approval to write documents on this computer",
    );
  });

  it("speaks of the environment there", async () => {
    const w = world();
    w.grantIs({ kind: "needed", gap: "missing" });
    await w.pass(CLOUD, true);
    w.signIn();
    await w.pass(CLOUD, true);
    expect(w.doc.state.global.check?.issues[0].message).toBe(
      "Sektar needs your approval to write documents in this environment",
    );
  });

  it("still gets the sign-in done first, so the card asks one thing at a time", async () => {
    const w = world();
    w.grantIs({ kind: "needed", gap: "missing" });
    await w.pass();
    expect(blocking(w)).toEqual([["NEEDS_SIGN_IN", false]]);
  });

  it("builds once it is granted, with no second approval", async () => {
    const w = await signedIn({ kind: "needed", gap: "missing" });
    w.grantIs(DELEGATED);
    await w.pass();
    expect(w.workflows.size).toBeGreaterThan(0);
    expect(w.doc.state.global.check?.issues).toEqual([]);
  });

  it("publishes as the person over a workflow the host published", async () => {
    const w = await signedIn();
    const id = w.doc.state.global.resources.liveWorkflowId!;
    const before = publishes(w, id).length;
    w.publishedBy(id, null);

    w.grantIs(DELEGATED);
    await w.pass();

    expect(publishes(w, id)).toHaveLength(before + 1);
  });

  it("raises the version, so a workflow parked for want of a person starts again", async () => {
    const w = await signedIn();
    const id = w.doc.state.global.resources.liveWorkflowId!;
    w.publishedBy(id, null);
    const count = w.workflows.get(id)!.actions.length;

    w.grantIs(DELEGATED);
    await w.pass();

    expect(
      w.workflows
        .get(id)!
        .actions.slice(count)
        .map((a) => a.type),
    ).toEqual(["SET_POLICY", "PUBLISH_WORKFLOW"]);
  });

  it("publishes as the new person when someone else granted before", async () => {
    const w = await signedIn(DELEGATED);
    const id = w.doc.state.global.resources.liveWorkflowId!;
    const before = publishes(w, id).length;
    w.publishedBy(id, "0xSomeoneElse");

    await w.pass();

    expect(publishes(w, id)).toHaveLength(before + 1);
  });

  it("leaves a workflow the person already published alone, whatever the case", async () => {
    const w = await signedIn(DELEGATED);
    const id = w.doc.state.global.resources.liveWorkflowId!;
    w.publishedBy(id, PERSON.toLowerCase());
    const before = publishes(w, id).length;

    await w.pass();

    expect(publishes(w, id)).toHaveLength(before);
  });

  it.each(["ended", "revoked", "invalid"] as const)(
    "stops what a person's approval kept running when it is %s",
    async (gap) => {
      const w = await signedIn(DELEGATED);
      const id = w.doc.state.global.resources.liveWorkflowId!;
      expect(w.workflows.get(id)!.status).toBe("ENABLED");
      const before = publishes(w, id).length;

      w.grantIs({ kind: "needed", gap, endedAt: "2026-11-29T00:00:00.000Z" });
      await w.pass();

      expect(w.workflows.get(id)!.status).toBe("DISABLED");
      expect(publishes(w, id)).toHaveLength(before);
      expect(blocking(w)).toEqual([["NEEDS_GRANT", true]]);
    },
  );

  it("says when an approval ended", async () => {
    const w = await signedIn(DELEGATED);
    w.grantIs({
      kind: "needed",
      gap: "ended",
      endedAt: "2026-11-29T00:00:00.000Z",
    });
    await w.pass();
    expect(w.doc.state.global.check?.issues[0].message).toBe(
      "Your approval ended on 2026-11-29. Approve again to carry on",
    );
  });

  it("repairs nothing while it waits: replay after revocation signs nothing", async () => {
    const w = await signedIn(DELEGATED);
    const id = w.doc.state.global.resources.liveWorkflowId!;
    const before = publishes(w, id).length;
    w.grantIs({ kind: "needed", gap: "revoked" });
    await w.pass();
    // Someone edits the workflow meanwhile: the drift waits for a person.
    w.workflows.get(id)!.triggerConfig = { tampered: true };
    await w.pass();
    await w.pass();
    expect(publishes(w, id)).toHaveLength(before);
    expect(w.workflows.get(id)!.triggerConfig).toEqual({ tampered: true });
  });

  it("switches back on once it is granted again", async () => {
    const w = await signedIn(DELEGATED);
    const id = w.doc.state.global.resources.liveWorkflowId!;
    w.grantIs({ kind: "needed", gap: "ended" });
    await w.pass();
    expect(w.workflows.get(id)!.status).toBe("DISABLED");
    w.grantIs(DELEGATED);
    await w.pass();
    expect(w.workflows.get(id)!.status).toBe("ENABLED");
  });

  it("leaves workflows that never had an approval as they are", async () => {
    const w = await signedIn();
    const id = w.doc.state.global.resources.liveWorkflowId!;
    w.grantIs({ kind: "needed", gap: "missing" });
    await w.pass();
    expect(w.workflows.get(id)!.status).toBe("ENABLED");
  });
});

describe("the history", () => {
  /** Signed in and settled: live workflow, queues and history workflow built */
  async function ready() {
    const w = world();
    await w.pass();
    w.signIn();
    await w.pass();
    const s = () => w.doc.state.global;
    const [ahead, back] = s().intent.backfill.items;
    const history = () => w.workflows.get(s().resources.backfillWorkflowId!)!;
    return { w, s, ahead, back, history };
  }

  it("makes a queue per backfill, walks what is coming first, a week a minute, and commits", async () => {
    const { w, s, ahead, back, history } = await ready();
    const q = (id: string | null | undefined) =>
      w.queues.get(id ?? "")!.state.global;
    // Forward from today; back from today, newest first
    expect(q(ahead.documentId).cursors[0]).toMatchObject({
      name: "Slice",
      first: "2026-10-28T00:00:00.000Z",
      deltaSeconds: 604800,
    });
    expect(q(back.documentId).cursors[0]).toMatchObject({
      first: "2026-10-28T00:00:00.000Z",
      last: "2025-01-01T00:00:00.000Z",
    });
    expect(s().resources.pluggedItemId).toBe(ahead.id);
    expect(history()).toMatchObject({
      status: "ENABLED",
      triggerName: "for-every",
      triggerConfig: { documentId: ahead.documentId, pollEverySeconds: 60 },
      triggerReactorConnectionId: "reactor-conn",
    });
    expect(history().steps?.find((x) => x.key === "get_events")).toMatchObject({
      connectionId: "conn-1",
    });
    expect(s().applied?.generation).toBe(s().intent.generation);
    expect(s().check?.issues).toEqual([]);

    // Walking, nothing to do: no writes
    w.walk(ahead.documentId!, 3);
    const before = w.writes.length;
    await w.pass();
    expect(w.writes.length).toBe(before);
  });

  it("moves on to the next backfill when one is done, and switches off when all are, quietly", async () => {
    const { w, s, ahead, back, history } = await ready();
    const total = (id: string) =>
      w.queues.get(id)!.state.global.cursors[0].count;
    w.walk(ahead.documentId!, total(ahead.documentId!));
    await w.pass();
    expect(s().resources.pluggedItemId).toBe(back.id);
    expect(history()).toMatchObject({
      status: "ENABLED",
      triggerConfig: { documentId: back.documentId },
    });
    expect(history().publishedVersion).toBe(history().version);

    w.walk(back.documentId!, total(back.documentId!));
    await w.pass();
    expect(history().status).toBe("DISABLED");
    // It keeps pointing at the queue it walked last
    expect(history().triggerConfig).toMatchObject({
      documentId: back.documentId,
    });
    expect(s().fixes).toEqual([]);
    expect(s().check?.issues).toEqual([]);

    const settled = w.writes.length;
    await w.pass();
    await w.pass();
    expect(w.writes.length).toBe(settled);
  });

  it("follows the backfill switch, leaving the queue where it was", async () => {
    const { w, s, ahead, history } = await ready();
    w.walk(ahead.documentId!, 5);
    const { actions } = await import("document-models/integration/v1");
    w.act(actions.setBackfillEnabled({ enabled: false }));
    await w.pass();
    expect(history().status).toBe("DISABLED");
    w.act(actions.setBackfillEnabled({ enabled: true }));
    await w.pass();
    expect(history().status).toBe("ENABLED");
    expect(
      w.queues.get(ahead.documentId!)!.state.global.progress,
    ).toBeGreaterThan(0);
    expect(s().fixes).toEqual([]);
  });

  it("puts back a change nobody asked for, and makes a deleted queue again", async () => {
    const { w, s, ahead, history } = await ready();
    const id = s().resources.backfillWorkflowId!;
    history().triggerConfig = {
      documentId: ahead.documentId,
      pollEverySeconds: 5,
    };
    await w.pass();
    expect(history().triggerConfig).toMatchObject({ pollEverySeconds: 60 });
    expect(s().fixes[0]).toMatchObject({
      code: "BACKFILL_WORKFLOW_DRIFT",
      subject: id,
      message: "Put back: the history workflow's pace was changed",
    });

    const gone = ahead.documentId!;
    w.queues.delete(gone);
    await w.pass();
    const remade = s().intent.backfill.items[0].documentId!;
    expect(remade).not.toBe(gone);
    expect(history().triggerConfig).toMatchObject({ documentId: remade });
    expect(s().fixes[0]).toMatchObject({
      code: "BACKFILL_QUEUE_DELETED",
      message:
        'Put back: the backfill "Next 12 months" was deleted; it starts again',
    });
  });

  it("moves on when the backfill it walks is removed, quietly", async () => {
    const { w, s, ahead, back, history } = await ready();
    const { actions } = await import("document-models/integration/v1");
    // The app deletes the queue and removes the item
    w.queues.delete(ahead.documentId!);
    w.act(actions.removeBackfill({ id: ahead.id }));
    await w.pass();
    expect(s().resources.pluggedItemId).toBe(back.id);
    expect(history()).toMatchObject({
      status: "ENABLED",
      triggerConfig: { documentId: back.documentId },
    });
    expect(s().fixes).toEqual([]);
    expect(s().applied?.generation).toBe(s().intent.generation);

    // The last one too: switched off, pointing at what it walked
    w.queues.delete(back.documentId!);
    w.act(actions.removeBackfill({ id: back.id }));
    await w.pass();
    expect(history().status).toBe("DISABLED");
    expect(s().fixes).toEqual([]);
  });

  it("files mail into the Mail drive it finds, and builds nothing while there is none", async () => {
    const { actions } = await import("document-models/integration/v1");
    const w = world("READ", [
      actions.initialize({ kind: "EMAIL", provider: "gmail" }),
      actions.setEmailSource({
        mailbox: "KSDC",
        address: "wouter@ksdc.be",
        folders: [],
      }),
    ]);
    w.mailDriveIs(null);
    await w.pass();
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", {
      ...c,
      status: "OK",
      signedIn: true,
      granted: [...c.scopes],
      accountLabel: "wouter@ksdc.be",
    });
    await w.pass();
    expect(w.doc.state.global.resources.liveWorkflowId).toBeFalsy();
    expect(w.doc.state.global.check?.issues.map((i) => i.code)).toContain(
      "NO_MAIL_DRIVE",
    );

    // A fresh store's drive, made under the "mail" slug
    w.mailDriveIs("mail-made-here");
    await w.pass();
    const id = w.doc.state.global.resources.liveWorkflowId!;
    const upsert = w.workflows
      .get(id)!
      .actions.find(
        (a) =>
          a.type === "ADD_STEP" &&
          (a.input as { actionName: string }).actionName === "upsert-documents",
      )!;
    expect(upsert.input).toMatchObject({
      config: { documentType: "sektar/email", driveId: "mail-made-here" },
    });
    expect(w.doc.state.global.check?.issues).toEqual([]);
  });

  it("fills a gap between backfills with one more, newest first, once", async () => {
    const { actions } = await import("document-models/integration/v1");
    const w = world("READ", [
      actions.initialize({ kind: "EMAIL", provider: "gmail" }),
      actions.setEmailSource({
        mailbox: "KSDC",
        address: "wouter@ksdc.be",
        folders: [],
      }),
      actions.addDateRangeBackfill({
        id: "old",
        label: "2014–2024",
        documentType: "distyra/original-source-queue",
        from: "2014-04-18T00:00:00.000Z",
        to: "2024-07-18T00:00:00.000Z",
        stepSeconds: 86400,
      }),
      actions.addDateRangeBackfill({
        id: "q1",
        label: "Q1-Q2 2026",
        documentType: "distyra/original-source-queue",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
        stepSeconds: 86400,
      }),
    ]);
    await w.pass();
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", {
      ...c,
      status: "OK",
      signedIn: true,
      granted: [...c.scopes],
      accountLabel: "wouter@ksdc.be",
    });
    await w.pass();
    const s = w.doc.state.global;
    expect(s.intent.backfill.items.at(-1)).toMatchObject({
      label: "Gap: 18 Jul 2024 – 1 Jan 2026",
      request: {
        from: "2024-07-18T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
        stepSeconds: 86400,
        direction: "BACKWARD",
      },
    });
    expect(s.fixes[0]).toMatchObject({
      code: "COVERAGE_GAP",
      message: "Filled a gap in the history: 18 Jul 2024 – 1 Jan 2026",
    });
    // Covered now: the next passes add nothing, and make its queue
    const items = s.intent.backfill.items.length;
    await w.pass();
    await w.pass();
    expect(w.doc.state.global.intent.backfill.items.length).toBe(items);
    expect(
      w.doc.state.global.intent.backfill.items.at(-1)?.documentId,
    ).toBeTruthy();
  });

  it("says so when the history workflow is parked", async () => {
    const { w, s } = await ready();
    w.health.set(s().resources.backfillWorkflowId!, {
      trigger: { status: "DISABLED", lastError: null, consecutiveFailures: 0 },
      park: { reason: "Google has more than one page", parkedAt: "t" },
    });
    await w.pass();
    expect(s().check?.issues).toEqual([
      expect.objectContaining({
        code: "BACKFILL_WORKFLOW_PARKED",
        severity: "BLOCKING",
        message:
          "Bringing in history stopped after a failed run: Google has more than one page",
      }),
    ]);
  });

  it("takes its queues down with the integration", async () => {
    const { w, s, ahead, back } = await ready();
    const { actions } = await import("document-models/integration/v1");
    w.act(actions.archive({}));
    w.writes.length = 0;
    await w.pass();
    expect(w.writes).toEqual([
      `delete ${s().resources.liveWorkflowId}`,
      `delete ${s().resources.backfillWorkflowId}`,
      `delete ${ahead.documentId}`,
      `delete ${back.documentId}`,
      "delete conn-1",
      "delete integration",
    ]);
  });
});

describe("a mail integration's sign-in", () => {
  async function mail(address: string) {
    const { actions } = await import("document-models/integration/v1");
    const w = world("READ", [
      actions.initialize({ kind: "EMAIL", provider: "gmail" }),
      actions.setEmailSource({ mailbox: "Pre-KSDC", address, folders: [] }),
    ]);
    await w.pass();
    return w;
  }
  const signInAs = (w: Awaited<ReturnType<typeof mail>>, label: string) => {
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", {
      ...c,
      status: "OK",
      signedIn: true,
      granted: [...c.scopes],
      accountLabel: label,
    });
  };

  it("refuses another Google account, so its mail never lands in this folder", async () => {
    const w = await mail("wouter+imported@ksdc.be");
    signInAs(w, "wkampmann@gmail.com");
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        message:
          "Signed in to Google as wkampmann@gmail.com; sign in again on pc as wouter@ksdc.be",
      }),
    ]);
    expect(w.doc.state.global.resources.liveWorkflowId).toBeNull();
  });

  it("asks for the right account without naming a computer in an environment", async () => {
    const { actions } = await import("document-models/integration/v1");
    const w = world("READ", [
      actions.initialize({ kind: "EMAIL", provider: "gmail" }),
      actions.setEmailSource({
        mailbox: "Pre-KSDC",
        address: "wouter@ksdc.be",
        folders: [],
      }),
    ]);
    await w.pass(CLOUD, true);
    signInAs(w, "wkampmann@gmail.com");
    await w.pass(CLOUD, true);
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        message:
          "Signed in to Google as wkampmann@gmail.com; sign in with Google again as wouter@ksdc.be",
      }),
    ]);
  });

  it("takes the account a +tag address belongs to", async () => {
    const w = await mail("wouter+imported@ksdc.be");
    signInAs(w, "Wouter@KSDC.be");
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([]);
    expect(w.doc.state.global.resources.liveWorkflowId).not.toBeNull();
  });
});

describe("an integration on a connection it is given (Distyra)", () => {
  async function bank() {
    const { actions } = await import("document-models/integration/v1");
    const w = world("READ", [
      actions.initialize({ kind: "TRANSACTIONS", provider: "distyra" }),
      actions.setTransactionsSource({
        bankConnectionId: "kbc",
        accounts: [
          { accountId: "a1", accountKey: "ak1", bankAccountId: "bank-1" },
        ],
      }),
      actions.setLiveInterval({ value: 6, unit: "HOURS" }),
    ]);
    return { w, actions };
  }

  it("waits for a connection to be picked, then builds on it without a sign-in or a backfill", async () => {
    const { w, actions } = await bank();
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({ code: "NO_CONNECTION", severity: "BLOCKING" }),
    ]);
    expect(w.writes.some((x) => x.startsWith("create conn"))).toBe(false);

    // The shared key, as adoption records it
    w.connections.set("distyra-key", {
      status: "OK",
      signedIn: true,
      scopes: [],
      config: {},
    });
    w.act(actions.recordResources({ connectionId: "distyra-key" }));
    await w.pass();
    const s = w.doc.state.global;
    expect(s.check?.issues).toEqual([]);
    expect(s.applied?.generation).toBe(s.intent.generation);
    const live = w.workflows.get(s.resources.liveWorkflowId!)!;
    expect(live).toMatchObject({
      status: "ENABLED",
      triggerName: "schedule",
      triggerConfig: { mode: "interval", unit: "hours", every: 6 },
    });
    expect(live.steps?.map((x) => [x.key, x.connectionId])).toEqual([
      ["pull", "distyra-key"],
      ["import_1", null],
    ]);
    expect(s.resources.backfillWorkflowId).toBeNull();
  });

  it("says so when the connection stops working, and leaves the shared key when removed", async () => {
    const { w, actions } = await bank();
    w.connections.set("distyra-key", {
      status: "ERROR",
      signedIn: true,
      scopes: [],
      config: {},
    });
    w.act(actions.recordResources({ connectionId: "distyra-key" }));
    await w.pass();
    expect(w.doc.state.global.check?.issues.map((i) => i.code)).toEqual([
      "CONNECTION_NOT_WORKING",
    ]);
    w.act(actions.archive({}));
    w.writes.length = 0;
    await w.pass();
    expect(w.writes).toEqual(["delete integration"]);
    expect(w.connections.has("distyra-key")).toBe(true);
  });
});

describe("a reconcile pass", () => {
  it("claims a new integration, makes its connection read-only, and asks for the sign-in", async () => {
    const w = world();
    await w.pass();
    const s = w.doc.state.global;
    expect(s.runner).toEqual(PC);
    expect(s.resources.connectionId).toBe("conn-1");
    expect(w.connections.get("conn-1")?.config).toEqual({
      oauth_app: GOOGLE_APP,
      oauth_scopes: [...IDENTITY, READ],
    });
    expect(s.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        severity: "BLOCKING",
        subject: "conn-1",
        message: "Sign in to Google on pc to finish",
        fixable: false,
      }),
    ]);
    expect(s.applied).toBeNull();
    expect(w.writes).toEqual([
      "RECORD_RUNNER",
      "create conn-1 @activepieces/piece-google-calendar#google-calendar",
      "RECORD_RESOURCES",
      "RECORD_CHECK",
    ]);
  });

  it("asks for the sign-in in this environment, not on a computer, when it runs as one", async () => {
    const w = world();
    await w.pass(CLOUD, true);
    expect(w.doc.state.global.runner).toEqual(CLOUD);
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        message: "Sign in with Google to finish",
      }),
    ]);
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", {
      ...c,
      status: "OK",
      signedIn: true,
      granted: null,
    });
    await w.pass(CLOUD, true);
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        message: "Sign in with Google again to finish: it needs more access",
      }),
    ]);
  });

  it("says this environment when it has no connection to write documents with", async () => {
    const w = world();
    w.noReactorConnection();
    await w.pass(CLOUD, true);
    w.signIn();
    await w.pass(CLOUD, true);
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_GRANT",
        fixable: true,
        message:
          "Sektar needs your approval to write documents in this environment",
      }),
    ]);
  });

  it("writes nothing when nothing changed, so its own writes do not loop", async () => {
    const w = world();
    await w.pass();
    const before = w.writes.length;
    await w.pass();
    await w.pass();
    expect(w.writes.length).toBe(before);
  });

  it("clears the sign-in once the connection holds a token, keeping the issue's first date otherwise", async () => {
    const w = world();
    await w.pass();
    const since = w.doc.state.global.check?.issues[0]?.since;
    w.act({
      ...(await import("document-models/integration/v1")).actions.requestCheck({
        id: "r1",
        requestedAt: "2026-10-28T10:01:00.000Z",
      }),
    } as IntegrationAction);
    await w.pass();
    expect(w.doc.state.global.check?.issues[0]?.since).toBe(since);
    expect(w.doc.state.global.checkRequest).toBeNull();
    w.signIn();
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([]);
  });

  it("leaves another switchboard's integration alone", async () => {
    const w = world();
    await w.pass({ reactorId: "switchboard@cloud", label: "cloud" });
    const writes = w.writes.length;
    await w.pass();
    expect(w.writes.length).toBe(writes);
    expect(w.doc.state.global.runner?.reactorId).toBe("switchboard@cloud");
  });

  it("asks for edit access and a new sign-in when the access changes", async () => {
    const w = world();
    await w.pass();
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", { ...c, status: "OK", signedIn: true });
    const { actions } = await import("document-models/integration/v1");
    w.act(actions.setAccess({ access: "READ_WRITE" }));
    await w.pass();
    expect(w.connections.get("conn-1")?.scopes.sort()).toEqual(
      [...IDENTITY, EVENTS, READ].sort(),
    );
    expect(w.doc.state.global.check?.issues.map((i) => i.code)).toEqual([
      "NEEDS_SIGN_IN",
    ]);
  });

  it("asks to sign in again when the sign-in does not reach what is asked, keeping the workflows", async () => {
    const w = world();
    await w.pass();
    w.signIn();
    await w.pass();
    const live = w.doc.state.global.resources.liveWorkflowId!;
    // Signed in before grants were recorded, the config already asking for more
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", { ...c, granted: null });
    w.writes.length = 0;
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        message: "Sign in to Google again on pc: it needs more access",
      }),
    ]);
    // Nothing taken down: the old token keeps them running meanwhile
    expect(w.workflows.get(live)?.status).toBe("ENABLED");
    expect(w.writes).toEqual(["RECORD_CHECK"]);
    // Signed in for the new scopes: settled again
    w.signIn();
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([]);
  });

  it("asks to sign in again when the provider no longer accepts the sign-in", async () => {
    const w = world();
    await w.pass();
    w.signIn();
    await w.pass();
    // The runtime records ERROR when Google refuses the refresh token
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", { ...c, status: "ERROR" });
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        subject: "conn-1",
        message:
          "Sign in to Google again on pc: Google no longer accepts the sign-in",
      }),
    ]);
    // The sign-in's check records OK: settled again
    w.signIn();
    await w.pass();
    expect(w.doc.state.global.check?.issues).toEqual([]);
  });

  it("asks to sign in again in this environment when the provider no longer accepts the sign-in", async () => {
    const w = world();
    await w.pass(CLOUD, true);
    w.signIn();
    await w.pass(CLOUD, true);
    const c = w.connections.get("conn-1")!;
    w.connections.set("conn-1", { ...c, status: "ERROR" });
    await w.pass(CLOUD, true);
    expect(w.doc.state.global.check?.issues).toEqual([
      expect.objectContaining({
        code: "NEEDS_SIGN_IN",
        message:
          "Sign in with Google again: Google no longer accepts the sign-in",
      }),
    ]);
  });

  it("makes a new connection when its connection was deleted", async () => {
    const w = world();
    await w.pass();
    w.connections.delete("conn-1");
    w.act(
      (await import("document-models/integration/v1")).actions.setLiveEnabled({
        enabled: false,
      }),
    );
    await w.pass();
    expect(w.doc.state.global.resources.connectionId).toBe("conn-2");
  });

  it("does nothing for an integration that is not set up", async () => {
    const empty = utils.createDocument();
    const writes: string[] = [];
    const io = {
      me: PC,
      now: () => "",
      dispatch: () => {
        writes.push("x");
        return Promise.resolve();
      },
    } as unknown as ReconcileIO;
    await reconcileIntegration(
      { id: "x", name: "x", state: empty.state.global },
      io,
    );
    expect(writes).toEqual([]);
  });

  it("takes down what a removed integration built, then the integration", async () => {
    const w = world();
    await w.pass();
    const { actions } = await import("document-models/integration/v1");
    w.act(actions.archive({}));
    w.writes.length = 0;
    await w.pass();
    expect(w.writes).toEqual(["delete conn-1", "delete integration"]);
    expect(w.connections.size).toBe(0);
  });

  it("leaves a removed integration to the switchboard that runs it", async () => {
    const w = world();
    await w.pass({ reactorId: "switchboard@cloud", label: "cloud" });
    const { actions } = await import("document-models/integration/v1");
    w.act(actions.archive({}));
    w.writes.length = 0;
    await w.pass();
    expect(w.writes).toEqual([]);
  });

  it("removes one that never got a runner or built anything", async () => {
    const w = world();
    const { actions } = await import("document-models/integration/v1");
    w.act(actions.archive({}));
    await w.pass();
    expect(w.writes).toEqual(["delete integration"]);
  });

  it("reports a provider it cannot connect", async () => {
    const w = world();
    const s = structuredClone(w.doc.state.global);
    s.provider = "microsoft-calendar";
    expect(connectionFor("x", s)).toBeNull();
    const out: IntegrationAction[] = [];
    await reconcileIntegration(
      { id: "x", name: "x", state: s },
      {
        me: PC,
        grant: { kind: "host" },
        now: () => "2026-10-28T10:00:00.000Z",
        readConnection: () => Promise.resolve(null),
        createConnection: () => Promise.reject(new Error("no")),
        setConnectionConfig: () => Promise.resolve(),
        deleteDocument: () => Promise.resolve(),
        deleteIntegration: () => Promise.resolve(),
        newId: () => "x",
        findReactorConnection: () => Promise.resolve(null),
        drive: () => Promise.resolve(null),
        readWorkflow: () => Promise.resolve(null),
        createWorkflow: () => Promise.reject(new Error("no")),
        updateWorkflow: () => Promise.resolve(),
        workflowHealth: () => Promise.resolve(null),
        createQueue: () => Promise.reject(new Error("no")),
        readQueue: () => Promise.resolve(null),
        dispatch: (l) => {
          out.push(...l);
          return Promise.resolve();
        },
      },
    );
    const check = out.find((a) => a.type === "RECORD_CHECK");
    expect(JSON.stringify(check)).toContain("PROVIDER_UNSUPPORTED");
  });
});
