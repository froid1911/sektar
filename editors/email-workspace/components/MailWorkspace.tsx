// The Mail workspace: the design system's panes pattern. Four panes — the
// inbox chooser (a level-0 parent, visible only when stacked), the message
// list, the message, the attachment preview — side by side on a wide
// screen and one at a time under 640px of container width, as a push
// navigation. The top bar's search filters the list; the inbox selector is
// a second top-bar row wide, and the list's title is the switch to the
// chooser when stacked.
//
// The list is rows from the mailbox index (kit/mail-index.ts), sized to the
// whole mailbox from the first frame and fetched page by page where the
// reader scrolls or drags, windowed so only a screenful is in the DOM; the
// document itself is loaded for the open message alone.
// That is what lets one mailbox hold tens of thousands of messages.
import {
  isFileNodeKind,
  useAttachments,
  useDocumentSafe,
  useSelectedDrive,
  useSelectedNode,
} from "@powerhousedao/reactor-browser";
import {
  isEmailDocument,
  type EmailAttachment,
  type EmailDocument,
} from "document-models/email";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AttachmentPreview,
  EmailBadges,
  EmailDetail,
  EmailMenu,
  PersonPreview,
  personName,
} from "../../sektar/components/EmailDetail.js";
import { useOpenIntegrations } from "../../sektar/kit/data.js";
import {
  traceChange,
  traceRender,
  useDomDiagnostics,
} from "../../sektar/kit/diagnostics.js";
import {
  useMailAccounts,
  useMailList,
  type MailRow,
  type MailView,
} from "../../sektar/kit/mail-index.js";
import {
  bytes,
  fmtWhen,
  mail,
  mailboxLabel,
  messagePeople,
  uniqueAttachments,
} from "../../sektar/kit/mail.js";
import { Menu } from "../../sektar/kit/menu.js";
import { printEmail } from "../../sektar/kit/print-email.js";
import {
  PullHeader,
  pullResult,
  usePullToRefresh,
} from "../../sektar/kit/pull-to-refresh.js";
import { useSearch } from "../../sektar/kit/search-context.js";
import {
  bringsMailFor,
  syncRow,
  syncSummary,
  type SyncRow,
} from "../../sektar/kit/sync-status.js";
import {
  useIntegrations,
  useSyncNow,
  useTriggerStates,
} from "../../sektar/kit/use-sync.js";
import {
  Avatar,
  Badge,
  Button,
  cx,
  EmptyState,
  Icon,
  ListItem,
  Selector,
  Skeleton,
} from "../../sektar/kit/ui.js";
import { useRowWindow } from "../../sektar/kit/virtual.js";
import {
  Pane,
  PaneSwitch,
  SubBar,
  Workspace,
} from "../../sektar/kit/workspace.js";

const ALL = "all";
const VIEWS: { value: MailView; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "unread", label: "Unread" },
  { value: "flagged", label: "Flagged" },
  { value: "archived", label: "Archived" },
];

/** Which level a stacked workspace shows: 0 inboxes · 1 list · 2 message · 3 file */
type Level = 0 | 1 | 2 | 3;

/** How long a scroll is left to settle before the pages under it are fetched. */
const ENSURE_DEBOUNCE_MS = 60;

export function MailWorkspace() {
  traceRender("MailWorkspace");
  const [drive] = useSelectedDrive();
  const node = useSelectedNode();
  const client = useAttachments();
  const { query } = useSearch();

  const [account, setAccount] = useState<string>(ALL);
  const [view, setView] = useState<MailView>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fileRef, setFileRef] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>(1);
  const [listCollapsed, setListCollapsed] = useState(false);
  // The preview pane: null means "decide for me" — collapsed to its strip
  // while the workspace is too narrow for three readable panes; a toggle or
  // an explicitly picked file makes the choice explicit.
  const [previewPref, setPreviewPref] = useState<boolean | null>(null);

  const list = useMailList(drive, {
    account: account === ALL ? null : account,
    view,
    query,
  });
  const accounts = useMailAccounts(drive, list.version) ?? [];

  // New mail is filed on the drive (a node on a legacy drive, a drive/child
  // relationship on a reactor-drive); either way the drive document's last
  // write moves, and the index follows a beat later.
  const driveWrittenAt = drive.header.lastModifiedAtUtcIso;
  const { refreshSoon } = list;
  useEffect(() => {
    if (driveWrittenAt) refreshSoon();
  }, [driveWrittenAt, refreshSoon]);

  // A message opened by URL (/d/mail/<node>) is the selection.
  useEffect(() => {
    if (node && isFileNodeKind(node) && node.documentType === "sektar/email") {
      setSelectedId(node.id);
      setLevel(2);
    }
  }, [node]);

  // The open message is the one document this view loads.
  const selectedQuery = useDocumentSafe(selectedId ?? undefined);
  const selected: EmailDocument | undefined =
    selectedQuery.data && isEmailDocument(selectedQuery.data)
      ? selectedQuery.data
      : undefined;
  const files = useMemo(
    () =>
      selected ? uniqueAttachments(selected.state.global.attachments) : [],
    [selected],
  );
  const hasFiles = files.length > 0;
  const file = files.find((a) => a.ref === fileRef) ?? null;
  // The people on the message share the preview pane's picker, after the files.
  const people = useMemo(
    () => (selected ? messagePeople(selected.state.global) : []),
    [selected],
  );
  const person = people.find((p) => p.key === fileRef) ?? null;

  // Triage from the message pane (the more-menu, the badges) changes the
  // document; the row follows at once, and the index soon after.
  const revision = selected?.header.lastModifiedAtUtcIso;
  const { patch } = list;
  useEffect(() => {
    if (!selected) return;
    const s = selected.state.global;
    patch(selected.header.id, {
      read: s.read,
      flagged: s.flagged,
      status: s.status,
      labels: s.labels,
      attachmentCount: uniqueAttachments(s.attachments).length,
      attachmentRefs: uniqueAttachments(s.attachments).map((a) => a.ref),
    });
    refreshSoon();
    // the document's revision is what says something changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.header.id, revision, patch, refreshSoon]);

  const pick = (row: MailRow) => {
    setSelectedId(row.id);
    // Line up the first file so an open preview follows the selection, but
    // keep a collapsed preview collapsed: a pane that reopens itself is a
    // pane you cannot close.
    setFileRef(row.attachmentRefs[0] ?? null);
    setLevel(2);
    if (!row.read) {
      patch(row.id, { read: true });
      void mail.markRead(row.id);
    }
  };

  const pickFile = (a: EmailAttachment) => {
    setFileRef(a.ref);
    setPreviewPref(false);
    setLevel(3);
  };

  // One mailbox: nothing to choose between, so no selector, no chooser
  // screen and no switch; the list is simply titled after the mailbox.
  const single = accounts.length <= 1;
  const accountName = single
    ? (accounts[0]?.name ?? "Inbox")
    : account === ALL
      ? "All inboxes"
      : (accounts.find((a) => a.address === account)?.name ?? account);
  const accountOptions = [
    {
      value: ALL,
      name: "All inboxes",
      meta: `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`,
      icon: "mail" as const,
    },
    ...accounts.map((a) => ({
      value: a.address,
      name: a.name,
      meta: a.unread > 0 ? `${a.unread} unread · ${a.address}` : a.address,
      icon: "customers" as const,
    })),
  ];

  // The root only exists once the index has answered (the empty state
  // renders without it), so the measuring hooks re-arm when it appears.
  const root = useRef<HTMLDivElement>(null);
  // Once shown, the workspace stays: a filter that is still loading, or one
  // that matches nothing, is the list pane's business, not a page loader's.
  const shownOnce = useRef(false);
  if (list.loaded && (accounts.length > 0 || list.total > 0))
    shownOnce.current = true;
  const ready = shownOnce.current;
  const height = useFillHeight(root, ready);
  const narrow = useNarrow(root, 1000, ready);
  // Opt-in: localStorage sk:mail-debug=1 or ?debug=mail (kit/diagnostics.ts)
  useDomDiagnostics(root, ready);
  const previewCollapsed = previewPref ?? narrow;

  // The list pane's body scrolls; the window keeps a screenful of rows in it.
  const listBody = useRef<HTMLDivElement>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    listBody.current = el;
    setListEl(el);
  }, []);
  const win = useRowWindow(listBody, list.total, { mounted: ready });
  // Pull to refresh (phone): the live updates of the inbox in view, or of
  // every email integration under All inboxes; never a backfill.
  const integrations = useIntegrations();
  const triggers = useTriggerStates();
  const { syncing, sync } = useSyncNow();
  const mailbox = single ? (accounts[0]?.address ?? null) : account === ALL ? null : account;
  const pullRows = integrations
    .filter((d) => bringsMailFor(d.state, mailbox))
    .map((d) =>
      syncRow(
        d.id,
        d.name,
        d.state,
        d.state.resources.liveWorkflowId
          ? triggers.get(d.state.resources.liveWorkflowId)
          : undefined,
      ),
    )
    .filter((r): r is SyncRow => r !== null);
  const pullIds = pullRows
    .map((r) => r.workflowId)
    .filter((id): id is string => Boolean(id));
  const pullSummary = syncSummary(
    pullRows,
    triggers,
    pullIds.some((id) => syncing.has(id)),
  );
  const ptr = usePullToRefresh(listEl, async () => {
    const result = await sync(pullIds);
    list.refreshSoon();
    return pullResult(result);
  });
  const { ensure, rowAt } = list;
  // The pages under the window, once the scroll settles: a drag across the
  // mailbox fetches where it stops, not every page it passed.
  useEffect(() => {
    const timer = setTimeout(
      () => ensure(win.start, win.end),
      ENSURE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [ensure, win.start, win.end, list.version]);
  const windowRows = useMemo(() => {
    const out: { index: number; row: MailRow | undefined }[] = [];
    for (let i = win.start; i < win.end; i++)
      out.push({ index: i, row: rowAt(i) });
    return out;
  }, [win.start, win.end, rowAt]);
  const firstReal = windowRows.find((r) => r.row)?.index;
  // A new filter starts at the top.
  const filterKey = `${account}|${view}|${query}`;
  useEffect(() => {
    if (listBody.current) listBody.current.scrollTop = 0;
  }, [filterKey]);

  traceChange("state", {
    mode: list.mode,
    total: list.total,
    stale: list.stale,
    window: [win.start, win.end],
    accounts: accounts.length,
    selected: selectedId?.slice(0, 8) ?? null,
    found: Boolean(selected),
    files: files.length,
    file: fileRef?.slice(-8) ?? null,
    fileFound: Boolean(file),
    collapsed: previewCollapsed,
    narrow,
    level,
    height,
  });

  if (!ready) {
    const unfiltered = account === ALL && view === "inbox" && !query;
    return (
      <div
        className="sk-page"
        style={{ padding: "var(--sk-space-10) var(--sk-space-6)" }}
      >
        {list.loaded && unfiltered && accounts.length === 0 ? (
          <MailEmpty
            error={list.error}
            indexed={list.mode !== "unknown"}
          />
        ) : (
          <div
            className="sk-stack sk-stack--4"
            style={{ maxWidth: 560, margin: "0 auto" }}
          >
            <Skeleton width={180} height={20} />
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={64} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={root}
      className="sk-mail"
      style={{ height: height ? `${height}px` : undefined }}
    >
      {/* The inbox selector: a second top-bar row. Narrow, the design system
          hides it and the list's title becomes the switch to the chooser. */}
      {!single && (
        <SubBar className="sk-subbar--wide">
          <Selector
            value={account}
            options={accountOptions}
            onChange={(v) => {
              setAccount(v);
              setLevel(1);
            }}
            label="Inbox"
          />
        </SubBar>
      )}

      <Workspace level={level} hasParent={!single}>
        {!single && (
          <Pane parent title="Inboxes" count={accounts.length} flush>
            <Selector
              value={account}
              options={accountOptions}
              onChange={(v) => {
                setAccount(v);
                setLevel(1);
              }}
              label="Inbox"
              list
            />
          </Pane>
        )}

        <Pane
          side="start"
          grow={1}
          flush
          bodyRef={listRef}
          collapsed={listCollapsed}
          onToggle={() => setListCollapsed((v) => !v)}
          count={list.total}
          // The switch's own title is what the collapsed strip shows.
          title={single ? accountName : undefined}
          header={
            single ? undefined : (
              <PaneSwitch
                label={accountName}
                ariaLabel="Choose inbox"
                onClick={() => setLevel(0)}
              />
            )
          }
          trailing={
            <Menu
              label="View"
              items={VIEWS.map((v) => ({
                label: v.label,
                active: v.value === view,
                onSelect: () => setView(v.value),
              }))}
              trigger={(open, toggle) => (
                <button
                  type="button"
                  className="sk-btn sk-btn--ghost sk-btn--sm"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  {VIEWS.find((v) => v.value === view)?.label}
                  <Icon name="chevron-down" size={16} mono />
                </button>
              )}
            />
          }
        >
          <PullHeader
            {...ptr}
            words={{
              idle: pullSummary
                ? `${accountName} · ${pullSummary.label.toLowerCase()}`
                : accountName,
              busy: "Checking for new mail…",
              busySub: accountName,
            }}
          />
          {list.total === 0 ? (
            <div style={{ padding: "var(--sk-space-6)" }}>
              {list.loaded ? (
                <EmptyState icon="mail" title="Nothing here">
                  {list.error
                    ? `The mailbox index did not answer: ${list.error}`
                    : query
                      ? "No message matches that search."
                      : "No messages in this view."}
                </EmptyState>
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
              style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}
            >
              {windowRows.map(({ index, row }) =>
                row ? (
                  <li
                    key={row.id}
                    ref={index === firstReal ? win.measure : undefined}
                  >
                    <MessageRow
                      row={row}
                      selected={row.id === selectedId}
                      onClick={() => pick(row)}
                    />
                  </li>
                ) : (
                  // Not fetched yet: a row's worth of placeholder, so the
                  // list keeps its true length while the page arrives.
                  <li
                    key={`at-${index}`}
                    className="sk-mail__placeholder"
                    style={{ height: win.rowHeight }}
                    aria-hidden="true"
                  >
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

        <Pane
          grow={1.35}
          onBack={() => setLevel(1)}
          backLabel="Back to the list"
          title={
            selected?.state.global.subject ??
            (selected ? "(no subject)" : "Mail")
          }
          titleDisplay
          header={
            selected && (
              <>
                <EmailBadges doc={selected} />
                <span className="sk-pane__spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="invoice"
                  title="Print the message, or save it as a PDF"
                  onClick={() => void printEmail(selected, client)}
                >
                  Print
                </Button>
                <EmailMenu doc={selected} />
              </>
            )
          }
        >
          {selected ? (
            <EmailDetail
              doc={selected}
              compact
              selectedRef={fileRef}
              onPickAttachment={pickFile}
              onPickPerson={(key) => {
                setFileRef(key);
                setLevel(3);
              }}
              onOpenDetails={() => {
                if (!file && !person) {
                  setFileRef(files[0]?.ref ?? people[0]?.key ?? null);
                }
                setLevel(3);
              }}
            />
          ) : selectedId && selectedQuery.isPending ? (
            <div className="sk-stack sk-stack--4">
              <Skeleton width={240} height={20} />
              <Skeleton height={120} />
            </div>
          ) : (
            <EmptyState icon="mail" title="Pick a message">
              The message opens here; its files open beside it.
            </EmptyState>
          )}
        </Pane>

        <Pane
          side="end"
          grow={1}
          collapsed={previewCollapsed}
          onToggle={() => setPreviewPref(!previewCollapsed)}
          onBack={() => setLevel(2)}
          backLabel="Back to the message"
          // With files the header is the picker and the title appears only
          // when collapsed; without, the title is the header.
          collapsedTitle={
            selected && (hasFiles || people.length > 0)
              ? hasFiles
                ? "Attachments"
                : "People"
              : undefined
          }
          title={
            selected && (hasFiles || people.length > 0)
              ? undefined
              : "Attachments"
          }
          header={
            selected && (hasFiles || people.length > 0) ? (
              <Selector
                value={fileRef ?? files[0]?.ref ?? ""}
                options={[
                  ...files.map((a) => ({
                    value: a.ref,
                    name: a.fileName,
                    meta: bytes(a.sizeBytes) || a.mimeType || undefined,
                  })),
                  ...people.map((p) => ({
                    value: p.key,
                    name: personName(p),
                    meta: p.m.address,
                    icon: "customers" as const,
                  })),
                ]}
                onChange={(ref) => setFileRef(ref)}
                label="Attachments and people"
              />
            ) : undefined
          }
        >
          {selected && person ? (
            <PersonPreview person={person} />
          ) : selected ? (
            <AttachmentPreview
              key={file?.ref ?? "none"}
              documentId={selected.header.id}
              file={file}
            />
          ) : (
            <p className="sk-small sk-text-muted">
              Files travel with their message.
            </p>
          )}
        </Pane>
      </Workspace>
    </div>
  );
}

/**
 * A row re-renders only when its own row or its selection changes. Rows are
 * replaced only when the index says they changed, so a refresh that confirms
 * what is shown re-renders nothing.
 */
const MessageRow = memo(
  MessageRowImpl,
  (a, b) => a.selected === b.selected && a.row === b.row,
);

function MessageRowImpl({
  row,
  selected,
  onClick,
}: {
  row: MailRow;
  selected: boolean;
  onClick: () => void;
}) {
  traceRender("MessageRow");
  const name = row.fromName?.trim() || row.fromAddress || "Unknown sender";
  const fileCount = row.attachmentCount;
  return (
    <ListItem
      rich
      selected={selected}
      onClick={onClick}
      // Stacked, this row leads to the message screen: the chevron says so.
      drill={2}
      icon={<Avatar name={name} />}
      title={
        <span className={cx(!row.read && "sk-mail__unread")}>
          {name}
          {!row.read && (
            <span
              className="sk-badge sk-badge--dot sk-badge--mint"
              style={{ marginLeft: 4 }}
              aria-label="Unread"
            />
          )}
        </span>
      }
      sub={[
        <span key="subject" style={{ color: "var(--sk-text)" }}>
          {row.subject ?? "(no subject)"}
        </span>,
        row.snippet ?? "",
      ]}
      aside={
        <>
          <span>{fmtWhen(row.when)}</span>
          {fileCount > 0 && (
            <span
              className="sk-mail__files"
              title={`${fileCount} ${fileCount === 1 ? "attachment" : "attachments"}`}
            >
              <Icon name="upload" size={16} mono />
              {fileCount > 1 && fileCount}
            </span>
          )}
          {row.flagged && (
            <Badge tone="warning" dot pill>
              Flagged
            </Badge>
          )}
        </>
      }
      chevron
    />
  );
}

export function MailEmpty({
  error,
  indexed,
}: {
  error: string | null;
  /** Whether a mailbox index could be reached at all. */
  indexed: boolean;
}) {
  const openIntegrations = useOpenIntegrations();
  return (
    <div
      className="sk-stack sk-stack--6"
      style={{ maxWidth: 560, margin: "0 auto" }}
    >
      <EmptyState
        icon="mail"
        title="No mail yet"
        action={
          <Button
            variant="primary"
            size="sm"
            icon="sync"
            onClick={openIntegrations}
          >
            Open Integrations
          </Button>
        }
      >
        Connect an email account and your mail is filed here as it arrives,
        with its attachments.
      </EmptyState>
      {!indexed && (
        <p className="sk-text-muted sk-small">
          No mailbox index answers for this drive: the switchboard behind it
          needs the email-index processor and subgraph.
        </p>
      )}
      {error && <p className="sk-text-danger sk-small">{error}</p>}
    </div>
  );
}

/** Whether the workspace is narrower than `px` (side by side, but cramped). */
function useNarrow(
  ref: React.RefObject<HTMLDivElement | null>,
  px: number,
  mounted: boolean,
): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      // Zero means hidden (a suspended subtree, a background tab), not narrow.
      if (width > 0) setNarrow(width < px);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px, mounted]);
  return narrow;
}

/**
 * The workspace fills the viewport below whatever sits above it. Connect's
 * wrapper grows with its content, so `height: 100%` would be circular; the
 * offset is measured instead and re-measured on resize.
 */
function useFillHeight(
  ref: React.RefObject<HTMLDivElement | null>,
  mounted: boolean,
): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const measure = () => {
      if (!ref.current) return;
      const top = ref.current.getBoundingClientRect().top;
      const next = Math.max(360, Math.round(window.innerHeight - top));
      setHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref, mounted]);
  return height;
}
