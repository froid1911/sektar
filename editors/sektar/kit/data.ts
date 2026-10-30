// Reading and writing Sektar's documents. Writes are imperative helpers
// around addDocument/dispatchActions so boards, panels and editors share one
// vocabulary. Lists, counts and pickers do not read documents:
// they come from the finance index (kit/finance-index.ts); the write store
// is read only for the one document that is open.
import { findDrive } from "../../../processors/drive-ids/index.js";
import {
  addDocument,
  addFolder,
  dispatchActions,
  getPHStore,
  loadDriveNodes,
  openTarget,
  useDrives,
} from "@powerhousedao/reactor-browser";
import type {
  DocumentDriveDocument,
  FileNode,
  FolderNode,
  Node,
} from "@powerhousedao/shared/document-drive";
import { generateId, type Action } from "document-model";
import {
  actions as bankActions,
  type AccountKind,
  type BankAccountDocument,
  type MatchKind,
  type TransactionCategory,
} from "document-models/bank-account";
import {
  actions as contactActions,
  type ContactDocument,
  type ContactKind,
} from "document-models/contact";
import {
  actions as expenseActions,
  type PaidWith,
} from "document-models/expense-report";
import {
  actions as invoiceActions,
  type InvoiceDirection,
  type InvoiceDocument,
  type InvoiceParty,
  type InvoiceState,
  type PaymentMethod,
  type SetBuyerInput,
  type SetSellerInput,
  type VatCategory,
} from "document-models/invoice";

/** The business drive, declared in the host files. */
export const SEKTAR_DRIVE_SLUG = "sektar";

export const DOC_TYPES = {
  account: "sektar/bank-account",
  invoice: "sektar/invoice",
  expense: "sektar/expense-report",
  contact: "sektar/contact",
} as const;

export const FOLDERS = {
  accounts: "Bank & cards",
  invoices: "Invoices",
  expenses: "Expenses",
  contacts: "Contacts",
} as const;

const now = () => new Date().toISOString();

/* ------------------------------------------------------------- reading */

// The whole-collection hooks that lived here (useAccounts, useInvoices,
// useExpenseReports, useContacts, useTransactions) loaded every document of
// a type through the write store. They are gone: use the finance index
// (kit/finance-index.ts) — useAccountRows, useInvoiceList,
// useTransactionList, useExpenseList, useContactList, useContactOptions,
// useInvoiceNumbers, useFinanceCounts — and `use<Type>DocumentById` for the
// one document that is open.

export function useSektarDrive(): DocumentDriveDocument | undefined {
  const drives = useDrives();
  // The converted drive where this store has it, else the one under the slug
  return findDrive(drives, SEKTAR_DRIVE_SLUG);
}

/** Opens the Integrations drive: where a page sends someone with nothing connected. */
export function useOpenIntegrations(): () => void {
  const drives = useDrives();
  return () =>
    openTarget({
      // The converted drive where this store has it, else the one under the slug
      driveSlug: findDrive(drives, "integrations")?.header.id ?? "integrations",
    });
}

/**
 * A drive's nodes as a list, for either drive type: a node list read
 * through `read.drives` (`useDriveNodes`, `loadDriveNodes`) as is, a legacy
 * drive document's own node array otherwise. A reactor-drive's document
 * holds no nodes, so passing one yields none: read its nodes instead.
 */
function nodesOf(
  source: readonly Node[] | DocumentDriveDocument | undefined,
): readonly Node[] {
  if (!source) return [];
  if (isNodeList(source)) return source;
  const state = source.state.global as { nodes?: readonly Node[] };
  return state.nodes ?? [];
}

function isNodeList(
  source: readonly Node[] | DocumentDriveDocument,
): source is readonly Node[] {
  return Array.isArray(source);
}

/** The ids of the files of a document type among a drive's nodes. */
export function fileIds(
  nodes: readonly Node[] | undefined,
  type: string,
): string[] {
  return nodesOf(nodes)
    .filter((n): n is FileNode => n.kind === "file")
    .filter((n) => n.documentType === type)
    .map((n) => n.id);
}

export function accountBalance(account: BankAccountDocument): number {
  const s = account.state.global;
  return s.transactions
    .filter((t) => t.status !== "EXCLUDED" && t.status !== "PENDING")
    .reduce((sum, t) => sum + t.amount, s.openingBalance);
}

/**
 * The root folder of that name among a drive's nodes. Pass the nodes
 * (`useDriveNodes(driveId)` or `await loadDriveNodes(driveId)`); a legacy
 * drive document is still accepted for the callers that pass one.
 */
export function folderNode(
  nodes: readonly Node[] | DocumentDriveDocument | undefined,
  name: string,
): FolderNode | undefined {
  return nodesOf(nodes).find(
    (n): n is FolderNode =>
      n.kind === "folder" && n.name === name && !n.parentFolder,
  );
}

/** The file node of a document among a drive's nodes. */
export function fileNodeOf(
  nodes: readonly Node[] | undefined,
  documentId: string,
): FileNode | undefined {
  return nodesOf(nodes).find(
    (n): n is FileNode => n.kind === "file" && n.id === documentId,
  );
}

/** Folders created this session, so a batch of writes against one (stale)
 * drive snapshot — a multi-document import, say — reuses the folder it just
 * made instead of adding "(copy) n" siblings. */
const createdFolders = new Map<string, string>();

/**
 * The id of the drive's root folder of that name, made when missing. The
 * drive's nodes are read through `read.drives` unless given, so this works
 * on a legacy drive and on a reactor-drive alike.
 */
export async function ensureFolder(
  drive: DocumentDriveDocument,
  name: string,
  nodes?: readonly Node[],
): Promise<string> {
  const driveId = drive.header.id;
  const key = `${driveId}:${name}`;
  const cached = createdFolders.get(key);
  if (cached) return cached;
  let known = nodes;
  if (!known) {
    try {
      known = await loadDriveNodes(driveId);
    } catch {
      // no listing: the folder is made, as it would be in an empty drive
      known = [];
    }
  }
  const existing = folderNode(known, name);
  if (existing) {
    createdFolders.set(key, existing.id);
    return existing.id;
  }
  const created = await addFolder(driveId, name);
  createdFolders.set(key, created.id);
  return created.id;
}

/* -------------------------------------------------------------- writing */

/**
 * The connected user as the signer of an action, as `dispatchActions` adds
 * it (reactor-browser's addActionContext, which it does not export).
 */
function withSigner(action: Action): Action {
  const renown = getPHStore()?.renown;
  if (!renown?.user) return action;
  return {
    context: {
      signer: {
        app: { name: "Connect", key: renown.did },
        user: {
          address: renown.user.address,
          networkId: renown.user.networkId,
          chainId: renown.user.chainId,
        },
        signatures: [],
      },
    },
    ...action,
  };
}

/**
 * Writes actions to a document by id without loading it first: what
 * `dispatchActions(actions, id)` does, minus the read of the whole document
 * it makes to start (for a bank account, every transaction ever imported).
 * Resolves once the operations are in the log.
 */
export async function dispatchById(
  documentId: string,
  actions: Action | Action[],
): Promise<void> {
  const client = getPHStore()?.reactorClient;
  if (!client) throw new Error("ReactorClient not initialized");
  const list = (Array.isArray(actions) ? actions : [actions]).map(withSigner);
  const handle = await client.write.execute(documentId, "main", list);
  await handle.written;
}

/* ------------------------------------------------------------- accounts */

export type NewAccount = {
  name: string;
  institution?: string;
  iban?: string;
  kind: AccountKind;
  currency?: string;
  openingBalance?: number;
};

export async function createAccount(
  drive: DocumentDriveDocument,
  input: NewAccount,
): Promise<string> {
  const folder = await ensureFolder(drive, FOLDERS.accounts);
  const node = await addDocument(
    drive.header.id,
    input.name,
    DOC_TYPES.account,
    folder,
  );
  await dispatchActions(
    bankActions.setAccountDetails({
      name: input.name,
      institution: input.institution ?? null,
      iban: input.iban ?? null,
      kind: input.kind,
      currency: input.currency ?? "EUR",
      openingBalance: input.openingBalance ?? 0,
    }),
    node.id,
  );
  return node.id;
}

export type ImportedTransaction = {
  bookedAt: string;
  amount: number;
  counterparty: string;
  description?: string;
  reference?: string;
};

export function importTransactions(
  accountId: string,
  rows: ImportedTransaction[],
  importedAt = now(),
) {
  return dispatchActions(
    bankActions.importTransactions({
      batchId: generateId(),
      importedAt,
      transactions: rows.map((r) => ({
        id: generateId(),
        bookedAt: r.bookedAt,
        amount: r.amount,
        counterparty: r.counterparty,
        description: r.description ?? null,
        reference: r.reference ?? null,
      })),
    }),
    accountId,
  );
}

// A transaction's bookkeeping writes go to its account by id without
// loading the account: the document holds every transaction ever imported.

export function categorizeTransaction(
  accountId: string,
  id: string,
  category: TransactionCategory,
  contactId?: string | null,
) {
  return dispatchById(
    accountId,
    bankActions.categorizeTransaction({
      id,
      category,
      contactId: contactId === undefined ? undefined : contactId,
    }),
  );
}

export function matchTransaction(
  accountId: string,
  id: string,
  documentId: string,
  kind: MatchKind,
) {
  return dispatchById(
    accountId,
    bankActions.matchTransaction({ id, documentId, kind }),
  );
}

export function unmatchTransaction(accountId: string, id: string) {
  return dispatchById(accountId, bankActions.unmatchTransaction({ id }));
}

export function excludeTransaction(
  accountId: string,
  id: string,
  excluded: boolean,
) {
  return dispatchById(
    accountId,
    bankActions.excludeTransaction({ id, excluded }),
  );
}

/* ------------------------------------------------------------- invoices */

export type NewInvoiceLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  /** Defaults to standard-rated above 0 %, zero-rated at 0 %. */
  vatCategory?: VatCategory;
};

export type NewInvoice = {
  direction: InvoiceDirection;
  /** The other party: the buyer of a sales invoice, the seller of a bill. */
  party: SetBuyerInput;
  /** Our own details; defaults to the ones on the latest invoice in the same direction. */
  us?: SetSellerInput;
  currency?: string;
  subject?: string | null;
  reference?: string | null;
  notes?: string | null;
  dueAt?: string | null;
  number?: string | null;
  lines: NewInvoiceLine[];
};

export function invoiceDocumentName(inv: { number?: string | null; party: { name?: string | null } }): string {
  const who = inv.party.name || "Untitled";
  return inv.number ? `${inv.number} · ${who}` : `Draft · ${who}`;
}

/** A contact as an invoice party: the fields an invoice copies. */
export function partyFromContact(c: ContactDocument): SetBuyerInput {
  const s = c.state.global;
  return {
    name: s.name,
    contactId: c.header.id,
    email: s.email,
    phone: s.phone,
    vatId: s.vatId,
    registrationId: s.registrationNumber,
    street: s.address.street,
    postalCode: s.address.postalCode,
    city: s.address.city,
    country: s.address.country,
  };
}

/** Our side of an invoice (the seller of a sales invoice, the buyer of a bill). */
export function ourParty(state: InvoiceState): InvoiceParty {
  return state.direction === "OUTGOING" ? state.seller : state.buyer;
}

// Our details for a new invoice (the latest invoice's, there being no
// company profile yet) come from the finance index: `useLatestOurParty`.

export function newLineAction(line: NewInvoiceLine) {
  return invoiceActions.addLine({
    id: generateId(),
    ...line,
    vatCategory: line.vatCategory ?? (line.vatRate > 0 ? "STANDARD" : "ZERO_RATED"),
  });
}

export async function createInvoice(
  drive: DocumentDriveDocument,
  input: NewInvoice,
): Promise<string> {
  const folder = await ensureFolder(drive, FOLDERS.invoices);
  const node = await addDocument(
    drive.header.id,
    invoiceDocumentName(input),
    DOC_TYPES.invoice,
    folder,
  );
  const outgoing = input.direction === "OUTGOING";
  await dispatchActions(
    [
      invoiceActions.setHeader({
        direction: input.direction,
        subject: input.subject ?? null,
        buyerReference: input.reference ?? null,
        notes: input.notes ?? null,
        dueAt: input.dueAt ?? null,
      }),
      ...(input.currency && input.currency !== "EUR"
        ? [invoiceActions.setCurrency({ currency: input.currency })]
        : []),
      outgoing
        ? invoiceActions.setBuyer(input.party)
        : invoiceActions.setSeller(input.party),
      ...(input.us
        ? [outgoing ? invoiceActions.setSeller(input.us) : invoiceActions.setBuyer(input.us)]
        : []),
      ...input.lines.map(newLineAction),
    ],
    node.id,
  );
  return node.id;
}

/**
 * A new draft from an existing invoice: parties, currency and rates, lines,
 * VAT mentions and payment instructions carry over; numbers, dates,
 * payments and documents do not. As a credit note it references the source.
 */
export async function duplicateInvoice(
  driveId: string,
  parentFolder: string | null | undefined,
  source: InvoiceDocument,
  opts: { credit?: boolean } = {},
) {
  const s = source.state.global;
  const other = s.direction === "OUTGOING" ? s.buyer : s.seller;
  const name = invoiceDocumentName({ number: null, party: other }).replace(
    "Draft",
    opts.credit ? "Credit note" : "Draft",
  );
  const node = await addDocument(driveId, name, DOC_TYPES.invoice, parentFolder ?? undefined);
  await dispatchActions(
    [
      invoiceActions.setHeader({
        kind: opts.credit ? "CREDIT_NOTE" : s.kind,
        direction: s.direction,
        subject: s.subject,
        paymentTerms: s.paymentTerms,
        notes: s.notes,
        buyerReference: s.references.buyerReference,
        orderReference: s.references.orderReference,
        contractReference: s.references.contractReference,
        projectReference: s.references.projectReference,
      }),
      invoiceActions.setSeller({ ...s.seller }),
      invoiceActions.setBuyer({ ...s.buyer }),
      invoiceActions.setCurrency({ currency: s.currency, vatCurrency: s.vatCurrency }),
      ...s.exchangeRates.map((r) => invoiceActions.setExchangeRate({ ...r })),
      ...s.lines.map((l) =>
        invoiceActions.addLine({
          id: generateId(),
          description: l.description,
          note: l.note,
          quantity: l.quantity,
          unitCode: l.unitCode,
          unitPrice: l.unitPrice,
          vatCategory: l.vatCategory,
          vatRate: l.vatRate,
          category: l.category,
          originalAmount: l.original?.amount,
          originalCurrency: l.original?.currency,
          originalRate: l.original?.rate,
          // A credit note corrects the same costs; a copy bills new ones.
          originalReference: opts.credit ? l.original?.reference : null,
        }),
      ),
      ...s.vatReasons.map((r) => invoiceActions.setVatReason({ ...r })),
      invoiceActions.setPaymentInstructions({ ...s.paymentInstructions, remittance: null }),
      ...(opts.credit && s.number
        ? [
            invoiceActions.addPrecedingInvoice({
              id: generateId(),
              number: s.number,
              issuedAt: s.issuedAt,
              documentId: source.header.id,
            }),
          ]
        : []),
    ],
    node.id,
  );
  return node;
}

export function issueInvoice(
  invoiceId: string,
  number: string,
  dueAt: string,
  issuedAt = now(),
) {
  return dispatchActions(
    invoiceActions.issueInvoice({ number, issuedAt, dueAt }),
    invoiceId,
  );
}

export function recordPayment(
  invoiceId: string,
  amount: number,
  method: PaymentMethod,
  opts: { paidAt?: string; transactionId?: string | null } = {},
) {
  return dispatchActions(
    invoiceActions.recordPayment({
      id: generateId(),
      paidAt: opts.paidAt ?? now(),
      amount,
      method,
      transactionId: opts.transactionId ?? null,
    }),
    invoiceId,
  );
}

export function voidInvoice(invoiceId: string, reason: string) {
  return dispatchActions(invoiceActions.voidInvoice({ reason }), invoiceId);
}

// The next number for an invoice comes from the finance index:
// `useNextInvoiceNumber` (the issue dialog's rule, over every number used).

/* ------------------------------------------------------------- expenses */

export type NewExpenseItem = {
  spentAt: string;
  merchant: string;
  category: TransactionCategory;
  amount: number;
  vatAmount?: number;
  paidWith: PaidWith;
  receiptName?: string | null;
  note?: string | null;
  contactId?: string | null;
};

export type NewExpenseReport = {
  title: string;
  submitterName: string;
  submitterEmail?: string | null;
  currency?: string;
  items: NewExpenseItem[];
};

export async function createExpenseReport(
  drive: DocumentDriveDocument,
  input: NewExpenseReport,
): Promise<string> {
  const folder = await ensureFolder(drive, FOLDERS.expenses);
  const node = await addDocument(
    drive.header.id,
    input.title,
    DOC_TYPES.expense,
    folder,
  );
  await dispatchActions(
    [
      expenseActions.setReportDetails({
        title: input.title,
        submitterName: input.submitterName,
        submitterEmail: input.submitterEmail ?? null,
        currency: input.currency ?? "EUR",
      }),
      ...input.items.map((item) =>
        expenseActions.addItem({
          id: generateId(),
          ...item,
          vatAmount: item.vatAmount ?? 0,
        }),
      ),
    ],
    node.id,
  );
  return node.id;
}

export function addExpenseItem(reportId: string, item: NewExpenseItem) {
  return dispatchActions(
    expenseActions.addItem({
      id: generateId(),
      ...item,
      vatAmount: item.vatAmount ?? 0,
    }),
    reportId,
  );
}

export function updateExpenseItem(
  reportId: string,
  id: string,
  item: Partial<NewExpenseItem>,
) {
  return dispatchActions(expenseActions.updateItem({ id, ...item }), reportId);
}

export function removeExpenseItem(reportId: string, id: string) {
  return dispatchActions(expenseActions.removeItem({ id }), reportId);
}

export function setReportDetails(
  reportId: string,
  details: Partial<Omit<NewExpenseReport, "items">>,
) {
  return dispatchActions(expenseActions.setReportDetails(details), reportId);
}

export function submitReport(reportId: string, submittedAt = now()) {
  return dispatchActions(
    expenseActions.submitReport({ submittedAt }),
    reportId,
  );
}

export function approveReport(
  reportId: string,
  decidedBy: string,
  note?: string | null,
  decidedAt = now(),
) {
  return dispatchActions(
    expenseActions.approveReport({ decidedAt, decidedBy, note: note ?? null }),
    reportId,
  );
}

export function rejectReport(
  reportId: string,
  decidedBy: string,
  note: string,
  decidedAt = now(),
) {
  return dispatchActions(
    expenseActions.rejectReport({ decidedAt, decidedBy, note }),
    reportId,
  );
}

export function reimburseReport(
  reportId: string,
  transactionId?: string | null,
  reimbursedAt = now(),
) {
  return dispatchActions(
    expenseActions.reimburseReport({
      reimbursedAt,
      transactionId: transactionId ?? null,
    }),
    reportId,
  );
}

/* ------------------------------------------------------------- contacts */

export type NewContact = {
  name: string;
  kind: ContactKind;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  vatId?: string | null;
  registrationNumber?: string | null;
  notes?: string | null;
  address?: {
    street?: string;
    postalCode?: string;
    city?: string;
    country?: string;
  };
  bank?: { iban?: string; bic?: string; accountHolder?: string };
  paymentTermsDays?: number;
  defaultCategory?: TransactionCategory;
  tags?: string[];
  people?: { name: string; role?: string; email?: string; phone?: string }[];
};

export async function createContact(
  drive: DocumentDriveDocument,
  input: NewContact,
): Promise<string> {
  const folder = await ensureFolder(drive, FOLDERS.contacts);
  const node = await addDocument(
    drive.header.id,
    input.name,
    DOC_TYPES.contact,
    folder,
  );
  await dispatchActions(
    [
      contactActions.setProfile({
        name: input.name,
        kind: input.kind,
        email: input.email ?? null,
        phone: input.phone ?? null,
        website: input.website ?? null,
        vatId: input.vatId ?? null,
        registrationNumber: input.registrationNumber ?? null,
        notes: input.notes ?? null,
      }),
      ...(input.address ? [contactActions.setAddress(input.address)] : []),
      ...(input.bank ? [contactActions.setBankDetails(input.bank)] : []),
      contactActions.setPaymentTerms({
        paymentTermsDays: input.paymentTermsDays ?? 30,
        defaultCategory: input.defaultCategory ?? null,
      }),
      ...(input.tags ?? []).map((tag) => contactActions.addTag({ tag })),
      ...(input.people ?? []).map((p) =>
        contactActions.addPerson({ id: generateId(), ...p }),
      ),
    ],
    node.id,
  );
  return node.id;
}

export function setContactProfile(
  contactId: string,
  profile: Partial<
    Pick<
      NewContact,
      | "name"
      | "kind"
      | "email"
      | "phone"
      | "website"
      | "vatId"
      | "registrationNumber"
      | "notes"
    >
  >,
) {
  return dispatchActions(contactActions.setProfile(profile), contactId);
}

export function setContactAddress(
  contactId: string,
  address: NonNullable<NewContact["address"]>,
) {
  return dispatchActions(contactActions.setAddress(address), contactId);
}

export function setContactBank(
  contactId: string,
  bank: NonNullable<NewContact["bank"]>,
) {
  return dispatchActions(contactActions.setBankDetails(bank), contactId);
}

export function setContactTerms(
  contactId: string,
  paymentTermsDays: number,
  defaultCategory?: TransactionCategory,
) {
  return dispatchActions(
    contactActions.setPaymentTerms({
      paymentTermsDays,
      defaultCategory: defaultCategory ?? null,
    }),
    contactId,
  );
}

export function addContactTag(contactId: string, tag: string) {
  return dispatchActions(contactActions.addTag({ tag }), contactId);
}

export function removeContactTag(contactId: string, tag: string) {
  return dispatchActions(contactActions.removeTag({ tag }), contactId);
}

export function addContactPerson(
  contactId: string,
  person: { name: string; role?: string; email?: string; phone?: string },
) {
  return dispatchActions(
    contactActions.addPerson({ id: generateId(), ...person }),
    contactId,
  );
}

export function removeContactPerson(contactId: string, id: string) {
  return dispatchActions(contactActions.removePerson({ id }), contactId);
}

export function archiveContact(contactId: string, archived: boolean) {
  return dispatchActions(
    contactActions.archiveContact({ archived }),
    contactId,
  );
}

export { generateId };
