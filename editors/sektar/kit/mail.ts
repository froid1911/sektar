// The small pure helpers the Mail surfaces share, and triage. Messages are
// filed by the Gmail workflow; the list itself is read through the mailbox
// index (kit/mail-index.ts), never by loading every document.
import { dispatchActions } from "@powerhousedao/reactor-browser";
import {
  actions as emailActions,
  type EmailAttachment,
  type EmailDocument,
  type Mailbox,
} from "document-models/email";

/* -------------------------------------------------------------- reading */

/** The instant a message is listed by: sent, else received, else captured. */
export function whenOf(doc: EmailDocument): string {
  const s = doc.state.global;
  return s.sentAt ?? s.receivedAt ?? s.capturedAt ?? doc.header.createdAtUtcIso;
}

export type MailAccountSummary = {
  address: string;
  name: string;
  provider: string | null;
  total: number;
  unread: number;
};

/** The mailboxes the drive holds mail for, with their counts. */
export function accountsOf(emails: EmailDocument[]): MailAccountSummary[] {
  const map = new Map<string, MailAccountSummary>();
  for (const doc of emails) {
    const a = doc.state.global.account;
    const address = a.address ?? "unknown";
    const cur = map.get(address) ?? {
      address,
      name: a.name ?? address,
      provider: a.provider ?? null,
      total: 0,
      unread: 0,
    };
    cur.total += 1;
    if (!doc.state.global.read && doc.state.global.status === "INBOX")
      cur.unread += 1;
    map.set(address, cur);
  }
  return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export function mailboxLabel(m: Mailbox): string {
  return m.name?.trim() || m.address;
}

/** Someone on a message, in the role they have on it. */
export type MessagePerson = { key: string; m: Mailbox; role: string };

/** Keys of people in the preview pane's picker start with this, beside file refs. */
export const PERSON_KEY = "person:";

/**
 * Sender, To, Cc, Bcc and Reply to, in that order, each address once: a
 * person on the message in several roles (typically the sender who is also
 * the reply-to) is one entry with the roles joined ("Sender · Reply to").
 * The name is the first one given. Each entry has a picker key.
 */
export function messagePeople(s: {
  from: Mailbox[];
  to: Mailbox[];
  cc: Mailbox[];
  bcc: Mailbox[];
  replyTo: Mailbox[];
}): MessagePerson[] {
  const roles: [string, Mailbox[]][] = [
    ["Sender", s.from],
    ["To", s.to],
    ["Cc", s.cc],
    ["Bcc", s.bcc],
    ["Reply to", s.replyTo],
  ];
  const byAddress = new Map<string, { m: Mailbox; roles: string[] }>();
  for (const [role, boxes] of roles) {
    for (const m of boxes) {
      const id = m.address.trim().toLowerCase();
      const seen = byAddress.get(id);
      if (!seen) {
        byAddress.set(id, { m, roles: [role] });
        continue;
      }
      if (!seen.m.name?.trim() && m.name?.trim()) seen.m = m;
      if (!seen.roles.includes(role)) seen.roles.push(role);
    }
  }
  return [...byAddress.entries()].map(([id, { m, roles: r }]) => ({
    key: `${PERSON_KEY}${id}`,
    m,
    role: r.join(" · "),
  }));
}

/** A time for a list: the hour today, the day this year, the date otherwise. */
export function fmtWhen(
  iso: string | null | undefined,
  now = new Date(),
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** A message's time in its header: the day as the list shows it, always
 * with the hour and minute (24h), e.g. "26 Oct, 14:05" or "Today, 09:30". */
export function fmtWhenTime(
  iso: string | null | undefined,
  now = new Date(),
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const day = sameDay
    ? "Today"
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      });
  return `${day}, ${time}`;
}

export function bytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files worth showing: one per stored ref. Gmail reports a calendar
 * invite twice — once as a `text/calendar` part under a synthesised name
 * ("attachment-1792440339391"), once as `invite.ics` — both pointing at the
 * same bytes. The capture keeps both, as received; the view shows the one
 * with a real name and the more specific type.
 */
export function uniqueAttachments<
  T extends Pick<EmailAttachment, "ref" | "fileName" | "mimeType">,
>(attachments: readonly T[]): T[] {
  const synthesised = (a: T) => /^attachment-\d+$/i.test(a.fileName);
  const byRef = new Map<string, T>();
  for (const a of attachments) {
    const cur = byRef.get(a.ref);
    if (!cur) {
      byRef.set(a.ref, a);
      continue;
    }
    // prefer a real name; between two real names, the one that looks like a file
    const better =
      synthesised(cur) && !synthesised(a)
        ? a
        : !synthesised(cur) && synthesised(a)
          ? cur
          : /\.[a-z0-9]{2,5}$/i.test(a.fileName) &&
              !/\.[a-z0-9]{2,5}$/i.test(cur.fileName)
            ? a
            : cur;
    byRef.set(a.ref, better);
  }
  return [...byRef.values()];
}

export type AttachmentKind = "image" | "pdf" | "sheet" | "document" | "other";

/** What a file is, for the tile and the preview. The store's own mime type wins over the one the sender claimed. */
export function attachmentKind(
  file: Pick<EmailAttachment, "fileName" | "mimeType">,
  actualMime?: string,
): AttachmentKind {
  const mime = (actualMime ?? file.mimeType ?? "").toLowerCase();
  const name = file.fileName.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(name))
    return "image";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (/sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/.test(name))
    return "sheet";
  if (/word|document|text\/plain/.test(mime) || /\.(docx?|txt|md)$/.test(name))
    return "document";
  return "other";
}

/** A plain-text file, previewed as text: `text/plain` (any charset), or a
 * `.txt` name when no type is known. The served type wins over the declared. */
export function isPlainText(
  file: Pick<EmailAttachment, "fileName" | "mimeType">,
  actualMime?: string,
): boolean {
  const mime = (actualMime ?? file.mimeType ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (mime) return mime === "text/plain";
  return file.fileName.toLowerCase().endsWith(".txt");
}

/** Free-text match over the fields a person scans a mailbox by. */
export function matchesMail(query: string, doc: EmailDocument): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const s = doc.state.global;
  const hay = [
    s.subject,
    s.snippet,
    ...s.from.map((m) => `${m.name ?? ""} ${m.address}`),
    ...s.to.map((m) => `${m.name ?? ""} ${m.address}`),
    ...s.labels,
    ...s.attachments.map((a) => a.fileName),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/* -------------------------------------------------------------- writing */

/** Triage, one operation each. */
export const mail = {
  markRead: (id: string) => dispatchActions(emailActions.markRead({}), id),
  markUnread: (id: string) => dispatchActions(emailActions.markUnread({}), id),
  setFlagged: (id: string, flagged: boolean) =>
    dispatchActions(emailActions.setFlagged({ flagged }), id),
  archive: (id: string) => dispatchActions(emailActions.archive({}), id),
  unarchive: (id: string) => dispatchActions(emailActions.unarchive({}), id),
  addLabels: (id: string, labels: string[]) =>
    dispatchActions(emailActions.addLabels({ labels }), id),
  removeLabels: (id: string, labels: string[]) =>
    dispatchActions(emailActions.removeLabels({ labels }), id),
  setNotes: (id: string, notes: string | null) =>
    dispatchActions(emailActions.setNotes({ notes }), id),
};
