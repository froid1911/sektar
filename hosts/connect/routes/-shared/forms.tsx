// Creation flows, each a side panel: a new invoice or bill, a new expense
// claim, a new contact, and a bank-feed import (paste CSV). They create the
// document through kit/data and hand the new id back to the page.
import type { DocumentDriveDocument } from "@powerhousedao/shared/document-drive";
import type { TransactionCategory } from "document-models/bank-account";
import type { ContactKind } from "document-models/contact";
import type { PaidWith } from "document-models/expense-report";
import type { InvoiceDirection } from "document-models/invoice";
import { useState } from "react";
import {
  createAccount,
  createContact,
  createExpenseReport,
  createInvoice,
  importTransactions,
  type ImportedTransaction,
  type NewExpenseItem,
  type NewInvoiceLine,
} from "../../../../editors/sektar/kit/data.js";
import {
  partyFromContactRow,
  useAccountRows,
  useContactOptions,
  useLatestOurParty,
} from "../../../../editors/sektar/kit/finance-index.js";
import {
  CATEGORY,
  CATEGORY_ORDER,
  CONTACT_KIND,
  fromDateInput,
  money,
  PAID_WITH,
  toDateInput,
} from "../../../../editors/sektar/kit/format.js";
import { useUserName } from "../../../../editors/sektar/kit/user-name.js";
import {
  Button,
  Field,
  Input,
  Segmented,
  Select,
  SidePanel,
  Textarea,
} from "../../../../editors/sektar/kit/ui.js";

/* ------------------------------------------------------------- invoice */

export function NewInvoicePanel({
  drive,
  direction: initial,
  onClose,
  onCreated,
}: {
  drive: DocumentDriveDocument;
  direction: InvoiceDirection;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  // The pickers read the finance index: the active contacts, and our details
  // as the latest invoice in the direction has them.
  const contacts = useContactOptions(drive);
  const [direction, setDirection] = useState<InvoiceDirection>(initial);
  const us = useLatestOurParty(direction, drive);
  const [contactId, setContactId] = useState("");
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<NewInvoiceLine[]>([
    { description: "", quantity: 1, unitPrice: 0, vatRate: 21 },
  ]);
  const [busy, setBusy] = useState(false);
  const contact = contacts.find((c) => c.id === contactId);
  const partyName = contact?.name ?? name;
  const valid =
    partyName.trim() &&
    lines.some((l) => l.description.trim() && l.quantity > 0);
  const total = lines.reduce(
    (s, l) => s + l.quantity * l.unitPrice * (1 + l.vatRate / 100),
    0,
  );
  const pool = contacts.filter((c) =>
    direction === "OUTGOING" ? c.kind !== "SUPPLIER" : c.kind !== "CUSTOMER",
  );

  const submit = () => {
    if (!valid) return;
    setBusy(true);
    void createInvoice(drive, {
      direction,
      party: contact ? partyFromContactRow(contact) : { name: partyName.trim() },
      us: us ?? undefined,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
      lines: lines
        .filter((l) => l.description.trim() && l.quantity > 0)
        .map((l) => ({ ...l, description: l.description.trim() })),
    })
      .then(onCreated)
      .finally(() => setBusy(false));
  };

  return (
    <SidePanel
      title={direction === "OUTGOING" ? "New invoice" : "New bill"}
      subtitle="Saved as a draft; issue it when the lines are final."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            Create draft · {money(total)}
          </Button>
        </>
      }
    >
      <Segmented
        value={direction}
        onChange={(d) => {
          setDirection(d);
          setContactId("");
        }}
        options={[
          { value: "OUTGOING", label: "Invoice a customer" },
          { value: "INCOMING", label: "Record a supplier bill" },
        ]}
      />
      <Field
        label={direction === "OUTGOING" ? "Customer" : "Supplier"}
        required
      >
        <Select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
        >
          <option value="">— pick a contact or type a name —</option>
          {pool.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {!contactId && (
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Company or person"
          />
        </Field>
      )}
      <Field
        label={
          direction === "OUTGOING"
            ? "Your reference / PO"
            : "Their invoice number"
        }
      >
        <Input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </Field>
      <div className="sk-stack sk-stack--2">
        <div className="sk-eyebrow">Lines</div>
        {lines.map((line, i) => (
          <div key={i} className="sk-row sk-row--2 sk-row--start">
            <Input
              className="sk-grow"
              value={line.description}
              placeholder="Description"
              onChange={(e) =>
                setLines(
                  lines.map((l, j) =>
                    j === i ? { ...l, description: e.target.value } : l,
                  ),
                )
              }
            />
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={line.quantity}
              style={{ width: 70 }}
              aria-label="Quantity"
              onChange={(e) =>
                setLines(
                  lines.map((l, j) =>
                    j === i ? { ...l, quantity: Number(e.target.value) } : l,
                  ),
                )
              }
            />
            <Input
              type="number"
              step="0.01"
              value={line.unitPrice || ""}
              placeholder="0.00"
              style={{ width: 100 }}
              aria-label="Unit price"
              onChange={(e) =>
                setLines(
                  lines.map((l, j) =>
                    j === i ? { ...l, unitPrice: Number(e.target.value) } : l,
                  ),
                )
              }
            />
            <Select
              value={line.vatRate}
              style={{ width: 80 }}
              aria-label="VAT"
              onChange={(e) =>
                setLines(
                  lines.map((l, j) =>
                    j === i ? { ...l, vatRate: Number(e.target.value) } : l,
                  ),
                )
              }
            >
              <option value={21}>21%</option>
              <option value={9}>9%</option>
              <option value={0}>0%</option>
            </Select>
            <Button
              variant="ghost"
              iconOnly
              icon="close"
              aria-label="Remove line"
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <div>
          <Button
            variant="soft"
            size="sm"
            icon="plus"
            onClick={() =>
              setLines([
                ...lines,
                { description: "", quantity: 1, unitPrice: 0, vatRate: 21 },
              ])
            }
          >
            Add line
          </Button>
        </div>
      </div>
      <Field label="Notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Shown on the document"
        />
      </Field>
    </SidePanel>
  );
}

/* ------------------------------------------------------------- expense */

export function NewExpensePanel({
  drive,
  onClose,
  onCreated,
}: {
  drive: DocumentDriveDocument;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const userName = useUserName();
  const [submitter, setSubmitter] = useState(userName);
  const [items, setItems] = useState<
    (Omit<NewExpenseItem, "spentAt"> & { date: string })[]
  >([
    {
      date: toDateInput(new Date().toISOString()),
      merchant: "",
      category: "TRAVEL",
      amount: 0,
      paidWith: "PERSONAL",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const valid =
    title.trim() &&
    submitter.trim() &&
    items.some((i) => i.merchant.trim() && i.amount > 0);
  const total = items.reduce((s, i) => s + (i.amount || 0), 0);
  const update = (i: number, patch: Partial<(typeof items)[number]>) =>
    setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <SidePanel
      title="New expense claim"
      subtitle="Group receipts into one claim for approval."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            onClick={() => {
              setBusy(true);
              void createExpenseReport(drive, {
                title: title.trim(),
                submitterName: submitter.trim(),
                items: items
                  .filter((i) => i.merchant.trim() && i.amount > 0)
                  .map(({ date, ...i }) => ({
                    ...i,
                    merchant: i.merchant.trim(),
                    spentAt: fromDateInput(date),
                    vatAmount:
                      Math.round(((i.amount * 0.21) / 1.21) * 100) / 100,
                  })),
              })
                .then(onCreated)
                .finally(() => setBusy(false));
            }}
          >
            Create claim · {money(total)}
          </Button>
        </>
      }
    >
      <Field label="Title" required>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Berlin client trip"
          autoFocus
        />
      </Field>
      <Field label="Submitted by" required>
        <Input
          value={submitter}
          onChange={(e) => setSubmitter(e.target.value)}
          placeholder="Your name"
        />
      </Field>
      <div className="sk-stack sk-stack--3">
        <div className="sk-eyebrow">Receipts</div>
        {items.map((it, i) => (
          <div
            key={i}
            className="sk-card sk-card--subtle sk-card--compact sk-stack sk-stack--2"
          >
            <div className="sk-row sk-row--2">
              <Input
                type="date"
                value={it.date}
                style={{ width: 150 }}
                onChange={(e) => update(i, { date: e.target.value })}
              />
              <Input
                className="sk-grow"
                value={it.merchant}
                placeholder="Merchant"
                onChange={(e) => update(i, { merchant: e.target.value })}
              />
              <Button
                variant="ghost"
                iconOnly
                icon="close"
                aria-label="Remove"
                disabled={items.length === 1}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              />
            </div>
            <div className="sk-row sk-row--2">
              <Select
                value={it.category}
                onChange={(e) =>
                  update(i, { category: e.target.value as TransactionCategory })
                }
              >
                {CATEGORY_ORDER.filter(
                  (c) =>
                    ![
                      "UNCATEGORIZED",
                      "SALES",
                      "TRANSFER",
                      "PAYROLL",
                      "TAX",
                      "RENT",
                      "BANK_FEES",
                    ].includes(c),
                ).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY[c].label}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                step="0.01"
                value={it.amount || ""}
                placeholder="0.00"
                style={{ width: 110 }}
                aria-label="Amount"
                onChange={(e) => update(i, { amount: Number(e.target.value) })}
              />
              <Select
                value={it.paidWith}
                onChange={(e) =>
                  update(i, { paidWith: e.target.value as PaidWith })
                }
              >
                {(Object.keys(PAID_WITH) as PaidWith[]).map((p) => (
                  <option key={p} value={p}>
                    {PAID_WITH[p]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ))}
        <div>
          <Button
            variant="soft"
            size="sm"
            icon="plus"
            onClick={() =>
              setItems([
                ...items,
                {
                  date: toDateInput(new Date().toISOString()),
                  merchant: "",
                  category: "TRAVEL",
                  amount: 0,
                  paidWith: "PERSONAL",
                },
              ])
            }
          >
            Add receipt
          </Button>
        </div>
      </div>
    </SidePanel>
  );
}

/* ------------------------------------------------------------- contact */

export function NewContactPanel({
  drive,
  onClose,
  onCreated,
}: {
  drive: DocumentDriveDocument;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ContactKind>("CUSTOMER");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("Netherlands");
  const [terms, setTerms] = useState("30");
  const [category, setCategory] = useState<TransactionCategory>("SALES");
  const [busy, setBusy] = useState(false);
  return (
    <SidePanel
      title="New contact"
      subtitle="A customer, a supplier, or both."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || busy}
            onClick={() => {
              setBusy(true);
              void createContact(drive, {
                name: name.trim(),
                kind,
                email: email.trim() || null,
                address:
                  city.trim() || country.trim()
                    ? { city: city.trim(), country: country.trim() }
                    : undefined,
                paymentTermsDays: Math.max(0, Number(terms) || 0),
                defaultCategory: category,
              })
                .then(onCreated)
                .finally(() => setBusy(false));
            }}
          >
            Create contact
          </Button>
        </>
      }
    >
      <Field label="Name" required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Company or person"
          autoFocus
        />
      </Field>
      <Field label="Relationship">
        <Select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as ContactKind;
            setKind(k);
            setCategory(k === "SUPPLIER" ? "SUPPLIES" : "SALES");
          }}
        >
          {(Object.keys(CONTACT_KIND) as ContactKind[]).map((k) => (
            <option key={k} value={k}>
              {CONTACT_KIND[k].label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Email">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <div className="sk-grid sk-grid--2">
        <Field label="City">
          <Input value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Country">
          <Input value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
        <Field label="Payment terms (days)">
          <Input
            type="number"
            min={0}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </Field>
        <Field label="Default category">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as TransactionCategory)}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY[c].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </SidePanel>
  );
}

/* ------------------------------------------------------------- import */

function parseCsv(text: string): ImportedTransaction[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[;,]\s*|\t/).map((c) => c.trim());
      const [date = "", amount = "", ...rest] = parts;
      const counterparty = parts.length > 2 ? rest[0] : "";
      return {
        bookedAt: date,
        amount: Number(amount),
        counterparty,
        description: rest.slice(1).join(", ") || undefined,
      };
    })
    .filter(
      (r) =>
        !Number.isNaN(Date.parse(r.bookedAt)) &&
        Number.isFinite(r.amount) &&
        r.counterparty,
    )
    .map((r) => ({
      ...r,
      bookedAt: new Date(r.bookedAt).toISOString(),
      reference: `PASTE-${Date.parse(r.bookedAt)}-${Math.round(r.amount * 100)}`,
    }));
}

export function ImportPanel({
  drive,
  onClose,
  onImported,
}: {
  drive: DocumentDriveDocument;
  onClose: () => void;
  onImported: () => void;
}) {
  // The accounts from the finance index: an id and a name is all the picker needs.
  const accounts = useAccountRows(drive);
  // Until one is picked, the first account; "" is a new one.
  const [picked, setAccountId] = useState<string | null>(null);
  const accountId = picked ?? accounts[0]?.id ?? "";
  const [text, setText] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = parseCsv(text);
  return (
    <SidePanel
      title="Import transactions"
      subtitle="Paste lines as date, amount, counterparty, description."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              busy || rows.length === 0 || (!accountId && !newName.trim())
            }
            onClick={() => {
              setBusy(true);
              void (async () => {
                const id =
                  accountId ||
                  (await createAccount(drive, {
                    name: newName.trim(),
                    kind: "CURRENT",
                  }));
                await importTransactions(id, rows);
              })()
                .then(onImported)
                .finally(() => setBusy(false));
            }}
          >
            Import {rows.length} rows
          </Button>
        </>
      }
    >
      <Field label="Account">
        <Select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="">+ new account…</option>
        </Select>
      </Field>
      {!accountId && (
        <Field label="New account name">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Business current"
          />
        </Field>
      )}
      <Field
        label="Rows"
        hint={
          rows.length
            ? `${rows.length} parsed`
            : "e.g. 2026-10-14, -89.00, Notion Labs, Team plan"
        }
      >
        <Textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            "2026-10-14, -89.00, Notion Labs, Team plan\n2026-10-15, 2420.00, Client payment, Invoice 1042"
          }
        />
      </Field>
    </SidePanel>
  );
}

