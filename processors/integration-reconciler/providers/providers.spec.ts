// Relocation parity: the Gmail and Distyra providers build what the mail and
// bank workflows that predate integrations run, as read from the switchboard
// on 2026-10-28, so adopting them changes nothing but the sign-in.
import {
  initialize,
  reducer,
  setEmailSource,
  setLiveInterval,
  setTransactionsSource,
  utils,
} from "document-models/integration/v1";
import { describe, expect, it } from "vitest";
import {
  backfillWorkflowSpec,
  liveWorkflowSpec,
} from "../backfill-workflow.js";
import { workflowDrift, type WorkflowFacts } from "../workflow-spec.js";
import { distyra } from "./distyra.js";
import { gmail } from "./gmail.js";

const newId = () => "id-new";
const MAIL_DRIVE_ID = "the-mail-drive";

type Action = Parameters<typeof reducer>[1];
const state = (...list: Action[]) =>
  list.reduce((d, a) => reducer(d, a), utils.createDocument()).state.global;

const AT = "2026-10-28T16:00:00.000Z";
const REACTOR = "sjyi6ZL8WbAp2ugIdSti-U6A92OlOaOTYkIbxZ0ralU";

describe("Gmail, as the existing mail workflows run", () => {
  const personal = state(
    initialize({ kind: "EMAIL", provider: "gmail" }),
    setEmailSource({ mailbox: "Personal", folders: [] }),
    setLiveInterval({ value: 2, unit: "HOURS" }),
  );
  const ctx = {
    name: "Personal mail",
    state: personal,
    connectionId: "conn-new",
    accountLabel: "wkampmann@gmail.com",
    reactorConnectionId: REACTOR,
    driveId: MAIL_DRIVE_ID,
  };

  it("checks for new mail on the same schedule, with the same search, mapping and upsert", () => {
    const spec = liveWorkflowSpec(gmail, ctx);
    expect(spec.trigger).toMatchObject({
      pieceName: "@powerhousedao/piece-core",
      triggerName: "schedule",
      config: { mode: "interval", unit: "hours", every: 2, timezone: "UTC" },
    });
    expect(
      spec.steps.map((s) => [s.key, s.pieceName, s.actionName, s.config]),
    ).toEqual([
      [
        "search_email",
        "@activepieces/piece-gmail",
        "gmail_search_email",
        { max_results: 100, has_attachment: false, include_spam_trash: false },
      ],
      [
        "map_emails",
        "@powerhousedao/distyra-piece",
        "gmail-to-email",
        {
          labels: "",
          messages: "{{steps.search_email.output.results.messages}}",
          accountName: "Personal",
          includeHtml: true,
          accountAddress: "wkampmann@gmail.com",
          includeHeaders: true,
        },
      ],
      [
        "upsert_emails",
        "@powerhousedao/distyra-piece",
        "upsert-documents",
        {
          name: "$item.name",
          items: "{{steps.map_emails.output.items}}",
          limit: 500,
          driveId: MAIL_DRIVE_ID,
          folderName: "$item.folder",
          itemKeyPath: "key",
          stopOnError: false,
          documentType: "sektar/email",
          createActions: "$item.actions",
          updateActions: "[]",
          documentKeyPath: "externalId",
        },
      ],
    ]);
    expect(spec.steps[0]?.connectionId).toBe("conn-new");
    expect(spec.steps[2]?.reactorConnectionId).toBe(REACTOR);
  });

  it("walks a day of mail a minute under the queue's own cursor", () => {
    const spec = backfillWorkflowSpec(gmail, ctx, "WICX", true, "day");
    expect(spec.trigger.config).toEqual({
      documentId: "WICX",
      pollEverySeconds: 60,
    });
    expect(spec.steps[0]?.config).toEqual({
      after_date: "{{trigger.payload.ranges.day.from}}",
      before_date: "{{trigger.payload.ranges.day.to}}",
      max_results: 500,
      has_attachment: false,
      include_spam_trash: false,
    });
    // The day is only left once it is in.
    expect(spec.steps.at(-1)).toMatchObject({
      key: "proceed",
      actionName: "osq-proceed",
      config: { documentId: "WICX", position: "{{trigger.payload}}" },
    });
  });

  it("adopting an existing workflow only moves it to the new sign-in", () => {
    const spec = liveWorkflowSpec(gmail, ctx);
    const legacy: WorkflowFacts = {
      status: "ENABLED",
      version: 11,
      publishedVersion: 11,
      triggerName: "schedule",
      triggerConnectionId: null,
      triggerConfig: {
        mode: "interval",
        unit: "hours",
        every: 2,
        timezone: "UTC",
      },
      triggerReactorConnectionId: null,
      // As published today, settings included (read 2026-10-28)
      steps: spec.steps.map((step, i) => ({
        id: `s${i + 1}`,
        key: step.key,
        connectionId: i === 0 ? "zpxupzJsW7" : null,
        config: JSON.parse(JSON.stringify(step.config)) as Record<
          string,
          unknown
        >,
      })),
    };
    const d = workflowDrift(spec, legacy, AT, newId);
    expect(d.differences).toEqual(["the workflow used another Google sign-in"]);
    expect(d.actions.map((a) => [a.type, a.input])).toEqual([
      ["UPDATE_STEP", { id: "s1", connectionId: "conn-new" }],
      ["PUBLISH_WORKFLOW", { publishedAt: AT }],
    ]);
    // A changed schedule reads as a schedule
    expect(
      workflowDrift(
        spec,
        { ...legacy, triggerConfig: { ...legacy.triggerConfig, every: 1 } },
        AT,
        newId,
      ).differences[0],
    ).toBe("the workflow ran every hour, not every 2 hours");
  });

  it("asks Google for read-only mail and who signed in", () => {
    expect(gmail.connection("Personal mail", personal)?.config).toEqual({
      oauth_app: "sektar-google",
      oauth_scopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
    });
  });
});

describe("Distyra, as the existing transaction workflows run", () => {
  const kbc = state(
    initialize({ kind: "TRANSACTIONS", provider: "distyra" }),
    setTransactionsSource({
      bankConnectionId: "5f3665c9-a1c1-4c15-95f9-566de0c783b8",
      accounts: [
        {
          accountId: "47af97c7",
          accountKey: "ak1_d3b6",
          bankAccountId: "JNBMjvNI",
        },
        {
          accountId: "0af05ed7",
          accountKey: "ak1_0b7b",
          bankAccountId: "90TTzVxT",
        },
      ],
    }),
    setLiveInterval({ value: 6, unit: "HOURS" }),
  );

  it("pulls the bank connection every 6 hours and imports each account onto its bank account", () => {
    const spec = liveWorkflowSpec(distyra, {
      name: "KBC",
      state: kbc,
      connectionId: "WSEf1HivUP",
      accountLabel: null,
      reactorConnectionId: REACTOR,
      driveId: "",
    });
    expect(spec.trigger.config).toEqual({
      mode: "interval",
      unit: "hours",
      every: 6,
      timezone: "UTC",
    });
    expect(
      spec.steps.map((s) => [
        s.key,
        s.actionName,
        s.connectionId,
        s.reactorConnectionId,
        s.config,
      ]),
    ).toEqual([
      [
        "pull",
        "get-latest-transactions",
        "WSEf1HivUP",
        undefined,
        {
          enrich: false,
          history: "automatic",
          connectionId: "5f3665c9-a1c1-4c15-95f9-566de0c783b8",
          // the person on screen, on a manual refresh only (null when scheduled)
          psuIpAddress: "{{trigger.payload.psu.ipAddress?}}",
          psuUserAgent: "{{trigger.payload.psu.userAgent?}}",
        },
      ],
      [
        "import_1",
        "import-to-bank-account",
        undefined,
        REACTOR,
        {
          accountId: "47af97c7",
          accountKey: "ak1_d3b6",
          transactions: "{{steps.pull.output.transactions}}",
          bankAccountId: "JNBMjvNI",
        },
      ],
      [
        "import_2",
        "import-to-bank-account",
        undefined,
        REACTOR,
        expect.objectContaining({
          accountId: "0af05ed7",
          bankAccountId: "90TTzVxT",
        }),
      ],
    ]);
    expect(distyra.auth).toBe("apiKey");
    expect(distyra.backfillPollSeconds).toBeUndefined();
    expect(distyra.connection("KBC", kbc)).toBeNull();
    expect(distyra.backfillSteps({} as never, "day")).toEqual([]);
  });
});

describe("a renamed mailbox", () => {
  it("reaches the mapping step of the workflow it built", () => {
    const before = state(
      initialize({ kind: "EMAIL", provider: "gmail" }),
      setEmailSource({ mailbox: "Personal Email", folders: [] }),
    );
    const after = state(
      initialize({ kind: "EMAIL", provider: "gmail" }),
      setEmailSource({
        mailbox: "Personal",
        address: "wkampmann@gmail.com",
        folders: [],
      }),
    );
    const ctx = (s: typeof before) => ({
      name: "Personal Email",
      state: s,
      connectionId: "c",
      accountLabel: "wkampmann@gmail.com",
      reactorConnectionId: REACTOR,
      driveId: MAIL_DRIVE_ID,
    });
    const built = liveWorkflowSpec(gmail, ctx(before));
    const facts: WorkflowFacts = {
      status: "ENABLED",
      version: 1,
      publishedVersion: 1,
      triggerName: "schedule",
      triggerConnectionId: null,
      triggerConfig: built.trigger.config,
      steps: built.steps.map((step, i) => ({
        id: `s${i + 1}`,
        key: step.key,
        connectionId: step.connectionId ?? null,
        config: step.config,
      })),
    };
    const d = workflowDrift(
      liveWorkflowSpec(gmail, ctx(after)),
      facts,
      AT,
      newId,
    );
    expect(d.differences).toEqual([
      `the workflow's step "Gmail Messages to Emails" was changed`,
    ]);
    expect(d.actions[0]?.input).toMatchObject({
      id: "s2",
      config: {
        accountName: "Personal",
        accountAddress: "wkampmann@gmail.com",
      },
    });
  });
});
