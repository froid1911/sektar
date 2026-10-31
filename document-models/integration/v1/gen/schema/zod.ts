/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AddDateRangeBackfillInput,
  ArchiveInput,
  AttachBackfillInput,
  BackfillBatch,
  BackfillDirection,
  BackfillIntent,
  BackfillItem,
  BankAccountLink,
  BankAccountLinkInput,
  CalendarRef,
  CalendarRefInput,
  CalendarSource,
  ClearGrantInput,
  DateRangeBackfill,
  EmailSource,
  FolderListBackfill,
  InitializeInput,
  IntegrationAccess,
  IntegrationApplied,
  IntegrationCheck,
  IntegrationCheckRequest,
  IntegrationFix,
  IntegrationFixInput,
  IntegrationGrant,
  IntegrationIntent,
  IntegrationIssue,
  IntegrationIssueInput,
  IntegrationKind,
  IntegrationResources,
  IntegrationRunner,
  IntegrationState,
  Interval,
  IntervalUnit,
  IssueSeverity,
  LiveIntent,
  RecordBackfillDocumentInput,
  RecordCheckInput,
  RecordResourcesInput,
  RecordRunnerInput,
  RemoveBackfillInput,
  RequestCheckInput,
  SetAccessInput,
  SetBackfillEnabledInput,
  SetCalendarSourceInput,
  SetConnectionInput,
  SetEmailSourceInput,
  SetGrantInput,
  SetLiveEnabledInput,
  SetLiveIntervalInput,
  SetTransactionsSourceInput,
  TransactionsSource,
} from "./types.js";

type Properties<T> = Required<{
  [K in keyof T]: z.ZodType<T[K]>;
}>;

type definedNonNullAny = {};

export const isDefinedNonNullAny = (v: any): v is definedNonNullAny =>
  v !== undefined && v !== null;

export const definedNonNullAnySchema = z
  .any()
  .refine((v) => isDefinedNonNullAny(v));

export const BackfillDirectionSchema = z.enum(["BACKWARD", "FORWARD"]);

export const IntegrationAccessSchema = z.enum(["READ", "READ_WRITE"]);

export const IntegrationKindSchema = z.enum([
  "CALENDAR",
  "EMAIL",
  "TIME_TRACKING",
  "TRANSACTIONS",
]);

export const IntervalUnitSchema = z.enum(["DAYS", "HOURS", "MINUTES"]);

export const IssueSeveritySchema = z.enum(["BLOCKING", "INFO", "WARNING"]);

export function AddDateRangeBackfillInputSchema(): z.ZodObject<
  Properties<AddDateRangeBackfillInput>
> {
  return z.object({
    direction: BackfillDirectionSchema.nullish(),
    documentType: z.string(),
    from: z.iso.datetime(),
    id: z.string(),
    label: z.string(),
    stepSeconds: z.number(),
    to: z.iso.datetime(),
  });
}

export function ArchiveInputSchema(): z.ZodObject<Properties<ArchiveInput>> {
  return z.object({
    _: z.boolean().nullish(),
  });
}

export function AttachBackfillInputSchema(): z.ZodObject<
  Properties<AttachBackfillInput>
> {
  return z.object({
    documentId: z.string(),
    documentType: z.string(),
    id: z.string(),
    label: z.string(),
  });
}

export function BackfillBatchSchema(): z.ZodObject<Properties<BackfillBatch>> {
  return z.object({
    __typename: z.literal("BackfillBatch").optional(),
    every: z.lazy(() => IntervalSchema()),
    size: z.number(),
  });
}

export function BackfillIntentSchema(): z.ZodObject<
  Properties<BackfillIntent>
> {
  return z.object({
    __typename: z.literal("BackfillIntent").optional(),
    batch: z.lazy(() => BackfillBatchSchema().nullish()),
    enabled: z.boolean(),
    items: z.array(z.lazy(() => BackfillItemSchema())),
    pinnedId: z.string().nullish(),
  });
}

export function BackfillItemSchema(): z.ZodObject<Properties<BackfillItem>> {
  return z.object({
    __typename: z.literal("BackfillItem").optional(),
    documentId: z.string().nullish(),
    documentType: z.string(),
    id: z.string(),
    label: z.string(),
    request: z.lazy(() => BackfillRequestSchema().nullish()),
  });
}

export function BackfillRequestSchema() {
  return z.union([DateRangeBackfillSchema(), FolderListBackfillSchema()]);
}

export function BankAccountLinkSchema(): z.ZodObject<
  Properties<BankAccountLink>
> {
  return z.object({
    __typename: z.literal("BankAccountLink").optional(),
    accountId: z.string(),
    accountKey: z.string(),
    bankAccountId: z.string(),
    label: z.string().nullish(),
  });
}

export function BankAccountLinkInputSchema(): z.ZodObject<
  Properties<BankAccountLinkInput>
> {
  return z.object({
    accountId: z.string(),
    accountKey: z.string(),
    bankAccountId: z.string(),
    label: z.string().nullish(),
  });
}

export function CalendarRefSchema(): z.ZodObject<Properties<CalendarRef>> {
  return z.object({
    __typename: z.literal("CalendarRef").optional(),
    id: z.string(),
    name: z.string().nullish(),
  });
}

export function CalendarRefInputSchema(): z.ZodObject<
  Properties<CalendarRefInput>
> {
  return z.object({
    id: z.string(),
    name: z.string().nullish(),
  });
}

export function CalendarSourceSchema(): z.ZodObject<
  Properties<CalendarSource>
> {
  return z.object({
    __typename: z.literal("CalendarSource").optional(),
    allOwned: z.boolean(),
    calendars: z.array(z.lazy(() => CalendarRefSchema())),
  });
}

export function ClearGrantInputSchema(): z.ZodObject<
  Properties<ClearGrantInput>
> {
  return z.object({
    _: z.boolean().nullish(),
  });
}

export function DateRangeBackfillSchema(): z.ZodObject<
  Properties<DateRangeBackfill>
> {
  return z.object({
    __typename: z.literal("DateRangeBackfill").optional(),
    direction: BackfillDirectionSchema.nullish(),
    from: z.iso.datetime(),
    stepSeconds: z.number(),
    to: z.iso.datetime(),
  });
}

export function EmailSourceSchema(): z.ZodObject<Properties<EmailSource>> {
  return z.object({
    __typename: z.literal("EmailSource").optional(),
    address: z.string().nullish(),
    folders: z.array(z.string()),
    mailbox: z.string(),
  });
}

export function FolderListBackfillSchema(): z.ZodObject<
  Properties<FolderListBackfill>
> {
  return z.object({
    __typename: z.literal("FolderListBackfill").optional(),
    folders: z.array(z.string()),
  });
}

export function InitializeInputSchema(): z.ZodObject<
  Properties<InitializeInput>
> {
  return z.object({
    kind: IntegrationKindSchema,
    provider: z.string(),
  });
}

export function IntegrationAppliedSchema(): z.ZodObject<
  Properties<IntegrationApplied>
> {
  return z.object({
    __typename: z.literal("IntegrationApplied").optional(),
    at: z.iso.datetime(),
    generation: z.number(),
    host: z.string().nullish(),
  });
}

export function IntegrationCheckSchema(): z.ZodObject<
  Properties<IntegrationCheck>
> {
  return z.object({
    __typename: z.literal("IntegrationCheck").optional(),
    at: z.iso.datetime(),
    generation: z.number(),
    host: z.string().nullish(),
    issues: z.array(z.lazy(() => IntegrationIssueSchema())),
    request: z.string().nullish(),
  });
}

export function IntegrationCheckRequestSchema(): z.ZodObject<
  Properties<IntegrationCheckRequest>
> {
  return z.object({
    __typename: z.literal("IntegrationCheckRequest").optional(),
    id: z.string(),
    requestedAt: z.iso.datetime(),
    requestedBy: z.string().nullish(),
  });
}

export function IntegrationFixSchema(): z.ZodObject<
  Properties<IntegrationFix>
> {
  return z.object({
    __typename: z.literal("IntegrationFix").optional(),
    at: z.iso.datetime(),
    code: z.string(),
    message: z.string(),
    subject: z.string().nullish(),
  });
}

export function IntegrationFixInputSchema(): z.ZodObject<
  Properties<IntegrationFixInput>
> {
  return z.object({
    at: z.iso.datetime(),
    code: z.string(),
    message: z.string(),
    subject: z.string().nullish(),
  });
}

export function IntegrationGrantSchema(): z.ZodObject<
  Properties<IntegrationGrant>
> {
  return z.object({
    __typename: z.literal("IntegrationGrant").optional(),
    expiresAt: z.iso.datetime(),
    grantedAt: z.iso.datetime(),
    person: z.string(),
    statement: z.string(),
  });
}

export function IntegrationIntentSchema(): z.ZodObject<
  Properties<IntegrationIntent>
> {
  return z.object({
    __typename: z.literal("IntegrationIntent").optional(),
    access: IntegrationAccessSchema.nullish(),
    archived: z.boolean(),
    backfill: z.lazy(() => BackfillIntentSchema()),
    connectionId: z.string().nullish(),
    generation: z.number(),
    live: z.lazy(() => LiveIntentSchema()),
    source: z.lazy(() => IntegrationSourceSchema().nullish()),
    targetDriveId: z.string().nullish(),
  });
}

export function IntegrationIssueSchema(): z.ZodObject<
  Properties<IntegrationIssue>
> {
  return z.object({
    __typename: z.literal("IntegrationIssue").optional(),
    code: z.string(),
    fixable: z.boolean(),
    message: z.string(),
    severity: IssueSeveritySchema,
    since: z.iso.datetime(),
    subject: z.string().nullish(),
  });
}

export function IntegrationIssueInputSchema(): z.ZodObject<
  Properties<IntegrationIssueInput>
> {
  return z.object({
    code: z.string(),
    fixable: z.boolean(),
    message: z.string(),
    severity: IssueSeveritySchema,
    since: z.iso.datetime(),
    subject: z.string().nullish(),
  });
}

export function IntegrationResourcesSchema(): z.ZodObject<
  Properties<IntegrationResources>
> {
  return z.object({
    __typename: z.literal("IntegrationResources").optional(),
    backfillWorkflowId: z.string().nullish(),
    connectionId: z.string().nullish(),
    liveWorkflowId: z.string().nullish(),
    pluggedItemId: z.string().nullish(),
  });
}

export function IntegrationRunnerSchema(): z.ZodObject<
  Properties<IntegrationRunner>
> {
  return z.object({
    __typename: z.literal("IntegrationRunner").optional(),
    label: z.string().nullish(),
    reactorId: z.string(),
  });
}

export function IntegrationSourceSchema() {
  return z.union([
    CalendarSourceSchema(),
    EmailSourceSchema(),
    TransactionsSourceSchema(),
  ]);
}

export function IntegrationStateSchema(): z.ZodObject<
  Properties<IntegrationState>
> {
  return z.object({
    __typename: z.literal("IntegrationState").optional(),
    applied: z.lazy(() => IntegrationAppliedSchema().nullish()),
    check: z.lazy(() => IntegrationCheckSchema().nullish()),
    checkRequest: z.lazy(() => IntegrationCheckRequestSchema().nullish()),
    fixes: z.array(z.lazy(() => IntegrationFixSchema())),
    grant: z.lazy(() => IntegrationGrantSchema().nullish()),
    intent: z.lazy(() => IntegrationIntentSchema()),
    kind: IntegrationKindSchema.nullish(),
    provider: z.string().nullish(),
    providerOptions: z.unknown().nullish(),
    resources: z.lazy(() => IntegrationResourcesSchema()),
    runner: z.lazy(() => IntegrationRunnerSchema().nullish()),
  });
}

export function IntervalSchema(): z.ZodObject<Properties<Interval>> {
  return z.object({
    __typename: z.literal("Interval").optional(),
    unit: IntervalUnitSchema,
    value: z.number(),
  });
}

export function LiveIntentSchema(): z.ZodObject<Properties<LiveIntent>> {
  return z.object({
    __typename: z.literal("LiveIntent").optional(),
    enabled: z.boolean(),
    every: z.lazy(() => IntervalSchema()),
  });
}

export function RecordBackfillDocumentInputSchema(): z.ZodObject<
  Properties<RecordBackfillDocumentInput>
> {
  return z.object({
    documentId: z.string(),
    itemId: z.string(),
  });
}

export function RecordCheckInputSchema(): z.ZodObject<
  Properties<RecordCheckInput>
> {
  return z.object({
    at: z.iso.datetime(),
    committed: z.boolean(),
    fixes: z.array(z.lazy(() => IntegrationFixInputSchema())),
    generation: z.number(),
    host: z.string().nullish(),
    issues: z.array(z.lazy(() => IntegrationIssueInputSchema())),
    request: z.string().nullish(),
  });
}

export function RecordResourcesInputSchema(): z.ZodObject<
  Properties<RecordResourcesInput>
> {
  return z.object({
    backfillWorkflowId: z.string().nullish(),
    connectionId: z.string().nullish(),
    liveWorkflowId: z.string().nullish(),
    pluggedItemId: z.string().nullish(),
  });
}

export function RecordRunnerInputSchema(): z.ZodObject<
  Properties<RecordRunnerInput>
> {
  return z.object({
    label: z.string().nullish(),
    reactorId: z.string(),
  });
}

export function RemoveBackfillInputSchema(): z.ZodObject<
  Properties<RemoveBackfillInput>
> {
  return z.object({
    id: z.string(),
  });
}

export function RequestCheckInputSchema(): z.ZodObject<
  Properties<RequestCheckInput>
> {
  return z.object({
    id: z.string(),
    requestedAt: z.iso.datetime(),
    requestedBy: z.string().nullish(),
  });
}

export function SetAccessInputSchema(): z.ZodObject<
  Properties<SetAccessInput>
> {
  return z.object({
    access: IntegrationAccessSchema,
  });
}

export function SetBackfillEnabledInputSchema(): z.ZodObject<
  Properties<SetBackfillEnabledInput>
> {
  return z.object({
    enabled: z.boolean(),
  });
}

export function SetCalendarSourceInputSchema(): z.ZodObject<
  Properties<SetCalendarSourceInput>
> {
  return z.object({
    allOwned: z.boolean(),
    calendars: z.array(z.lazy(() => CalendarRefInputSchema())),
  });
}

export function SetConnectionInputSchema(): z.ZodObject<
  Properties<SetConnectionInput>
> {
  return z.object({
    connectionId: z.string().nullish(),
  });
}

export function SetEmailSourceInputSchema(): z.ZodObject<
  Properties<SetEmailSourceInput>
> {
  return z.object({
    address: z.string().nullish(),
    folders: z.array(z.string()),
    mailbox: z.string(),
  });
}

export function SetGrantInputSchema(): z.ZodObject<Properties<SetGrantInput>> {
  return z.object({
    expiresAt: z.iso.datetime(),
    grantedAt: z.iso.datetime(),
    person: z.string(),
    statement: z.string(),
  });
}

export function SetLiveEnabledInputSchema(): z.ZodObject<
  Properties<SetLiveEnabledInput>
> {
  return z.object({
    enabled: z.boolean(),
  });
}

export function SetLiveIntervalInputSchema(): z.ZodObject<
  Properties<SetLiveIntervalInput>
> {
  return z.object({
    unit: IntervalUnitSchema,
    value: z.number(),
  });
}

export function SetTransactionsSourceInputSchema(): z.ZodObject<
  Properties<SetTransactionsSourceInput>
> {
  return z.object({
    accounts: z.array(z.lazy(() => BankAccountLinkInputSchema())),
    bankConnectionId: z.string(),
  });
}

export function TransactionsSourceSchema(): z.ZodObject<
  Properties<TransactionsSource>
> {
  return z.object({
    __typename: z.literal("TransactionsSource").optional(),
    accounts: z.array(z.lazy(() => BankAccountLinkSchema())),
    bankConnectionId: z.string(),
  });
}
