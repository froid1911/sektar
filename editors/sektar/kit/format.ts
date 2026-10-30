// Formatting, labels and tone maps shared by the boards, the side panels and
// the document editors. Pure functions over document state; no React except
// the small `useNow` clock.
import type { TransactionCategory } from "document-models/bank-account";
import type { ExpenseStatus, PaidWith } from "document-models/expense-report";
import type { ContactKind } from "document-models/contact";
import {
  computeTotals,
  findRate,
  type InvoiceDirection,
  type InvoiceParty,
  type InvoiceState,
  type InvoiceStatus,
  type PaymentMethod,
} from "document-models/invoice";
import type {
  TransactionStatus,
  AccountKind,
} from "document-models/bank-account";
import type { ExpenseReportState } from "document-models/expense-report";
import { useEffect, useState } from "react";

/* ------------------------------------------------------------------ money */

export function money(
  amount: number,
  currency = "EUR",
  opts: { signed?: boolean; compact?: boolean } = {},
): string {
  const abs = Math.abs(amount);
  const text = new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency,
    maximumFractionDigits: opts.compact && abs >= 10_000 ? 0 : 2,
    minimumFractionDigits: opts.compact && abs >= 10_000 ? 0 : 2,
    notation: opts.compact && abs >= 100_000 ? "compact" : "standard",
  }).format(abs);
  if (opts.signed) return amount < 0 ? `−${text}` : `+${text}`;
  return amount < 0 ? `−${text}` : text;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ dates */

const DAY = 86_400_000;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function fmtMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
  });
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY);
}

/** "in 5 days", "3 days ago", "today" */
export function relativeDays(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "";
  const diff = Math.round((Date.parse(iso) - now) / DAY);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

export function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

export function fromDateInput(value: string): string {
  return new Date(`${value}T12:00:00.000Z`).toISOString();
}

export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ names */

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/* ------------------------------------------------------------------ badges */

/** Badge variants of the design system (`sk-badge--*`). */
export type BadgeTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "mint"
  | "forest"
  | "outline"
  | "neutral";

export const INVOICE_STATUS: Record<
  InvoiceStatus,
  { label: string; tone: BadgeTone }
> = {
  DRAFT: { label: "Draft", tone: "outline" },
  OPEN: { label: "Open", tone: "info" },
  PAID: { label: "Paid", tone: "success" },
  VOID: { label: "Void", tone: "neutral" },
};

export const INVOICE_DIRECTION: Record<
  InvoiceDirection,
  { label: string; short: string }
> = {
  OUTGOING: { label: "Outgoing · receivable", short: "Sales" },
  INCOMING: { label: "Incoming · payable", short: "Purchase" },
};

export const EXPENSE_STATUS: Record<
  ExpenseStatus,
  { label: string; tone: BadgeTone }
> = {
  DRAFT: { label: "Draft", tone: "outline" },
  SUBMITTED: { label: "Awaiting approval", tone: "warning" },
  APPROVED: { label: "Approved", tone: "info" },
  REJECTED: { label: "Rejected", tone: "danger" },
  REIMBURSED: { label: "Reimbursed", tone: "success" },
};

export const EXPENSE_FLOW: ExpenseStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REIMBURSED",
];

export const PAID_WITH: Record<PaidWith, string> = {
  COMPANY_CARD: "Company card",
  PERSONAL: "Personal · reimburse",
  CASH: "Cash",
};

export const TX_STATUS: Record<
  TransactionStatus,
  { label: string; tone: BadgeTone }
> = {
  PENDING: { label: "Pending", tone: "outline" },
  NEW: { label: "To review", tone: "warning" },
  CATEGORIZED: { label: "Categorised", tone: "outline" },
  MATCHED: { label: "Matched", tone: "success" },
  EXCLUDED: { label: "Excluded", tone: "neutral" },
};

export const ACCOUNT_KIND: Record<AccountKind, string> = {
  CURRENT: "Current account",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit card",
};

export const CONTACT_KIND: Record<
  ContactKind,
  { label: string; tone: BadgeTone }
> = {
  SUPPLIER: { label: "Supplier", tone: "mint" },
  CUSTOMER: { label: "Customer", tone: "success" },
  BOTH: { label: "Supplier & customer", tone: "info" },
  OTHER: { label: "Other", tone: "outline" },
};

export const PAYMENT_METHOD: Record<PaymentMethod, string> = {
  BANK_TRANSFER: "Bank transfer",
  CARD: "Card",
  CASH: "Cash",
  OTHER: "Other",
};

export const CATEGORY: Record<
  TransactionCategory,
  { label: string; tone: BadgeTone }
> = {
  UNCATEGORIZED: { label: "Uncategorised", tone: "warning" },
  SALES: { label: "Sales", tone: "success" },
  SUPPLIES: { label: "Supplies", tone: "outline" },
  PAYROLL: { label: "Payroll", tone: "forest" },
  RENT: { label: "Rent", tone: "outline" },
  SOFTWARE: { label: "Software", tone: "mint" },
  TRAVEL: { label: "Travel", tone: "outline" },
  MARKETING: { label: "Marketing", tone: "mint" },
  TAX: { label: "Tax", tone: "info" },
  BANK_FEES: { label: "Fees", tone: "info" },
  TRANSFER: { label: "Transfer", tone: "neutral" },
  OTHER: { label: "Other", tone: "outline" },
};

export const CATEGORY_ORDER: TransactionCategory[] = [
  "SALES",
  "SUPPLIES",
  "PAYROLL",
  "RENT",
  "SOFTWARE",
  "MARKETING",
  "TRAVEL",
  "TAX",
  "BANK_FEES",
  "TRANSFER",
  "OTHER",
  "UNCATEGORIZED",
];

/* ------------------------------------------------------------------ totals */

export type InvoiceTotals = {
  net: number;
  vat: number;
  gross: number;
  paid: number;
  outstanding: number;
};

/** The totals the boards show, computed the EN 16931 way by the model (lines rounded, VAT per category). */
export function invoiceTotals(state: InvoiceState): InvoiceTotals {
  const t = computeTotals(state);
  return {
    net: t.net,
    vat: t.vat,
    gross: t.gross,
    paid: t.paid,
    outstanding: round2(Math.max(0, t.due)),
  };
}

/** The currency the books are kept in: what the boards add up in. */
export const BOOK_CURRENCY = "EUR";

/**
 * An invoice's totals in the book currency, at the invoice's own rate (the
 * one its VAT is reported at). Without a rate the amounts stay as they are:
 * close enough for a board, never for the books.
 */
export function bookTotals(state: InvoiceState): InvoiceTotals {
  const t = invoiceTotals(state);
  if (state.currency === BOOK_CURRENCY) return t;
  const rate = findRate(state.exchangeRates, state.currency, BOOK_CURRENCY);
  if (rate === null) return t;
  return {
    net: round2(t.net * rate),
    vat: round2(t.vat * rate),
    gross: round2(t.gross * rate),
    paid: round2(t.paid * rate),
    outstanding: round2(t.outstanding * rate),
  };
}

/** The other party: the buyer of a sales invoice, the seller of a bill. */
export function counterparty(state: InvoiceState): InvoiceParty {
  return state.direction === "OUTGOING" ? state.buyer : state.seller;
}

/** A party's address on one line. */
export function partyAddress(p: InvoiceParty): string | null {
  const city = [p.postalCode, p.city].filter(Boolean).join(" ");
  const parts = [p.street, p.additionalStreet, city, p.region, p.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function isOverdue(state: InvoiceState, now = Date.now()): boolean {
  return (
    state.status === "OPEN" && !!state.dueAt && Date.parse(state.dueAt) < now
  );
}

export function expenseTotal(state: ExpenseReportState): number {
  return round2(state.items.reduce((sum, it) => sum + it.amount, 0));
}

export function expenseReimbursable(state: ExpenseReportState): number {
  return round2(
    state.items
      .filter((it) => it.paidWith === "PERSONAL" || it.paidWith === "CASH")
      .reduce((sum, it) => sum + it.amount, 0),
  );
}

/* ------------------------------------------------------------------ counts */

/** "1 receipt", "3 receipts". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
