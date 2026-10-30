import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "sektar/integration",
  name: "Integration",
  author: {
    name: "Sektar",
    website: "https://sektar.app",
  },
  extension: "intg",
  description:
    "An account Sektar keeps in sync (mail, bank, calendar, hours): what the user asked for, what the reconciler on the runner built for it, the generation it committed, and what it found on its last check.",
  specifications: [
    {
      version: 1,
      changeLog: [],
      state: {
        global: {
          schema:
            'type IntegrationState {\n  "What comes in; fixed by INITIALIZE. Null until then"\n  kind: IntegrationKind\n  "How it comes in: a provider adapter id (google-calendar, gmail, imap). Null until INITIALIZE"\n  provider: String\n  "Settings only this provider has, checked by its adapter"\n  providerOptions: Unknown\n  "What the user asked for; written from the app"\n  intent: IntegrationIntent!\n  "What the reconciler built for the intent"\n  resources: IntegrationResources!\n  "The last intent generation the reconciler committed"\n  applied: IntegrationApplied\n  "The reconciler\'s last pass: what it found"\n  check: IntegrationCheck\n  "A check asked for from the app (Check now)"\n  checkRequest: IntegrationCheckRequest\n  "What the reconciler put back, latest first, at most 20"\n  fixes: [IntegrationFix!]!\n  "The reactor that fetches and holds the token; null: the switchboard that owns this drive, until it claims it"\n  runner: IntegrationRunner\n  "Who lets Sektar write for this integration; null: nobody yet"\n  grant: IntegrationGrant\n}\n\ntype IntegrationGrant {\n  "The signed statement naming this environment\'s runner key (ADR 0008)"\n  statement: String!\n  "The person it acts for"\n  person: String!\n  grantedAt: DateTime!\n  "When the statement ends; a signed-in browser renews it"\n  expiresAt: DateTime!\n}\n\nenum IntegrationKind {\n  EMAIL\n  TRANSACTIONS\n  CALENDAR\n  TIME_TRACKING\n}\n\ntype IntegrationIntent {\n  "Raised by every change to the intent; the reconciler commits a generation"\n  generation: Int!\n  "An existing connection the user picked; null: the reconciler makes one (resources.connectionId)"\n  connectionId: PHID\n  "The drive the imported documents land in; null: the kind\'s default drive"\n  targetDriveId: PHID\n  "What Sektar may do with the account: only read, or read and write. Null: not chosen (read only)"\n  access: IntegrationAccess\n  "What to bring in, per kind and provider-neutral"\n  source: IntegrationSource\n  live: LiveIntent!\n  backfill: BackfillIntent!\n  "An archived integration\'s workflows are archived; its data stays"\n  archived: Boolean!\n}\n\nenum IntegrationAccess {\n  "See, never change: the provider\'s read-only permissions"\n  READ\n  "Also add and change; never delete"\n  READ_WRITE\n}\n\nunion IntegrationSource = CalendarSource | EmailSource | TransactionsSource\n\ntype CalendarSource {\n  "The calendars picked; empty while allOwned"\n  calendars: [CalendarRef!]!\n  "Every calendar the account owns, including ones added later"\n  allOwned: Boolean!\n}\n\ntype CalendarRef {\n  "The provider\'s calendar id"\n  id: String!\n  name: String\n}\n\ntype EmailSource {\n  "The account\'s name in Sektar, and the Mail drive folder its messages go in, e.g. Personal"\n  mailbox: String!\n  "The account\'s address; null until the sign-in names it"\n  address: String\n  "Labels or folders to bring in; empty: all mail"\n  folders: [String!]!\n}\n\ntype TransactionsSource {\n  "The aggregator\'s own id of the bank connection (Distyra: connectionId), e.g. KBC"\n  bankConnectionId: String!\n  "Its accounts, each onto a Sektar bank account"\n  accounts: [BankAccountLink!]!\n}\n\ntype BankAccountLink {\n  "The aggregator\'s account id"\n  accountId: String!\n  "The aggregator\'s stable account key, used in transaction references"\n  accountKey: String!\n  "The sektar/bank-account document its transactions go in"\n  bankAccountId: PHID!\n  label: String\n}\n\ntype LiveIntent {\n  "The Live updates switch"\n  enabled: Boolean!\n  "How often to check for what is new"\n  every: Interval!\n}\n\ntype Interval {\n  value: Int!\n  unit: IntervalUnit!\n}\n\nenum IntervalUnit {\n  MINUTES\n  HOURS\n  DAYS\n}\n\ntype BackfillIntent {\n  "The Backfill switch: the backfill workflow on or off"\n  enabled: Boolean!\n  "How much per run, and how often; null: the provider\'s default"\n  batch: BackfillBatch\n  "In the order they run"\n  items: [BackfillItem!]!\n  "Make active; null: the first unfinished item"\n  pinnedId: OID\n}\n\ntype BackfillBatch {\n  size: Int!\n  every: Interval!\n}\n\ntype BackfillItem {\n  id: OID!\n  "e.g. 2023 to today"\n  label: String!\n  "Any backfill document type with an adapter"\n  documentType: String!\n  "Null until the reconciler has created it from the request"\n  documentId: PHID\n  "How to create it; null when an existing document was attached"\n  request: BackfillRequest\n}\n\nunion BackfillRequest = DateRangeBackfill | FolderListBackfill\n\ntype DateRangeBackfill {\n  from: DateTime!\n  to: DateTime!\n  "The size of one slice"\n  stepSeconds: Int!\n  "Which end it starts from; null: BACKWARD, newest first (the queue\'s own default)"\n  direction: BackfillDirection\n}\n\nenum BackfillDirection {\n  "From the range\'s start towards its end: oldest first"\n  FORWARD\n  "From the range\'s end back towards its start: newest first"\n  BACKWARD\n}\n\ntype FolderListBackfill {\n  folders: [String!]!\n}\n\ntype IntegrationResources {\n  "The connection the reconciler made, when the intent names none"\n  connectionId: PHID\n  liveWorkflowId: PHID\n  backfillWorkflowId: PHID\n  "The backfill item the backfill workflow points at now"\n  pluggedItemId: OID\n}\n\ntype IntegrationApplied {\n  generation: Int!\n  at: DateTime!\n  host: String\n}\n\ntype IntegrationCheck {\n  at: DateTime!\n  host: String\n  "The intent generation this pass evaluated"\n  generation: Int!\n  "The check request it answered, if any"\n  request: OID\n  issues: [IntegrationIssue!]!\n}\n\ntype IntegrationIssue {\n  "Plugin-defined, e.g. NEEDS_SIGN_IN, LIVE_WORKFLOW_MISSING, COVERAGE_GAP"\n  code: String!\n  severity: IssueSeverity!\n  "The workflow, backfill or connection it is about"\n  subject: PHID\n  "In the user\'s words"\n  message: String!\n  "False: only the user can fix it (Reconnect)"\n  fixable: Boolean!\n  since: DateTime!\n}\n\nenum IssueSeverity {\n  INFO\n  WARNING\n  BLOCKING\n}\n\ntype IntegrationCheckRequest {\n  id: OID!\n  requestedAt: DateTime!\n  requestedBy: String\n}\n\ntype IntegrationFix {\n  at: DateTime!\n  code: String!\n  subject: PHID\n  "Put back: ..."\n  message: String!\n}\n\ntype IntegrationRunner {\n  reactorId: String!\n  "The machine\'s name, e.g. Wouter\'s PC"\n  label: String\n}',
          initialValue:
            '{\n  "kind": null,\n  "provider": null,\n  "providerOptions": null,\n  "intent": {\n    "generation": 0,\n    "connectionId": null,\n    "targetDriveId": null,\n    "access": null,\n    "source": null,\n    "live": {\n      "enabled": true,\n      "every": {\n        "value": 5,\n        "unit": "MINUTES"\n      }\n    },\n    "backfill": {\n      "enabled": true,\n      "batch": null,\n      "items": [],\n      "pinnedId": null\n    },\n    "archived": false\n  },\n  "resources": {\n    "connectionId": null,\n    "liveWorkflowId": null,\n    "backfillWorkflowId": null,\n    "pluggedItemId": null\n  },\n  "applied": null,\n  "check": null,\n  "checkRequest": null,\n  "fixes": [],\n  "runner": null,\n  "grant": null\n}',
          examples: [],
        },
        local: {
          schema: "",
          initialValue: "",
          examples: [],
        },
      },
      modules: [
        {
          id: "b305d5dc-3e75-4d5a-b192-cbd4a6e0d8af",
          name: "setup",
          description:
            "What the integration is: its kind, provider, access and source",
          operations: [
            {
              id: "e5532523-06c1-45fb-b1bc-e0b5d6c2bb7e",
              name: "INITIALIZE",
              description: "",
              schema:
                "input InitializeInput {\n  kind: IntegrationKind!\n  provider: String!\n}",
              template: "",
              reducer:
                'if (state.kind) throw new AlreadyInitializedError("The integration is set up already");\nstate.kind = action.input.kind;\nstate.provider = action.input.provider;',
              errors: [
                {
                  id: "c69af2e6-180a-44c2-a651-e30c64e9b9c8",
                  code: "ALREADY_INITIALIZED",
                  name: "AlreadyInitializedError",
                  description:
                    "The integration's kind and provider are set once",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "48973dea-6c06-4b91-8f6f-cf71ca165a6a",
              name: "SET_ACCESS",
              description: "",
              schema: "input SetAccessInput {\n  access: IntegrationAccess!\n}",
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nstate.intent.access = action.input.access;\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "7483fa1e-8f7c-4de8-bcaf-97265b3d1503",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "ea8dbc40-2d46-460e-8f17-cb6865720e1d",
              name: "SET_CONNECTION",
              description: "",
              schema:
                'input SetConnectionInput {\n  "An existing connection to use (an API key shared with others); omit to let the reconciler make one"\n  connectionId: PHID\n}',
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nstate.intent.connectionId = action.input.connectionId ?? null;\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "91dcac92-16ad-4298-b2fd-a343bd824633",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "74bf51c9-fc1e-44a3-9c89-070237d612d9",
              name: "SET_CALENDAR_SOURCE",
              description: "",
              schema:
                "input CalendarRefInput {\n  id: String!\n  name: String\n}\n\ninput SetCalendarSourceInput {\n  calendars: [CalendarRefInput!]!\n  allOwned: Boolean!\n}",
              template: "",
              reducer:
                'if (state.kind !== "CALENDAR") throw new WrongKindError("Only a calendar integration has calendars");\nstate.intent.source = {\n  calendars: action.input.allOwned\n    ? []\n    : action.input.calendars.map((c) => ({ id: c.id, name: c.name ?? null })),\n  allOwned: action.input.allOwned,\n};\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "003f3adc-4d14-436f-bc51-6637520de103",
                  code: "WRONG_KIND",
                  name: "WrongKindError",
                  description:
                    "This source belongs to another kind of integration",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "20f5e2d7-2b53-4b93-8c46-21352d973556",
              name: "SET_EMAIL_SOURCE",
              description: "",
              schema:
                "input SetEmailSourceInput {\n  mailbox: String!\n  address: String\n  folders: [String!]!\n}",
              template: "",
              reducer:
                'if (state.kind !== "EMAIL") throw new WrongKindError("Only an email integration has a mailbox");\nstate.intent.source = {\n  mailbox: action.input.mailbox,\n  address: action.input.address ?? null,\n  folders: action.input.folders,\n};\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "0d6cd97e-4f88-441c-b715-738dda8db39d",
                  code: "WRONG_KIND",
                  name: "WrongKindError",
                  description:
                    "This source belongs to another kind of integration",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "ba7166ba-ac90-4a9e-8908-336992696bdf",
              name: "SET_TRANSACTIONS_SOURCE",
              description: "",
              schema:
                "input BankAccountLinkInput {\n  accountId: String!\n  accountKey: String!\n  bankAccountId: PHID!\n  label: String\n}\n\ninput SetTransactionsSourceInput {\n  bankConnectionId: String!\n  accounts: [BankAccountLinkInput!]!\n}",
              template: "",
              reducer:
                'if (state.kind !== "TRANSACTIONS") throw new WrongKindError("Only a transactions integration has bank accounts");\nstate.intent.source = {\n  bankConnectionId: action.input.bankConnectionId,\n  accounts: action.input.accounts.map((a) => ({\n    accountId: a.accountId,\n    accountKey: a.accountKey,\n    bankAccountId: a.bankAccountId,\n    label: a.label ?? null,\n  })),\n};\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "a428585c-a11c-4080-9ffb-13b8f57f02aa",
                  code: "WRONG_KIND",
                  name: "WrongKindError",
                  description:
                    "This source belongs to another kind of integration",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "95284345-5e58-445a-b7ed-e5917c5668de",
              name: "SET_GRANT",
              description: "The person lets Sektar write for this integration",
              schema:
                'input SetGrantInput {\n  "The signed statement naming this environment\'s runner key"\n  statement: String!\n  "The person it acts for"\n  person: String!\n  grantedAt: DateTime!\n  "When the statement ends"\n  expiresAt: DateTime!\n}',
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nstate.grant = {\n  statement: action.input.statement,\n  person: action.input.person,\n  grantedAt: action.input.grantedAt,\n  expiresAt: action.input.expiresAt,\n};',
              errors: [
                {
                  id: "e30a59fc-dc21-44db-a24e-bfde9abf5f2a",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "89cc62e2-8246-4728-8696-f2e0985019e0",
              name: "CLEAR_GRANT",
              description:
                "Takes the permission back: the reconciler stops signing for this integration",
              schema: "input ClearGrantInput {\n  _: Boolean\n}",
              template: "",
              reducer: "state.grant = null;",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "cdb09d6e-cae4-4688-91c3-df817ce70adf",
          name: "live",
          description: "Live updates: on or off, and how often",
          operations: [
            {
              id: "498cbf11-3781-4b4f-bb52-84bb465dd183",
              name: "SET_LIVE_ENABLED",
              description: "",
              schema: "input SetLiveEnabledInput {\n  enabled: Boolean!\n}",
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nstate.intent.live.enabled = action.input.enabled;\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "59486bca-fa99-473d-84a2-ac8543fb4bde",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "4c56232a-2822-40dc-86b7-3b0f2c082af6",
              name: "SET_LIVE_INTERVAL",
              description: "",
              schema:
                "input SetLiveIntervalInput {\n  value: Int!\n  unit: IntervalUnit!\n}",
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nif (!Number.isInteger(action.input.value) || action.input.value < 1) throw new InvalidIntervalError(`${action.input.value} is not a whole number of at least 1`);\nstate.intent.live.every = { value: action.input.value, unit: action.input.unit };\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "2ceb9f9f-f3d9-45a1-9b5e-6dcbbaa97784",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
                {
                  id: "881cd012-f0c7-4bc6-ad2a-42028cd903a1",
                  code: "INVALID_INTERVAL",
                  name: "InvalidIntervalError",
                  description: "An interval is at least one unit",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "edfa58f3-5538-4708-89ca-3b7cb62f6494",
          name: "backfill",
          description: "Backfills: the switch and the history to bring in",
          operations: [
            {
              id: "c075734e-b2af-4129-a1a9-81aa864000ca",
              name: "SET_BACKFILL_ENABLED",
              description: "",
              schema: "input SetBackfillEnabledInput {\n  enabled: Boolean!\n}",
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nstate.intent.backfill.enabled = action.input.enabled;\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "9e278a69-936a-48ff-92eb-58e21ebaccd6",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "d82ce1f4-0a42-4e6e-ae09-5c5d690f0efc",
              name: "ADD_DATE_RANGE_BACKFILL",
              description: "",
              schema:
                'input AddDateRangeBackfillInput {\n  id: OID!\n  label: String!\n  documentType: String!\n  from: DateTime!\n  to: DateTime!\n  stepSeconds: Int!\n  "Null: BACKWARD"\n  direction: BackfillDirection\n}',
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nconst i = action.input;\nif (state.intent.backfill.items.some((b) => b.id === i.id)) throw new DuplicateBackfillIdError(`A backfill ${i.id} exists`);\nif (!(Date.parse(i.from) < Date.parse(i.to)) || !Number.isInteger(i.stepSeconds) || i.stepSeconds < 60) throw new InvalidRangeError(`${i.from} to ${i.to} in ${i.stepSeconds} s slices`);\nstate.intent.backfill.items.push({\n  id: i.id,\n  label: i.label,\n  documentType: i.documentType,\n  documentId: null,\n  request: { from: i.from, to: i.to, stepSeconds: i.stepSeconds, direction: i.direction ?? null },\n});\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "8d24b4ef-97ac-40d9-887a-9e3106c4eabf",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
                {
                  id: "a956add7-9fd7-4725-a534-7bd9b7a867c6",
                  code: "DUPLICATE_BACKFILL_ID",
                  name: "DuplicateBackfillIdError",
                  description: "A backfill with this id exists",
                  template: "",
                },
                {
                  id: "84069953-6d48-4e82-bead-0bb676b8da77",
                  code: "INVALID_RANGE",
                  name: "InvalidRangeError",
                  description:
                    "A date range starts before it ends, in slices of at least a minute",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "924dabc0-c7c1-4bb0-8bf4-4bb0b8f7e84c",
              name: "ATTACH_BACKFILL",
              description: "",
              schema:
                'input AttachBackfillInput {\n  id: OID!\n  label: String!\n  documentType: String!\n  "An existing backfill document, adopted as it is"\n  documentId: PHID!\n}',
              template: "",
              reducer:
                'if (!state.kind) throw new NotInitializedError("Set up the integration first");\nconst i = action.input;\nif (state.intent.backfill.items.some((b) => b.id === i.id)) throw new DuplicateBackfillIdError(`A backfill ${i.id} exists`);\nstate.intent.backfill.items.push({\n  id: i.id,\n  label: i.label,\n  documentType: i.documentType,\n  documentId: i.documentId,\n  request: null,\n});\nstate.intent.generation += 1;',
              errors: [
                {
                  id: "c79b2ef3-6c13-4ac4-a0f2-b94e10a80c18",
                  code: "NOT_INITIALIZED",
                  name: "NotInitializedError",
                  description:
                    "The integration's kind is set first (INITIALIZE)",
                  template: "",
                },
                {
                  id: "686ce352-b5d4-4c13-bb2f-b703b1f20d81",
                  code: "DUPLICATE_BACKFILL_ID",
                  name: "DuplicateBackfillIdError",
                  description: "A backfill with this id exists",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "99c692b6-9781-41cf-a0b6-cff5e841b16a",
              name: "REMOVE_BACKFILL",
              description: "",
              schema:
                'input RemoveBackfillInput {\n  "The backfill item; its document is the app\'s to delete"\n  id: OID!\n}',
              template: "",
              reducer:
                "const items = state.intent.backfill.items;\nconst index = items.findIndex((b) => b.id === action.input.id);\nif (index < 0) throw new UnknownBackfillError(`No backfill ${action.input.id}`);\nitems.splice(index, 1);\nif (state.intent.backfill.pinnedId === action.input.id) state.intent.backfill.pinnedId = null;\nstate.intent.generation += 1;",
              errors: [
                {
                  id: "7c749784-3791-4865-ab27-a4e0003813cc",
                  code: "UNKNOWN_BACKFILL",
                  name: "UnknownBackfillError",
                  description:
                    "The integration has no backfill item with this id",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "eff99f10-4d88-4de5-b0a3-fa3e5f93297b",
          name: "reconciler",
          description:
            "What the reconciler on the runner writes back: who runs it, what it built, what it found; and the app asking it to look again",
          operations: [
            {
              id: "768646ca-f3d7-4ebf-a811-32ecbe52722b",
              name: "REQUEST_CHECK",
              description: "",
              schema:
                "input RequestCheckInput {\n  id: OID!\n  requestedAt: DateTime!\n  requestedBy: String\n}",
              template: "",
              reducer:
                "state.checkRequest = {\n  id: action.input.id,\n  requestedAt: action.input.requestedAt,\n  requestedBy: action.input.requestedBy ?? null,\n};",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "e5ac9883-3b4c-40fc-8ce5-b711fd6c3b8a",
              name: "RECORD_RUNNER",
              description: "",
              schema:
                "input RecordRunnerInput {\n  reactorId: String!\n  label: String\n}",
              template: "",
              reducer:
                "if (state.runner && state.runner.reactorId !== action.input.reactorId) throw new RunnerTakenError(`${state.runner.reactorId} runs this integration`);\nstate.runner = { reactorId: action.input.reactorId, label: action.input.label ?? null };",
              errors: [
                {
                  id: "42c4a3b2-20d1-45cc-bd4e-fb647b6a7770",
                  code: "RUNNER_TAKEN",
                  name: "RunnerTakenError",
                  description: "Another switchboard runs this integration",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "f04635bc-2949-417a-b19d-e3f236dfecd3",
              name: "RECORD_RESOURCES",
              description: "",
              schema:
                "input RecordResourcesInput {\n  connectionId: PHID\n  liveWorkflowId: PHID\n  backfillWorkflowId: PHID\n  pluggedItemId: OID\n}",
              template: "",
              reducer:
                "const i = action.input;\nconst r = state.resources;\nif (i.connectionId) r.connectionId = i.connectionId;\nif (i.liveWorkflowId) r.liveWorkflowId = i.liveWorkflowId;\nif (i.backfillWorkflowId) r.backfillWorkflowId = i.backfillWorkflowId;\nif (i.pluggedItemId) r.pluggedItemId = i.pluggedItemId;",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "bac19d2e-def9-4af8-8f93-5b317398cb18",
              name: "RECORD_BACKFILL_DOCUMENT",
              description: "",
              schema:
                'input RecordBackfillDocumentInput {\n  "The backfill item"\n  itemId: OID!\n  "The backfill document the reconciler created for it"\n  documentId: PHID!\n}',
              template: "",
              reducer:
                "const item = state.intent.backfill.items.find((b) => b.id === action.input.itemId);\nif (!item) throw new BackfillNotFoundError(`No backfill ${action.input.itemId}`);\nitem.documentId = action.input.documentId;",
              errors: [
                {
                  id: "c650f6bc-cb0c-419f-ac30-73bbf09fdad0",
                  code: "BACKFILL_NOT_FOUND",
                  name: "BackfillNotFoundError",
                  description:
                    "The integration has no backfill item with this id",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "de9acea1-fa7e-477e-af7d-f08670a83c50",
              name: "RECORD_CHECK",
              description: "",
              schema:
                'input IntegrationIssueInput {\n  code: String!\n  severity: IssueSeverity!\n  subject: PHID\n  message: String!\n  fixable: Boolean!\n  since: DateTime!\n}\n\ninput IntegrationFixInput {\n  at: DateTime!\n  code: String!\n  subject: PHID\n  message: String!\n}\n\ninput RecordCheckInput {\n  at: DateTime!\n  host: String\n  "The intent generation this pass evaluated"\n  generation: Int!\n  "The check request it answered, if any"\n  request: OID\n  issues: [IntegrationIssueInput!]!\n  fixes: [IntegrationFixInput!]!\n  "Everything the reconciler can do for this generation is done"\n  committed: Boolean!\n}',
              template: "",
              reducer:
                "const i = action.input;\nstate.check = {\n  at: i.at,\n  host: i.host ?? null,\n  generation: i.generation,\n  request: i.request ?? null,\n  issues: i.issues.map((x) => ({\n    code: x.code,\n    severity: x.severity,\n    subject: x.subject ?? null,\n    message: x.message,\n    fixable: x.fixable,\n    since: x.since,\n  })),\n};\nif (i.request && state.checkRequest?.id === i.request) state.checkRequest = null;\nstate.fixes = [\n  ...i.fixes.map((f) => ({ at: f.at, code: f.code, subject: f.subject ?? null, message: f.message })),\n  ...state.fixes,\n].slice(0, 20);\n// A commit for an older generation is ignored: the user changed something meanwhile.\nif (i.committed && i.generation === state.intent.generation) {\n  state.applied = { generation: i.generation, at: i.at, host: i.host ?? null };\n}",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "2186f0c9-7ac8-4a60-b2bf-abc7e52c0b8c",
          name: "lifecycle",
          description:
            "Removing an integration: the user asks, the reconciler takes down what it built",
          operations: [
            {
              id: "cd27336a-c6c1-428c-9aed-56316e3585ef",
              name: "ARCHIVE",
              description: "",
              schema:
                'input ArchiveInput {\n  "The empty-input workaround: ARCHIVE takes nothing"\n  _: Boolean\n}',
              template: "",
              reducer:
                "if (!state.intent.archived) {\n  state.intent.archived = true;\n  state.intent.generation += 1;\n}",
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
    },
  ],
};
