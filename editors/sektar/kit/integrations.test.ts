import {
  reducer,
  utils,
  type IntegrationDocument,
} from "document-models/integration/v1";
import { describe, expect, it } from "vitest";
import {
  accessOptions,
  cardView,
  historyView,
  liveLine,
  hasBuiltAnything,
  removalPlan,
  createActions,
  DATE_RANGE_BACKFILL_TYPE,
  defaultChoices,
  defaultName,
  defaultSince,
  importRange,
  intervalLabel,
  kindInfo,
  providersFor,
  rangeLabel,
  type CreateChoices,
  addHashFor,
  KINDS,
  kindOfAddHash,
} from "./integrations.js";

// 28 Oct 2026, mid-morning
const NOW = new Date(2026, 9, 28, 9, 30);

const calendar = (patch: Partial<CreateChoices> = {}): CreateChoices => ({
  ...defaultChoices("CALENDAR", "google-calendar", NOW),
  ...patch,
});

/** Ids bf-1, bf-2, … in the order the create flow asks for them */
function ids() {
  let n = 0;
  return () => `bf-${++n}`;
}

function created(choices: CreateChoices = calendar()): IntegrationDocument {
  return createActions(choices, NOW, ids()).reduce(
    (doc, action) => reducer(doc, action),
    utils.createDocument(),
  );
}

describe("what the create flow offers", () => {
  it("offers Calendar and Email with Google, and bank transactions with Distyra", () => {
    expect(kindInfo("CALENDAR")?.available).toBe(true);
    expect(kindInfo("EMAIL")?.available).toBe(true);
    expect(kindInfo("TRANSACTIONS")?.available).toBe(true);
    expect(providersFor("CALENDAR").map((p) => [p.id, p.available])).toEqual([
      ["google-calendar", true],
      ["microsoft-calendar", false],
      ["caldav", false],
    ]);
    expect(kindInfo(null)).toBeUndefined();
  });

  it("names it after the provider and kind, and defaults to since 1 Jan last year", () => {
    expect(defaultName("CALENDAR", "google-calendar")).toBe("Google Calendar");
    expect(defaultName("CALENDAR", "nope")).toBe("Calendar");
    expect(defaultSince(NOW)).toBe("2025-01-01");
    const c = calendar();
    expect(c.live).toBe(true);
    expect(c.every).toEqual({ value: 5, unit: "MINUTES" });
    expect(c.history).toEqual({ kind: "since", date: "2025-01-01" });
  });
});

describe("a link that says what to bring in", () => {
  it("opens at the kind it names, for each kind that can be added", () => {
    for (const { kind } of KINDS.filter((k) => k.available)) {
      expect(kindOfAddHash(addHashFor(kind))).toBe(kind);
    }
  });

  it("is ignored when it names nothing that can be added", () => {
    expect(kindOfAddHash("add")).toBeNull();
    expect(kindOfAddHash("add/for/FAX")).toBeNull();
    expect(kindOfAddHash(null)).toBeNull();
    for (const { kind } of KINDS.filter((k) => !k.available)) {
      expect(kindOfAddHash(addHashFor(kind))).toBeNull();
    }
  });
});

describe("how much", () => {
  it("reaches 12 months ahead from today, whatever the history", () => {
    expect(importRange({ kind: "none" }, NOW)).toEqual({
      from: "2026-10-28T00:00:00.000Z",
      to: "2027-10-28T00:00:00.000Z",
    });
    expect(importRange({ kind: "since", date: "2025-01-01" }, NOW).from).toBe(
      "2025-01-01T00:00:00.000Z",
    );
    expect(importRange({ kind: "everything" }, NOW).from).toBe(
      "2000-01-01T00:00:00.000Z",
    );
  });

  it("treats a future or unreadable date as today", () => {
    expect(importRange({ kind: "since", date: "2030-05-01" }, NOW).from).toBe(
      "2026-10-28T00:00:00.000Z",
    );
    expect(importRange({ kind: "since", date: "" }, NOW).from).toBe(
      "2026-10-28T00:00:00.000Z",
    );
  });

  it("says the range and the interval in words", () => {
    expect(rangeLabel({ kind: "none" }, NOW)).toBe("Today to 12 months ahead");
    expect(rangeLabel({ kind: "everything" }, NOW)).toBe(
      "Everything to 12 months ahead",
    );
    expect(rangeLabel({ kind: "since", date: "2025-01-01" }, NOW)).toBe(
      "1 Jan 2025 to 12 months ahead",
    );
    expect(intervalLabel({ value: 5, unit: "MINUTES" })).toBe(
      "every 5 minutes",
    );
    expect(intervalLabel({ value: 1, unit: "HOURS" })).toBe("every hour");
    expect(intervalLabel({ value: 2, unit: "DAYS" })).toBe("every 2 days");
  });
});

describe("access", () => {
  it("offers read only first, then read and write, with the provider permission each asks for", () => {
    const [read, write] = accessOptions("google-calendar");
    expect(read).toMatchObject({ access: "READ" });
    expect(read.permission).toBe("Google: calendar.readonly");
    expect(write).toMatchObject({ access: "READ_WRITE" });
    expect(write.cannot).toEqual(["Delete events"]);
    expect(accessOptions("caldav")).toEqual([]);
    expect(accessOptions(null)).toEqual([]);
  });

  it("defaults to read only and writes the choice", () => {
    expect(calendar().access).toBe("READ");
    expect(
      created(calendar({ access: "READ_WRITE" })).state.global.intent.access,
    ).toBe("READ_WRITE");
  });
});

describe("removal", () => {
  it("removes right away what never built anything", () => {
    const plan = removalPlan(created().state.global);
    expect(plan.immediate).toBe(true);
    expect(plan.keeps).toContain("stays in Sektar");
    expect(hasBuiltAnything(created().state.global)).toBe(false);
  });

  it("hands built things to the runner to take down first", () => {
    const s = structuredClone(created().state.global);
    s.resources.liveWorkflowId = "wf";
    const plan = removalPlan(s);
    expect(plan.immediate).toBe(false);
    expect(plan.steps.join(" ")).toContain("signs out of Google");
    const backfillOnly = structuredClone(created().state.global);
    backfillOnly.intent.backfill.items[0]!.documentId = "osq";
    expect(hasBuiltAnything(backfillOnly)).toBe(true);
  });

  it("forgets the sign-in in this environment when it runs as one", () => {
    const s = structuredClone(created().state.global);
    s.resources.liveWorkflowId = "wf";
    expect(removalPlan(s).steps[2]).toBe(
      "Sektar signs out of Google and forgets the sign-in on the computer that runs it.",
    );
    expect(removalPlan(s, { environment: true }).steps[2]).toBe(
      "Sektar signs out of Google and forgets the sign-in in this environment.",
    );
  });

  it("names the kind and account generically when they are unknown", () => {
    const plan = removalPlan(utils.createDocument().state.global);
    expect(plan.keeps).toBe(
      "Everything already brought in stays in Sektar. The account itself is not changed.",
    );
    expect(removalPlan(created().state.global).keeps).toContain(
      "Your Google account itself",
    );
  });

  it("calls a document whose setup never finished incomplete", () => {
    expect(cardView(utils.createDocument().state.global)).toMatchObject({
      state: "incomplete",
      line: "Its setup did not finish. Remove it and add it again.",
    });
  });

  it("shows Removing once archived", () => {
    const s = structuredClone(created().state.global);
    s.intent.archived = true;
    expect(cardView(s).state).toBe("removing");
  });
});

describe("Create", () => {
  it("writes the intent in one batch the model accepts", () => {
    const doc = created();
    expect(doc.operations.global.every((op) => !op.error)).toBe(true);
    const s = doc.state.global;
    expect(s.kind).toBe("CALENDAR");
    expect(s.provider).toBe("google-calendar");
    expect(s.intent.source).toEqual({ calendars: [], allOwned: true });
    expect(s.intent.live).toEqual({
      enabled: true,
      every: { value: 5, unit: "MINUTES" },
    });
    // What is coming first, then the history back to the chosen start, a week at a time
    expect(s.intent.backfill.items).toEqual([
      expect.objectContaining({
        id: "bf-1",
        label: "Next 12 months",
        documentType: DATE_RANGE_BACKFILL_TYPE,
        request: {
          from: "2026-10-28T00:00:00.000Z",
          to: "2027-10-28T00:00:00.000Z",
          stepSeconds: 604800,
          direction: "FORWARD",
        },
      }),
      expect.objectContaining({
        id: "bf-2",
        label: "Back to 1 Jan 2025",
        documentType: DATE_RANGE_BACKFILL_TYPE,
        request: {
          from: "2025-01-01T00:00:00.000Z",
          to: "2026-10-28T00:00:00.000Z",
          stepSeconds: 604800,
          direction: "BACKWARD",
        },
      }),
    ]);
  });

  it("brings in only what is coming when no history is wanted, and names everything", () => {
    const none = created(calendar({ history: { kind: "none" } }));
    expect(none.state.global.intent.backfill.items.map((i) => i.label)).toEqual(
      ["Next 12 months"],
    );
    const all = created(calendar({ history: { kind: "everything" } }));
    expect(all.operations.global.every((op) => !op.error)).toBe(true);
    expect(all.state.global.intent.backfill.items.map((i) => i.label)).toEqual([
      "Next 12 months",
      "Everything before today",
    ]);
  });
});

describe("cardView", () => {
  const withState = (
    doc: IntegrationDocument,
    patch: (s: IntegrationDocument["state"]["global"]) => void,
  ) => {
    const s = structuredClone(doc.state.global);
    patch(s);
    return s;
  };

  it("waits for sign-in until the runner has a connection", () => {
    const view = cardView(created().state.global);
    expect(view.state).toBe("waiting-for-sign-in");
    expect(view.line).toBe(
      "Sign in on the computer that runs Sektar to finish",
    );
    const named = cardView(
      withState(created(), (s) => {
        s.runner = { reactorId: "r1", label: "Wouter's PC" };
      }),
    );
    expect(named.line).toBe("Sign in on Wouter's PC to finish");
  });

  it("asks for the sign-in here, naming no computer, in an environment", () => {
    const view = cardView(
      withState(created(), (s) => {
        s.runner = {
          reactorId: "switchboard@acme.vetra.io",
          label: "acme.vetra.io",
        };
      }),
      { environment: true },
    );
    expect(view.state).toBe("waiting-for-sign-in");
    expect(view.line).toBe("Sign in with Google to finish");
  });

  it("keeps waiting while the runner reports that a sign-in is needed", () => {
    const view = cardView(
      withState(created(), (s) => {
        s.resources.connectionId = "conn";
        s.check = {
          at: "2026-10-28T10:00:00.000Z",
          host: "pc",
          generation: 4,
          request: null,
          issues: [
            {
              code: "NEEDS_SIGN_IN",
              severity: "BLOCKING",
              subject: "conn",
              message: "Sign in",
              fixable: false,
              since: "2026-10-28T10:00:00.000Z",
            },
          ],
        };
      }),
    );
    expect(view.state).toBe("waiting-for-sign-in");
  });

  it("applies, then goes live or paused once the generation is committed", () => {
    const signedIn = withState(created(), (s) => {
      s.resources.connectionId = "conn";
    });
    expect(cardView(signedIn).state).toBe("applying");
    const committed = {
      ...signedIn,
      applied: {
        generation: signedIn.intent.generation,
        at: "2026-10-28T10:00:00.000Z",
        host: "pc",
      },
    };
    expect(cardView(committed)).toEqual({
      state: "live",
      badge: { label: "Live", tone: "success", dot: true },
      line: "Checks for changes every 5 minutes",
    });
    const paused = structuredClone(committed);
    paused.intent.live.enabled = false;
    expect(cardView(paused).state).toBe("paused");
  });

  it("puts a blocking problem first, in the runner's words", () => {
    const view = cardView(
      withState(created(), (s) => {
        s.resources.connectionId = "conn";
        s.check = {
          at: "2026-10-28T10:00:00.000Z",
          host: "pc",
          generation: 4,
          request: null,
          issues: [
            {
              code: "CONNECTION_REVOKED",
              severity: "BLOCKING",
              subject: "conn",
              message: "Google access was removed. Reconnect.",
              fixable: false,
              since: "2026-10-28T10:00:00.000Z",
            },
          ],
        };
      }),
    );
    expect(view).toEqual({
      state: "attention",
      badge: { label: "Needs attention", tone: "danger", dot: true },
      line: "Google access was removed. Reconnect.",
    });
  });
});

describe("historyView", () => {
  const ready = () => {
    const s = structuredClone(created().state.global);
    s.intent.backfill.items[0].documentId = "q-ahead";
    s.intent.backfill.items[1].documentId = "q-back";
    s.resources.pluggedItemId = "bf-1";
    return s;
  };
  const progress = (
    ahead: [number, number, boolean],
    back: [number, number, boolean],
  ) =>
    new Map([
      ["q-ahead", { done: ahead[0], total: ahead[1], finished: ahead[2] }],
      ["q-back", { done: back[0], total: back[1], finished: back[2] }],
    ]);

  it("says it is starting until every backfill has its queue", () => {
    expect(historyView(created().state.global, new Map())).toEqual({
      line: "Starting",
      percent: null,
      complete: false,
    });
  });

  it("says which backfill runs, how many are done, and how far all of them are", () => {
    expect(
      historyView(ready(), progress([13, 53, false], [0, 96, false])),
    ).toEqual({
      line: "Running Next 12 months · 0 of 2 done · 13 of 149 weeks",
      percent: 9,
      complete: false,
    });
    const back = ready();
    back.resources.pluggedItemId = "bf-2";
    expect(
      historyView(back, progress([53, 53, true], [48, 96, false]))?.line,
    ).toBe("Running Back to 1 Jan 2025 · 1 of 2 done · 101 of 149 weeks");
  });

  it("says paused when the switch is off, and complete when all are walked", () => {
    const off = ready();
    off.intent.backfill.enabled = false;
    expect(
      historyView(off, progress([13, 53, false], [0, 96, false]))?.line,
    ).toBe("Paused · 13 of 149 weeks");
    expect(
      historyView(ready(), progress([53, 53, true], [96, 96, true])),
    ).toEqual({
      line: "Complete · 149 weeks",
      percent: 100,
      complete: true,
    });
  });

  it("is not there without backfills", () => {
    const none = structuredClone(created().state.global);
    none.intent.backfill.items = [];
    expect(historyView(none, new Map())).toBeNull();
  });
});

describe("liveLine", () => {
  const NOW_MS = Date.parse("2026-10-28T15:00:00.000Z");
  const trigger = (
    patch: Partial<Parameters<typeof liveLine>[1] & object> = {},
  ) => ({
    workflowId: "wf",
    status: "ENABLED",
    lastPollAt: "2026-10-28T14:56:00.000Z",
    nextPollAt: null,
    lastError: null,
    ...patch,
  });

  it("says when it last looked and how often it does", () => {
    const s = created().state.global;
    expect(liveLine(s, trigger(), NOW_MS)).toEqual({
      line: "Synced 4 min ago · checks every 5 minutes",
      dot: "ok",
    });
    expect(liveLine(s, trigger({ lastPollAt: null }), NOW_MS)).toEqual({
      line: "Starting · checks every 5 minutes",
      dot: "running",
    });
    // Not read yet: only how often
    expect(liveLine(s, undefined, NOW_MS)).toEqual({
      line: "Checks for changes every 5 minutes",
      dot: null,
    });
  });

  it("says when it fails, stopped, or is off", () => {
    const s = created().state.global;
    expect(
      liveLine(s, trigger({ status: "ERROR", lastError: "timeout" }), NOW_MS),
    ).toEqual({ line: "Failing · last synced 4 min ago", dot: "warning" });
    expect(liveLine(s, trigger({ status: "PARKED" }), NOW_MS)).toEqual({
      line: "Stopped · last synced 4 min ago",
      dot: "error",
    });
    expect(
      liveLine(s, trigger({ status: "PARKED", lastPollAt: null }), NOW_MS).line,
    ).toBe("Stopped");
    expect(
      liveLine(s, trigger({ status: "ERROR", lastPollAt: null }), NOW_MS).line,
    ).toBe("Failing");
    const off = structuredClone(s);
    off.intent.live.enabled = false;
    expect(liveLine(off, trigger(), NOW_MS)).toEqual({
      line: "Off",
      dot: "paused",
    });
  });
});

describe("an email integration from the create flow", () => {
  it("brings in its mail back from today, a day at a time, into a folder named after it", () => {
    const choices = {
      ...defaultChoices("EMAIL", "gmail", NOW),
      name: "Work mail",
    };
    expect(choices.every).toEqual({ value: 15, unit: "MINUTES" });
    const doc = created(choices);
    expect(doc.operations.global.every((op) => !op.error)).toBe(true);
    const s = doc.state.global;
    expect(s.intent.source).toEqual({
      mailbox: "Work mail",
      address: null,
      folders: [],
    });
    // No months ahead for mail: only the way back
    expect(s.intent.backfill.items).toEqual([
      expect.objectContaining({
        label: "Back to 1 Jan 2025",
        request: {
          from: "2025-01-01T00:00:00.000Z",
          to: "2026-10-28T00:00:00.000Z",
          stepSeconds: 86400,
          direction: "BACKWARD",
        },
      }),
    ]);
    expect(
      created({ ...choices, history: { kind: "none" } }).state.global.intent
        .backfill.items,
    ).toEqual([]);
    expect(accessOptions("gmail").map((o) => [o.access, o.permission])).toEqual(
      [["READ", "Google: gmail.readonly"]],
    );
    expect(providersFor("EMAIL").map((p) => [p.id, p.available])).toEqual([
      ["gmail", true],
    ]);
  });
});
