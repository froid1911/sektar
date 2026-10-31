/**
 * The integrations' words and rules that the page, the create flow and the
 * cards share, kept free of React so they can be tested on their own: the
 * kinds and providers the flow offers, what a choice of "how much" means,
 * the actions Create dispatches, and the state a card shows.
 * Design: workspace/integrations-design.md; pilot: calendar-integration-pilot.md.
 */
import type { QueueProgress } from "../../backfills/progress.js";
import { ago } from "./folder-sync.js";
import type { TriggerState } from "./workflow-runtime.js";
import {
  actions,
  type IntegrationAccess,
  type IntegrationAction,
  type IntegrationKind,
  type IntegrationState,
  type IntervalUnit,
} from "document-models/integration";
import type { BadgeTone } from "./format.js";
import type { IconName } from "./ui.js";

export const INTEGRATION_TYPE = "sektar/integration";
/** The backfill document type the reconciler creates for a date range. */
export const DATE_RANGE_BACKFILL_TYPE = "distyra/original-source-queue";

export type KindInfo = {
  kind: IntegrationKind;
  label: string;
  /** One line under the label on the "What to bring in" tile */
  lead: string;
  icon: IconName;
  /** Offered in the create flow; the others say Coming soon */
  available: boolean;
};

/** In the order the "What to bring in" step shows them. */
export const KINDS: readonly KindInfo[] = [
  {
    kind: "CALENDAR",
    label: "Calendar",
    lead: "Events and meetings",
    icon: "calendar",
    available: true,
  },
  {
    kind: "EMAIL",
    label: "Email",
    lead: "Messages and attachments",
    icon: "mail",
    available: true,
  },
  {
    kind: "TRANSACTIONS",
    label: "Bank transactions",
    lead: "Payments in and out",
    icon: "bank",
    available: true,
  },
  {
    kind: "TIME_TRACKING",
    label: "Time tracking",
    lead: "Hours worked",
    icon: "reports",
    available: false,
  },
];

export function kindInfo(
  kind: IntegrationKind | null | undefined,
): KindInfo | undefined {
  return KINDS.find((k) => k.kind === kind);
}

/** The hash that opens Add integration with this kind already chosen. */
export function addHashFor(kind: IntegrationKind): string {
  return `add/for/${kind}`;
}

/** The kind such a hash asks for, when it's one that can be added. */
export function kindOfAddHash(hash: string | null): IntegrationKind | null {
  const found = KINDS.find((k) => k.available && addHashFor(k.kind) === hash);
  return found?.kind ?? null;
}

export type ProviderInfo = {
  id: string;
  kind: IntegrationKind;
  /** As people know it */
  label: string;
  lead: string;
  /** What it can do, in a badge: Instant, Every 5 min */
  badge: string;
  /** The tile's letter or icon; no brand marks */
  mark: string;
  available: boolean;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "google-calendar",
    kind: "CALENDAR",
    label: "Google",
    lead: "Google Calendar and Workspace",
    badge: "Every 5 min",
    mark: "G",
    available: true,
  },
  {
    id: "gmail",
    kind: "EMAIL",
    label: "Google",
    lead: "Gmail and Workspace",
    badge: "Every 15 min",
    mark: "G",
    available: true,
  },
  {
    id: "distyra",
    kind: "TRANSACTIONS",
    label: "Distyra",
    lead: "Open banking",
    badge: "Every 6 hours",
    mark: "D",
    available: true,
  },
  {
    id: "microsoft-calendar",
    kind: "CALENDAR",
    label: "Microsoft 365",
    lead: "Outlook and Exchange",
    badge: "Coming soon",
    mark: "M",
    available: false,
  },
  {
    id: "caldav",
    kind: "CALENDAR",
    label: "Other calendar",
    lead: "iCloud, Fastmail and others",
    badge: "Coming soon",
    mark: "",
    available: false,
  },
];

export function providersFor(kind: IntegrationKind): ProviderInfo[] {
  return PROVIDERS.filter((p) => p.kind === kind);
}

export function providerInfo(
  id: string | null | undefined,
): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * What each access level lets Sektar do with the account, in the user's
 * words, and the provider permission it maps to (the scope override asks for
 * exactly this, so the provider's own consent screen says the same).
 */
export type AccessOption = {
  access: IntegrationAccess;
  label: string;
  can: string[];
  cannot: string[];
  /** The provider's permission, shown small for those who check */
  permission: string;
};

const ACCESS: Record<string, AccessOption[]> = {
  distyra: [
    {
      access: "READ",
      label: "Read only",
      can: ["See your accounts and their transactions"],
      cannot: ["Move money or change anything at the bank"],
      permission: "Distyra: account information (PSD2)",
    },
  ],
  gmail: [
    {
      access: "READ",
      label: "Read only",
      can: ["Read your messages", "Keep their attachments"],
      cannot: ["Send, change or delete mail"],
      permission: "Google: gmail.readonly",
    },
  ],
  "google-calendar": [
    {
      access: "READ",
      label: "Read only",
      can: [
        "See your calendars and events",
        "See guests, places and attachments",
      ],
      cannot: ["Change or delete anything"],
      permission: "Google: calendar.readonly",
    },
    {
      access: "READ_WRITE",
      label: "Read and write",
      can: [
        "Everything in Read only",
        "Add events, like trips you plan",
        "Change events Sektar added",
      ],
      cannot: ["Delete events"],
      permission: "Google: calendar.events",
    },
  ],
};

export function accessOptions(
  provider: string | null | undefined,
): AccessOption[] {
  return (provider && ACCESS[provider]) || [];
}

export type History =
  | { kind: "none" }
  | { kind: "since"; date: string }
  | { kind: "everything" };

/** What the user picked in the flow, before anything is written. */
export type CreateChoices = {
  kind: IntegrationKind;
  provider: string;
  name: string;
  access: IntegrationAccess;
  live: boolean;
  every: { value: number; unit: IntervalUnit };
  history: History;
  /** Bank transactions: the aggregator connection (API key) to use */
  connectionId?: string;
  /** Bank transactions: the aggregator's bank connection, and its name */
  bankConnectionId?: string;
  bankName?: string;
  /** Bank transactions: the accounts to bring in */
  accounts?: BankAccountChoice[];
};

/** The intervals the "Check every" select offers. */
export const INTERVALS: readonly {
  value: number;
  unit: IntervalUnit;
  label: string;
}[] = [
  { value: 5, unit: "MINUTES", label: "5 minutes" },
  { value: 15, unit: "MINUTES", label: "15 minutes" },
  { value: 1, unit: "HOURS", label: "hour" },
];

/** Months ahead a calendar's first import reaches. */
export const MONTHS_AHEAD = 12;
/** "Everything": earlier than any calendar a person still keeps. */
const EVERYTHING_FROM = "2000-01-01";
/**
 * One slice of a calendar backfill: a week of events. Google's Get Events
 * answers one page (250 events); a week stays well under it.
 */
export const CALENDAR_SLICE_SECONDS = 7 * 24 * 3600;

/** 1 January of last year, as yyyy-mm-dd: the "Since" default. */
export function defaultSince(now: Date): string {
  return `${now.getFullYear() - 1}-01-01`;
}

export function defaultChoices(
  kind: IntegrationKind,
  provider: string,
  now: Date,
): CreateChoices {
  return {
    kind,
    provider,
    name: defaultName(kind, provider),
    access: "READ",
    live: true,
    every: KIND_COPY[kind]?.every ?? { value: 5, unit: "MINUTES" },
    history: { kind: "since", date: defaultSince(now) },
  };
}

/** What the create flow says about a kind, and how it brings its history in. */
export type KindCopy = {
  /** The "How much?" row naming what comes in */
  sourceLabel: string;
  sourceMeta: string;
  /** What live updates bring */
  liveMeta: string;
  /** The history legend */
  historyLegend: string;
  /** "fetches your calendar" */
  thing: string;
  every: { value: number; unit: IntervalUnit };
  /** One backfill slice; 0: the provider keeps the history itself */
  sliceSeconds: number;
  /** Also bring in what is ahead (a calendar's coming months) */
  ahead: boolean;
  /** The "Check every" choices; absent: INTERVALS */
  intervals?: typeof INTERVALS;
};

export const KIND_COPY: Partial<Record<IntegrationKind, KindCopy>> = {
  CALENDAR: {
    sourceLabel: "Calendars",
    sourceMeta: "All you own. Pick specific ones after signing in.",
    liveMeta: "New, moved and cancelled events",
    historyLegend: "Older events",
    thing: "your calendar",
    every: { value: 5, unit: "MINUTES" },
    sliceSeconds: 7 * 24 * 3600,
    ahead: true,
  },
  EMAIL: {
    sourceLabel: "Mail",
    sourceMeta: "All mail except spam and trash, with attachments",
    liveMeta: "New messages",
    historyLegend: "Older mail",
    thing: "your mail",
    every: { value: 15, unit: "MINUTES" },
    // A day of mail per slice, as the existing mail backfills walk
    sliceSeconds: 24 * 3600,
    ahead: false,
  },
  TRANSACTIONS: {
    sourceLabel: "Accounts",
    sourceMeta: "The accounts you pick, each onto a bank account in Sektar",
    liveMeta: "New transactions",
    historyLegend: "",
    thing: "your bank",
    // Banks allow about four unattended fetches a day
    every: { value: 6, unit: "HOURS" },
    sliceSeconds: 0,
    ahead: false,
    intervals: [
      { value: 6, unit: "HOURS", label: "6 hours" },
      { value: 12, unit: "HOURS", label: "12 hours" },
      { value: 1, unit: "DAYS", label: "day" },
    ],
  },
};

/** One bank account the create flow brings in, and the Sektar bank account it goes onto. */
export type BankAccountChoice = {
  accountId: string;
  accountKey: string;
  label: string;
  /** A sektar/bank-account id, or null: make a new one at Create */
  bankAccountId: string | null;
  /** For a new one */
  name: string;
  currency: string | null;
  ibanMasked: string | null;
  kind: string | null;
};

export function defaultName(kind: IntegrationKind, provider: string): string {
  const p = providerInfo(provider);
  const k = kindInfo(kind);
  return [p?.label, k?.label].filter(Boolean).join(" ") || "Integration";
}

const startOfDayUtc = (d: Date) =>
  Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

/** The range the first import covers: from the history choice to MONTHS_AHEAD from today. */
export function importRange(
  history: History,
  now: Date,
): { from: string; to: string } {
  const today = startOfDayUtc(now);
  const ahead = new Date(today);
  ahead.setUTCMonth(ahead.getUTCMonth() + MONTHS_AHEAD);
  const from =
    history.kind === "none"
      ? today
      : history.kind === "everything"
        ? Date.parse(`${EVERYTHING_FROM}T00:00:00.000Z`)
        : Date.parse(`${history.date}T00:00:00.000Z`);
  return {
    from: new Date(
      Number.isNaN(from) ? today : Math.min(from, today),
    ).toISOString(),
    to: ahead.toISOString(),
  };
}

const MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "1 Jan 2025 to 12 months ahead", "Today to 12 months ahead" */
export function rangeLabel(history: History, now: Date): string {
  const ahead = `${MONTHS_AHEAD} months ahead`;
  if (history.kind === "none") return `Today to ${ahead}`;
  if (history.kind === "everything") return `Everything to ${ahead}`;
  const { from } = importRange(history, now);
  return `${MONTH.format(new Date(from))} to ${ahead}`;
}

/**
 * The first import as backfill items, in the order they run: from today
 * forward (what is coming shows first), then from today back to the start
 * of the history the person chose, newest first. No history: forward only.
 */
export function importItems(
  history: History,
  now: Date,
): {
  label: string;
  from: string;
  to: string;
  direction: "FORWARD" | "BACKWARD";
}[] {
  const { from, to } = importRange(history, now);
  const today = new Date(startOfDayUtc(now)).toISOString();
  const items: ReturnType<typeof importItems> = [
    {
      label: `Next ${MONTHS_AHEAD} months`,
      from: today,
      to,
      direction: "FORWARD",
    },
  ];
  if (Date.parse(from) < Date.parse(today)) {
    items.push({
      label:
        history.kind === "everything"
          ? "Everything before today"
          : `Back to ${MONTH.format(new Date(from))}`,
      from,
      to: today,
      direction: "BACKWARD",
    });
  }
  return items;
}

export function intervalLabel(every: {
  value: number;
  unit: IntervalUnit;
}): string {
  const unit =
    every.unit === "MINUTES"
      ? "minute"
      : every.unit === "HOURS"
        ? "hour"
        : "day";
  return every.value === 1 ? `every ${unit}` : `every ${every.value} ${unit}s`;
}

/**
 * The actions Create dispatches on the new document, in one batch: the kind,
 * the source, live updates, and the first import as date-range backfills
 * (importItems).
 * The document's name is set when it is created (the built-in name).
 */
export function createActions(
  choices: CreateChoices,
  now: Date,
  newId: () => string,
): IntegrationAction[] {
  if (choices.kind === "TRANSACTIONS") {
    // Every account already onto a Sektar bank account (Create makes the new ones first)
    const accounts = (choices.accounts ?? []).filter(
      (a): a is BankAccountChoice & { bankAccountId: string } =>
        a.bankAccountId !== null,
    );
    return [
      actions.initialize({ kind: choices.kind, provider: choices.provider }),
      actions.setAccess({ access: "READ" }),
      actions.setConnection({ connectionId: choices.connectionId }),
      actions.setTransactionsSource({
        bankConnectionId: choices.bankConnectionId ?? "",
        accounts: accounts.map((a) => ({
          accountId: a.accountId,
          accountKey: a.accountKey,
          bankAccountId: a.bankAccountId,
          label: a.label,
        })),
      }),
      actions.setLiveEnabled({ enabled: choices.live }),
      actions.setLiveInterval({
        value: choices.every.value,
        unit: choices.every.unit,
      }),
      // The aggregator keeps the history: no backfill
      actions.setBackfillEnabled({ enabled: false }),
    ];
  }
  return [
    actions.initialize({ kind: choices.kind, provider: choices.provider }),
    actions.setAccess({ access: choices.access }),
    choices.kind === "EMAIL"
      ? // The account's name is its folder in the Mail drive
        actions.setEmailSource({ mailbox: choices.name, folders: [] })
      : actions.setCalendarSource({ calendars: [], allOwned: true }),
    actions.setLiveEnabled({ enabled: choices.live }),
    actions.setLiveInterval({
      value: choices.every.value,
      unit: choices.every.unit,
    }),
    actions.setBackfillEnabled({ enabled: true }),
    ...importItems(choices.history, now)
      .filter(
        (item) =>
          KIND_COPY[choices.kind]?.ahead !== false ||
          item.direction === "BACKWARD",
      )
      .map((item) =>
        actions.addDateRangeBackfill({
          id: newId(),
          label: item.label,
          documentType: DATE_RANGE_BACKFILL_TYPE,
          from: item.from,
          to: item.to,
          stepSeconds:
            KIND_COPY[choices.kind]?.sliceSeconds ?? CALENDAR_SLICE_SECONDS,
          direction: item.direction,
        }),
      ),
  ];
}

export type CardState =
  | "waiting-for-sign-in"
  | "applying"
  | "live"
  | "paused"
  | "attention"
  | "removing"
  | "incomplete";

export type CardView = {
  state: CardState;
  badge: { label: string; tone: BadgeTone; dot?: boolean };
  /** One line under the head, in the user's words */
  line: string;
};

/**
 * How the texts speak of where Sektar runs. environment: an environment at a
 * public address, where the sign-in finishes with the card's button
 * (sign-in-place.ts); otherwise someone's computer, named by the runner.
 */
export type WhereOptions = { environment?: boolean };

/**
 * What a card shows, from the document alone. Later steps add the live facts
 * (last sync, runs, backfill progress) read from the workflows; this is the
 * part the document can answer.
 */
export function cardView(
  state: IntegrationState,
  options: WhereOptions = {},
): CardView {
  const where = state.runner?.label
    ? state.runner.label
    : "the computer that runs Sektar";
  if (!state.kind) {
    return {
      state: "incomplete",
      badge: { label: "Incomplete", tone: "warning" },
      line: "Its setup did not finish. Remove it and add it again.",
    };
  }
  if (state.intent.archived) {
    return {
      state: "removing",
      badge: { label: "Removing", tone: "outline" },
      line: "Taking down what Sektar set up for it",
    };
  }
  const blocking = state.check?.issues.find(
    (i) => i.severity === "BLOCKING" && i.code !== "NEEDS_SIGN_IN",
  );
  if (blocking) {
    return {
      state: "attention",
      badge: { label: "Needs attention", tone: "danger", dot: true },
      line: blocking.message,
    };
  }
  const signedIn =
    Boolean(state.resources.connectionId) &&
    !state.check?.issues.some((i) => i.code === "NEEDS_SIGN_IN");
  if (!signedIn) {
    return {
      state: "waiting-for-sign-in",
      badge: { label: "Waiting for sign-in", tone: "warning", dot: true },
      line: options.environment
        ? `Sign in with ${providerInfo(state.provider)?.label ?? "the provider"} to finish`
        : `Sign in on ${where} to finish`,
    };
  }
  if ((state.applied?.generation ?? -1) < state.intent.generation) {
    return {
      state: "applying",
      badge: { label: "Applying", tone: "outline" },
      line: "Setting up what you asked for",
    };
  }
  if (!state.intent.live.enabled) {
    return {
      state: "paused",
      badge: { label: "Paused", tone: "outline" },
      line: "Live updates are off",
    };
  }
  return {
    state: "live",
    badge: { label: "Live", tone: "success", dot: true },
    line: `Checks for changes ${intervalLabel(state.intent.live.every)}`,
  };
}

/** Whether anything was built for an integration: a connection, a workflow or a backfill document. */
export function hasBuiltAnything(state: IntegrationState): boolean {
  const r = state.resources;
  return Boolean(
    r.connectionId ||
    r.liveWorkflowId ||
    r.backfillWorkflowId ||
    state.intent.backfill.items.some((b) => b.documentId),
  );
}

export type RemovalPlan = {
  /** Nothing was built: the document goes now. Otherwise the runner takes things down first. */
  immediate: boolean;
  /** What removing does, in order, in the user's words */
  steps: string[];
  /** What stays */
  keeps: string;
};

/**
 * What removing an integration does. Built things are taken down by the
 * reconciler on the runner (it holds the token and the workflows), so the app
 * only records the wish (ARCHIVE) and the card says Removing until it is done.
 */
export function removalPlan(
  state: IntegrationState,
  options: WhereOptions = {},
): RemovalPlan {
  const kind = kindInfo(state.kind)?.label.toLowerCase() ?? "integration";
  const known = providerInfo(state.provider)?.label;
  const provider = known ?? "the account";
  const keeps = `Everything already brought in stays in Sektar. ${known ? `Your ${known} account` : "The account"} itself is not changed.`;
  if (!hasBuiltAnything(state)) {
    return {
      immediate: true,
      steps: [
        "Nothing has been set up for it yet, so it is removed right away.",
      ],
      keeps,
    };
  }
  return {
    immediate: false,
    steps: [
      "Live updates and the history import stop.",
      `The workflows Sektar made for this ${kind} are archived.`,
      options.environment
        ? `Sektar signs out of ${provider} and forgets the sign-in in this environment.`
        : `Sektar signs out of ${provider} and forgets the sign-in on the computer that runs it.`,
      "Then the integration disappears from this page.",
    ],
    keeps,
  };
}

/** What the Backfill row on a card says, from the integration and its queues. */
export type HistoryView = {
  line: string;
  /** 0–100; null while no queue exists yet */
  percent: number | null;
  complete: boolean;
};

/** A slice size in words, for counting: "weeks", "days", or plain "slices". */
export function sliceUnit(stepSeconds: number): string {
  if (stepSeconds === 7 * 86400) return "weeks";

  if (stepSeconds === 86400) return "days";
  return "slices";
}

const count = (n: number) => n.toLocaleString("en-GB");

/**
 * The Backfill row (design system: Patterns · Integrations · card), from
 * the integration and the progress of its queues (by queue id). Null when
 * it asks for no history.
 */
export function historyView(
  state: IntegrationState,
  progress: ReadonlyMap<string, QueueProgress>,
): HistoryView | null {
  const items = state.intent.backfill.items;
  if (items.length === 0) return null;
  const known = items.map((item) =>
    item.documentId ? progress.get(item.documentId) : undefined,
  );
  if (known.some((p) => !p)) {
    return { line: "Starting", percent: null, complete: false };
  }
  const all = known as QueueProgress[];
  const done = all.reduce((n, p) => n + p.done, 0);
  const total = all.reduce((n, p) => n + p.total, 0);
  const finished = all.filter((p) => p.finished).length;
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);
  // Adopted backfills carry no request: the unit comes from the ones that say
  const steps = items
    .map(
      (i) => (i.request as { stepSeconds?: number } | null)?.stepSeconds ?? 0,
    )
    .filter((x) => x > 0);
  const unit =
    steps.length > 0 && steps.every((x) => x === steps[0])
      ? sliceUnit(steps[0] ?? 0)
      : "slices";
  const amount = `${count(done)} of ${count(total)} ${unit}`;
  if (finished === items.length) {
    return {
      line: `Complete · ${count(total)} ${unit}`,
      percent: 100,
      complete: true,
    };
  }
  if (!state.intent.backfill.enabled) {
    return { line: `Paused · ${amount}`, percent, complete: false };
  }
  const plugged = items.find((i) => i.id === state.resources.pluggedItemId);
  const parts = [
    plugged ? `Running ${plugged.label}` : "Running",
    items.length > 1 ? `${finished} of ${items.length} done` : null,
    amount,
  ].filter(Boolean);
  return { line: parts.join(" · "), percent, complete: false };
}

/** What the Live updates row says, and its dot (design system: sk-sync-dot). */
export type LiveLine = {
  line: string;
  dot: "ok" | "running" | "paused" | "warning" | "error" | null;
};

/**
 * The Live updates row: when the live workflow last looked for changes and
 * how often it does ("Synced 4 min ago · checks every 5 minutes"), from the
 * runtime's trigger state. Without one (not read yet, or never polled) it
 * says how often it checks.
 */
export function liveLine(
  state: IntegrationState,
  trigger: TriggerState | undefined,
  now = Date.now(),
): LiveLine {
  const every = intervalLabel(state.intent.live.every);
  if (!state.intent.live.enabled) return { line: "Off", dot: "paused" };
  if (!trigger) return { line: `Checks for changes ${every}`, dot: null };
  const last = trigger.lastPollAt ? ago(trigger.lastPollAt, now) : null;
  if (trigger.status === "PARKED") {
    return {
      line: last ? `Stopped · last synced ${last}` : "Stopped",
      dot: "error",
    };
  }
  if (trigger.status === "ERROR" || trigger.lastError) {
    return {
      line: last ? `Failing · last synced ${last}` : "Failing",
      dot: "warning",
    };
  }
  if (!last) return { line: `Starting · checks ${every}`, dot: "running" };
  return { line: `Synced ${last} · checks ${every}`, dot: "ok" };
}
