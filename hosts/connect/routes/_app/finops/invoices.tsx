import { createFileRoute } from "@tanstack/react-router";
import type { InvoiceDirection } from "document-models/invoice";
import { useState } from "react";
import { InvoicesWorkspace } from "../../../../../editors/sektar/components/invoice/InvoicesWorkspace.js";
import { useSektarDrive } from "../../../../../editors/sektar/kit/data.js";
import { useInvoiceList, type InvoiceView } from "../../../../../editors/sektar/kit/finance-index.js";
import { useNow } from "../../../../../editors/sektar/kit/format.js";
import { Connecting } from "../../-shared/connecting.js";
import { NewInvoicePanel } from "../../-shared/forms.js";
import { useSearch } from "../../-shared/search.js";

export const Route = createFileRoute("/_app/finops/invoices")({
  validateSearch: (raw: Record<string, unknown>): { open?: string } => ({
    ...(typeof raw.open === "string" ? { open: raw.open } : {}),
  }),
  head: () => ({ meta: [{ title: "Invoices · Sektar" }] }),
  component: InvoicesPage,
});

function InvoicesPage() {
  const drive = useSektarDrive();
  const now = useNow();
  const { query } = useSearch();
  const { open: openParam } = Route.useSearch();
  const [created, setCreated] = useState<string | null>(null);
  const [creating, setCreating] = useState<InvoiceDirection | null>(null);
  // Which side and which status the list shows: the list is asked for exactly that.
  const [direction, setDirection] = useState<InvoiceDirection>("OUTGOING");
  const [view, setView] = useState<InvoiceView>("all");
  const list = useInvoiceList({ direction, view, query, now });

  if (!drive) return <Connecting />;

  return (
    <>
      <InvoicesWorkspace
        list={list}
        direction={direction}
        onDirection={setDirection}
        view={view}
        onView={setView}
        now={now}
        query={query}
        open={created ?? openParam ?? null}
        onNew={setCreating}
      />
      {creating && (
        <NewInvoicePanel
          drive={drive}
          direction={creating}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            setCreated(id);
          }}
        />
      )}
    </>
  );
}
