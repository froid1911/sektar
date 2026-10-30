// @vitest-environment happy-dom
import type * as ReactRouter from "@tanstack/react-router";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailEmpty } from "../../../../editors/email-workspace/components/MailWorkspace.js";
import { toDashboardStats } from "../../../../processors/finance-index/queries.js";
import { setUserName } from "../../../../editors/sektar/kit/user-name.js";
import { Route as ContactsRoute } from "../_app/contacts.js";
import { Route as DashboardRoute } from "../_app/finops/dashboard.js";
import { Route as ExpensesRoute } from "../_app/finops/expenses.js";
import { Route as InvoicesRoute } from "../_app/finops/invoices.js";
import { Route as TransactionsRoute } from "../_app/finops/transactions.js";
import { NewExpensePanel } from "./forms.js";

// A customer's first visit: the drive is there and every read of the books
// comes back empty. The pages are the real ones; only those reads are scripted.
const app = vi.hoisted(() => {
  const state = {
    drive: undefined as { header: { id: string } } | undefined,
    /** The index has not answered yet. */
    loading: false,
    openIntegrations: vi.fn(),
    emptyList: () => ({
      total: 0,
      rowAt: () => undefined,
      ensure: () => {},
      loaded: !state.loading,
      stale: false,
      busy: false,
      error: null,
      version: 0,
      refreshSoon: () => {},
      invalidate: () => {},
      patch: () => {},
    }),
  };
  return state;
});

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof ReactRouter>()),
  createFileRoute: () => (options: object) => ({
    options,
    useSearch: () => ({}),
  }),
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock("../../../../editors/sektar/kit/data.js", async (original) => ({
  ...(await original<object>()),
  useOpenIntegrations: () => app.openIntegrations,
  useSektarDrive: () => app.drive,
}));

vi.mock("../../../../editors/sektar/kit/finance-index.js", async (original) => ({
  ...(await original<object>()),
  useAccountIndex: () => (app.loading ? undefined : []),
  useAccountRows: () => [],
  useAwaitingClaims: () => [],
  useContactCounts: () =>
    app.loading
      ? undefined
      : { all: 0, customers: 0, suppliers: 0, archived: 0 },
  useContactList: app.emptyList,
  useContactNames: () => new Map(),
  useContactOptions: () => [],
  useDashboardStats: (_: unknown, now: number) =>
    app.loading
      ? undefined
      : toDashboardStats(now, {
          positions: undefined,
          invoices: undefined,
          overdue: [],
          transactions: undefined,
          months: [],
          spend: [],
          recent: [],
        }),
  useExpenseCounts: () =>
    app.loading ? undefined : { all: 0, byStatus: [] },
  useExpenseList: app.emptyList,
  useExpenseSpend: () => (app.loading ? undefined : 0),
  useInvoiceList: () => ({
    ...app.emptyList(),
    counts: app.loading
      ? undefined
      : { outgoing: 0, incoming: 0, byView: [] },
  }),
  useInvoiceNumbers: () => [],
  useLatestOurParty: () => null,
  useNextInvoiceNumber: () => undefined,
  useTransactionDetail: () => ({ row: undefined, patch: () => {} }),
  useTransactionList: () => ({
    ...app.emptyList(),
    counts: app.loading
      ? undefined
      : {
          all: 0,
          new: 0,
          categorised: 0,
          matched: 0,
          excluded: 0,
          pending: 0,
        },
  }),
}));

vi.mock("document-models/contact", async (original) => ({
  ...(await original<object>()),
  useContactDocumentById: () => [undefined],
}));
vi.mock("document-models/invoice", async (original) => ({
  ...(await original<object>()),
  useInvoiceDocumentById: () => [undefined],
}));
vi.mock("document-models/expense-report", async (original) => ({
  ...(await original<object>()),
  useExpenseReportDocumentById: () => [undefined],
}));

type PageRoute = { options: { component: ComponentType } };
const PAGES: [string, PageRoute, RegExp][] = [
  ["Dashboard", DashboardRoute, /Create invoice/],
  ["Contacts", ContactsRoute, /New contact/],
  ["Invoices", InvoicesRoute, /New invoice/],
  ["Expenses", ExpensesRoute, /New claim/],
  ["Transactions", TransactionsRoute, /Import feed/],
] as unknown as [string, PageRoute, RegExp][];

/** Anything of the demo company, or of the set-up page that offered it. */
const DEMO =
  /juniper|jane doe|sara visser|tom bakker|nadia haddad|eli brandt|bright media|acme|maple & finch|set up|sample mail|demo/i;

let root: Root;
let host: HTMLElement;

function show(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(node));
  return document.body.textContent ?? "";
}

function button(name: string) {
  const found = [...document.body.querySelectorAll("button")].find((b) =>
    (b.textContent ?? b.getAttribute("aria-label") ?? "").includes(name),
  );
  if (!found) throw new Error(`No button "${name}"`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  app.drive = { header: { id: "sektar" } };
  app.loading = false;
  app.openIntegrations.mockClear();
  setUserName("");
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe.each(PAGES)("%s", (_, route, createAction) => {
  const Page = route.options.component;

  it("renders with nothing in the books: its create action, no demo company", () => {
    const text = show(<Page />);
    expect(text).toMatch(createAction);
    expect(text).not.toMatch(DEMO);
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("says only that it is connecting until the drive has loaded", () => {
    app.drive = undefined;
    const text = show(<Page />);
    expect(text).toContain("Connecting…");
    expect(text).not.toMatch(/not available|does not exist|No .* yet/);
    expect(text).not.toMatch(DEMO);
  });

  it("does not call the books empty before the index has answered", () => {
    app.loading = true;
    expect(show(<Page />)).not.toMatch(/No \w+( \w+)? yet/);
  });
});

describe("what an empty page offers", () => {
  it("Contacts says there are none yet", () => {
    expect(show(<ContactsRoute.options.component />)).toContain(
      "No contacts yet",
    );
  });

  it("Invoices offers the first invoice, and that opens the form", () => {
    const text = show(<InvoicesRoute.options.component />);
    expect(text).toContain("No invoices yet");
    expect(text).not.toContain("Pick an invoice");
    act(() => button("New invoice").click());
    expect(document.body.textContent).toContain("Cancel");
  });

  it("Expenses says there are no claims yet, instead of an empty board", () => {
    const text = show(<ExpensesRoute.options.component />);
    expect(text).toContain("No expense claims yet");
    expect(text).not.toContain("To approve");
  });

  it("Transactions points at Integrations", () => {
    const text = show(<TransactionsRoute.options.component />);
    expect(text).toContain("No transactions yet");
    act(() => button("Open Integrations").click());
    expect(app.openIntegrations).toHaveBeenCalledOnce();
  });

  it("the dashboard says each card has nothing yet, instead of drawing it", () => {
    const text = show(<DashboardRoute.options.component />);
    expect(text).toContain("Here's what's happening today.");
    for (const card of [
      "No cash flow yet",
      "No accounts yet",
      "No transactions yet",
      "No spending yet",
      "Nothing to review yet",
    ])
      expect(text).toContain(card);
    expect(text).not.toContain("Every transaction is categorised");
    act(() => button("Open Integrations").click());
    expect(app.openIntegrations).toHaveBeenCalledOnce();
  });

  it("Mail points at Integrations, with no sample mail", () => {
    const text = show(<MailEmpty error={null} indexed />);
    expect(text).toContain("No mail yet");
    expect(text).toContain("Connect an email account");
    expect(text).not.toMatch(DEMO);
    act(() => button("Open Integrations").click());
    expect(app.openIntegrations).toHaveBeenCalledOnce();
  });
});

describe("a new expense claim", () => {
  const panel = () => (
    <NewExpensePanel
      drive={{} as never}
      onClose={() => {}}
      onCreated={() => {}}
    />
  );

  it("is submitted by the user, not by a demo employee", () => {
    setUserName("Marit Jansen");
    const text = show(panel());
    expect(text).not.toMatch(DEMO);
    const inputs = [...document.body.querySelectorAll("input")];
    expect(inputs.map((i) => i.value)).toContain("Marit Jansen");
  });
});
