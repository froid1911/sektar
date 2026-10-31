export type Maybe<T> = T | null | undefined;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = {
  [K in keyof T]: T[K];
};
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]?: Maybe<T[SubKey]>;
};
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]: Maybe<T[SubKey]>;
};
export type MakeEmpty<
  T extends { [key: string]: unknown },
  K extends keyof T,
> = { [_ in K]?: never };
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never;
    };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  Address: { input: `${string}:0x${string}`; output: `${string}:0x${string}` };
  Amount: {
    input: { unit?: string; value?: number };
    output: { unit?: string; value?: number };
  };
  Amount_Crypto: {
    input: { unit: string; value: string };
    output: { unit: string; value: string };
  };
  Amount_Currency: {
    input: { unit: string; value: string };
    output: { unit: string; value: string };
  };
  Amount_Fiat: {
    input: { unit: string; value: number };
    output: { unit: string; value: number };
  };
  Amount_Money: { input: number; output: number };
  Amount_Percentage: { input: number; output: number };
  Amount_Tokens: { input: number; output: number };
  AttachmentRef: {
    input: `attachment://v${number}:${string}`;
    output: `attachment://v${number}:${string}`;
  };
  Currency: { input: string; output: string };
  Date: { input: string; output: string };
  DateTime: { input: string; output: string };
  EmailAddress: { input: string; output: string };
  EthereumAddress: { input: string; output: string };
  OID: { input: string; output: string };
  OLabel: { input: string; output: string };
  PHID: { input: string; output: string };
  URL: { input: string; output: string };
  Unknown: { input: unknown; output: unknown };
  Upload: { input: File; output: File };
};

export type AddDateRangeBackfillInput = {
  /** Null: BACKWARD */
  direction?: InputMaybe<BackfillDirection>;
  documentType: Scalars["String"]["input"];
  from: Scalars["DateTime"]["input"];
  id: Scalars["OID"]["input"];
  label: Scalars["String"]["input"];
  stepSeconds: Scalars["Int"]["input"];
  to: Scalars["DateTime"]["input"];
};

export type ArchiveInput = {
  /** The empty-input workaround: ARCHIVE takes nothing */
  _?: InputMaybe<Scalars["Boolean"]["input"]>;
};

export type AttachBackfillInput = {
  /** An existing backfill document, adopted as it is */
  documentId: Scalars["PHID"]["input"];
  documentType: Scalars["String"]["input"];
  id: Scalars["OID"]["input"];
  label: Scalars["String"]["input"];
};

export type BackfillBatch = {
  every: Interval;
  size: Scalars["Int"]["output"];
};

export type BackfillDirection =
  /** From the range's end back towards its start: newest first */
  | "BACKWARD"
  /** From the range's start towards its end: oldest first */
  | "FORWARD";

export type BackfillIntent = {
  /** How much per run, and how often; null: the provider's default */
  batch: Maybe<BackfillBatch>;
  /** The Backfill switch: the backfill workflow on or off */
  enabled: Scalars["Boolean"]["output"];
  /** In the order they run */
  items: Array<BackfillItem>;
  /** Make active; null: the first unfinished item */
  pinnedId: Maybe<Scalars["OID"]["output"]>;
};

export type BackfillItem = {
  /** Null until the reconciler has created it from the request */
  documentId: Maybe<Scalars["PHID"]["output"]>;
  /** Any backfill document type with an adapter */
  documentType: Scalars["String"]["output"];
  id: Scalars["OID"]["output"];
  /** e.g. 2023 to today */
  label: Scalars["String"]["output"];
  /** How to create it; null when an existing document was attached */
  request: Maybe<BackfillRequest>;
};

export type BackfillRequest = DateRangeBackfill | FolderListBackfill;

export type BankAccountLink = {
  /** The aggregator's account id */
  accountId: Scalars["String"]["output"];
  /** The aggregator's stable account key, used in transaction references */
  accountKey: Scalars["String"]["output"];
  /** The sektar/bank-account document its transactions go in */
  bankAccountId: Scalars["PHID"]["output"];
  label: Maybe<Scalars["String"]["output"]>;
};

export type BankAccountLinkInput = {
  accountId: Scalars["String"]["input"];
  accountKey: Scalars["String"]["input"];
  bankAccountId: Scalars["PHID"]["input"];
  label?: InputMaybe<Scalars["String"]["input"]>;
};

export type CalendarRef = {
  /** The provider's calendar id */
  id: Scalars["String"]["output"];
  name: Maybe<Scalars["String"]["output"]>;
};

export type CalendarRefInput = {
  id: Scalars["String"]["input"];
  name?: InputMaybe<Scalars["String"]["input"]>;
};

export type CalendarSource = {
  /** Every calendar the account owns, including ones added later */
  allOwned: Scalars["Boolean"]["output"];
  /** The calendars picked; empty while allOwned */
  calendars: Array<CalendarRef>;
};

export type ClearGrantInput = {
  _?: InputMaybe<Scalars["Boolean"]["input"]>;
};

export type DateRangeBackfill = {
  /** Which end it starts from; null: BACKWARD, newest first (the queue's own default) */
  direction: Maybe<BackfillDirection>;
  from: Scalars["DateTime"]["output"];
  /** The size of one slice */
  stepSeconds: Scalars["Int"]["output"];
  to: Scalars["DateTime"]["output"];
};

export type EmailSource = {
  /** The account's address; null until the sign-in names it */
  address: Maybe<Scalars["String"]["output"]>;
  /** Labels or folders to bring in; empty: all mail */
  folders: Array<Scalars["String"]["output"]>;
  /** The account's name in Sektar, and the Mail drive folder its messages go in, e.g. Personal */
  mailbox: Scalars["String"]["output"];
};

export type FolderListBackfill = {
  folders: Array<Scalars["String"]["output"]>;
};

export type InitializeInput = {
  kind: IntegrationKind;
  provider: Scalars["String"]["input"];
};

export type IntegrationAccess =
  /** See, never change: the provider's read-only permissions */
  | "READ"
  /** Also add and change; never delete */
  | "READ_WRITE";

export type IntegrationApplied = {
  at: Scalars["DateTime"]["output"];
  generation: Scalars["Int"]["output"];
  host: Maybe<Scalars["String"]["output"]>;
};

export type IntegrationCheck = {
  at: Scalars["DateTime"]["output"];
  /** The intent generation this pass evaluated */
  generation: Scalars["Int"]["output"];
  host: Maybe<Scalars["String"]["output"]>;
  issues: Array<IntegrationIssue>;
  /** The check request it answered, if any */
  request: Maybe<Scalars["OID"]["output"]>;
};

export type IntegrationCheckRequest = {
  id: Scalars["OID"]["output"];
  requestedAt: Scalars["DateTime"]["output"];
  requestedBy: Maybe<Scalars["String"]["output"]>;
};

export type IntegrationFix = {
  at: Scalars["DateTime"]["output"];
  code: Scalars["String"]["output"];
  /** Put back: ... */
  message: Scalars["String"]["output"];
  subject: Maybe<Scalars["PHID"]["output"]>;
};

export type IntegrationFixInput = {
  at: Scalars["DateTime"]["input"];
  code: Scalars["String"]["input"];
  message: Scalars["String"]["input"];
  subject?: InputMaybe<Scalars["PHID"]["input"]>;
};

export type IntegrationGrant = {
  /** When the statement ends; a signed-in browser renews it */
  expiresAt: Scalars["DateTime"]["output"];
  grantedAt: Scalars["DateTime"]["output"];
  /** The person it acts for */
  person: Scalars["String"]["output"];
  /** The signed statement naming this environment's runner key (ADR 0008) */
  statement: Scalars["String"]["output"];
};

export type IntegrationIntent = {
  /** What Sektar may do with the account: only read, or read and write. Null: not chosen (read only) */
  access: Maybe<IntegrationAccess>;
  /** An archived integration's workflows are archived; its data stays */
  archived: Scalars["Boolean"]["output"];
  backfill: BackfillIntent;
  /** An existing connection the user picked; null: the reconciler makes one (resources.connectionId) */
  connectionId: Maybe<Scalars["PHID"]["output"]>;
  /** Raised by every change to the intent; the reconciler commits a generation */
  generation: Scalars["Int"]["output"];
  live: LiveIntent;
  /** What to bring in, per kind and provider-neutral */
  source: Maybe<IntegrationSource>;
  /** The drive the imported documents land in; null: the kind's default drive */
  targetDriveId: Maybe<Scalars["PHID"]["output"]>;
};

export type IntegrationIssue = {
  /** Plugin-defined, e.g. NEEDS_SIGN_IN, LIVE_WORKFLOW_MISSING, COVERAGE_GAP */
  code: Scalars["String"]["output"];
  /** False: only the user can fix it (Reconnect) */
  fixable: Scalars["Boolean"]["output"];
  /** In the user's words */
  message: Scalars["String"]["output"];
  severity: IssueSeverity;
  since: Scalars["DateTime"]["output"];
  /** The workflow, backfill or connection it is about */
  subject: Maybe<Scalars["PHID"]["output"]>;
};

export type IntegrationIssueInput = {
  code: Scalars["String"]["input"];
  fixable: Scalars["Boolean"]["input"];
  message: Scalars["String"]["input"];
  severity: IssueSeverity;
  since: Scalars["DateTime"]["input"];
  subject?: InputMaybe<Scalars["PHID"]["input"]>;
};

export type IntegrationKind =
  | "CALENDAR"
  | "EMAIL"
  | "TIME_TRACKING"
  | "TRANSACTIONS";

export type IntegrationResources = {
  backfillWorkflowId: Maybe<Scalars["PHID"]["output"]>;
  /** The connection the reconciler made, when the intent names none */
  connectionId: Maybe<Scalars["PHID"]["output"]>;
  liveWorkflowId: Maybe<Scalars["PHID"]["output"]>;
  /** The backfill item the backfill workflow points at now */
  pluggedItemId: Maybe<Scalars["OID"]["output"]>;
};

export type IntegrationRunner = {
  /** The machine's name, e.g. Wouter's PC */
  label: Maybe<Scalars["String"]["output"]>;
  reactorId: Scalars["String"]["output"];
};

export type IntegrationSource =
  | CalendarSource
  | EmailSource
  | TransactionsSource;

export type IntegrationState = {
  /** The last intent generation the reconciler committed */
  applied: Maybe<IntegrationApplied>;
  /** The reconciler's last pass: what it found */
  check: Maybe<IntegrationCheck>;
  /** A check asked for from the app (Check now) */
  checkRequest: Maybe<IntegrationCheckRequest>;
  /** What the reconciler put back, latest first, at most 20 */
  fixes: Array<IntegrationFix>;
  /** Who lets Sektar write for this integration; null: nobody yet */
  grant: Maybe<IntegrationGrant>;
  /** What the user asked for; written from the app */
  intent: IntegrationIntent;
  /** What comes in; fixed by INITIALIZE. Null until then */
  kind: Maybe<IntegrationKind>;
  /** How it comes in: a provider adapter id (google-calendar, gmail, imap). Null until INITIALIZE */
  provider: Maybe<Scalars["String"]["output"]>;
  /** Settings only this provider has, checked by its adapter */
  providerOptions: Maybe<Scalars["Unknown"]["output"]>;
  /** What the reconciler built for the intent */
  resources: IntegrationResources;
  /** The reactor that fetches and holds the token; null: the switchboard that owns this drive, until it claims it */
  runner: Maybe<IntegrationRunner>;
};

export type Interval = {
  unit: IntervalUnit;
  value: Scalars["Int"]["output"];
};

export type IntervalUnit = "DAYS" | "HOURS" | "MINUTES";

export type IssueSeverity = "BLOCKING" | "INFO" | "WARNING";

export type LiveIntent = {
  /** The Live updates switch */
  enabled: Scalars["Boolean"]["output"];
  /** How often to check for what is new */
  every: Interval;
};

export type RecordBackfillDocumentInput = {
  /** The backfill document the reconciler created for it */
  documentId: Scalars["PHID"]["input"];
  /** The backfill item */
  itemId: Scalars["OID"]["input"];
};

export type RecordCheckInput = {
  at: Scalars["DateTime"]["input"];
  /** Everything the reconciler can do for this generation is done */
  committed: Scalars["Boolean"]["input"];
  fixes: Array<IntegrationFixInput>;
  /** The intent generation this pass evaluated */
  generation: Scalars["Int"]["input"];
  host?: InputMaybe<Scalars["String"]["input"]>;
  issues: Array<IntegrationIssueInput>;
  /** The check request it answered, if any */
  request?: InputMaybe<Scalars["OID"]["input"]>;
};

export type RecordResourcesInput = {
  backfillWorkflowId?: InputMaybe<Scalars["PHID"]["input"]>;
  connectionId?: InputMaybe<Scalars["PHID"]["input"]>;
  liveWorkflowId?: InputMaybe<Scalars["PHID"]["input"]>;
  pluggedItemId?: InputMaybe<Scalars["OID"]["input"]>;
};

export type RecordRunnerInput = {
  label?: InputMaybe<Scalars["String"]["input"]>;
  reactorId: Scalars["String"]["input"];
};

export type RemoveBackfillInput = {
  /** The backfill item; its document is the app's to delete */
  id: Scalars["OID"]["input"];
};

export type RequestCheckInput = {
  id: Scalars["OID"]["input"];
  requestedAt: Scalars["DateTime"]["input"];
  requestedBy?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetAccessInput = {
  access: IntegrationAccess;
};

export type SetBackfillEnabledInput = {
  enabled: Scalars["Boolean"]["input"];
};

export type SetCalendarSourceInput = {
  allOwned: Scalars["Boolean"]["input"];
  calendars: Array<CalendarRefInput>;
};

export type SetConnectionInput = {
  /** An existing connection to use (an API key shared with others); omit to let the reconciler make one */
  connectionId?: InputMaybe<Scalars["PHID"]["input"]>;
};

export type SetEmailSourceInput = {
  address?: InputMaybe<Scalars["String"]["input"]>;
  folders: Array<Scalars["String"]["input"]>;
  mailbox: Scalars["String"]["input"];
};

export type SetGrantInput = {
  /** When the statement ends */
  expiresAt: Scalars["DateTime"]["input"];
  grantedAt: Scalars["DateTime"]["input"];
  /** The person it acts for */
  person: Scalars["String"]["input"];
  /** The signed statement naming this environment's runner key */
  statement: Scalars["String"]["input"];
};

export type SetLiveEnabledInput = {
  enabled: Scalars["Boolean"]["input"];
};

export type SetLiveIntervalInput = {
  unit: IntervalUnit;
  value: Scalars["Int"]["input"];
};

export type SetTransactionsSourceInput = {
  accounts: Array<BankAccountLinkInput>;
  bankConnectionId: Scalars["String"]["input"];
};

export type TransactionsSource = {
  /** Its accounts, each onto a Sektar bank account */
  accounts: Array<BankAccountLink>;
  /** The aggregator's own id of the bank connection (Distyra: connectionId), e.g. KBC */
  bankConnectionId: Scalars["String"]["output"];
};
