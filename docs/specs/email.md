# Email (`sektar/email`) — one-pager

**Type id** `sektar/email` · **extension** `.mail` · **spec** `specs/email.json` · **status** implemented 2026-10-19

## Purpose

One document per message, as received from a mailbox. It holds what the Gmail
piece's `gmail_search_email` step returns (see the 2026-10-19 run of the
"Email test flow": a parsed MIME object per message, attachments already in
the store as `attachment://v1:<sha256>` refs), plus the mailbox it came from
and our own triage on top. Capture replaces the message wholesale; triage is
separate operations so a re-capture never undoes a flag.

## State

```graphql
type EmailState {
  account: MailAccount!          # the mailbox: address, name, provider ("gmail")
  externalId: String             # namespaced: gmail:<id> — the identity
  messageId: String              # RFC 5322 Message-ID
  threadId: String
  inReplyTo: String
  references: [String!]!
  subject: String
  from: [Mailbox!]!              # { address!, name }
  to: [Mailbox!]!
  cc: [Mailbox!]!
  bcc: [Mailbox!]!
  replyTo: [Mailbox!]!
  sentAt: DateTime
  receivedAt: DateTime
  text: String
  html: String
  snippet: String                # derived from text, 160 chars
  headers: [EmailHeader!]!       # { key!, value! }
  labels: [String!]!
  attachments: [EmailAttachment!]!  # { id!, ref: AttachmentRef!, fileName!, mimeType, sizeBytes, contentId, inline! }
  status: EmailStatus!           # INBOX | ARCHIVED
  read: Boolean!
  flagged: Boolean!
  notes: String
  source: String                 # "gmail" | "sample" | …
  capturedAt: DateTime
}
```

No type is named after a codegen scalar (`Address`, `EmailAddress`, `URL`…);
addresses are plain strings because mailboxes like `undisclosed-recipients:;`
exist.

## Operations

| Module | Operation | Errors |
|---|---|---|
| message | `SET_ACCOUNT` (partial) | |
| message | `CAPTURE_MESSAGE` (everything but attachments, `capturedAt!`) | `INVALID_EXTERNAL_ID` (not `system:id`), `EXTERNAL_ID_MISMATCH` (document holds another message) |
| message | `SET_NOTES` | |
| attachments | `ADD_ATTACHMENT` (`id!`, `ref!`, `fileName!`) | `INVALID_FILE_NAME`, `DUPLICATE_ATTACHMENT` (same id, or same ref under the same name) |
| attachments | `REMOVE_ATTACHMENT` | `ATTACHMENT_NOT_FOUND` |
| triage | `MARK_READ`, `MARK_UNREAD` (idempotent), `SET_FLAGGED` | |
| triage | `ARCHIVE`, `UNARCHIVE` | `ALREADY_ARCHIVED`, `NOT_ARCHIVED` |
| triage | `ADD_LABELS`, `REMOVE_LABELS` (atomic: one bad label rejects the batch) | `INVALID_LABEL`, `LABEL_NOT_FOUND` |

## Mapping from the Gmail step

| Gmail `messages[]` | `CAPTURE_MESSAGE` input |
|---|---|
| `id` | `externalId: "gmail:" + id` (also the dedup key) |
| `messageId`, `inReplyTo`, `references` | same names; `references` split on whitespace |
| `subject`, `date` | `subject`, `sentAt` |
| `from.value[]`, `to.value[]`, `cc.value[]`, `replyTo.value[]` | `{ address, name }` lists |
| `text`, `html` | `text`, `html` (`textAsHtml` is dropped: derivable) |
| `headerLines[]` `{ key, line }` | `headers[] { key, value: line after the first ": " }` |
| `attachments[]` `{ fileName, mimeType, size, data }` | one `ADD_ATTACHMENT` each: `ref = data`, `sizeBytes = size` |
| — | `labels` from the search's label prop, `source: "gmail"`, `capturedAt: now` |

Gmail returns no `threadId`, `labelIds` or `snippet`; `snippet` is derived.
A message is ~85 KB on average, of which `html` + `textAsHtml` +
`headerLines` are 85 %; keeping `html` and `headers` is the "capture never
transforms" choice and can be revisited per workflow.

## Where it lives

- Drive `mail` ("Mail", app `email-workspace`), declared in
  `hosts/switchboard/host.js` (served), `hosts/connect/host.js` (local copy for
  standalone Connect), `hosts/vetra/host.js` (served by the studio switchboard,
  attached by the studio Connect as a remote); `hosts/cli` derives its remote
  list from the switchboard's drives.
- One folder per mailbox at the drive root; attachments go preprocess →
  dispatch `ADD_ATTACHMENT` with the ref → upload, in that order, because the
  store refuses bytes for a ref no document carries.
- Productivity Center nav: "Mail" → `/d/mail`.

## How a mailbox is listed

The list never loads documents. `processors/email-index` keeps one lean row
per message (`email_index`: account, sender, subject, snippet, listing
instant, read/flagged/status, attachment refs, labels, a lower-cased search
text) built off the operations themselves — the resulting state when an
operation carries it, else the action applied as the reducer applies it — so
a first install replays history without reading a body. The switchboard
answers `emailIndex { messages(driveId, account, view, query, cursor, limit)
accounts(driveId) }` (`subgraphs/email-index`), keyset-paged on
`(when_at, document_id)` so page one hundred costs what page one does.

Connect reads it through `editors/sektar/kit/mail-index.ts`: a remote drive
is answered by its switchboard (found from the drive's channel URL, as the
framework finds its own switchboard links), a drive in the tab's own reactor
by the same queries run live on its database. `MailWorkspace` pages as the
reader scrolls, keeps a screenful of rows in the DOM (`kit/virtual.ts`), and
loads the one document that is open with `useDocumentSafe`. New mail shows
when the drive's node list grows (the index follows within a second); a row
this tab triaged is patched at once and confirmed by the next refresh.

