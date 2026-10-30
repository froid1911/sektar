import { createFileRoute } from "@tanstack/react-router";
import {
  useExpenseReportDocumentById,
  type ExpenseStatus,
} from "document-models/expense-report";
import { useEffect, useRef, useState } from "react";
import {
  ExpenseDetail,
  ExpenseStatusBadge,
} from "../../../../../editors/sektar/components/ExpenseDetail.js";
import { useSektarDrive } from "../../../../../editors/sektar/kit/data.js";
import {
  categoryOf,
  expenseStatusOf,
  FINANCE_PAGE,
  useExpenseCounts,
  useExpenseList,
  useExpenseSpend,
  type ExpenseCounts,
  type ExpenseRow,
} from "../../../../../editors/sektar/kit/finance-index.js";
import {
  CATEGORY,
  fmtShortDate,
  money,
  plural,
} from "../../../../../editors/sektar/kit/format.js";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  SidePanel,
  Stat,
  cx,
} from "../../../../../editors/sektar/kit/ui.js";
import { Connecting } from "../../-shared/connecting.js";
import { NewExpensePanel } from "../../-shared/forms.js";
import { useSearch } from "../../-shared/search.js";

export const Route = createFileRoute("/_app/finops/expenses")({
  validateSearch: (raw: Record<string, unknown>): { open?: string } => ({
    ...(typeof raw.open === "string" ? { open: raw.open } : {}),
  }),
  head: () => ({ meta: [{ title: "Expenses · Sektar" }] }),
  component: ExpensesBoard,
});

type Column = { status: ExpenseStatus[]; label: string; caption: string };

const COLUMNS: Column[] = [
  {
    status: ["DRAFT", "REJECTED"],
    label: "In progress",
    caption: "Drafts and returned claims",
  },
  {
    status: ["SUBMITTED"],
    label: "To approve",
    caption: "Waiting on a decision",
  },
  { status: ["APPROVED"], label: "Approved", caption: "Ready to reimburse" },
  { status: ["REIMBURSED"], label: "Reimbursed", caption: "Paid out" },
];

/** A status's count and totals out of the index's per-status counts. */
function statusOf(counts: ExpenseCounts | undefined, status: string) {
  return (
    counts?.byStatus.find((c) => c.status === status) ?? {
      status,
      count: 0,
      total: 0,
      reimbursable: 0,
    }
  );
}

function ExpensesBoard() {
  const drive = useSektarDrive();
  const { query } = useSearch();
  const { open: openParam } = Route.useSearch();
  const [selectedId, setSelectedId] = useState<string | null>(
    openParam ?? null,
  );
  useEffect(() => {
    if (openParam) setSelectedId(openParam);
  }, [openParam]);
  const [creating, setCreating] = useState(false);
  // The board's instant: fixed for the visit, so the spend does not re-ask per render.
  const [now] = useState(() => Date.now());

  // Every number comes from the finance index; the claim that is open is
  // the one document this board loads.
  const totals = useExpenseCounts("", drive);
  const searched = useExpenseCounts(query, drive);
  const spend90 = useExpenseSpend(now, drive);
  const [selected] = useExpenseReportDocumentById(selectedId);
  const awaiting = statusOf(totals, "SUBMITTED");
  const approved = statusOf(totals, "APPROVED");

  if (!drive) return <Connecting />;

  return (
    <div className="sk-page sk-stack sk-stack--6">
      <PageHeader
        eyebrow="Claims & receipts"
        title="Expenses"
        lead="What the team spent, who approved it, and what is still owed to them."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setCreating(true)}
          >
            New claim
          </Button>
        }
      />
      <div className="sk-grid sk-grid--3">
        <Stat
          icon="wallet"
          label="Awaiting approval"
          value={money(awaiting.total, "EUR", { compact: true })}
          foot={plural(awaiting.count, "claim")}
        />
        <Stat
          icon="customers"
          label="Owed to the team"
          value={money(approved.reimbursable, "EUR", { compact: true })}
          foot="approved, not yet reimbursed"
        />
        <Stat
          icon="pie"
          label="Spend · 90 days"
          value={money(spend90 ?? 0, "EUR", { compact: true })}
          foot="across all claims"
        />
      </div>

      {totals?.all === 0 ? (
        <EmptyState icon="wallet" title="No expense claims yet">
          Start a claim to group receipts and send them for approval.
        </EmptyState>
      ) : (
        <div className="sk-board">
          {COLUMNS.map((col) => (
            <ExpenseColumn
              key={col.label}
              col={col}
              query={query}
              counts={searched}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      )}

      {selected && (
        <SidePanel eyebrow="Expense claim" onClose={() => setSelectedId(null)}>
          <ExpenseDetail doc={selected} />
        </SidePanel>
      )}
      {creating && (
        <NewExpensePanel
          drive={drive}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}

/** One column of the board: its claims, a page at a time, latest changed first. */
function ExpenseColumn({
  col,
  query,
  counts,
  selectedId,
  onSelect,
}: {
  col: Column;
  query: string;
  /** Per status, for the same search: the column's count and total. */
  counts: ExpenseCounts | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const list = useExpenseList({ statuses: col.status, query });
  const filterKey = JSON.stringify([col.status, query]);
  const [shown, setShown] = useState({ key: filterKey, count: FINANCE_PAGE });
  const shownCount = shown.key === filterKey ? shown.count : FINANCE_PAGE;
  const rowCount = Math.min(list.total, shownCount);
  const { ensure } = list;
  useEffect(() => {
    if (rowCount > 0) ensure(0, rowCount);
  }, [ensure, rowCount, list.version]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || rowCount >= list.total) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown({ key: filterKey, count: shownCount + FINANCE_PAGE });
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filterKey, shownCount, rowCount, list.total]);

  const head = col.status.map((s) => statusOf(counts, s));
  const count = counts ? head.reduce((n, s) => n + s.count, 0) : list.total;
  const total = head.reduce((n, s) => n + s.total, 0);
  const rows: (ExpenseRow | undefined)[] = Array.from(
    { length: rowCount },
    (_, i) => list.rowAt(i),
  );

  return (
    <section className="sk-board__col">
      <header className="sk-board__head">
        <div>
          <div className="sk-weight-semibold">
            {col.label}{" "}
            <span className="sk-text-muted sk-weight-regular">{count}</span>
          </div>
          <div className="sk-caption">{col.caption}</div>
        </div>
        <div className="sk-caption sk-tabular">
          {money(total, "EUR", { compact: true })}
        </div>
      </header>
      {list.loaded && list.total === 0 && !list.stale ? (
        <div className="sk-empty" style={{ padding: "var(--sk-space-6)" }}>
          <span className="sk-caption">
            {list.error ? "Could not load the claims" : "Nothing here"}
          </span>
        </div>
      ) : (
        <>
          {rows.map((r, i) =>
            r ? (
              <ExpenseCard
                key={r.id}
                row={r}
                selected={r.id === selectedId}
                onClick={() => onSelect(r.id)}
              />
            ) : (
              <div key={`pending-${i}`} aria-hidden className="sk-card sk-card--compact">
                &nbsp;
              </div>
            ),
          )}
          {rowCount < list.total && (
            <div ref={sentinel} className="sk-caption sk-text-muted">
              Loading more…
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ExpenseCard({
  row: r,
  selected,
  onClick,
}: {
  row: ExpenseRow;
  selected: boolean;
  onClick: () => void;
}) {
  const cats = r.categories.slice(0, 3).map(categoryOf);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "sk-card sk-card--compact sk-card--interactive sk-stack sk-stack--2",
        selected && "is-selected",
      )}
      style={{ textAlign: "left", width: "100%" }}
    >
      <div className="sk-row sk-row--between">
        <span className="sk-weight-semibold sk-small sk-truncate">
          {r.title}
        </span>
        <ExpenseStatusBadge status={expenseStatusOf(r.status)} />
      </div>
      <div className="sk-row sk-row--2">
        <Avatar name={r.submitterName} size="sm" variant="sage" />
        <span className="sk-caption">
          {r.submitterName} · {plural(r.itemCount, "receipt")} ·{" "}
          {fmtShortDate(r.firstSpentAt ?? r.createdAt)}
        </span>
      </div>
      <div className="sk-row sk-row--2 sk-row--wrap">
        {cats.map((c) => (
          <Badge key={c} tone={CATEGORY[c].tone}>
            {CATEGORY[c].label}
          </Badge>
        ))}
      </div>
      <div className="sk-row sk-row--between">
        <span className="sk-numeral" style={{ fontSize: "var(--sk-text-xl)" }}>
          {money(r.total, r.currency)}
        </span>
        <span className="sk-caption">
          {money(r.reimbursable, r.currency)} to reimburse
        </span>
      </div>
    </button>
  );
}
