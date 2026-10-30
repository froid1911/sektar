import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  useOpenIntegrations,
  useSektarDrive,
} from "../../../../../editors/sektar/kit/data.js";
import {
  accountKindOf,
  categoryOf,
  useAccountIndex,
  useAwaitingClaims,
  useDashboardStats,
  useExpenseCounts,
} from "../../../../../editors/sektar/kit/finance-index.js";
import {
  ACCOUNT_KIND,
  CATEGORY,
  fmtMonth,
  fmtShortDate,
  money,
  relativeDays,
  plural,
} from "../../../../../editors/sektar/kit/format.js";
import {
  greeting,
  useUserName,
} from "../../../../../editors/sektar/kit/user-name.js";
import {
  ActionTile,
  Badge,
  Bars,
  Button,
  Card,
  Donut,
  EmptyState,
  HeroCard,
  IconTile,
  Legend,
  ListItem,
  PageHeader,
  ProgressRow,
  Ring,
  Stat,
  Table,
} from "../../../../../editors/sektar/kit/ui.js";
import artDark from "../../../../../editors/sektar/design/shapes/sektar-growth-four-column-combined-dark.svg";
import artLight from "../../../../../editors/sektar/design/shapes/sektar-growth-four-column-combined-light.svg";
import hero from "../../../../../icons/sektar_background_2048x1152.webp";
import { Connecting } from "../../-shared/connecting.js";
import {
  ImportPanel,
  NewContactPanel,
  NewExpensePanel,
  NewInvoicePanel,
} from "../../-shared/forms.js";
import { recentAccountsWithBalance } from "../../../../../editors/sektar/kit/account-order.js";

export const Route = createFileRoute("/_app/finops/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard · Sektar" }] }),
  component: Dashboard,
});

function Dashboard() {
  const drive = useSektarDrive();
  const openIntegrations = useOpenIntegrations();
  const userName = useUserName();
  // The dashboard's instant: fixed for the visit, so the numbers do not re-ask per render.
  const [now] = useState(() => Date.now());
  const index = useDashboardStats(drive, now);
  const accountIndex = useAccountIndex(drive);
  const accounts = accountIndex ?? [];
  // The claims awaiting approval and the claims per status, from the index.
  const awaitingClaims = useAwaitingClaims(drive);
  const claimCounts = useExpenseCounts("", drive);
  const navigate = useNavigate();
  const [panel, setPanel] = useState<
    "invoice" | "expense" | "contact" | "import" | null
  >(null);

  // The numbers come from the finance index; what is left here is
  // presentation (month labels, the month-on-month delta).
  const stats = useMemo(() => {
    if (!index) return undefined;
    const months = index.months.map((m) => ({
      ...m,
      label: fmtMonth(`${m.key}-01T00:00:00.000Z`),
    }));
    const empty = { key: "", label: "", in: 0, out: 0 };
    const thisMonth = months[months.length - 1] ?? empty;
    const lastMonth = months[months.length - 2] ?? empty;
    const pct = (a: number, b: number) =>
      b > 0 ? Math.round(((a - b) / b) * 100) : 0;
    const awaiting = awaitingClaims;
    const claims = claimCounts?.all ?? 0;
    const decided = (claimCounts?.byStatus ?? [])
      .filter((c) => ["APPROVED", "REIMBURSED", "REJECTED"].includes(c.status))
      .reduce((sum, c) => sum + c.count, 0);
    const pctOf = (n: number, d: number) =>
      d ? Math.round((n / d) * 100) : 100;
    const readinessRows = [
      { label: "Transactions categorised", value: index.categorisedPct },
      { label: "Payments matched to invoices", value: index.matchedPct },
      { label: "Invoices issued", value: index.issuedPct },
      {
        label: "Claims decided",
        value: pctOf(decided, claims),
      },
    ];
    return {
      ...index,
      awaiting,
      months,
      thisMonth,
      lastMonth,
      pct,
      spendSlices: index.spend.map((x) => [x.category, x.amount] as const),
      readinessRows,
    };
  }, [index, awaitingClaims, claimCounts]);

  if (!drive) return <Connecting />;
  if (!stats) {
    return (
      <div className="sk-page sk-stack sk-stack--6">
        <div className="sk-small sk-text-muted">Loading the books…</div>
      </div>
    );
  }

  const attention = [
    ...stats.overdue.map((i) => ({
      key: i.id,
      icon: "invoice" as const,
      title: `${i.number} is overdue`,
      meta: `${i.counterpartyName ?? ""} · due ${relativeDays(i.dueAt)}`,
      value: money(i.outstanding, i.currency),
      to: "/finops/invoices" as const,
    })),
    ...(stats.toReview > 0
      ? [
          {
            key: "review",
            icon: "transactions" as const,
            title: `${plural(stats.toReview, "transaction")} to review`,
            meta: "Uncategorised bank and card activity",
            value: "",
            to: "/finops/transactions" as const,
          },
        ]
      : []),
    ...stats.awaiting.map((r) => ({
      key: r.id,
      icon: "wallet" as const,
      title: `${r.title} awaits approval`,
      meta: r.submitterName ?? "",
      value: money(r.total),
      to: "/finops/expenses" as const,
    })),
  ];
  // A card with nothing behind it says so, rather than drawing an empty chart.
  const noCashFlow = stats.months.every((m) => m.in === 0 && m.out === 0);
  const noAccounts = accountIndex?.length === 0;
  const noTransactions = stats.transactionCount === 0;

  return (
    <div className="sk-page sk-stack sk-stack--6">
      <PageHeader
        display
        title={greeting(new Date(now).getHours(), userName)}
        lead="Here's what's happening today."
        art={{ light: artLight, dark: artDark }}
        actions={
          <Button variant="secondary" icon="calendar">
            This month
          </Button>
        }
      />

      <div className="sk-dash-grid">
        <div className="c3">
          <Stat
            icon="bank"
            label="Cash position"
            value={money(stats.cash, "EUR", { compact: true })}
            foot={`across ${plural(
              accounts.filter((a) => a.kind !== "CREDIT_CARD").length,
              "account",
            )}`}
            spark={
              noCashFlow ? undefined : stats.months.map((m) => m.in - m.out)
            }
          />
        </div>
        <div className="c3">
          <Stat
            icon="growth"
            label="Money in this month"
            value={money(stats.thisMonth.in, "EUR", { compact: true })}
            delta={
              noCashFlow
                ? undefined
                : stats.pct(stats.thisMonth.in, stats.lastMonth.in)
            }
            foot={noCashFlow ? "nothing in yet" : "vs. last month"}
            spark={noCashFlow ? undefined : stats.months.map((m) => m.in)}
          />
        </div>
        <div className="c3">
          <Stat
            icon="invoice"
            label="Outstanding receivables"
            value={money(stats.receivable, "EUR", { compact: true })}
            foot={
              stats.overdue.length
                ? `${stats.overdue.length} overdue`
                : "nothing overdue"
            }
          />
        </div>
        <div className="c3">
          <Stat
            icon="card"
            label="Bills & card to pay"
            value={money(stats.payable + -stats.card, "EUR", { compact: true })}
            foot={`${money(-stats.card)} on card`}
          />
        </div>

        <div className="c6">
          <Card
            title="Cash flow"
            actions={
              !noCashFlow && (
                <Legend
                  items={[
                    { label: "Money in" },
                    { label: "Money out", color: "var(--sk-chart-3)" },
                  ]}
                />
              )
            }
          >
            {noCashFlow ? (
              <EmptyState icon="growth" title="No cash flow yet">
                Money in and out shows here once transactions come in.
              </EmptyState>
            ) : (
              <Bars
                axis
                ticks={4}
                format={(v) => money(v, "EUR", { compact: true })}
                groups={stats.months.map((m) => ({
                  label: m.label,
                  values: [Math.round(m.in), Math.round(m.out)],
                }))}
              />
            )}
          </Card>
        </div>
        <div className="c3">
          <Card
            title="Accounts"
            actions={
              !noAccounts && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => void navigate({ to: "/finops/transactions" })}
                >
                  View all
                </Button>
              )
            }
          >
            {noAccounts ? (
              <EmptyState
                icon="bank"
                title="No accounts yet"
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="sync"
                    onClick={openIntegrations}
                  >
                    Open Integrations
                  </Button>
                }
              >
                Connect your bank to see your balances here.
              </EmptyState>
            ) : (
              <ul className="sk-list sk-list--divided">
                {recentAccountsWithBalance(accounts).map((a) => (
                  <li key={a.id}>
                    <ListItem
                      icon={
                        <IconTile
                          name={a.kind === "CREDIT_CARD" ? "card" : "bank"}
                          size="sm"
                        />
                      }
                      title={a.name}
                      meta={`${ACCOUNT_KIND[accountKindOf(a.kind)]} · ${a.institution ?? ""}`}
                      value={
                        <span className="sk-tabular sk-weight-medium">
                          {money(a.balance, a.currency)}
                        </span>
                      }
                      onClick={() =>
                        void navigate({
                          to: "/finops/transactions",
                          search: { account: a.id },
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="c3 sk-stack">
          <HeroCard
            image={hero}
            style={{ minHeight: 150, padding: "var(--sk-space-5)" }}
          >
            <h2 style={{ fontSize: "var(--sk-text-xl)", color: "inherit" }}>
              Help businesses grow with clarity.
            </h2>
          </HeroCard>
          <div className="sk-action-grid">
            <ActionTile
              icon="invoice"
              label="Create invoice"
              onClick={() => setPanel("invoice")}
            />
            <ActionTile
              icon="wallet"
              label="Add expense"
              onClick={() => setPanel("expense")}
            />
            <ActionTile
              icon="upload"
              label="Import feed"
              onClick={() => setPanel("import")}
            />
            <ActionTile
              icon="customers"
              label="New contact"
              onClick={() => setPanel("contact")}
            />
          </div>
        </div>

        <div className="c6">
          <Card
            title="Recent transactions"
            actions={
              !noTransactions && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => void navigate({ to: "/finops/transactions" })}
                >
                  All transactions
                </Button>
              )
            }
          >
            {noTransactions ? (
              <EmptyState icon="transactions" title="No transactions yet">
                Your latest bank and card activity shows here.
              </EmptyState>
            ) : (
              <Table compact stack>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th className="is-num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent.map((tx) => (
                    <tr key={tx.id}>
                      <td className="is-muted sk-nowrap">
                        {fmtShortDate(tx.bookedAt)}
                      </td>
                      <td>
                        <div className="sk-table__primary">
                          {tx.counterparty}
                        </div>
                        <div className="sk-table__secondary">
                          {tx.description ??
                            accounts.find((a) => a.id === tx.accountId)?.name}
                        </div>
                      </td>
                      <td>
                        <Badge tone={CATEGORY[categoryOf(tx.category)].tone}>
                          {CATEGORY[categoryOf(tx.category)].label}
                        </Badge>
                      </td>
                      <td
                        className={
                          tx.amount > 0 ? "is-num sk-amount--in" : "is-num"
                        }
                      >
                        {money(tx.amount, tx.currency, {
                          signed: true,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <div className="c3">
          <Card title="Spend by category">
            {stats.spendSlices.length === 0 ? (
              <EmptyState icon="pie" title="No spending yet">
                The last 90 days show here.
              </EmptyState>
            ) : (
              <div
                className="sk-stack sk-stack--4"
                style={{ alignItems: "center" }}
              >
                <Donut
                  slices={stats.spendSlices.map(([, v]) => ({ value: v }))}
                  value={money(
                    stats.spendSlices.reduce((s, [, v]) => s + v, 0),
                    "EUR",
                    { compact: true },
                  )}
                  label="last 90 days"
                />
                <Legend
                  items={stats.spendSlices.map(([c, v]) => ({
                    label: CATEGORY[categoryOf(c)].label,
                    value: money(v, "EUR", { compact: true }),
                  }))}
                />
              </div>
            )}
          </Card>
        </div>
        <div className="c3">
          <Card title="Books readiness">
            {noTransactions ? (
              <EmptyState icon="reports" title="Nothing to review yet">
                This fills in as transactions come in.
              </EmptyState>
            ) : (
              <div className="sk-stack sk-stack--4">
                <div className="sk-row sk-row--4">
                  <Ring small value={stats.readiness} />
                  <p className="sk-small sk-text-secondary">
                    {stats.toReview === 0
                      ? "Every transaction is categorised. You're on track."
                      : `${plural(stats.toReview, "transaction")} still ${
                          stats.toReview === 1 ? "needs" : "need"
                        } a category before the VAT return.`}
                  </p>
                </div>
                <div className="sk-stack sk-stack--3">
                  {stats.readinessRows.map((r) => (
                    <div key={r.label}>
                      <div className="sk-caption sk-mb-1">{r.label}</div>
                      <ProgressRow value={r.value} />
                    </div>
                  ))}
                </div>
                <Button
                  variant="primary"
                  block
                  icon="arrow-right"
                  onClick={() => void navigate({ to: "/finops/transactions" })}
                >
                  Review transactions
                </Button>
              </div>
            )}
          </Card>
        </div>

        {attention.length > 0 && (
          <div className="c12">
            <Card
              title="Needs attention"
              actions={
                <Badge tone="warning" pill>
                  {attention.length}
                </Badge>
              }
            >
              <ul className="sk-list sk-list--rich">
                {attention.map((a) => (
                  <li key={a.key}>
                    <ListItem
                      rich
                      icon={<IconTile name={a.icon} size="sm" />}
                      title={a.title}
                      sub={a.meta}
                      aside={a.value ? <span>{a.value}</span> : undefined}
                      chevron
                      onClick={() => void navigate({ to: a.to })}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </div>

      {panel === "invoice" && (
        <NewInvoicePanel
          drive={drive}
          direction="OUTGOING"
          onClose={() => setPanel(null)}
          onCreated={() => {
            setPanel(null);
            void navigate({ to: "/finops/invoices" });
          }}
        />
      )}
      {panel === "expense" && (
        <NewExpensePanel
          drive={drive}
          onClose={() => setPanel(null)}
          onCreated={() => {
            setPanel(null);
            void navigate({ to: "/finops/expenses" });
          }}
        />
      )}
      {panel === "contact" && (
        <NewContactPanel
          drive={drive}
          onClose={() => setPanel(null)}
          onCreated={() => {
            setPanel(null);
            void navigate({ to: "/contacts" });
          }}
        />
      )}
      {panel === "import" && (
        <ImportPanel
          drive={drive}
          onClose={() => setPanel(null)}
          onImported={() => {
            setPanel(null);
            void navigate({ to: "/finops/transactions" });
          }}
        />
      )}
    </div>
  );
}
