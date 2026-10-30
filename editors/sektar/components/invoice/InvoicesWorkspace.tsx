// The Invoices page as the design system's workspace pattern, like Mail and
// Files, in three columns:
//   the list     every invoice of one side (Sales or Purchases), in the
//                workspace's order, from the finance index (kit/finance-index.ts)
//   the invoice  read once, top to bottom: who and what, the amount and where
//                it stands, the dates, then its lines grouped by category
//   what's open  a line, with its receipts, stepping line by line; or, with
//                no line open, the invoice itself (the copy that was sent, or
//                the PDF preview for a draft) and the invoice's own documents
// Side by side on a wide screen; one at a time under 640px of container
// width, as a push navigation. Sales or Purchases is the "inbox" choice: a
// sub-bar selector wide, a level-0 chooser opened from the list's title
// when stacked. The top bar's search filters the list; a status menu narrows it.
//
// The list is index rows, windowed and fetched page by page where the reader
// is; only the invoice that is open is loaded as a document.
import { dispatchActions, makeNodeSlug, openTarget, useAttachments } from "@powerhousedao/reactor-browser";
import {
  actions,
  computeTotals,
  useInvoiceDocumentById,
  type InvoiceAction,
  type InvoiceDirection,
  type InvoiceDocument,
  type InvoiceLine,
  type InvoiceState,
} from "document-models/invoice";
import { Component, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFillHeight, useNarrow } from "../../../backfills/components/measure.js";
import { SEKTAR_DRIVE_SLUG } from "../../kit/data.js";
import type { InvoiceList, InvoiceRow, InvoiceView } from "../../kit/finance-index.js";
import {
  counterparty,
  fmtDate,
  fmtShortDate,
  fromDateInput,
  invoiceTotals,
  isOverdue,
  money,
  plural,
  relativeDays,
  toDateInput,
} from "../../kit/format.js";
import { attachFile, invoiceChecks, roleLabel } from "../../kit/invoice.js";
import { LINE_HEADERS, printedLine, type PrintedLine } from "../../kit/invoice-print.js";
import { Menu } from "../../kit/menu.js";
import { Avatar, Badge, Button, cx, EmptyState, Icon, ListItem, Selector, Skeleton } from "../../kit/ui.js";
import { useRowWindow } from "../../kit/virtual.js";
import { Pane, PaneSwitch, SubBar, Workspace } from "../../kit/workspace.js";
import { bytes, fileKind } from "../../kit/files.js";
import { FileTypeTile, useDocumentLocation } from "../FilePreview.js";
import { InvoiceStatusBadge, InvoiceRowStatusBadge as RowStatusBadge } from "../InvoiceDetail.js";
import { InvoicePrintPreview } from "./InvoicePrintPreview.js";
import { IssueDialog, PaymentDialog } from "./InvoiceWorkspace.js";
import { PartyDetails } from "./PartyEditor.js";
import { FilePreviewFrame } from "./InvoicePreview.js";
import { SendActions } from "./SendActions.js";

/** Which level a stacked workspace shows: 0 Sales or Purchases · 1 list · 2 the invoice · 3 what's open */
type Level = 0 | 1 | 2 | 3;

/** The statuses the list can be narrowed to; the index decides which invoice is in which. */
const VIEWS: { value: InvoiceView; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "settled", label: "Settled" },
];

const DIRECTION_NAME: Record<InvoiceDirection, string> = { OUTGOING: "Sales", INCOMING: "Purchases" };

/** The pages under the list's window are asked for once the scroll settles. */
const ENSURE_DEBOUNCE_MS = 60;

/** The third column: the invoice itself (its PDF preview, or one of its documents by id), or a line by id. */
type Open = { kind: "invoice"; doc: string } | { kind: "line"; id: string };
/** The invoice as its PDF will print, from the print HTML */
const PDF = "pdf";
/** A party of the invoice, as a view beside it ("party:buyer", "party:seller") */
const PARTY = "party:";

/**
 * The invoice's parties as views beside it, in the order its reader meets
 * them: a sale's recipient (the buyer) before its issuer (us), a purchase's
 * issuer (the supplier) before its recipient (us).
 */
function partyViews(s: InvoiceState): { value: string; name: string; party: InvoiceState["buyer"]; ours: boolean }[] {
  const outgoing = s.direction === "OUTGOING";
  const recipient = { value: `${PARTY}buyer`, name: "Recipient", party: s.buyer, ours: !outgoing };
  const issuer = { value: `${PARTY}seller`, name: "Issuer", party: s.seller, ours: outgoing };
  return outgoing ? [recipient, issuer] : [issuer, recipient];
}

const isCurrent = (s: unknown): s is InvoiceState => typeof s === "object" && s !== null && "buyer" in s && "lines" in s;
const lineAmount = (l: InvoiceLine) => Math.round(l.quantity * l.unitPrice * 100) / 100;

/** "Invoice #2026004" once issued ("Credit note #…", "Bill #…"), "Draft invoice" before. */
function titleFor(kind: string, direction: string, number: string | null | undefined): string {
  const name = kind === "CREDIT_NOTE" ? "Credit note" : direction === "INCOMING" ? "Bill" : "Invoice";
  return number ? `${name} #${number}` : `Draft ${name.toLowerCase()}`;
}

/** The invoice pane's title, from the document. */
const paneTitle = (s: InvoiceState) => titleFor(s.kind, s.direction, s.number);

const directionOf = (value: string): InvoiceDirection => (value === "INCOMING" ? "INCOMING" : "OUTGOING");

/** "612 ×", "51.75 ×": how many, in front of a line. */
const qtyLabel = (q: number) => `${Number.isInteger(q) ? q : q.toFixed(2)} ×`;

/** A rate to at most 6 decimals, however precisely it is stored: 0.09186653286 → 0.091867. */
const fmtRate = (rate: number) => String(Math.round(rate * 1e6) / 1e6);

/**
 * Every exchange rate the invoice uses, as "1 EUR = 1.141897 USD": its own
 * rates, then any a line carries for a currency they do not cover (a line
 * billed in SEK with its own rate), one per currency.
 */
function invoiceRates(s: InvoiceState): string[] {
  const out = s.exchangeRates.map((r) => `1 ${r.base} = ${fmtRate(r.rate)} ${r.quote}`);
  const covered = new Set(s.exchangeRates.flatMap((r) => [r.base, r.quote]));
  for (const l of s.lines) {
    const o = l.original;
    if (!o?.rate || o.currency === s.currency || covered.has(o.currency)) continue;
    covered.add(o.currency);
    out.push(`1 ${o.currency} = ${fmtRate(o.rate)} ${s.currency}`);
  }
  return out;
}

/** The lines by category, in the order the categories first appear: how the invoice reads, and the order the stepper walks (no subtotals). */
function groupLines(lines: readonly InvoiceLine[]): { name: string; lines: { line: InvoiceLine; n: number }[] }[] {
  const out: { name: string; lines: { line: InvoiceLine; n: number }[] }[] = [];
  lines.forEach((line, i) => {
    const name = line.category?.trim() || "Other";
    let g = out.find((x) => x.name === name);
    if (!g) out.push((g = { name, lines: [] }));
    g.lines.push({ line, n: i + 1 });
  });
  return out;
}

/** What the third column opens on for an invoice: the copy that was sent, else the PDF preview. */
function invoiceView(s: InvoiceState): Open {
  const sent = s.attachments.find((a) => a.role === "ISSUED_COPY");
  return { kind: "invoice", doc: sent?.id ?? PDF };
}

/**
 * What a change this tab made to the open invoice does to its list row,
 * laid over the row until the index catches up: issuing (status, number,
 * dates), a payment (status, outstanding), voiding, a date edited.
 */
function rowPatch(s: InvoiceState, now: number): Partial<InvoiceRow> {
  const t = invoiceTotals(s);
  return {
    status: s.status,
    number: s.number ?? null,
    issuedAt: s.issuedAt ?? null,
    dueAt: s.dueAt ?? null,
    deliveredAt: s.deliveredAt ?? null,
    periodStart: s.period?.start ?? null,
    periodEnd: s.period?.end ?? null,
    gross: t.gross,
    outstanding: t.outstanding,
    overdue: isOverdue(s, now),
    lastPaidAt: s.payments.at(-1)?.paidAt ?? null,
  };
}

export function InvoicesWorkspace({
  list,
  direction,
  onDirection,
  view,
  onView,
  now,
  query,
  open,
  onNew,
}: {
  /** The list for `direction` and `view` (and the top bar's search), from the finance index */
  list: InvoiceList;
  direction: InvoiceDirection;
  onDirection: (direction: InvoiceDirection) => void;
  view: InvoiceView;
  onView: (view: InvoiceView) => void;
  now: number;
  /** The top bar's search, as the list was asked for it */
  query: string;
  /** An invoice to open (from the URL, or one just made): it is shown, in its direction */
  open?: string | null;
  onNew: (direction: InvoiceDirection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The row the invoice was picked from: its header while the document loads. */
  const [picked, setPicked] = useState<InvoiceRow | null>(null);
  /** Which side the open invoice is on, once known (from its row, or its document). */
  const [selectedDirection, setSelectedDirection] = useState<InvoiceDirection | null>(null);
  /** An invoice asked for by id: its direction is taken from its document once it has loaded. */
  const [asked, setAsked] = useState<string | null>(null);
  const [opened, setOpened] = useState<Open>({ kind: "invoice", doc: PDF });
  const [level, setLevel] = useState<Level>(1);
  const [listCollapsed, setListCollapsed] = useState(false);
  // null: decide for me, folded while the workspace is too narrow for three panes.
  const [sidePref, setSidePref] = useState<boolean | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const listBody = useRef<HTMLDivElement>(null);
  const height = useFillHeight(root, true);
  const narrow = useNarrow(root, 1000, true);
  const sideCollapsed = sidePref ?? narrow;

  const { counts, ensure, rowAt, invalidate, patch } = list;
  const pickView = VIEWS.find((v) => v.value === view) ?? VIEWS[0];
  const viewCount = (v: InvoiceView) => counts?.byView.find((c) => c.direction === direction && c.view === v)?.count;

  // The list pane's body scrolls; the window keeps a screenful of rows in it.
  const win = useRowWindow(listBody, list.total);
  // The pages under the window, once the scroll settles.
  useEffect(() => {
    const timer = setTimeout(() => ensure(win.start, win.end), ENSURE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ensure, win.start, win.end, list.version]);
  const windowRows = useMemo(() => {
    const out: { index: number; row: InvoiceRow | undefined }[] = [];
    for (let i = win.start; i < win.end; i++) out.push({ index: i, row: rowAt(i) });
    return out;
  }, [win.start, win.end, rowAt]);
  const firstReal = windowRows.find((r) => r.row)?.index;
  // The open invoice's row as the list now has it (a patch shows there), else as it was picked.
  const selectedRow = windowRows.find((r) => r.row?.id === selectedId)?.row ?? (picked?.id === selectedId ? picked : null);

  const pick = (row: InvoiceRow) => {
    setSelectedId(row.id);
    setPicked(row);
    setSelectedDirection(directionOf(row.direction));
    setAsked(null);
    setOpened({ kind: "invoice", doc: row.issuedCopyId ?? PDF });
    setLevel(2);
  };

  // Opened from elsewhere (search, a contact, a new invoice): it opens at
  // once; its direction follows when its document has loaded. A new invoice
  // is not in the index yet: the list is asked again.
  useEffect(() => {
    if (!open) return;
    setSelectedId(open);
    setPicked(null);
    setSelectedDirection(null);
    setAsked(open);
    setOpened({ kind: "invoice", doc: PDF });
    setLevel(2);
    invalidate();
  }, [open, invalidate]);

  const arrived = (state: InvoiceState) => {
    setAsked(null);
    setSelectedDirection(state.direction);
    if (state.direction !== direction) onDirection(state.direction);
    if (view !== "all") onView("all");
    setOpened(invoiceView(state));
  };

  // A new direction, status or search starts the list at the top.
  useEffect(() => {
    if (listBody.current) listBody.current.scrollTop = 0;
  }, [direction, view, query]);

  const chooseDirection = (d: InvoiceDirection) => {
    onDirection(d);
    setLevel(1);
    // An invoice from the other side is not in this list: it closes.
    if (selectedDirection && selectedDirection !== d) setSelectedId(null);
  };

  const directionOptions = (["OUTGOING", "INCOMING"] as const).map((d) => {
    const n = counts ? (d === "OUTGOING" ? counts.outgoing : counts.incoming) : undefined;
    return {
      value: d,
      name: DIRECTION_NAME[d],
      meta: n === undefined ? "…" : plural(n, d === "OUTGOING" ? "invoice" : "bill"),
      icon: d === "OUTGOING" ? ("invoice" as const) : ("cart" as const),
    };
  });

  const panes: PanesProps = {
    selectedId,
    listEmpty: list.total === 0,
    row: selectedRow,
    asked,
    now,
    opened,
    sideCollapsed,
    onOpened: setOpened,
    onSidePref: setSidePref,
    onLevel: setLevel,
    onArrived: arrived,
    onPatch: patch,
  };

  return (
    <div ref={root} className="sk-invoices" style={{ height: height ? `${height}px` : undefined }}>
      {/* Sales or Purchases: a second top-bar row. Narrow, the design system
          hides it and the list's title becomes the switch to the chooser. */}
      <SubBar className="sk-subbar--wide">
        <Selector value={direction} options={directionOptions} onChange={chooseDirection} label="Direction" />
      </SubBar>

      <Workspace level={level} hasParent>
        <Pane parent title="Invoices" flush>
          <Selector value={direction} options={directionOptions} onChange={chooseDirection} label="Direction" list />
        </Pane>

        <Pane
          side="start"
          grow={0.9}
          flush
          bodyRef={listBody}
          collapsed={listCollapsed}
          onToggle={() => setListCollapsed((v) => !v)}
          count={list.total}
          header={<PaneSwitch label={DIRECTION_NAME[direction]} ariaLabel="Choose sales or purchases" onClick={() => setLevel(0)} />}
          trailing={
            <span className="sk-row" style={{ gap: "var(--sk-space-1)", flexWrap: "nowrap" }}>
              <Menu
                label="Status"
                items={VIEWS.map((v) => {
                  const n = viewCount(v.value);
                  return {
                    label: (
                      <>
                        {v.label}
                        {n !== undefined && <span className="sk-text-muted sk-tabular"> · {n}</span>}
                      </>
                    ),
                    active: v.value === view,
                    onSelect: () => onView(v.value),
                  };
                })}
                trigger={(isOpen, toggle) => (
                  <button type="button" className="sk-btn sk-btn--ghost sk-btn--sm" aria-haspopup="menu" aria-expanded={isOpen} onClick={toggle}>
                    {pickView.label}
                    <Icon name="chevron-down" size={16} mono />
                  </button>
                )}
              />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="plus"
                aria-label={direction === "OUTGOING" ? "New invoice" : "New bill"}
                title={direction === "OUTGOING" ? "New invoice" : "New bill"}
                onClick={() => onNew(direction)}
              />
            </span>
          }
        >
          {list.total === 0 ? (
            <div style={{ padding: "var(--sk-space-6)" }}>
              {list.loaded && !list.stale ? (
                list.error || query.trim() || view !== "all" ? (
                  <EmptyState icon="invoice" title="Nothing here">
                    {list.error
                      ? `The invoices could not be loaded: ${list.error}`
                      : query.trim()
                        ? "No invoice matches that search."
                        : `No ${pickView.label.toLowerCase()} ${direction === "OUTGOING" ? "sales invoices" : "purchase bills"}.`}
                  </EmptyState>
                ) : direction === "OUTGOING" ? (
                  <EmptyState
                    icon="invoice"
                    title="No invoices yet"
                    action={
                      <Button variant="primary" size="sm" icon="plus" onClick={() => onNew(direction)}>
                        New invoice
                      </Button>
                    }
                  >
                    Write your first invoice and send it to a customer.
                  </EmptyState>
                ) : (
                  <EmptyState
                    icon="cart"
                    title="No bills yet"
                    action={
                      <Button variant="primary" size="sm" icon="plus" onClick={() => onNew(direction)}>
                        New bill
                      </Button>
                    }
                  >
                    Add a bill you received from a supplier.
                  </EmptyState>
                )
              ) : (
                <div className="sk-stack sk-stack--4">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} height={64} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <ul
              className="sk-list sk-list--rich"
              data-sk-more={win.end < list.total ? "" : undefined}
              aria-busy={list.stale || undefined}
              style={{ paddingTop: win.padTop, paddingBottom: win.padBottom, opacity: list.stale ? 0.6 : undefined }}
            >
              {windowRows.map(({ index, row }) =>
                row ? (
                  <li key={row.id} ref={index === firstReal ? win.measure : undefined}>
                    <InvoiceListItem row={row} selected={row.id === selectedId} onPick={pick} />
                  </li>
                ) : (
                  // Not fetched yet: a row's worth of placeholder, so the
                  // list keeps its true length while the page arrives.
                  <li key={`at-${index}`} className="sk-mail__placeholder" style={{ height: win.rowHeight }} aria-hidden="true">
                    <Skeleton width={36} height={36} circle />
                    <span className="sk-mail__placeholder-lines">
                      <Skeleton width="45%" height={12} />
                      <Skeleton width="80%" height={12} />
                      <Skeleton width="65%" height={12} />
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </Pane>

        {/* The open invoice's document loads here; until it has, its row heads the pane. */}
        <LoadBoundary key={selectedId ?? ""} fallback={<InvoicePanes {...panes} doc={undefined} status="failed" />}>
          <Suspense fallback={<InvoicePanes {...panes} doc={undefined} status="loading" />}>
            <SelectedInvoicePanes {...panes} />
          </Suspense>
        </LoadBoundary>
      </Workspace>
    </div>
  );
}

/* ------------------------------------------------------------ the panes */

/** A document that could not be loaded (removed, not found) shows as such, not as a broken page. */
class LoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface PanesProps {
  selectedId: string | null;
  /** Nothing in the list: no reason to say pick one */
  listEmpty: boolean;
  /** The open invoice's list row, while it is known */
  row: InvoiceRow | null;
  /** The invoice asked for by id, whose direction is to follow */
  asked: string | null;
  now: number;
  opened: Open;
  sideCollapsed: boolean;
  onOpened: (open: Open) => void;
  onSidePref: (collapsed: boolean) => void;
  onLevel: (level: Level) => void;
  /** The invoice asked for by id has loaded */
  onArrived: (state: InvoiceState) => void;
  /** Show a change made here on the invoice's row before the index has it */
  onPatch: (id: string, change: Partial<InvoiceRow>) => void;
}

/** Loads the open invoice (suspending while it does) and shows it. */
function SelectedInvoicePanes(props: PanesProps) {
  const [doc] = useInvoiceDocumentById(props.selectedId);
  return <InvoicePanes {...props} doc={doc} status="ready" />;
}

/** The invoice and what is open beside it. */
function InvoicePanes({
  selectedId,
  listEmpty,
  row,
  asked,
  now,
  opened,
  sideCollapsed,
  onOpened,
  onSidePref,
  onLevel,
  onArrived,
  onPatch,
  doc,
  status,
}: PanesProps & { doc: InvoiceDocument | undefined; status: "loading" | "ready" | "failed" }) {
  const selected = selectedId ? doc : undefined;
  const state = selected && isCurrent(selected.state.global) ? selected.state.global : null;
  const lines = useMemo(() => state?.lines ?? [], [state]);
  // The order the invoice reads in (by category): the stepper walks it.
  const walk = useMemo(() => groupLines(lines).flatMap((g) => g.lines.map((x) => x.line)), [lines]);
  const lineAt = opened.kind === "line" ? walk.findIndex((l) => l.id === opened.id) : -1;

  // The invoice asked for by id has loaded: its side and its view follow.
  const arrivedRef = useRef(onArrived);
  arrivedRef.current = onArrived;
  useEffect(() => {
    if (state && selected && selected.header.id === asked) arrivedRef.current(state);
  }, [state, selected, asked]);

  // A change made while it is open (issued, paid, voided, a date): its row follows at once.
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;
  const last = useRef<{ id: string; state: InvoiceState } | null>(null);
  useEffect(() => {
    if (!selected || !state) return;
    const prev = last.current;
    last.current = { id: selected.header.id, state };
    if (prev?.id === selected.header.id && prev.state !== state) patchRef.current(selected.header.id, rowPatch(state, now));
  }, [selected, state, now]);

  // A line removed from the invoice takes the third column back to the invoice.
  useEffect(() => {
    if (state && opened.kind === "line" && lineAt < 0) onOpened(invoiceView(state));
  }, [state, opened, lineAt, onOpened]);

  const openLine = (id: string) => {
    onOpened({ kind: "line", id });
    onSidePref(false);
    onLevel(3);
  };
  const step = (by: number) => {
    const next = walk[lineAt + by];
    if (next) onOpened({ kind: "line", id: next.id });
  };

  // Walking the lines with the arrow keys while one is open, unless typing.
  useEffect(() => {
    if (opened.kind !== "line") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Before the document is here, the row says what it is.
  const title = selected && state ? paneTitle(state) : row ? titleFor(row.kind, row.direction, row.number) : "Invoice";
  const badge = selected && state ? state.number && <InvoiceStatusBadge doc={selected} /> : row?.number && <RowStatusBadge row={row} />;

  return (
    <>
      <Pane
        grow={1.3}
        flush
        onBack={() => onLevel(1)}
        backLabel="Back to the list"
        // Issued: its number and where it stands. A draft is simply that.
        title={title}
        header={badge}
      >
        {!selectedId ? (
          !listEmpty && (
            <div style={{ padding: "var(--sk-space-6)" }}>
              <EmptyState icon="invoice" title="Pick an invoice">
                It opens here, line by line; a line opens beside it with its receipt.
              </EmptyState>
            </div>
          )
        ) : !selected ? (
          status === "loading" ? (
            <div className="sk-stack sk-stack--4" style={{ padding: "var(--sk-space-6)" }} aria-busy="true">
              <Skeleton height={56} />
              <Skeleton height={140} />
              <Skeleton height={220} />
            </div>
          ) : (
            <div style={{ padding: "var(--sk-space-6)" }}>
              <EmptyState icon="invoice" title="This invoice could not be opened">
                It may have been removed.
              </EmptyState>
            </div>
          )
        ) : !state ? (
          <div style={{ padding: "var(--sk-space-6)" }}>
            <EmptyState icon="invoice" title="This invoice uses the older format">
              Open it in the invoice editor to upgrade it.
            </EmptyState>
          </div>
        ) : (
          <InvoiceRead
            doc={selected}
            state={state}
            now={now}
            activeLine={opened.kind === "line" ? opened.id : null}
            // Only with the preview open beside it is one of them "the one shown".
            invoiceView={opened.kind === "invoice" && !sideCollapsed ? opened.doc : null}
            folded={sideCollapsed}
            onLine={openLine}
            onInvoice={(view) => {
              onOpened({ kind: "invoice", doc: view });
              onSidePref(false);
              onLevel(3);
            }}
          />
        )}
      </Pane>

      <Pane
        side="end"
        grow={1}
        // Wide enough that a receipt and the PDF read well (see app.css).
        className="sk-invoices__side"
        collapsed={sideCollapsed}
        onToggle={() => onSidePref(!sideCollapsed)}
        onBack={() => onLevel(2)}
        backLabel="Back to the invoice"
        collapsedTitle={opened.kind === "line" ? "Line" : "Preview"}
        header={
          state && opened.kind === "line" && lineAt >= 0 ? (
            <LineStepper at={lineAt} n={lines.indexOf(walk[lineAt]) + 1} count={walk.length} onStep={step} />
          ) : state ? (
            <Selector
              value={opened.kind === "invoice" ? opened.doc : PDF}
              options={[
                // Two lines, like the documents' tiles (name and role), so it sits on the header's edge as they do.
                { value: PDF, name: "Print/PDF", meta: "Preview", media: <FileTypeTile kind="pdf" small /> },
                ...partyViews(state).map((v) => ({ value: v.value, name: v.name, meta: v.party.name ?? "Not filled in", icon: "customers" as const })),
                // The file, with its type, here; what it is goes in the preview's toolbar below.
                ...state.attachments.map((a) => ({
                  value: a.id,
                  name: a.fileName,
                  meta: bytes(a.sizeBytes) || a.mimeType,
                  media: <FileTypeTile kind={fileKind(a.mimeType, a.fileName)} small />,
                })),
              ]}
              onChange={(view) => onOpened({ kind: "invoice", doc: view })}
              label="Invoice document"
            />
          ) : undefined
        }
        title={state ? undefined : "Preview"}
      >
        {selected && state ? (
          opened.kind === "line" && lineAt >= 0 ? (
            <LineView key={opened.id} documentId={selected.header.id} state={state} line={walk[lineAt]} />
          ) : (
            <InvoiceDocView invoice={selected} state={state} doc={opened.kind === "invoice" ? opened.doc : PDF} />
          )
        ) : (
          <p className="sk-small sk-text-muted">A line and its receipt open here.</p>
        )}
      </Pane>
    </>
  );
}

/* ------------------------------------------------------------------ list */

/** A row re-renders only when its index row or its selection changes. */
const InvoiceListItem = memo(InvoiceListItemImpl);

function InvoiceListItemImpl({ row: r, selected, onPick }: { row: InvoiceRow; selected: boolean; onPick: (row: InvoiceRow) => void }) {
  const name = r.counterpartyName || "No counterparty yet";
  const when =
    r.status === "OPEN"
      ? `due ${relativeDays(r.dueAt)}`
      : r.status === "PAID"
        ? `paid ${fmtShortDate(r.lastPaidAt)}`
        : r.status === "DRAFT"
          ? // What the draft covers: its delivery, else its period, else nothing yet.
            r.deliveredAt
            ? `delivered ${fmtShortDate(r.deliveredAt)}`
            : r.periodStart || r.periodEnd
              ? `${r.periodStart ? fmtShortDate(r.periodStart) : "…"} – ${r.periodEnd ? fmtShortDate(r.periodEnd) : "…"}`
              : "no date"
          : "void";
  return (
    <ListItem
      rich
      selected={selected}
      onClick={() => onPick(r)}
      // Stacked, this row leads to the invoice screen: the chevron says so.
      drill={2}
      icon={<Avatar name={name} variant={r.direction === "OUTGOING" ? "sage" : "forest"} />}
      title={
        <span className={cx(r.status === "VOID" && "sk-text-muted")}>
          {/* The number as a label; a draft has none yet, so its label is just the hash. */}
          <Badge tone="outline" className="sk-invoices__number">
            #{r.number ?? ""}
          </Badge>
          {name}
        </span>
      }
      sub={[
        <span key="what" style={{ color: "var(--sk-text)" }}>
          {r.subject || r.firstLine || "No lines"}
        </span>,
        <span key="when" className={cx(r.overdue && "sk-text-danger")}>
          {r.issuedAt ? `${fmtShortDate(r.issuedAt)} · ` : ""}
          {when}
        </span>,
      ]}
      aside={
        <>
          <span className="sk-tabular">{money(r.status === "OPEN" ? r.outstanding : r.gross, r.currency)}</span>
          <RowStatusBadge row={r} />
        </>
      }
      chevron
    />
  );
}

/* --------------------------------------------------------------- invoice */

/** Opens the invoice in its editor, where it is changed. */
function useOpenInvoice(documentId: string): (() => void) | null {
  const location = useDocumentLocation(documentId, SEKTAR_DRIVE_SLUG);
  if (!location) return null;
  return () =>
    openTarget({
      driveSlug: location.drive.header.slug || location.drive.header.id,
      nodeSlug: makeNodeSlug(location.node),
    });
}

/** The invoice read once: who and what, the amount and where it stands, the dates, the lines. */
function InvoiceRead({
  doc,
  state: s,
  now,
  activeLine,
  invoiceView,
  folded,
  onLine,
  onInvoice,
}: {
  doc: InvoiceDocument;
  state: InvoiceState;
  now: number;
  activeLine: string | null;
  /** The invoice view open beside (the PDF, or one of its documents); null while a line is, or nothing is */
  invoiceView: string | null;
  /** The preview pane is folded: "Show beside" is then a plain list of places to go (no radio, nothing chosen) */
  folded: boolean;
  onLine: (id: string) => void;
  onInvoice: (view: string) => void;
}) {
  const open = useOpenInvoice(doc.header.id);
  const [dialog, setDialog] = useState<"issue" | "pay" | null>(null);
  const dispatch = (action: InvoiceAction | InvoiceAction[]) => void dispatchActions(action, doc.header.id);
  // The dates the model lets change: a draft's, and an issued (open) invoice's due date.
  const draft = s.status === "DRAFT";
  const dueEditable = draft || s.status === "OPEN";
  const [dateError, setDateError] = useState<string | null>(null);
  const setHeader = (input: Parameters<typeof actions.setHeader>[0]) => {
    setDateError(null);
    dispatchActions(actions.setHeader(input), doc.header.id).catch((e: unknown) =>
      setDateError(e instanceof Error ? e.message : String(e)),
    );
  };
  const t = computeTotals(s);
  const total = t.gross + t.rounding;
  const other = counterparty(s);
  const overdue = isOverdue(s, now);
  const kind = s.kind === "CREDIT_NOTE" ? "Credit note" : s.direction === "OUTGOING" ? "Sales invoice" : "Purchase bill";
  const missing = s.lines.filter((l) => l.attachments.length === 0).length;

  const groups = useMemo(() => groupLines(s.lines), [s.lines]);
  const rates = useMemo(() => invoiceRates(s), [s]);
  /** The invoice's own rate from a currency into its currency (either way round as stored). */
  const rateInto = (from: string): number | null => {
    const r = s.exchangeRates.find((x) => (x.base === from && x.quote === s.currency) || (x.base === s.currency && x.quote === from));
    if (!r) return null;
    return r.base === from ? r.rate : 1 / r.rate;
  };

  const standing =
    s.status === "PAID"
      ? `Paid ${fmtDate(s.payments.at(-1)?.paidAt)}`
      : s.status === "VOID"
        ? "Void"
        : s.status === "DRAFT"
          ? "Not issued yet"
          : t.paid > 0
            ? `${money(t.paid, s.currency)} paid · ${money(invoiceTotals(s).outstanding, s.currency)} to go`
            : `Due ${relativeDays(s.dueAt)}`;

  return (
    <article className="sk-invbook">
      <header className="sk-invbook__head">
        <Avatar name={other.name ?? "?"} size="lg" variant={s.direction === "OUTGOING" ? "sage" : "forest"} />
        <div className="sk-invbook__who">
          <div className="sk-eyebrow">
            {kind} · {s.number ?? "Draft"}
          </div>
          <h2 className="sk-invbook__name">{other.name ?? "No counterparty yet"}</h2>
          {s.subject && <div className="sk-invbook__subject">{s.subject}</div>}
        </div>
      </header>

      {/* Two summary boxes: what it comes to, and when. */}
      <div className="sk-invbook__summary">
        <section className="sk-invbook__box" aria-label="Amount">
          <div className="sk-eyebrow">Total incl. VAT</div>
          <div className="sk-numeral sk-invbook__amount">
            <Amount text={money(total, s.currency)} />
          </div>
          <div className={cx("sk-invbook__standing", overdue && "sk-text-danger")}>{standing}</div>
          <dl className="sk-invbook__figs">
            <Fact label="Net" value={money(t.net, s.currency)} />
            {t.groups.length > 0 ? (
              t.groups.map((g) => <Fact key={`${g.category}-${g.rate}`} label={`VAT ${g.rate}%`} value={money(g.tax, s.currency)} />)
            ) : (
              <Fact label="VAT" value={money(t.vat, s.currency)} />
            )}
            {t.rounding !== 0 && <Fact label="Rounding" value={money(t.rounding, s.currency)} />}
            <Fact label="Gross" value={money(total, s.currency)} strong />
          </dl>
        </section>
        <section className="sk-invbook__box sk-invbook__box--dates" aria-label="Dates">
          <div className="sk-eyebrow">Dates</div>
          {/* Every date, always; each editable while the invoice allows it
              (a draft: all but the issue date, set by issuing; issued: the
              due date; paid or void: none). */}
          {/* In the order things happen: what was delivered, then the invoice's own life. */}
          <dl className="sk-invbook__dates">
            <DateRow label="Period from" value={s.period?.start} onChange={draft ? (v) => setHeader({ periodStart: v }) : undefined} />
            <DateRow label="Period to" value={s.period?.end} onChange={draft ? (v) => setHeader({ periodEnd: v }) : undefined} />
            <DateRow label="Delivered" value={s.deliveredAt} onChange={draft ? (v) => setHeader({ deliveredAt: v }) : undefined} />
          </dl>
          <dl className="sk-invbook__dates sk-invbook__dates--life">
            <DateRow label="Issued" value={s.issuedAt} empty={s.status === "DRAFT" ? "on issue" : "—"} />
            <DateRow label="Due" value={s.dueAt} danger={overdue} onChange={dueEditable ? (v) => setHeader({ dueAt: v }) : undefined} />
            {s.payments.length > 1 ? (
              s.payments.map((p, i) => <DateRow key={p.id} label={`Paid (${i + 1})`} value={p.paidAt} />)
            ) : (
              <DateRow label="Paid" value={s.payments[0]?.paidAt} />
            )}
          </dl>
          {dateError && <p className="sk-small sk-text-danger">{dateError}</p>}
        </section>
      </div>

      {/* What the third column shows of the invoice itself: one of these, picked here or in its header. */}
      <div className={cx("sk-invbook__views", folded && "is-plain")} role="radiogroup" aria-label="Show beside">
        {[
          { value: PDF, name: "Print/PDF", meta: "Preview" },
          ...partyViews(s).map((v) => ({ value: v.value, name: v.name, meta: v.party.name ?? "Not filled in" })),
          ...s.attachments.map((a) => ({ value: a.id, name: a.fileName, meta: roleLabel(a.role) })),
        ].map((o) => {
          const on = invoiceView === o.value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} className={cx("sk-invbook__view", on && "is-active")} onClick={() => onInvoice(o.value)}>
              <span className="sk-invbook__radio" aria-hidden="true" />
              <Icon name={o.value === PDF ? "invoice" : o.value.startsWith(PARTY) ? "customers" : "upload"} size={16} mono />
              <span className="sk-invbook__view-text">
                <span className="sk-invbook__view-name">{o.name}</span>
                <span className="sk-invbook__view-meta">{o.meta}</span>
              </span>
              <Icon name="chevron-right" size={16} mono className="sk-invbook__view-go" />
            </button>
          );
        })}
      </div>

      <div className="sk-invbook__actions">
        {/* The next step in the invoice's life, as the editor offers it. */}
        {s.status === "DRAFT" && (
          <Button variant="primary" icon="arrow-right" disabled={s.lines.length === 0} onClick={() => setDialog("issue")}>
            {s.direction === "INCOMING" ? "Approve the bill" : s.kind === "CREDIT_NOTE" ? "Issue the credit note" : "Issue the invoice"}
          </Button>
        )}
        {s.status === "OPEN" && (
          <Button variant="primary" icon="check" onClick={() => setDialog("pay")}>
            Record a payment
          </Button>
        )}
        {/* Not on a phone (stacked): the editor is a desktop tool. */}
        <Button variant="secondary" icon="arrow-up-right" className="sk-stack-hide" disabled={!open} onClick={open ?? undefined}>
          Open in the editor
        </Button>
      </div>
      {dialog === "issue" && (
        <IssueDialog doc={doc} checks={invoiceChecks(s)} dispatch={dispatch} onClose={() => setDialog(null)} onChecks={() => open?.()} />
      )}
      {dialog === "pay" && <PaymentDialog state={s} dispatch={dispatch} onClose={() => setDialog(null)} />}

      <section className="sk-invbook__lines" aria-label="Lines">
        {/* "22 lines" (and what lacks a receipt) on the left, on the bottom
            edge; the invoice's exchange rates on the right, one per line. */}
        <div className="sk-invbook__lines-head">
          <span className="sk-invbook__lines-count">
            <span className="sk-eyebrow">{plural(s.lines.length, "line")}</span>
            {missing > 0 && (
              <span className="sk-invbook__missing">
                <span className="sk-invbook__dot" aria-hidden="true" />
                {missing} without a receipt
              </span>
            )}
          </span>
          {rates.length > 0 && (
            <span className="sk-invbook__rates">
              {rates.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </span>
          )}
        </div>
        {groups.map((g) => (
          <div key={g.name} className="sk-invbook__group">
            <div className="sk-invbook__group-head">{g.name}</div>
            <ul className="sk-invbook__rows">
              {g.lines.map(({ line, n }) => (
                <li key={line.id}>
                  <LineRow line={line} n={n} currency={s.currency} rate={rateInto} active={line.id === activeLine} onOpen={() => onLine(line.id)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {s.lines.length === 0 && <p className="sk-small sk-text-muted">No lines yet.</p>}
      </section>

    </article>
  );
}

/** A formatted amount with its currency ("US$", "€") set apart: lighter, and half a character from the figures. */
function Amount({ text }: { text: string }) {
  const m = /^(-?)([^\d\s.,-]+)\s?(.+)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="sk-invbook__cur">{m[2]}</span>
      {m[3]}
    </>
  );
}

/**
 * One date in the Dates box: read, or (given onChange) a date input that
 * reads like text until hovered or focused and commits as soon as a whole
 * date is picked. Clearing it clears the date.
 */
function DateRow({
  label,
  value,
  empty = "—",
  danger,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  empty?: string;
  danger?: boolean;
  onChange?: (next: string | null) => void;
}) {
  return (
    <div className="sk-invbook__date-row">
      <dt>{label}</dt>
      <dd className={cx(danger && "sk-text-danger")}>
        {onChange ? (
          <input
            type="date"
            className="sk-invbook__date"
            aria-label={label}
            value={toDateInput(value)}
            onChange={(e) => {
              const next = e.target.value ? fromDateInput(e.target.value) : null;
              if (toDateInput(next) !== toDateInput(value)) onChange(next);
            }}
          />
        ) : value ? (
          fmtDate(value)
        ) : (
          <span className="sk-text-muted">{empty}</span>
        )}
      </dd>
    </div>
  );
}

function Fact({ label, value, tone, strong }: { label: string; value: ReactNode; tone?: "danger"; strong?: boolean }) {
  return (
    <div className={cx("sk-invbook__fact", strong && "is-strong")}>
      <dt>{label}</dt>
      <dd className={cx("sk-tabular", tone === "danger" && "sk-text-danger")}>{value}</dd>
    </div>
  );
}

/** One line: what it is, where the amount came from, the amount, whether its receipt is there. */
function LineRow({
  line,
  n,
  currency,
  rate,
  active,
  onOpen,
}: {
  line: InvoiceLine;
  n: number;
  currency: string;
  /** The invoice's rate from a currency into its own, for a line that does not carry one */
  rate: (from: string) => number | null;
  active: boolean;
  onOpen: () => void;
}) {
  const original = line.original && line.original.currency !== currency ? line.original : null;
  const factor = original ? (original.rate ?? rate(original.currency)) : null;
  const receipts = line.attachments.length;
  const reference = line.original?.reference;
  return (
    <button
      type="button"
      className={cx("sk-invbook__line", active && "is-active")}
      onClick={onOpen}
      data-sk-drill={3}
      aria-current={active || undefined}
      aria-label={`Line ${n}: ${line.quantity} × ${line.description}`}
    >
      {/* How many, in front of what: "1 × Toggl". */}
      <span className="sk-invbook__qty" aria-hidden="true">
        {qtyLabel(line.quantity)}
      </span>
      <span className="sk-invbook__line-main">
        {/* The supplier's reference in front of what it is. */}
        <span className="sk-invbook__line-desc">
          {reference && (
            <Badge tone="outline" className="sk-invbook__ref">
              {reference}
            </Badge>
          )}
          {line.description}
        </span>
        {/* More than one: what one costs, under what it is. */}
        {(line.quantity !== 1 || line.note) && (
          <span className="sk-invbook__line-meta">
            {[line.quantity !== 1 ? `Unit cost: ${money(line.unitPrice, currency)}` : null, line.note].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className="sk-invbook__line-amount">
        <span className="sk-tabular">{money(lineAmount(line), currency)}</span>
        {/* A forward-billed cost: what it was, times the rate, makes the total above. */}
        {original && (
          <span className="sk-invbook__line-from sk-tabular">
            = {money(original.amount, original.currency)}
            {factor ? ` × ${fmtRate(factor)}` : ""}
          </span>
        )}
      </span>
      <span
        className={cx("sk-invbook__mark", receipts === 0 && "is-missing")}
        title={receipts === 0 ? "No receipt yet" : plural(receipts, "receipt")}
      >
        {receipts === 0 ? <span className="sk-invbook__dot" /> : <Icon name="check" size={16} mono />}
      </span>
      {/* Stacked, the row leads to the line's screen: the chevron says so. */}
      <Icon name="chevron-right" size={16} mono className="sk-stack-only sk-invbook__chevron" />
    </button>
  );
}

/* ----------------------------------------------------------- what's open */

/**
 * The third column's header for a line: which line, and at the right a step
 * up or down the invoice as it reads (the arrow keys do the same). Back to the
 * invoice itself is "Show beside" in the middle pane.
 */
function LineStepper({ at, n, count, onStep }: { at: number; n: number; count: number; onStep: (by: number) => void }) {
  return (
    <div className="sk-invbook__stepper">
      <span className="sk-invbook__step">
        Line <b>{n}</b> of {count}
      </span>
      <span className="sk-pane__spacer" />
      <button type="button" className="sk-btn sk-btn--ghost sk-btn--sm sk-btn--icon" aria-label="Line above" title="Line above (↑)" disabled={at === 0} onClick={() => onStep(-1)}>
        <Icon name="chevron-down" size={16} mono className="sk-invbook__up" />
      </button>
      <button type="button" className="sk-btn sk-btn--ghost sk-btn--sm sk-btn--icon" aria-label="Line below" title="Line below (↓)" disabled={at === count - 1} onClick={() => onStep(1)}>
        <Icon name="chevron-down" size={16} mono />
      </button>
    </div>
  );
}

/** A line opened: its facts, then its receipts. */
function LineView({ documentId, state: s, line }: { documentId: string; state: InvoiceState; line: InvoiceLine }) {
  const [receipt, setReceipt] = useState<string | null>(line.attachments[0]?.id ?? null);
  const shown = line.attachments.find((a) => a.id === receipt) ?? line.attachments[0];
  // The line as the PDF prints it: its headers, its cells; the currency said
  // once above the table, as the PDF says it above its lines.
  const p = printedLine(line, s.currency, { symbol: false });
  const widths = useColumnWidths(s);

  // The line's receipts: added here (stored, then attached to the line) or removed, after a word.
  const client = useAttachments();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = s.status === "VOID";
  const add = async (files: FileList | null) => {
    if (!client || !files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const id = await attachFile(client, documentId, file, { lineId: line.id, role: "RECEIPT" });
        setReceipt(id);
      }
    } catch (e) {
      setError(`Could not add it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = () => {
    if (!shown) return;
    setConfirm(false);
    setError(null);
    dispatchActions(actions.removeAttachment({ id: shown.id }), documentId).catch((e: unknown) =>
      setError(`Could not remove it: ${e instanceof Error ? e.message : String(e)}`),
    );
    setReceipt(line.attachments.find((a) => a.id !== shown.id)?.id ?? null);
  };
  return (
    <div className="sk-invbook-line">
      <div className="sk-invbook-line__scroll">
        {/* Column widths fixed for the whole invoice (fitted to its largest
            figures): stepping from line to line, the columns stay put. */}
        {/* The description keeps at least 5em: an invoice with huge figures scrolls sideways rather than crushing it. */}
        <table className="sk-invbook-line__table" style={{ minWidth: `calc(${widths.reduce((a, b) => a + b, 0)}ch + 5em)` }}>
          <colgroup>
            <col />
            {widths.map((w, i) => (
              <col key={i} style={{ width: `${w}ch` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {LINE_HEADERS.map((h, i) => (
                <th key={h} className={cx(i > 0 && "is-num")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                {p.description}
                {p.note && <div className="sk-invbook-line__note">{p.note}</div>}
              </td>
              <td className="is-num">{p.unitPrice}</td>
              <td className="is-num">{p.quantity}</td>
              <td className="is-num">{p.net}</td>
              <td className="is-num">{p.vatRate}</td>
              <td className="is-num">{p.gross}</td>
            </tr>
          </tbody>
        </table>
        <div className="sk-invbook-line__currency">All amounts in {s.currency}</div>
      </div>
      {line.attachments.length > 1 && (
        <Selector
          value={shown?.id ?? ""}
          options={line.attachments.map((a) => ({ value: a.id, name: a.fileName, meta: roleLabel(a.role) }))}
          onChange={setReceipt}
          label="Receipt"
        />
      )}
      {shown ? (
        <FilePreviewFrame
          key={shown.id}
          documentId={documentId}
          attachment={shown}
          subtitle={
            line.original?.reference && (
              <Badge tone="outline" className="sk-invbook__ref">
                {line.original.reference}
              </Badge>
            )
          }
        />
      ) : (
        <div className="sk-invbook-line__none">
          <span className="sk-invbook__dot" aria-hidden="true" />
          <div className="sk-stack sk-stack--2">
            <div>
              <div className="sk-weight-medium">No receipt on this line yet</div>
              <div className="sk-caption">{closed ? "A void invoice takes no documents." : "Add the receipt or invoice behind this cost."}</div>
            </div>
            {!closed && (
              <span>
                <Button size="sm" variant="primary" icon="upload" disabled={!client || busy} onClick={() => input.current?.click()}>
                  {busy ? "Adding…" : "Add a receipt"}
                </Button>
              </span>
            )}
          </div>
        </div>
      )}
      {shown && !closed && (
        <div className="sk-invbook-line__receipt-actions">
          {confirm ? (
            <>
              <span className="sk-small">Remove {shown.fileName}?</span>
              <Button size="sm" variant="danger" onClick={remove}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" icon="upload" disabled={!client || busy} onClick={() => input.current?.click()}>
                {busy ? "Adding…" : "Add a receipt"}
              </Button>
              <Button size="sm" variant="ghost" icon="close" onClick={() => setConfirm(true)}>
                Remove this receipt
              </Button>
            </>
          )}
        </div>
      )}
      {error && <p className="sk-small sk-text-danger">{error}</p>}
      <input
        ref={input}
        type="file"
        multiple
        accept=".pdf,image/*"
        hidden
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * The open line's figure columns, in `ch`: each as wide as the widest value
 * any line of the invoice puts in it (or the longest word of its header),
 * plus room between columns. One set per invoice, so the columns hold still.
 */
function useColumnWidths(s: InvoiceState): number[] {
  return useMemo(() => {
    const rows = s.lines.map((l) => printedLine(l, s.currency, { symbol: false }));
    const cells: (keyof PrintedLine)[] = ["unitPrice", "quantity", "net", "vatRate", "gross"];
    return cells.map((key, i) => {
      const widest = Math.max(0, ...rows.map((r) => String(r[key] ?? "").length));
      const word = Math.max(...LINE_HEADERS[i + 1].split(" ").map((w) => w.length));
      // Room between columns: a figure needs a little, a header word (and the cell's padding) a little more.
      return Math.max(widest + 0.6, word + 1.2);
    });
  }, [s.lines, s.currency]);
}

/**
 * The invoice itself: its PDF preview (from the print HTML), with what is
 * done with it — print or save it, bundle its receipts — or one of its own
 * documents.
 */
function InvoiceDocView({ invoice, state: s, doc }: { invoice: InvoiceDocument; state: InvoiceState; doc: string }) {
  const attachment = s.attachments.find((a) => a.id === doc);
  if (attachment) return <FilePreviewFrame key={attachment.id} documentId={invoice.header.id} attachment={attachment} named />;
  const party = partyViews(s).find((v) => v.value === doc);
  if (party) return <PartyDetails role={party.name} party={party.party} ours={party.ours} />;
  return (
    <div className="sk-invbook-pdf">
      {s.direction === "OUTGOING" && (
        <div className="sk-invbook-pdf__actions">
          <SendActions doc={invoice} size="sm" />
        </div>
      )}
      <InvoicePrintPreview state={s} />
    </div>
  );
}
