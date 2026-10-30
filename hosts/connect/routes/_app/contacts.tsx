import { createFileRoute } from "@tanstack/react-router";
import { useContactDocumentById } from "document-models/contact";
import { useInvoiceDocumentById } from "document-models/invoice";
import { useEffect, useRef, useState } from "react";
import {
  ContactDetail,
  ContactKindBadge,
} from "../../../../editors/sektar/components/ContactDetail.js";
import {
  InvoiceDetail,
} from "../../../../editors/sektar/components/InvoiceDetail.js";
import { useSektarDrive } from "../../../../editors/sektar/kit/data.js";
import {
  contactKindOf,
  FINANCE_PAGE,
  useContactCounts,
  useContactList,
  type ContactRow,
  type ContactView,
} from "../../../../editors/sektar/kit/finance-index.js";
import { money, plural } from "../../../../editors/sektar/kit/format.js";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ListItem,
  PageHeader,
  Pills,
  SidePanel,
} from "../../../../editors/sektar/kit/ui.js";
import artDark from "../../../../editors/sektar/design/shapes/sektar-growth-four-column-combined-dark.svg";
import artLight from "../../../../editors/sektar/design/shapes/sektar-growth-four-column-combined-light.svg";
import { Connecting } from "../-shared/connecting.js";
import { NewContactPanel } from "../-shared/forms.js";
import { useSearch } from "../-shared/search.js";

export const Route = createFileRoute("/_app/contacts")({
  validateSearch: (raw: Record<string, unknown>): { open?: string } => ({
    ...(typeof raw.open === "string" ? { open: raw.open } : {}),
  }),
  head: () => ({ meta: [{ title: "Contacts · Sektar" }] }),
  component: ContactsPage,
});

type Filter = "ALL" | "CUSTOMERS" | "SUPPLIERS" | "ARCHIVED";

const VIEW: Record<Filter, ContactView> = {
  ALL: "all",
  CUSTOMERS: "customers",
  SUPPLIERS: "suppliers",
  ARCHIVED: "archived",
};

function ContactsPage() {
  const drive = useSektarDrive();
  const { query } = useSearch();
  const [filter, setFilter] = useState<Filter>("ALL");
  const { open: openParam } = Route.useSearch();
  const [selectedId, setSelectedId] = useState<string | null>(
    openParam ?? null,
  );
  useEffect(() => {
    if (openParam) setSelectedId(openParam);
  }, [openParam]);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The list, its filters' counts and each contact's open invoices and bank
  // activity come from the finance index; the contact and the invoice that
  // are open are the documents this page loads.
  const list = useContactList({ view: VIEW[filter], query }, drive);
  const indexCounts = useContactCounts(drive);
  const [selected] = useContactDocumentById(selectedId);
  const [openInvoice] = useInvoiceDocumentById(invoiceId);
  const counts: Record<Filter, number> = {
    ALL: indexCounts?.all ?? 0,
    CUSTOMERS: indexCounts?.customers ?? 0,
    SUPPLIERS: indexCounts?.suppliers ?? 0,
    ARCHIVED: indexCounts?.archived ?? 0,
  };

  // The list grows a page at a time as its end scrolls into view.
  const filterKey = JSON.stringify([filter, query]);
  const [shown, setShown] = useState({ key: filterKey, count: FINANCE_PAGE });
  const shownCount = shown.key === filterKey ? shown.count : FINANCE_PAGE;
  const rowCount = Math.min(list.total, shownCount);
  const { ensure } = list;
  useEffect(() => {
    if (rowCount > 0) ensure(0, rowCount);
  }, [ensure, rowCount, list.version]);
  const sentinel = useRef<HTMLLIElement>(null);
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
  const rows: (ContactRow | undefined)[] = Array.from(
    { length: rowCount },
    (_, i) => list.rowAt(i),
  );

  if (!drive) return <Connecting />;

  // Nobody at all yet, rather than nobody under this filter or search.
  const none =
    indexCounts?.all === 0 && indexCounts.archived === 0 && !query && !list.error;

  return (
    <div className="sk-page sk-stack sk-stack--6">
      <PageHeader
        eyebrow="Customers & suppliers"
        title="Contacts"
        lead="Everyone you invoice and everyone who invoices you."
        art={{ light: artLight, dark: artDark }}
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setCreating(true)}
          >
            New contact
          </Button>
        }
      />

      <Pills
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "ALL", label: "All", count: counts.ALL },
          { value: "CUSTOMERS", label: "Customers", count: counts.CUSTOMERS },
          { value: "SUPPLIERS", label: "Suppliers", count: counts.SUPPLIERS },
          { value: "ARCHIVED", label: "Archived", count: counts.ARCHIVED },
        ]}
      />

      {!list.loaded ? (
        <div className="sk-small sk-text-muted">Loading contacts…</div>
      ) : list.total === 0 && !list.stale ? (
        <EmptyState
          icon="customers"
          title={none ? "No contacts yet" : "No contacts here"}
        >
          {list.error
            ? `The contacts could not be loaded: ${list.error}`
            : query
              ? `Nothing matches “${query}”.`
              : "Add a customer or supplier to get going."}
        </EmptyState>
      ) : (
        <Card compact className="sk-p-0">
          <ul
            className="sk-list sk-list--rich"
            style={{ opacity: list.stale ? 0.6 : 1 }}
          >
            {rows.map((c, i) =>
              c ? (
                <li key={c.id}>
                  <ContactListItem
                    row={c}
                    selected={selectedId === c.id}
                    onClick={() => setSelectedId(c.id)}
                  />
                </li>
              ) : (
                <li key={`pending-${i}`} aria-hidden>
                  &nbsp;
                </li>
              ),
            )}
            {rowCount < list.total && (
              <li ref={sentinel} className="sk-small sk-text-muted">
                Loading more…
              </li>
            )}
          </ul>
        </Card>
      )}

      {selected && (
        <SidePanel eyebrow="Contact" onClose={() => setSelectedId(null)}>
          <ContactDetail
            doc={selected}
            onOpenInvoice={(id) => setInvoiceId(id)}
          />
        </SidePanel>
      )}
      {openInvoice && (
        <SidePanel
          eyebrow={
            openInvoice.state.global.direction === "OUTGOING"
              ? "Sales invoice"
              : "Purchase bill"
          }
          onClose={() => setInvoiceId(null)}
        >
          <InvoiceDetail doc={openInvoice} />
        </SidePanel>
      )}
      {creating && (
        <NewContactPanel
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

function ContactListItem({
  row: c,
  selected,
  onClick,
}: {
  row: ContactRow;
  selected: boolean;
  onClick: () => void;
}) {
  const kind = contactKindOf(c.kind);
  return (
    <ListItem
      rich
      selected={selected}
      onClick={onClick}
      icon={
        <Avatar name={c.name} variant={kind === "CUSTOMER" ? "sage" : "forest"} />
      }
      title={c.name}
      sub={[
        [c.city, c.country].filter(Boolean).join(", ") || c.email,
        `${
          c.paymentTermsDays === 0
            ? "On receipt"
            : `${c.paymentTermsDays}-day terms`
        } · ${plural(c.transactionCount, "transaction")}`,
      ].filter(Boolean)}
      tags={
        c.tags.length > 0
          ? c.tags.map((t) => (
              <Badge key={t} tone="outline">
                {t}
              </Badge>
            ))
          : undefined
      }
      aside={
        <>
          <ContactKindBadge kind={kind} />
          {c.openInvoiceCount > 0 ? (
            <span className="sk-small sk-weight-medium sk-tabular sk-text">
              {money(c.openBookOutstanding)} open
            </span>
          ) : (
            <span>Settled</span>
          )}
        </>
      }
      chevron
    />
  );
}
