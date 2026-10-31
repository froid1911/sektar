/**
 * Gmail, as the mail workflows that predate integrations run it (relocated,
 * not redesigned): on a schedule, Search Email for the latest messages; per
 * backfill day, Search Email for that day; then distyra gmail-to-email and
 * Upsert Documents into the Mail drive, keyed gmail:<id>, a folder per
 * account. The sign-in is the publisher's Google app with read-only mail.
 */
import type { IntegrationState } from "document-models/integration";
import { DISTYRA_PIECE, DISTYRA_PIECE_VERSION } from "../pieces.js";
import type { StepSpec } from "../workflow-spec.js";
import { GOOGLE_APP } from "./google-calendar.js";
import { scheduleTrigger, scheduleWords } from "./schedule.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";

export const GMAIL_PIECE = "@activepieces/piece-gmail";
export const GMAIL_PIECE_VERSION = "0.18.1";
/**
 * The Mail drive, by the slug the host declares it under (hosts/switchboard).
 * The reconciler resolves it (io.drive) and files mail under the id it finds.
 */
export const MAIL_DRIVE_SLUG = "mail";
export const EMAIL_TYPE = "sektar/email";

const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email"];
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

type EmailSource = { mailbox: string; address?: string | null };

function source(state: IntegrationState): EmailSource {
  const s = state.intent.source as Partial<EmailSource> | null;
  return { mailbox: s?.mailbox ?? "Mail", address: s?.address ?? null };
}

/** The Google account an address belongs to: lower case, without a +tag. */
export function googleAccount(address: string): string {
  const [local = "", domain = ""] = address.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

function searchStep(
  connectionId: string,
  config: Record<string, unknown>,
): StepSpec {
  return {
    key: "search_email",
    name: "Search Email",
    pieceName: GMAIL_PIECE,
    pieceVersion: GMAIL_PIECE_VERSION,
    actionName: "gmail_search_email",
    connectionId,
    config: { has_attachment: false, include_spam_trash: false, ...config },
  };
}

/** gmail-to-email then the upsert, as the existing mail workflows have them. */
function tail(ctx: ProviderContext): StepSpec[] {
  const { mailbox, address } = source(ctx.state);
  return [
    {
      key: "map_emails",
      name: "Gmail Messages to Emails",
      pieceName: DISTYRA_PIECE,
      pieceVersion: DISTYRA_PIECE_VERSION,
      actionName: "gmail-to-email",
      config: {
        labels: "",
        messages: "{{steps.search_email.output.results.messages}}",
        accountName: mailbox,
        accountAddress: address ?? ctx.accountLabel ?? "",
        includeHtml: true,
        includeHeaders: true,
      },
    },
    {
      key: "upsert_emails",
      name: "Upsert Documents",
      pieceName: DISTYRA_PIECE,
      pieceVersion: DISTYRA_PIECE_VERSION,
      actionName: "upsert-documents",
      reactorConnectionId: ctx.reactorConnectionId,
      config: {
        name: "$item.name",
        items: "{{steps.map_emails.output.items}}",
        limit: 500,
        driveId: ctx.driveId,
        folderName: "$item.folder",
        itemKeyPath: "key",
        stopOnError: false,
        documentType: EMAIL_TYPE,
        createActions: "$item.actions",
        updateActions: "[]",
        documentKeyPath: "externalId",
      },
    },
  ];
}

export const gmail: ProviderAdapter = {
  id: "gmail",
  label: "Google",
  auth: "oauth",
  drive: MAIL_DRIVE_SLUG,
  // A day of mail a minute, as the largest existing backfill walks
  backfillPollSeconds: 60,
  backfillSliceSeconds: 86_400,

  expectedAccount(state: IntegrationState) {
    const address = source(state).address;
    return address ? googleAccount(address) : null;
  },

  connection(name: string) {
    return {
      name: `${name} · Google`,
      connectorId: "@activepieces/piece-gmail#gmail",
      config: {
        oauth_app: GOOGLE_APP,
        oauth_scopes: [...IDENTITY, GMAIL_READ],
      },
    };
  },

  live(ctx: ProviderContext) {
    return {
      name: `${ctx.name} · new mail`,
      trigger: scheduleTrigger(ctx.state),
      steps: [
        // The latest messages; the upsert skips the ones already in
        searchStep(ctx.connectionId, { max_results: 100 }),
        ...tail(ctx),
      ],
      config: scheduleWords,
    };
  },

  backfillSteps(ctx: ProviderContext, range: string) {
    return [
      searchStep(ctx.connectionId, {
        after_date: `{{trigger.payload.ranges.${range}.from}}`,
        before_date: `{{trigger.payload.ranges.${range}.to}}`,
        max_results: 500,
      }),
      ...tail(ctx),
    ];
  },
};
