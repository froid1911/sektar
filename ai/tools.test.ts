import { MAX_TOOL_RESULT_CHARS } from "@powerhousedao/reactor-browser/ai";
import type { PhAiToolDescriptor } from "@powerhousedao/shared/document-model";
import {
  addAttachment,
  reducer as invoiceReducer,
  utils as invoiceUtils,
} from "document-models/invoice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetHandles } from "./handles.js";
import { RESULT_BUDGET } from "./read.js";
import {
  answerWith,
  BASE,
  installStore,
  serve,
  TOKEN,
  unreachable,
} from "./test-index.js";
import { aiTools } from "./tools.js";

const LONG = "a long stretch of text ".repeat(40);

const refOf = (i: number) =>
  `attachment://v1:${String(i).repeat(64).slice(0, 64)}` as const;

function tool(name: string): PhAiToolDescriptor {
  const found = aiTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found;
}

const call = (name: string, args: unknown = {}) =>
  tool(name).callback(args as never) as Promise<Record<string, unknown>>;

const invoice = (i: number, over: Record<string, unknown> = {}) => ({
  id: `invoice-${i}`,
  direction: "OUTGOING",
  kind: "INVOICE",
  status: "DRAFT",
  number: null,
  counterpartyName: "Powerhouse Inc",
  counterpartyContactId: "contact-1",
  subject: "Consulting",
  firstLine: "Consulting, October",
  currency: "EUR",
  issuedAt: null,
  dueAt: null,
  deliveredAt: null,
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-10-31T00:00:00.000Z",
  createdAt: "2026-10-28T09:12:00.000Z",
  gross: 1210,
  outstanding: 1210,
  bookGross: 1210,
  bookOutstanding: 1210,
  bookRateKnown: true,
  overdue: false,
  issuedCopyId: null,
  issuedCopyRef: null,
  lineCount: 1,
  linesMissingAttachments: 0,
  lastPaidAt: null,
  updatedAt: "2026-10-28T09:12:00.000Z",
  ...over,
});

const transaction = (i: number, over: Record<string, unknown> = {}) => ({
  id: `tx-${i}`,
  accountId: "account-1",
  bookedAt: "2026-10-20T00:00:00.000Z",
  counterparty: "Acme",
  description: "Monthly fee",
  reference: "RF18",
  category: "SOFTWARE",
  status: "NEW",
  amount: -49,
  currency: "EUR",
  contactId: null,
  matchedDocumentId: null,
  matchedKind: null,
  importBatch: "batch-secret-detail",
  ...over,
});

const contact = (i: number, over: Record<string, unknown> = {}) => ({
  id: `contact-${i}`,
  name: "Powerhouse Inc",
  kind: "CUSTOMER",
  status: "ACTIVE",
  email: "billing@powerhouse.test",
  phone: null,
  website: null,
  vatId: "BE0123456789",
  registrationNumber: null,
  street: "Hidden street 1",
  postalCode: "9000",
  city: "Ghent",
  country: "BE",
  paymentTermsDays: 30,
  defaultCategory: "SALES",
  tags: [],
  openInvoiceCount: 2,
  openBookOutstanding: 2420,
  transactionCount: 7,
  lastTransactionAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

const message = (i: number, over: Record<string, unknown> = {}) => ({
  id: `mail-${i}`,
  accountAddress: "me@sektar.test",
  accountName: "Me",
  subject: "Your invoice",
  fromName: "Jo",
  fromAddress: "jo@example.test",
  snippet: "Please find attached",
  when: `2026-10-${String(10 + (i % 20)).padStart(2, "0")}T08:00:00.000Z`,
  read: false,
  flagged: false,
  status: "INBOX",
  attachmentCount: 1,
  attachmentRefs: [refOf(1)],
  labels: [],
  threadId: "thread-1",
  ...over,
});

const event = (i: number, over: Record<string, unknown> = {}) => ({
  id: `event-${i}`,
  calendarKey: "me|work",
  calendarId: "work",
  calendarAccount: "me",
  calendarName: "Work",
  calendarLabel: "Work",
  title: `Planning ${i}`,
  location: "Ghent",
  meetingUrl: null,
  startAt: "2026-11-02T09:00:00.000Z",
  endAt: "2026-11-02T10:00:00.000Z",
  startDate: null,
  endDate: null,
  timeZone: "Europe/Brussels",
  allDay: false,
  busy: true,
  tentative: false,
  status: "CONFIRMED",
  repeats: false,
  recurrence: [],
  recurrenceId: null,
  uid: `uid-${i}`,
  seriesId: null,
  seriesEnd: null,
  organizerName: "Jo",
  organizerEmail: "jo@example.test",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const fileEntry = (i: number, over: Record<string, unknown> = {}) => ({
  id: `file-${i}`,
  kind: "file",
  name: `Contract ${i}.pdf`,
  parentId: "folder-1",
  documentType: "sektar/file",
  title: "Contract",
  description: "Signed copy",
  tags: [{ id: "t", label: "Legal", color: "blue" }],
  sourceKind: "UPLOAD",
  sourceMime: "application/pdf",
  sourceName: "contract.pdf",
  sourceSize: 12000,
  sourceDocumentType: null,
  sourceDocumentName: null,
  renditionCount: 0,
  thumbRef: null,
  diskChange: null,
  ...over,
});

const trip = (i: number, over: Record<string, unknown> = {}) => ({
  id: `trip-${i}`,
  title: "Ghent client visit",
  status: "BOOKED",
  purposeKind: "CLIENT",
  startDate: "2026-11-02",
  endDate: "2026-11-04",
  travelerName: "Jo",
  destinations: [{ city: "Ghent", country: "BE" }],
  firstLeg: {
    mode: "TRAIN",
    carrier: "NMBS",
    number: null,
    from: "Brussels",
    to: "Ghent",
    departAt: "2026-11-02T07:00:00.000Z",
  },
  flights: 0,
  legs: 2,
  nights: 2,
  costTotal: 300,
  currency: "EUR",
  phase: "UPCOMING",
  ...over,
});

const year = {
  year: 2026,
  trips: 3,
  flights: 2,
  legs: 6,
  nights: 9,
  days: 12,
  cost: 2100,
  billed: 900,
  costByKind: { transport: 1, stays: 1, meals: 1, extras: 1 },
};

const integrationState = {
  kind: "EMAIL",
  intent: { archived: false, generation: 1, live: { enabled: true, every: { value: 15, unit: "MINUTES" } } },
  applied: { generation: 1 },
  resources: { connectionId: "connection-1" },
  check: { issues: [] },
};

const integration = (i: number, over: Record<string, unknown> = {}) => ({
  id: `integration-${i}`,
  name: "Work mail",
  kind: "EMAIL",
  provider: "gmail",
  archived: false,
  liveEnabled: true,
  backfillEnabled: false,
  liveWorkflowId: null,
  backfillWorkflowId: null,
  connectionId: "connection-1",
  mailbox: "work",
  address: "me@sektar.test",
  queueIds: [],
  state: JSON.stringify(integrationState),
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const queue = (i: number) => ({
  id: `queue-${i}`,
  name: `Mail history ${LONG}`,
  status: "IN_PROGRESS",
  description: null,
  loops: 1,
  total: 100,
  progress: 0.25,
  iteration: 26,
  done: 25,
  finished: false,
  awaitingValues: false,
  errorCount: 0,
  lastError: null,
  searchText: "",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const folderSync = (i: number) => ({
  id: `sync-${i}`,
  name: `Sync ${LONG}`,
  driveId: "drive",
  folderId: "folder-1",
  folderPath: "Contracts",
  localPath: "D:/contracts",
  enabled: true,
  trigger: "MANUAL",
  includeSubfolders: true,
  status: "OK",
  requestedAt: null,
  lastRun: { startedAt: null, finishedAt: "2026-10-01", status: "OK", placeholders: 0, error: null },
  issueCount: 0,
  pullCount: 0,
  hostName: "office-pc",
});

const hit = (i: number) => ({
  documentId: `invoice-${i}`,
  entityId: `invoice-${i}`,
  documentType: "sektar/invoice",
  kind: "invoice",
  title: "Invoice 2026-001",
  subtitle: "Powerhouse Inc",
  amount: 1210,
  status: "OPEN",
  at: "2026-10-01T00:00:00.000Z",
});

const page = <T>(items: T[], total = items.length) => ({
  items,
  total,
  hasMore: items.length < total,
});

const mailPage = <T>(items: T[], total = items.length) => ({
  items,
  total,
  nextCursor: null,
});

const dashboard = (over: Record<string, unknown> = {}) => ({
  bookCurrency: "EUR",
  cash: 5000,
  card: -200,
  receivable: 2420,
  payable: 300,
  overdue: [],
  toReview: 4,
  months: [{ key: "2026-10", in: 3000, out: 1000 }],
  spend: [{ category: "SOFTWARE", amount: 49 }],
  readiness: 50,
  categorisedPct: 50,
  matchedPct: 50,
  issuedPct: 50,
  transactionCount: 10,
  categorisedCount: 5,
  matchedCount: 2,
  salesCount: 4,
  invoiceCount: 8,
  issuedCount: 4,
  recent: [],
  ...over,
});

const finance = (fields: Record<string, unknown>) => ({ financeIndex: fields });

const summaryRoot = (over: Record<string, unknown> = {}) =>
  finance({
    dashboard: dashboard(over),
    invoiceCounts: {
      outgoing: 5,
      incoming: 3,
      byView: [{ direction: "OUTGOING", view: "DRAFT", count: 1 }],
    },
    accounts: [
      {
        id: "account-1",
        name: "Current",
        kind: "CURRENT",
        institution: "KBC",
        ibanLast4: "1234",
        currency: "EUR",
        openingBalance: 0,
        balance: 5000,
        txCount: 10,
        newCount: 4,
        lastImportedAt: null,
        lastBookedAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
      },
    ],
    counts: { accounts: 1, invoices: 8, contacts: 3 },
  });


/**
 * The tools that list rows: their arguments, an index with `rows` rows of
 * long text, and how to read the list out of the tool's answer.
 */
const LISTS: {
  name: string;
  args: Record<string, unknown>;
  root: (count: number) => Record<string, unknown>;
}[] = [
  {
    name: "sektarFindInvoices",
    args: {},
    root: (count) =>
      finance({
        invoices: page(
          Array.from({ length: count }, (_, i) =>
            invoice(i, { subject: LONG, counterpartyName: LONG }),
          ),
        ),
      }),
  },
  {
    name: "sektarFindTransactions",
    args: {},
    root: (count) =>
      finance({
        transactions: page(
          Array.from({ length: count }, (_, i) =>
            transaction(i, { description: LONG, counterparty: LONG }),
          ),
        ),
      }),
  },
  {
    name: "sektarFindContacts",
    args: {},
    root: (count) =>
      finance({
        contacts: page(
          Array.from({ length: count }, (_, i) =>
            contact(i, { name: LONG, website: LONG }),
          ),
        ),
      }),
  },
  {
    name: "sektarSearchMail",
    args: { view: "INBOX" },
    root: (count) => ({
      emailIndex: {
        messages: mailPage(
          Array.from({ length: count }, (_, i) =>
            message(i, { subject: LONG, snippet: LONG }),
          ),
        ),
        accounts: [],
      },
    }),
  },
  {
    name: "sektarCalendarEvents",
    args: { from: "2026-11-01", to: "2026-11-30", limit: 50 },
    root: (count) => ({
      calendarIndex: {
        events: Array.from({ length: count }, (_, i) =>
          event(i, { title: LONG, location: LONG }),
        ),
        calendars: [{ key: "me|work", label: "Work", events: count }],
      },
    }),
  },
  {
    name: "sektarFindFiles",
    args: { query: "contract" },
    root: (count) => ({
      filesIndex: {
        listing: page(
          Array.from({ length: count }, (_, i) =>
            fileEntry(i, { name: LONG, description: LONG, title: LONG }),
          ),
        ),
      },
    }),
  },
  {
    name: "sektarFindTrips",
    args: {},
    root: (count) => ({
      tripIndex: {
        trips: page(
          Array.from({ length: count }, (_, i) =>
            trip(i, { title: LONG, travelerName: LONG }),
          ),
        ),
        years: [],
        places: [],
      },
    }),
  },
];

const everyTool: { name: string; args: Record<string, unknown> }[] = [
  ...LISTS,
  { name: "sektarFinanceSummary", args: {} },
  { name: "sektarIntegrationStatus", args: {} },
  { name: "sektarSearch", args: { query: "powerhouse" } },
];

beforeEach(() => {
  forgetHandles();
  installStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** They go through the stored files, not an index: see attachments.test.ts. */
const ATTACHMENT_TOOLS = [
  "sektarListAttachments",
  "sektarReadAttachment",
  "sektarSaveChatImage",
  "sektarAttachToInvoice",
  "sektarAddToFiles",
];

describe("the tool set", () => {
  it("offers every tool under a name of its own, described", () => {
    expect(aiTools.map((t) => t.name).sort()).toEqual(
      [...everyTool.map((t) => t.name), ...ATTACHMENT_TOOLS].sort(),
    );
    for (const descriptor of aiTools) {
      expect(descriptor.name).toMatch(/^sektar/);
      expect(descriptor.annotations?.destructiveHint).toBe(false);
      expect(descriptor.description?.length).toBeGreaterThan(80);
    }
  });

  it("asks for approval only for what writes", () => {
    expect(
      aiTools
        .filter((t) => t.annotations?.readOnlyHint !== true)
        .map((t) => t.name),
    ).toEqual([
      "sektarSaveChatImage",
      "sektarAttachToInvoice",
      "sektarAddToFiles",
    ]);
  });

  it("stops under the agent's own limit, so it never cuts an answer mid-JSON", () => {
    expect(RESULT_BUDGET).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });

  it("is what the package offers Connect", async () => {
    const pkg = await import("../index.js");
    expect(pkg.aiTools).toBe(aiTools);
  }, 120_000);
});

describe("every tool", () => {
  it.each(everyTool)(
    "$name reports an unreachable switchboard as an error",
    async ({ name, args }) => {
      unreachable();
      await expect(call(name, args)).rejects.toThrow(/could not be read/);
    },
  );

  it.each(everyTool)(
    "$name reports a refused request as an error",
    async ({ name, args }) => {
      answerWith(() => Response.json({ errors: [{ message: "No such table" }] }));
      await expect(call(name, args)).rejects.toThrow(/No such table/);
    },
  );

  it.each(everyTool)(
    "$name reports a broken answer as an error",
    async ({ name, args }) => {
      answerWith(() => new Response("Bad gateway", { status: 502 }));
      await expect(call(name, args)).rejects.toThrow(/could not be read/);
    },
  );

  it.each(everyTool)(
    "$name reports a drive this session does not have",
    async ({ name, args }) => {
      installStore({}, []);
      await expect(call(name, args)).rejects.toThrow(/not available/);
    },
  );
});

describe("the tools that list rows", () => {
  it.each(LISTS)(
    "$name says when the index holds nothing",
    async ({ name, args, root }) => {
      serve(root(0));
      const result = await call(name, args);
      expect(result).toMatchObject({ found: 0, shown: 0, items: [] });
      expect(result.note).toMatch(/was read and holds no/);
      expect(result.cutOff).toBeUndefined();
    },
  );

  it.each(LISTS)(
    "$name stays under the limit and says it was cut off",
    async ({ name, args, root }) => {
      serve(root(200));
      const result = await call(name, args);
      expect(JSON.stringify(result).length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
      expect(result.cutOff).toBe(true);
      expect(result.found).toBe(200);
      expect(result.shown).toBeGreaterThan(0);
      expect(result.note).toContain(`of 200`);
      expect(result.note).toContain(`offset ${String(result.shown)}`);
    },
  );

  it.each(LISTS)(
    "$name says nothing was cut off when all rows fit",
    async ({ name, args, root }) => {
      serve(root(1));
      const result = await call(name, args);
      expect(result).toMatchObject({ found: 1, shown: 1 });
      expect(result.cutOff).toBeUndefined();
      expect(result.note).toBeUndefined();
    },
  );
});

describe("finding the drive and the switchboard", () => {
  const empty = finance({ invoices: page([]) });

  it("asks at the endpoint the screens use, with the caller's bearer", async () => {
    const calls = serve(empty);
    await call("sektarFindInvoices");
    expect(calls[0].url).toBe(`${BASE}/graphql`);
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].variables.d).toBe("id-of-sektar");
  });

  it("takes a synced drive's own switchboard", async () => {
    const { DriveCollectionId } = await import("@powerhousedao/reactor-browser");
    installStore({
      reactorClientModule: {
        kind: "browser",
        reactorModule: {
          syncModule: {
            syncManager: {
              list: () => [
                {
                  meta: { collectionId: DriveCollectionId.forDrive("id-of-sektar") },
                  channel: { config: { url: "http://other.test/graphql/r" } },
                },
              ],
            },
          },
        },
      },
    });
    const calls = serve(empty);
    await call("sektarFindInvoices");
    expect(calls[0].url).toBe("http://other.test/graphql");
  });

  it("does not pretend to read a drive kept in the tab's own reactor", async () => {
    installStore({ reactorClientModule: { kind: "browser" } });
    await expect(call("sektarFindInvoices")).rejects.toThrow(/kept in this browser/);
  });

  it("does not pretend to read a drive no switchboard answers for", async () => {
    installStore({ reactorGraphQLClient: undefined });
    await expect(call("sektarFindInvoices")).rejects.toThrow(/No switchboard/);
  });
});

describe("sektarFindInvoices", () => {
  it("passes the filters and answers the draft question from the row's dates", async () => {
    const calls = serve(finance({ invoices: page([invoice(1)]) }));
    const result = await call("sektarFindInvoices", {
      direction: "OUTGOING",
      view: "DRAFT",
      query: "Powerhouse",
      contactId: "contact-1",
      limit: 10,
      offset: 5,
    });
    expect(calls[0].variables).toMatchObject({
      dir: "OUTGOING",
      v: "DRAFT",
      q: "Powerhouse",
      c: "contact-1",
      l: 10,
      o: 5,
    });
    expect(Date.parse(String(calls[0].variables.n))).not.toBeNaN();
    expect(result).toMatchObject({
      found: 1,
      items: [
        {
          id: "invoice-1",
          status: "DRAFT",
          party: "Powerhouse Inc",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          createdAt: "2026-10-28",
        },
      ],
    });
  });

  it("leaves out what the model does not need", async () => {
    serve(finance({ invoices: page([invoice(1)]) }));
    const { items } = (await call("sektarFindInvoices")) as { items: object[] };
    expect(items[0]).not.toHaveProperty("number");
    expect(items[0]).not.toHaveProperty("linesMissingAttachments");
  });

  it("warns that a search of several words proves little when it finds nothing", async () => {
    serve(finance({ invoices: page([]) }));
    const several = await call("sektarFindInvoices", {
      query: "Powerhouse October",
    });
    expect(several.note).toMatch(/try fewer words/);
    const one = await call("sektarFindInvoices", { query: "Powerhouse" });
    expect(one.note).not.toMatch(/try fewer words/);
  });
});

describe("sektarFinanceSummary", () => {
  it("gives the figures, the accounts and short lists", async () => {
    const calls = serve(
      summaryRoot({
        overdue: Array.from({ length: 30 }, (_, i) =>
          invoice(i, { status: "OPEN", overdue: true, subject: LONG }),
        ),
        recent: Array.from({ length: 7 }, (_, i) =>
          transaction(i, { description: LONG }),
        ),
      }),
    );
    const result = await call("sektarFinanceSummary");
    expect(Date.parse(String(calls[0].variables.n))).not.toBeNaN();
    expect(result).toMatchObject({
      cash: 5000,
      receivable: 2420,
      transactionsToReview: 4,
      documents: { invoices: 8 },
      accounts: { found: 1, items: [{ id: "account-1", balance: 5000 }] },
      overdueInvoices: { found: 30, shown: 5, cutOff: true },
      latestTransactions: { found: 7, shown: 5, cutOff: true },
    });
    const { items } = result.overdueInvoices as { items: object[] };
    expect(items[0]).toMatchObject({ id: "invoice-0", overdue: true });
    expect(JSON.stringify(result).length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });
});

describe("sektarFinanceSummary, on empty books", () => {
  it("says the lists were read and hold nothing", async () => {
    const root = summaryRoot();
    (root.financeIndex as { accounts: unknown[] }).accounts = [];
    serve(root);
    const result = await call("sektarFinanceSummary");
    for (const list of ["accounts", "overdueInvoices", "latestTransactions"]) {
      expect(result[list]).toMatchObject({ found: 0, items: [] });
      expect(JSON.stringify(result[list])).toContain("was read and holds no");
    }
  });
});

describe("sektarFindTransactions", () => {
  it("passes the filters", async () => {
    const calls = serve(finance({ transactions: page([transaction(1)]) }));
    await call("sektarFindTransactions", {
      query: "acme",
      accountId: "account-1",
      status: "NEW",
      category: "SOFTWARE",
      contactId: "contact-1",
    });
    expect(calls[0].variables).toMatchObject({
      q: "acme",
      a: "account-1",
      s: "NEW",
      cat: "SOFTWARE",
      c: "contact-1",
    });
  });
});

describe("sektarFindContacts", () => {
  it("passes the view and gives what the books hold on the contact", async () => {
    const calls = serve(finance({ contacts: page([contact(1)]) }));
    const result = await call("sektarFindContacts", {
      query: "powerhouse",
      view: "CUSTOMERS",
    });
    expect(calls[0].variables).toMatchObject({ v: "CUSTOMERS", q: "powerhouse" });
    expect(result).toMatchObject({
      items: [
        {
          email: "billing@powerhouse.test",
          vatId: "BE0123456789",
          openBookOutstanding: 2420,
        },
      ],
    });
  });
});

describe("sektarSearchMail", () => {
  const mailRoot = (inbox: unknown[], archived: unknown[]) => ({
    emailIndex: {
      messages: ({ view }: { view: string }) =>
        mailPage(view === "ARCHIVED" ? archived : inbox),
      accounts: [
        { address: "me@sektar.test", name: "Me", provider: null, total: 2, unread: 1 },
      ],
    },
  });

  it("searches the inbox and the archive together, newest first", async () => {
    serve(
      mailRoot(
        [message(1, { when: "2026-10-01T08:00:00.000Z" })],
        [message(2, { when: "2026-10-05T08:00:00.000Z", status: "ARCHIVED" })],
      ),
    );
    const result = await call("sektarSearchMail", { query: "invoice" });
    expect(result).toMatchObject({
      found: 2,
      mailboxes: [{ address: "me@sektar.test", unread: 1 }],
      items: [
        { id: "mail-2", archived: true },
        { id: "mail-1", from: "Jo <jo@example.test>", unread: true },
      ],
    });
  });

  it("keeps to one view when it is given one", async () => {
    const calls = serve(mailRoot([message(1)], [message(2)]));
    const result = await call("sektarSearchMail", {
      view: "FLAGGED",
      mailbox: "me@sektar.test",
    });
    expect(calls[0].variables).toMatchObject({ v: "FLAGGED", a: "me@sektar.test" });
    expect(result).toMatchObject({ found: 1 });
  });

  it("gives handles for a row's files, and none for a row without", async () => {
    serve(
      mailRoot(
        [
          message(1, {
            attachmentCount: 7,
            attachmentRefs: Array.from({ length: 7 }, (_, i) => refOf(i)),
          }),
          message(2, { attachmentCount: 0, attachmentRefs: [] }),
        ],
        [],
      ),
    );
    const { items } = (await call("sektarSearchMail", {
      view: "INBOX",
    })) as { items: Record<string, unknown>[] };
    expect(items[0]).toMatchObject({
      attachments: 7,
      attachmentHandles: ["file-1", "file-2", "file-3", "file-4", "file-5"],
    });
    expect(items[0]).not.toHaveProperty("attachmentRefs");
    expect(items[1]).not.toHaveProperty("attachmentHandles");
  });

  it("keeps a row's handles when the same search runs again", async () => {
    serve(mailRoot([message(1)], []));
    const first = await call("sektarSearchMail", { view: "INBOX" });
    expect(await call("sektarSearchMail", { view: "INBOX" })).toEqual(first);
  });

  it("gives no handle for a damaged reference", async () => {
    const damaged = `attachment://v1:${"a".repeat(78)}`;
    serve(mailRoot([message(1, { attachmentRefs: [damaged] })], []));
    const result = await call("sektarSearchMail", { view: "INBOX" });
    expect(result).toMatchObject({ items: [{ attachments: 1 }] });
    expect(JSON.stringify(result)).not.toContain("attachment://");
  });

  it("reads on through the merged list", async () => {
    const inbox = Array.from({ length: 4 }, (_, i) =>
      message(i, { when: `2026-10-0${String(i + 1)}T08:00:00.000Z` }),
    );
    const calls = serve(mailRoot(inbox, []));
    const result = await call("sektarSearchMail", { limit: 2, offset: 2 });
    expect(calls[0].variables.l).toBe(4);
    expect(result).toMatchObject({
      found: 4,
      shown: 2,
      items: [{ id: "mail-1" }, { id: "mail-0" }],
    });
  });
});

describe("sektarCalendarEvents", () => {
  const root = (events: unknown[]) => ({
    calendarIndex: {
      events,
      calendars: [{ key: "me|work", label: "Work", events: events.length }],
    },
  });

  it("asks a day wider, as the week does, and cuts the range exactly", async () => {
    const calls = serve(
      root([
        event(1),
        event(2, {
          startAt: "2026-12-10T09:00:00.000Z",
          endAt: "2026-12-10T10:00:00.000Z",
        }),
      ]),
    );
    const result = await call("sektarCalendarEvents", {
      from: "2026-11-02",
      to: "2026-11-08",
    });
    const asked = calls[0].variables;
    expect(new Date(String(asked.f)).getTime()).toBe(
      new Date(2026, 10, 1).getTime(),
    );
    expect(new Date(String(asked.t)).getTime()).toBe(
      new Date(2026, 10, 10).getTime(),
    );
    expect(result).toMatchObject({
      found: 1,
      calendars: [{ label: "Work" }],
      items: [{ id: "event-1", calendar: "Work", organizer: "Jo" }],
    });
    expect(result.timeZone).toEqual(expect.any(String));
  });

  it("expands a repeating event and leaves out cancelled ones", async () => {
    serve(
      root([
        event(1, {
          repeats: true,
          recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
          startAt: "2026-11-02T09:00:00.000Z",
          endAt: "2026-11-02T10:00:00.000Z",
        }),
        event(2, { status: "CANCELLED" }),
      ]),
    );
    const result = await call("sektarCalendarEvents", {
      from: "2026-11-02",
      to: "2026-11-08",
    });
    const repeated = { id: "event-1", repeats: true };
    expect(result).toMatchObject({
      found: 3,
      items: [repeated, repeated, repeated],
    });
  });

  it("says a whole day's last day, not the exclusive end", async () => {
    serve(
      root([
        event(1, {
          allDay: true,
          startAt: null,
          endAt: null,
          startDate: "2026-11-02",
          endDate: "2026-11-04",
        }),
      ]),
    );
    const result = await call("sektarCalendarEvents", {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(result).toMatchObject({
      items: [{ start: "2026-11-02", end: "2026-11-03", allDay: true }],
    });
  });

  it("filters on words in the event", async () => {
    serve(root([event(1, { title: "Lunch" }), event(2, { title: "Board" })]));
    const result = await call("sektarCalendarEvents", {
      from: "2026-11-01",
      to: "2026-11-30",
      query: "board",
    });
    expect(result).toMatchObject({ found: 1, items: [{ id: "event-2" }] });
  });

  it("refuses a range it cannot read, rather than answering none", async () => {
    serve(root([]));
    await expect(
      call("sektarCalendarEvents", { from: "soon", to: "2026-11-30" }),
    ).rejects.toThrow(/not a date/);
    await expect(
      call("sektarCalendarEvents", { from: "2026-11-30", to: "2026-11-01" }),
    ).rejects.toThrow(/after from/);
    await expect(
      call("sektarCalendarEvents", { from: "2024-01-01", to: "2026-11-30" }),
    ).rejects.toThrow(/at most/);
  });
});

describe("sektarFindFiles", () => {
  const root = { filesIndex: { listing: page([fileEntry(1)]) } };

  it("searches every folder with a query", async () => {
    const calls = serve(root);
    await call("sektarFindFiles", { query: "contract" });
    expect(calls[0].variables).toMatchObject({ deep: true, q: "contract", f: null });
  });

  it("lists a folder without one", async () => {
    const calls = serve(root);
    const result = await call("sektarFindFiles", { folderId: "folder-1" });
    expect(calls[0].variables).toMatchObject({ deep: false, f: "folder-1" });
    expect(result).toMatchObject({
      items: [{ id: "file-1", tags: ["Legal"], sourceMime: "application/pdf" }],
    });
  });

});

describe("sektarFindTrips", () => {
  it("passes the filters and adds the year figures", async () => {
    const calls = serve({
      tripIndex: {
        trips: page([trip(1)]),
        years: [year],
        places: [{ city: "Ghent", country: "BE", visits: 3, last: "2026-11-02" }],
      },
    });
    const result = await call("sektarFindTrips", {
      year: 2026,
      phases: ["UPCOMING"],
      query: "ghent",
    });
    expect(calls[0].variables).toMatchObject({
      y: 2026,
      p: ["UPCOMING"],
      q: "ghent",
    });
    expect(result).toMatchObject({
      years: [{ year: 2026, nights: 9 }],
      mostVisited: [{ city: "Ghent", visits: 3 }],
      items: [{ id: "trip-1", destinations: ["Ghent, BE"], phase: "UPCOMING" }],
    });
  });
});

describe("sektarIntegrationStatus", () => {
  const roots = (over: Record<string, unknown> = {}) => ({
    integrationIndex: {
      integrations: [integration(1)],
      connections: [
        {
          id: "connection-1",
          name: "Gmail",
          connectorId: "gmail",
          accountLabel: "me@sektar.test",
          status: "OK",
          lastCheckedAt: "2026-10-30",
          lastError: null,
          updatedAt: "2026-10-30",
        },
      ],
      queues: [queue(1)],
      ...over,
    },
    filesIndex: { syncMappings: [folderSync(1)] },
  });

  it("reads each subject from its own drive and says how each stands", async () => {
    const calls = serve(roots());
    const result = await call("sektarIntegrationStatus");
    const driveOf = (fragment: string) =>
      calls.find((c) => c.query.includes(fragment))?.variables.d;
    expect(driveOf("integrations(")).toBe("id-of-integrations");
    expect(driveOf("connections(")).toBe("id-of-workflows");
    expect(driveOf("queues(")).toBe("id-of-backfills");
    expect(driveOf("syncMappings(")).toBe("id-of-files");
    expect(result).toMatchObject({
      integrations: {
        items: [
          {
            name: "Work mail",
            status: "Live",
            connection: { account: "me@sektar.test", status: "OK" },
          },
        ],
      },
      backfills: { items: [{ percent: 25, done: 25 }] },
      folderSyncs: { items: [{ status: "OK", host: "office-pc" }] },
    });
    expect(result.notRead).toBeUndefined();
  });

  it("says when an integration's state cannot be read", async () => {
    serve(
      roots({
        integrations: [integration(1, { state: "not json" })],
      }),
    );
    expect(await call("sektarIntegrationStatus")).toMatchObject({
      integrations: { items: [{ status: "Unknown" }] },
    });
  });

  it("names the part that failed, so it cannot pass for an empty one", async () => {
    installStore({}, [
      { header: { id: "id-of-integrations", slug: "integrations" } },
      { header: { id: "id-of-files", slug: "files" } },
    ]);
    serve(roots());
    const result = await call("sektarIntegrationStatus");
    expect(result.integrations).toBeDefined();
    expect(result.backfills).toBeUndefined();
    const notRead = result.notRead as Record<string, string>;
    expect(notRead.backfills).toMatch(/backfills drive is not available/);
    expect(notRead.connections).toMatch(/workflows drive is not available/);
    expect(result.note).toMatch(/could not be read/);
  });

  it("says when each part holds nothing", async () => {
    serve({
      integrationIndex: { integrations: [], queues: [] },
      filesIndex: { syncMappings: [] },
    });
    const result = await call("sektarIntegrationStatus");
    expect(result.integrations).toMatchObject({ found: 0 });
    expect(result.backfills).toMatchObject({ found: 0 });
    expect(result.folderSyncs).toMatchObject({ found: 0 });
    expect(JSON.stringify(result)).toContain("was read and holds no");
  });

  it("stays under the limit", async () => {
    serve({
      integrationIndex: {
        integrations: Array.from({ length: 80 }, (_, i) =>
          integration(i, { name: LONG }),
        ),
        connections: [],
        queues: Array.from({ length: 80 }, (_, i) => queue(i)),
      },
      filesIndex: {
        syncMappings: Array.from({ length: 80 }, (_, i) => folderSync(i)),
      },
    });
    const result = await call("sektarIntegrationStatus");
    expect(JSON.stringify(result).length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
    expect(result.integrations).toMatchObject({ cutOff: true });
  });
});

describe("sektarSearch", () => {
  const roots = (over: Record<string, unknown> = {}) => ({
    searchIndex: { search: [hit(1)] },
    emailIndex: {
      messages: ({ view }: { view: string }) =>
        mailPage(view === "INBOX" ? [message(1)] : []),
      accounts: [],
    },
    filesIndex: { listing: page([fileEntry(1)]) },
    tripIndex: { trips: page([trip(1)]) },
    ...over,
  });

  it("reads each subject from its own drive", async () => {
    const calls = serve(roots());
    const result = await call("sektarSearch", { query: " powerhouse " });
    expect(Object.fromEntries(calls.map((c) => [c.root, c.variables.d]))).toEqual(
      {
        emailIndex: "id-of-mail",
        filesIndex: "id-of-files",
        searchIndex: "id-of-sektar",
        tripIndex: "id-of-trips",
      },
    );
    expect(calls.every((c) => c.variables.q === "powerhouse")).toBe(true);
    expect(result).toMatchObject({
      finance: [{ kind: "invoice", title: "Invoice 2026-001" }],
      mail: [{ id: "mail-1" }],
      files: [{ id: "file-1" }],
      trips: [{ id: "trip-1" }],
    });
    expect(result.cutOff).toBeUndefined();
  });

  it("points a transaction hit at the transaction", async () => {
    serve(
      roots({
        searchIndex: {
          search: [{ ...hit(1), kind: "transaction", entityId: "tx-9" }],
        },
      }),
    );
    expect(await call("sektarSearch", { query: "acme" })).toMatchObject({
      finance: [{ id: "tx-9", kind: "transaction" }],
    });
  });

  it("shows a subject with no hits as read and empty", async () => {
    serve({
      searchIndex: { search: [] },
      emailIndex: { messages: mailPage([]), accounts: [] },
      filesIndex: { listing: page([]) },
      tripIndex: { trips: page([]) },
    });
    expect(await call("sektarSearch", { query: "nothing" })).toEqual({
      finance: [],
      mail: [],
      files: [],
      trips: [],
    });
  });

  it("names the subject that failed", async () => {
    installStore({}, [
      { header: { id: "id-of-sektar", slug: "sektar" } },
      { header: { id: "id-of-files", slug: "files" } },
      { header: { id: "id-of-trips", slug: "trips" } },
    ]);
    serve(roots());
    const result = await call("sektarSearch", { query: "powerhouse" });
    expect(result.mail).toBeUndefined();
    expect((result.notRead as { mail: string }).mail).toMatch(
      /mail drive is not available/,
    );
    expect(result.note).toMatch(/could not be read/);
  });

  it("says a full subject was cut off, and stays under the limit", async () => {
    serve(
      roots({
        searchIndex: {
          search: Array.from({ length: 10 }, (_, i) => ({
            ...hit(i),
            title: LONG,
            subtitle: LONG,
          })),
        },
      }),
    );
    const result = await call("sektarSearch", { query: "powerhouse" });
    expect(result.cutOff).toBe(true);
    expect(result.note).toMatch(/Cut off/);
    expect(JSON.stringify(result).length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });

  it("does not answer a blank search with nothing found", async () => {
    await expect(call("sektarSearch", { query: "  " })).rejects.toThrow(
      /at least one word/,
    );
  });
});

describe("a file reference", () => {
  const RAW = /attachment:\/\/|[0-9a-f]{64}/i;
  const STORED = refOf(7);
  const PNG = "cG5nIGJ5dGVz";

  const held = () =>
    invoiceReducer(
      invoiceUtils.createDocument(),
      addAttachment({
        id: "attachment-1",
        role: "SUPPORTING",
        fileName: "receipt.png",
        mimeType: "image/png",
        ref: STORED,
        sizeBytes: 9,
        addedAt: "2026-10-30T12:00:00.000Z",
      }),
    );

  /** Every index holding references, wherever a row can carry one. */
  const everyIndex = () => ({
    ...summaryRoot(),
    financeIndex: {
      ...summaryRoot().financeIndex,
      invoices: page([invoice(1, { issuedCopyRef: STORED })]),
      transactions: page([transaction(1)]),
      contacts: page([contact(1)]),
    },
    emailIndex: {
      messages: mailPage([message(1, { attachmentRefs: [STORED] })]),
      accounts: [],
    },
    calendarIndex: { events: [event(1)], calendars: [] },
    filesIndex: {
      listing: page([fileEntry(1, { thumbRef: STORED })]),
      syncMappings: [],
    },
    tripIndex: { trips: page([trip(1)]), years: [], places: [] },
    integrationIndex: { integrations: [], connections: [], queues: [] },
    searchIndex: { search: [hit(1)] },
  });

  const answered = (value: object) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  });

  const installEverything = () => {
    const document = held();
    installStore({
      reactorClient: { get: () => Promise.resolve(document) },
      attachmentService: {
        get: () =>
          Promise.resolve({
            header: {
              mimeType: "image/png",
              fileName: "receipt.png",
              sizeBytes: 9,
            },
            body: new Blob(["png bytes"]).stream(),
          }),
        reserve: () =>
          Promise.resolve({
            send: () => Promise.resolve({ ref: STORED, header: {} }),
          }),
      },
      aiTools: () =>
        Promise.resolve(
          ["createDocument", "addActions"].map((name) => ({
            name,
            callback: () =>
              Promise.resolve(
                answered({ documentId: "new-file", success: true, results: [] }),
              ),
          })),
        ),
    });
    serve(everyIndex());
    return document.header.id;
  };

  /** Each tool's arguments, given a handle from the list. */
  const calls = (invoiceId: string, handle: string) =>
    ({
      ...Object.fromEntries(everyTool.map(({ name, args }) => [name, args])),
      sektarListAttachments: { documentId: invoiceId },
      sektarReadAttachment: { handle },
      sektarSaveChatImage: { handle: "image-1" },
      sektarAttachToInvoice: { handle, invoiceId, role: "SUPPORTING" },
      sektarAddToFiles: { handle },
    }) as Record<string, unknown>;

  const listed = async (invoiceId: string) => {
    const { items } = (await call("sektarListAttachments", {
      documentId: invoiceId,
    })) as { items: { handle: string }[] };
    return items[0].handle;
  };

  const chat = {
    chatImages: [
      {
        handle: "image-1",
        dataUrl: `data:image/png;base64,${PNG}`,
        mediaType: "image/png",
      },
    ],
  };

  it("is covered here for every tool", () => {
    expect(Object.keys(calls("invoice", "file-1")).sort()).toEqual(
      aiTools.map((t) => t.name).sort(),
    );
  });

  it.each(aiTools.map((t) => t.name))(
    "is never in what %s answers",
    async (name) => {
      vi.stubGlobal("FileReader", class {
        result: string | null = `data:image/png;base64,${PNG}`;
        onload: (() => void) | null = null;
        readAsDataURL() {
          queueMicrotask(() => this.onload?.());
        }
      });
      const invoiceId = installEverything();
      const handle = await listed(invoiceId);
      const answer = await tool(name).callback(
        calls(invoiceId, handle)[name] as never,
        chat,
      );
      expect(JSON.stringify(answer)).not.toMatch(RAW);
      expect(handle).toMatch(/^file-\d+$/);
    },
  );

  it("is never what a tool's description or parameters ask for", () => {
    const told = aiTools.map((t) => ({
      description: t.description,
      parameters: Object.entries(t.inputSchema).map(
        ([key, schema]) =>
          `${key}: ${(schema as { description?: string }).description}`,
      ),
    }));
    expect(JSON.stringify(told)).not.toMatch(RAW);
    expect(JSON.stringify(told)).not.toContain('"ref:');
  });
});

describe("expenses", () => {
  it("are not the assistant's to read", async () => {
    expect(aiTools.map((tool) => tool.name)).not.toContain("sektarFindExpenses");
    expect(aiTools.some((tool) => /expense/i.test(tool.description ?? ""))).toBe(false);
  });
});
