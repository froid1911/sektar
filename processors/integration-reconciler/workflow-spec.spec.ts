import { utils } from "document-models/integration/v1";
import { describe, expect, it } from "vitest";
import {
  createActions,
  defaultChoices,
} from "../../editors/sektar/kit/integrations.js";
import { backfillWorkflowSpec, liveWorkflowSpec } from "./backfill-workflow.js";
import { googleCalendar } from "./providers/google-calendar.js";
import { reducer } from "document-models/integration/v1";
import {
  buildWorkflow,
  humanSeconds,
  STEP_RETRY,
  workflowDrift,
  type WorkflowFacts,
} from "./workflow-spec.js";

const AT = "2026-10-28T10:00:00.000Z";
const state = createActions(
  defaultChoices("CALENDAR", "google-calendar", new Date(2026, 9, 28)),
  new Date(2026, 9, 28),
  (() => {
    let n = 0;
    return () => `bf-${++n}`;
  })(),
).reduce((d, a) => reducer(d, a), utils.createDocument()).state.global;
const ctx = {
  name: "Cal",
  state,
  connectionId: "conn-1",
  accountLabel: null,
  reactorConnectionId: "reactor",
  driveId: "calendar-drive",
};
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe("the live workflow (Google Calendar)", () => {
  const spec = liveWorkflowSpec(googleCalendar, ctx);
  const matching: WorkflowFacts = {
    status: "ENABLED",
    version: 3,
    publishedVersion: 3,
    triggerName: "new_or_updated_event",
    triggerConnectionId: "conn-1",
    // Same config, keys in another order
    triggerConfig: {
      pollEverySeconds: 300,
      expandRecurringEvent: false,
      calendar_id: "primary",
    },
  };
  const drift = (patch: Partial<WorkflowFacts>) =>
    workflowDrift(spec, { ...matching, ...patch }, AT, ids());

  it("polls the primary calendar on the sign-in, maps and upserts into the Calendar drive", () => {
    const list = buildWorkflow(spec, ids(), AT);
    expect(list.map((a) => [a.type, a.input])).toEqual([
      ["SET_WORKFLOW_NAME", { name: "Cal · new events" }],
      [
        "SET_TRIGGER",
        expect.objectContaining({
          id: "id-1",
          triggerName: "new_or_updated_event",
          connectionId: "conn-1",
          config: matching.triggerConfig,
        }),
      ],
      [
        "ADD_STEP",
        expect.objectContaining({
          id: "id-2",
          key: "map_events",
          config: {
            events: "{{trigger.payload}}",
            calendarId: "primary",
            calendarName: "Cal",
          },
        }),
      ],
      [
        "ADD_STEP",
        expect.objectContaining({
          id: "id-3",
          key: "upsert_events",
          reactorConnectionId: "reactor",
          config: expect.objectContaining({
            documentType: "sektar/calendar-event",
            driveId: "calendar-drive",
          }) as unknown,
        }),
      ],
      ["ADD_EDGE", { id: "id-4", from: "id-1", to: "id-2", port: "next" }],
      ["ADD_EDGE", { id: "id-5", from: "id-2", to: "id-3", port: "next" }],
      ["SET_POLICY", { defaultRetry: STEP_RETRY }],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
      ["SET_WORKFLOW_STATUS", { status: "ENABLED" }],
    ]);
  });

  it("is left alone when it is the spec", () => {
    expect(drift({})).toEqual({ differences: [], actions: [] });
  });

  it("puts the trigger back and re-publishes", () => {
    const d = drift({
      triggerConfig: { ...matching.triggerConfig, pollEverySeconds: 3600 },
      triggerConnectionId: "other",
    });
    expect(d.differences).toEqual([
      "the workflow checked every hour, not every 5 minutes",
      "the workflow used another Google sign-in",
    ]);
    expect(d.actions.map((a) => [a.type, a.input])).toEqual([
      [
        "SET_TRIGGER_CONFIG",
        { config: { ...matching.triggerConfig, pollEverySeconds: 300 } },
      ],
      ["SET_TRIGGER_CONNECTION", { connectionId: "conn-1" }],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
    expect(
      drift({ triggerConfig: { calendar_id: "work" } }).differences,
    ).toEqual(["the workflow watched calendar work"]);
    expect(
      drift({
        triggerConfig: {
          ...matching.triggerConfig,
          expandRecurringEvent: true,
        },
      }).differences,
    ).toEqual(["the workflow's trigger settings were changed"]);
  });

  // A switchboard start used to park every backfill: its first slice met
  // npm still slow and failed fetching the piece
  it("retries a piece it could not fetch, and puts that back", () => {
    expect(drift({ defaultRetry: STEP_RETRY })).toEqual({
      differences: [],
      actions: [],
    });
    const d = drift({
      defaultRetry: { ...STEP_RETRY, maxAttempts: 1, retryOn: [] },
    });
    expect(d.differences).toEqual([
      "the workflow did not retry a piece it could not fetch",
    ]);
    expect(d.actions.map((a) => [a.type, a.input])).toEqual([
      ["SET_POLICY", { defaultRetry: STEP_RETRY }],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
  });

  it("publishes unpublished edits, and switches the status", () => {
    const types = (patch: Partial<WorkflowFacts>) =>
      drift(patch).actions.map((a) => a.type);
    expect(types({ version: 4 })).toEqual(["PUBLISH_WORKFLOW"]);
    expect(types({ publishedVersion: null })).toEqual(["PUBLISH_WORKFLOW"]);
    expect(drift({ version: 4 }).differences).toEqual([
      "the workflow had unpublished changes",
    ]);
    expect(types({ status: "DISABLED" })).toEqual(["SET_WORKFLOW_STATUS"]);
    expect(drift({ status: "DISABLED" }).differences).toEqual([
      "the workflow was off",
    ]);
  });
});

describe("the history workflow (Google Calendar)", () => {
  const spec = backfillWorkflowSpec(googleCalendar, ctx, "q-1", true, "slice");
  const matching: WorkflowFacts = {
    status: "ENABLED",
    version: 2,
    publishedVersion: 2,
    triggerName: "for-every",
    triggerConnectionId: null,
    triggerConfig: {
      pollEverySeconds: 60,
      documentId: "q-1",
    },
    triggerReactorConnectionId: "reactor",
    steps: [
      { id: "g", key: "get_events", connectionId: "conn-1" },
      { id: "m", key: "map_events", connectionId: null },
      { id: "u", key: "upsert_events", connectionId: null },
      { id: "p", key: "proceed", connectionId: null },
    ],
  };
  const drift = (patch: Partial<WorkflowFacts>, s = spec) =>
    workflowDrift(s, { ...matching, ...patch }, AT, ids());

  it("walks the plugged queue a slice a minute, asks Google for the slice, and maps and upserts like live", () => {
    const list = buildWorkflow(spec, ids(), AT);
    expect(list.map((a) => a.type)).toEqual([
      "SET_WORKFLOW_NAME",
      "SET_TRIGGER",
      "ADD_STEP",
      "ADD_STEP",
      "ADD_STEP",
      "ADD_STEP",
      "ADD_EDGE",
      "ADD_EDGE",
      "ADD_EDGE",
      "ADD_EDGE",
      "SET_POLICY",
      "PUBLISH_WORKFLOW",
      "SET_WORKFLOW_STATUS",
    ]);
    expect(list[0]?.input).toEqual({ name: "Cal · history" });
    expect(list[1]?.input).toMatchObject({
      pieceName: "@powerhousedao/distyra-piece",
      triggerName: "for-every",
      reactorConnectionId: "reactor",
      config: { documentId: "q-1", pollEverySeconds: 60 },
    });
    expect(list[2]?.input).toMatchObject({
      key: "get_events",
      actionName: "google_calendar_get_events",
      connectionId: "conn-1",
      config: {
        calendar_id: "primary",
        start_date: "{{trigger.payload.ranges.slice.from}}",
        end_date: "{{trigger.payload.ranges.slice.to}}",
        singleEvents: false,
      },
    });
    expect(list[3]?.input).toMatchObject({
      key: "map_events",
      config: { events: "{{steps.get_events.output.body}}" },
    });
    expect(list[4]?.input).toMatchObject({
      key: "upsert_events",
      reactorConnectionId: "reactor",
    });
    // Last, the step that moves the queue, and only from this run's slice
    expect(list[5]?.input).toMatchObject({
      key: "proceed",
      actionName: "osq-proceed",
      reactorConnectionId: "reactor",
      config: { documentId: "q-1", position: "{{trigger.payload}}" },
    });
    expect(list.slice(6, 10).map((a) => a.input)).toEqual([
      { id: "id-6", from: "id-1", to: "id-2", port: "next" },
      { id: "id-7", from: "id-2", to: "id-3", port: "next" },
      { id: "id-8", from: "id-3", to: "id-4", port: "next" },
      { id: "id-9", from: "id-4", to: "id-5", port: "next" },
    ]);
  });

  it("is left alone when it is the spec, and is pointed at the next queue", () => {
    expect(drift({})).toEqual({ differences: [], actions: [] });
    const next = backfillWorkflowSpec(
      googleCalendar,
      ctx,
      "q-2",
      true,
      "slice",
    );
    const d = drift({}, next);
    expect(d.differences).toEqual([
      "the history workflow walked another backfill",
    ]);
    expect(d.actions.map((a) => [a.type, a.input])).toEqual([
      [
        "SET_TRIGGER_CONFIG",
        {
          config: {
            documentId: "q-2",
            pollEverySeconds: 60,
          },
        },
      ],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
  });

  it("puts back its pace, connections and status", () => {
    expect(
      drift({
        triggerConfig: {
          documentId: "q-1",
          pollEverySeconds: 5,
        },
      }).differences,
    ).toEqual(["the history workflow's pace was changed"]);
    expect(
      drift({ triggerReactorConnectionId: "other" }).actions.map((a) => [
        a.type,
        a.input,
      ]),
    ).toEqual([
      ["SET_TRIGGER_CONNECTION", { reactorConnectionId: "reactor" }],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
    const signIn = drift({
      steps: [
        { id: "g", key: "get_events", connectionId: "conn-old" },
        ...(matching.steps ?? []).slice(1),
      ],
    });
    expect(signIn.differences).toEqual([
      "the history workflow used another Google sign-in",
    ]);
    expect(signIn.actions.map((a) => [a.type, a.input])).toEqual([
      ["UPDATE_STEP", { id: "g", connectionId: "conn-1" }],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
    const off = backfillWorkflowSpec(
      googleCalendar,
      ctx,
      "q-1",
      false,
      "slice",
    );
    expect(drift({}, off).actions.map((a) => a.input)).toEqual([
      { status: "DISABLED" },
    ]);
    expect(drift({}, off).differences).toEqual(["the history workflow was on"]);
  });

  it("gives a workflow built before it the step that moves the queue, in the same publish", () => {
    const before = drift({
      triggerConfig: { pollEverySeconds: 60, documentId: "q-1" },
      steps: matching.steps?.slice(0, 3),
    });
    expect(before.differences).toEqual([
      'the history workflow had no step "Move to the next slice"',
    ]);
    expect(before.actions.map((a) => a.type)).toEqual([
      "ADD_STEP",
      "ADD_EDGE",
      "PUBLISH_WORKFLOW",
    ]);
    expect(before.actions[0]?.input).toMatchObject({
      id: "id-1",
      key: "proceed",
      config: { documentId: "q-1", position: "{{trigger.payload}}" },
    });
    // Chained after the slice's last step
    expect(before.actions[1]?.input).toEqual({
      id: "id-2",
      from: "u",
      to: "id-1",
      port: "next",
    });
  });

  it("drops a trigger setting For Every no longer takes", () => {
    const interim = drift({
      triggerConfig: {
        pollEverySeconds: 60,
        documentId: "q-1",
        advance: "at-end",
      },
    });
    expect(interim.differences).toEqual([
      "the history workflow's trigger had a setting it no longer takes",
    ]);
    expect(interim.actions.map((a) => [a.type, a.input])).toEqual([
      [
        "SET_TRIGGER_CONFIG",
        { config: { documentId: "q-1", pollEverySeconds: 60 } },
      ],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
  });

  it("leaves the trigger alone while the steps it needs cannot be added", () => {
    // Steps out of the spec's order: adding one in place could not be right
    const odd = drift({
      triggerConfig: { pollEverySeconds: 5, documentId: "q-1" },
      steps: [
        { id: "m", key: "map_events", connectionId: null },
        { id: "g", key: "get_events", connectionId: "conn-1" },
      ],
    });
    expect(odd.differences).toEqual([
      "the history workflow is missing steps that cannot be added in place",
    ]);
    expect(odd.actions).toEqual([]);
    // Nothing published at all: no first step to chain after
    expect(drift({ triggerConfig: null, steps: [] }).actions).toEqual([]);
  });
});

it("says intervals the way people do", () => {
  expect([30, 60, 120, 3600, 7200, 86400, 172800].map(humanSeconds)).toEqual([
    "30 seconds",
    "minute",
    "2 minutes",
    "hour",
    "2 hours",
    "day",
    "2 days",
  ]);
});

describe("the step retry", () => {
  // The runtime matches retryOn anywhere in the message, case-insensitively.
  const retries = (message: string) =>
    STEP_RETRY.retryOn.some((s) => message.toLowerCase().includes(s.toLowerCase()));

  it("retries a request that got no answer, which parked a bank's live updates", () => {
    expect(retries('Step "pull" failed: Error: Distyra request failed: fetch failed')).toBe(true);
    expect(retries("Distyra API returned 503.")).toBe(true);
    expect(retries("No source could be asked for @sektar/distyra")).toBe(true);
  });

  it("still parks on a refusal, which a retry would only repeat", () => {
    expect(retries("Distyra API returned 401 (invalid_api_key).")).toBe(false);
    expect(retries("Distyra API returned 429 (bank_fetch_limit_reached).")).toBe(false);
  });
});
