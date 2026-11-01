/**
 * Keeps the finance index in step with the invoice, bank-account,
 * expense-report and contact documents.
 *
 * Rows come only off the operations' resulting state: an invoice's row, an
 * account's row and every transaction row of that account are all derived
 * from the document's global state after the operation (`rows.ts`). No
 * document is ever loaded. An operation without a resulting state (an older,
 * backfilled one) leaves the rows as they are; the batch counts them in one
 * warning.
 *
 * Only the last state per document in a batch is parsed: a replay holds one
 * entry per past operation, each carrying the whole state, and the last one
 * is the document's truth for the batch. An account's transactions are
 * reconciled against the rows stored for it: rows no longer in the account
 * are deleted, new or changed ones written, unchanged ones left alone, so a
 * categorisation rewrites one row, not the account's ten thousand.
 */
import { RelationalDbProcessor } from "@powerhousedao/shared/processors";
import type { OperationWithContext } from "document-model";
import { statelessWarning } from "../stateless-warning.js";
import { up } from "./migrations.js";
import {
  accountRows,
  accountState,
  contactRow,
  contactState,
  diffTransactions,
  expenseRows,
  expenseState,
  invoiceRow,
  invoiceState,
  parseState,
} from "./rows.js";
import type {
  ContactRow,
  DB,
  ExpenseItemRow,
  ExpenseRow,
  InvoiceRow,
  TransactionRow,
} from "./schema.js";

export const INVOICE_DOCUMENT_TYPE = "sektar/invoice";
export const ACCOUNT_DOCUMENT_TYPE = "sektar/bank-account";
export const EXPENSE_DOCUMENT_TYPE = "sektar/expense-report";
export const CONTACT_DOCUMENT_TYPE = "sektar/contact";

/** Every document type the index follows. */
export const FINANCE_DOCUMENT_TYPES = [
  INVOICE_DOCUMENT_TYPE,
  ACCOUNT_DOCUMENT_TYPE,
  EXPENSE_DOCUMENT_TYPE,
  CONTACT_DOCUMENT_TYPE,
] as const;

const FOLLOWED: ReadonlySet<string> = new Set(FINANCE_DOCUMENT_TYPES);

/**
 * Rows per statement. The widest table has thirty-four columns, so 200 rows
 * is 6,800 bind parameters: well under PostgreSQL's 65,535 and under what the
 * driver builds comfortably (see the osc-index processor for how that fails).
 */
const BATCH = 200;

interface Latest {
  documentType: string;
  resultingState: string;
  at: string;
}

export class FinanceIndex extends RelationalDbProcessor<DB> {
  /** Writes are serialised: two batches for one document must not interleave. */
  private queue: Promise<void> = Promise.resolve();

  onOperations(operations: OperationWithContext[]): Promise<void> {
    const next = this.queue.then(() => this.index(operations));
    // Keep the chain alive after a failure, or one bad batch stalls every
    // later one behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }

  onDisconnect(): Promise<void> {
    return Promise.resolve();
  }

  static override getNamespace(driveId: string): string {
    return super.getNamespace(driveId);
  }

  override async initAndUpgrade(): Promise<void> {
    await up(this.relationalDb);
  }

  private async index(operations: OperationWithContext[]): Promise<void> {
    const latest = new Map<string, Latest>();
    const deleted = new Set<string>();
    // The first operation's time per document: its creation time when the
    // batch holds its CREATE_DOCUMENT (scope "document", first of all).
    const firstAt = new Map<string, string>();
    const withoutState = new Map<string, number>();

    for (const { operation, context } of operations) {
      const type = operation.action.type;
      if (type === "DELETE_DOCUMENT" || type === "PURGE_DOCUMENT") {
        const input = operation.action.input as { documentId?: string } | null;
        const documentId = input?.documentId ?? context.documentId;
        if (this.isNamespaceDrive(documentId)) {
          await this.dropNamespace();
          return;
        }
        deleted.add(documentId);
        latest.delete(documentId);
        continue;
      }
      const { documentId, documentType } = context;
      if (!FOLLOWED.has(documentType)) continue;
      if (!firstAt.has(documentId)) firstAt.set(documentId, timeOf(operation));
      if (context.scope !== "global") continue;
      // A refused operation left the document as it was.
      if (operation.error || operation.deniedReason !== undefined) continue;
      if (deleted.has(documentId)) continue;
      if (!context.resultingState) {
        withoutState.set(documentId, (withoutState.get(documentId) ?? 0) + 1);
        continue;
      }
      latest.set(documentId, {
        documentType,
        resultingState: context.resultingState,
        at: timeOf(operation),
      });
    }

    const warning = statelessWarning("finance-index", withoutState);
    if (warning) console.warn(warning);

    await this.deleteDocuments([...deleted]);

    const invoices: [string, Latest][] = [];
    const accounts: [string, Latest][] = [];
    const expenses: [string, Latest][] = [];
    const contacts: [string, Latest][] = [];
    for (const entry of latest) {
      switch (entry[1].documentType) {
        case INVOICE_DOCUMENT_TYPE:
          invoices.push(entry);
          break;
        case ACCOUNT_DOCUMENT_TYPE:
          accounts.push(entry);
          break;
        case EXPENSE_DOCUMENT_TYPE:
          expenses.push(entry);
          break;
        default:
          contacts.push(entry);
      }
    }
    await this.writeInvoices(invoices, firstAt);
    for (const [documentId, entry] of accounts) {
      await this.writeAccount(documentId, entry);
    }
    await this.writeExpenses(expenses, firstAt);
    await this.writeContacts(contacts);
  }

  private async deleteDocuments(ids: string[]): Promise<void> {
    for (let at = 0; at < ids.length; at += BATCH) {
      const chunk = ids.slice(at, at + BATCH);
      await this.relationalDb
        .deleteFrom("invoice_index")
        .where("document_id", "in", chunk)
        .execute();
      await this.relationalDb
        .deleteFrom("account_index")
        .where("document_id", "in", chunk)
        .execute();
      await this.relationalDb
        .deleteFrom("transaction_index")
        .where("account_id", "in", chunk)
        .execute();
      await this.relationalDb
        .deleteFrom("expense_index")
        .where("document_id", "in", chunk)
        .execute();
      await this.relationalDb
        .deleteFrom("expense_item_index")
        .where("report_id", "in", chunk)
        .execute();
      await this.relationalDb
        .deleteFrom("contact_index")
        .where("document_id", "in", chunk)
        .execute();
    }
  }

  private async writeInvoices(
    entries: [string, Latest][],
    firstAt: Map<string, string>,
  ): Promise<void> {
    for (let at = 0; at < entries.length; at += BATCH) {
      const chunk = entries.slice(at, at + BATCH);
      // A stored row keeps the creation time it was first written with.
      const stored = await this.relationalDb
        .selectFrom("invoice_index")
        .select(["document_id", "created_at"])
        .where(
          "document_id",
          "in",
          chunk.map(([id]) => id),
        )
        .execute();
      const createdAt = new Map(
        stored.map((r) => [r.document_id, r.created_at]),
      );
      const rows: InvoiceRow[] = [];
      for (const [documentId, entry] of chunk) {
        const json = parseState(entry.resultingState);
        const state = json ? invoiceState(json) : null;
        if (!state) continue;
        const created =
          createdAt.get(documentId) ?? firstAt.get(documentId) ?? entry.at;
        rows.push(invoiceRow(documentId, state, created, entry.at));
      }
      if (rows.length === 0) continue;
      await this.relationalDb
        .insertInto("invoice_index")
        .values(rows)
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            direction: eb.ref("excluded.direction"),
            kind: eb.ref("excluded.kind"),
            status: eb.ref("excluded.status"),
            number: eb.ref("excluded.number"),
            is_draft: eb.ref("excluded.is_draft"),
            list_key: eb.ref("excluded.list_key"),
            counterparty_name: eb.ref("excluded.counterparty_name"),
            counterparty_contact_id: eb.ref("excluded.counterparty_contact_id"),
            subject: eb.ref("excluded.subject"),
            first_line: eb.ref("excluded.first_line"),
            currency: eb.ref("excluded.currency"),
            issued_at: eb.ref("excluded.issued_at"),
            due_at: eb.ref("excluded.due_at"),
            delivered_at: eb.ref("excluded.delivered_at"),
            period_start: eb.ref("excluded.period_start"),
            period_end: eb.ref("excluded.period_end"),
            gross: eb.ref("excluded.gross"),
            outstanding: eb.ref("excluded.outstanding"),
            book_gross: eb.ref("excluded.book_gross"),
            book_outstanding: eb.ref("excluded.book_outstanding"),
            book_rate_known: eb.ref("excluded.book_rate_known"),
            issued_copy_id: eb.ref("excluded.issued_copy_id"),
            issued_copy_ref: eb.ref("excluded.issued_copy_ref"),
            line_count: eb.ref("excluded.line_count"),
            lines_missing_attachments: eb.ref(
              "excluded.lines_missing_attachments",
            ),
            last_paid_at: eb.ref("excluded.last_paid_at"),
            our_party: eb.ref("excluded.our_party"),
            search_text: eb.ref("excluded.search_text"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }

  /** The claims' rows, and their receipts' rows replaced with the claims' own. */
  private async writeExpenses(
    entries: [string, Latest][],
    firstAt: Map<string, string>,
  ): Promise<void> {
    for (let at = 0; at < entries.length; at += BATCH) {
      const chunk = entries.slice(at, at + BATCH);
      // A stored row keeps the creation time it was first written with.
      const stored = await this.relationalDb
        .selectFrom("expense_index")
        .select(["document_id", "created_at"])
        .where(
          "document_id",
          "in",
          chunk.map(([id]) => id),
        )
        .execute();
      const createdAt = new Map(
        stored.map((r) => [r.document_id, r.created_at]),
      );
      const reports: ExpenseRow[] = [];
      const items: ExpenseItemRow[] = [];
      for (const [documentId, entry] of chunk) {
        const json = parseState(entry.resultingState);
        const state = json ? expenseState(json) : null;
        if (!state) continue;
        const created =
          createdAt.get(documentId) ?? firstAt.get(documentId) ?? entry.at;
        const rows = expenseRows(documentId, state, created, entry.at);
        reports.push(rows.report);
        items.push(...rows.items);
      }
      if (reports.length === 0) continue;
      await this.relationalDb
        .insertInto("expense_index")
        .values(reports)
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            submitter_name: eb.ref("excluded.submitter_name"),
            submitter_email: eb.ref("excluded.submitter_email"),
            status: eb.ref("excluded.status"),
            currency: eb.ref("excluded.currency"),
            total: eb.ref("excluded.total"),
            reimbursable: eb.ref("excluded.reimbursable"),
            vat_total: eb.ref("excluded.vat_total"),
            item_count: eb.ref("excluded.item_count"),
            categories: eb.ref("excluded.categories"),
            first_spent_at: eb.ref("excluded.first_spent_at"),
            submitted_at: eb.ref("excluded.submitted_at"),
            decided_at: eb.ref("excluded.decided_at"),
            reimbursed_at: eb.ref("excluded.reimbursed_at"),
            search_text: eb.ref("excluded.search_text"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
      // A claim holds a handful of receipts: replacing them is simpler than
      // a diff and costs no more.
      await this.relationalDb
        .deleteFrom("expense_item_index")
        .where(
          "report_id",
          "in",
          reports.map((r) => r.document_id),
        )
        .execute();
      for (let i = 0; i < items.length; i += BATCH) {
        await this.relationalDb
          .insertInto("expense_item_index")
          .values(items.slice(i, i + BATCH))
          .onConflict((oc) => oc.columns(["report_id", "id"]).doNothing())
          .execute();
      }
    }
  }

  private async writeContacts(entries: [string, Latest][]): Promise<void> {
    for (let at = 0; at < entries.length; at += BATCH) {
      const rows: ContactRow[] = [];
      for (const [documentId, entry] of entries.slice(at, at + BATCH)) {
        const json = parseState(entry.resultingState);
        const state = json ? contactState(json) : null;
        if (state) rows.push(contactRow(documentId, state, entry.at));
      }
      if (rows.length === 0) continue;
      await this.relationalDb
        .insertInto("contact_index")
        .values(rows)
        .onConflict((oc) =>
          oc.column("document_id").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            kind: eb.ref("excluded.kind"),
            status: eb.ref("excluded.status"),
            email: eb.ref("excluded.email"),
            phone: eb.ref("excluded.phone"),
            website: eb.ref("excluded.website"),
            vat_id: eb.ref("excluded.vat_id"),
            registration_number: eb.ref("excluded.registration_number"),
            street: eb.ref("excluded.street"),
            postal_code: eb.ref("excluded.postal_code"),
            city: eb.ref("excluded.city"),
            country: eb.ref("excluded.country"),
            payment_terms_days: eb.ref("excluded.payment_terms_days"),
            default_category: eb.ref("excluded.default_category"),
            tags: eb.ref("excluded.tags"),
            search_text: eb.ref("excluded.search_text"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        )
        .execute();
    }
  }

  /** The account's row, and its transaction rows brought to its state. */
  private async writeAccount(documentId: string, entry: Latest): Promise<void> {
    const json = parseState(entry.resultingState);
    const state = json ? accountState(json) : null;
    if (!state) return;
    const { account, transactions } = accountRows(documentId, state, entry.at);

    await this.relationalDb
      .insertInto("account_index")
      .values(account)
      .onConflict((oc) =>
        oc.column("document_id").doUpdateSet((eb) => ({
          name: eb.ref("excluded.name"),
          kind: eb.ref("excluded.kind"),
          institution: eb.ref("excluded.institution"),
          iban_last4: eb.ref("excluded.iban_last4"),
          currency: eb.ref("excluded.currency"),
          opening_balance: eb.ref("excluded.opening_balance"),
          balance: eb.ref("excluded.balance"),
          tx_count: eb.ref("excluded.tx_count"),
          new_count: eb.ref("excluded.new_count"),
          last_imported_at: eb.ref("excluded.last_imported_at"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();

    const stored: TransactionRow[] = await this.relationalDb
      .selectFrom("transaction_index")
      .selectAll()
      .where("account_id", "=", documentId)
      .execute();
    const { deletes, upserts } = diffTransactions(stored, transactions);
    for (let at = 0; at < deletes.length; at += BATCH) {
      await this.relationalDb
        .deleteFrom("transaction_index")
        .where("account_id", "=", documentId)
        .where("id", "in", deletes.slice(at, at + BATCH))
        .execute();
    }
    for (let at = 0; at < upserts.length; at += BATCH) {
      await this.relationalDb
        .insertInto("transaction_index")
        .values(upserts.slice(at, at + BATCH))
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({
            account_id: eb.ref("excluded.account_id"),
            booked_at: eb.ref("excluded.booked_at"),
            counterparty: eb.ref("excluded.counterparty"),
            description: eb.ref("excluded.description"),
            reference: eb.ref("excluded.reference"),
            category: eb.ref("excluded.category"),
            status: eb.ref("excluded.status"),
            amount: eb.ref("excluded.amount"),
            currency: eb.ref("excluded.currency"),
            contact_id: eb.ref("excluded.contact_id"),
            matched_document_id: eb.ref("excluded.matched_document_id"),
            matched_kind: eb.ref("excluded.matched_kind"),
            import_batch: eb.ref("excluded.import_batch"),
            search_text: eb.ref("excluded.search_text"),
          })),
        )
        .execute();
    }
  }
}

/** When an operation happened, as the index's instant. */
function timeOf(operation: OperationWithContext["operation"]): string {
  const stamped = operation as { timestampUtcMs?: unknown };
  if (typeof stamped.timestampUtcMs === "string" && stamped.timestampUtcMs)
    return stamped.timestampUtcMs;
  const action = operation.action as { timestampUtcMs?: unknown };
  if (typeof action.timestampUtcMs === "string" && action.timestampUtcMs)
    return action.timestampUtcMs;
  return new Date().toISOString();
}
