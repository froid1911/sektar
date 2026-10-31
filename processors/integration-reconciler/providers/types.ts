/**
 * What a provider brings to an integration (integrations design §3a): the
 * connection to make, the live workflow's trigger and steps, and the steps a
 * backfill slice runs after the queue's for-every trigger. Everything else
 * (claiming, sign-in, queues, plugging, drift, health, teardown) is the
 * reconciler core's, the same for every kind.
 */
import type { IntegrationState } from "document-models/integration";
import type { DriftWords, StepSpec, TriggerSpec } from "../workflow-spec.js";

export type ConnectionSpec = {
  name: string;
  connectorId: string;
  config: Record<string, unknown>;
};

/** What the provider's workflows are built with. */
export type ProviderContext = {
  /** The integration's name */
  name: string;
  state: IntegrationState;
  /** The provider connection: the sign-in the reconciler made, or the one it was given */
  connectionId: string;
  /** Who the connection is (its label, e.g. the signed-in address); null: not known yet */
  accountLabel: string | null;
  /** The switchboard's own connection, for steps that write documents */
  reactorConnectionId: string;
  /** The id of the drive the provider files into (`drive`); "" for a provider without one */
  driveId: string;
};

export interface ProviderAdapter {
  /** The integration's provider id, e.g. "google-calendar" */
  id: string;
  /** Whose sign-in, in words: "Google" */
  label: string;
  /**
   * How it connects. oauth: the reconciler makes the connection and asks
   * for a sign-in on the runner. apiKey: it uses a connection it is given
   * (resources.connectionId or intent.connectionId) and never deletes it.
   */
  auth: "oauth" | "apiKey";
  /** The connection to make (oauth); null when this setup cannot be served */
  connection(name: string, state: IntegrationState): ConnectionSpec | null;
  /**
   * The account a sign-in must be (normalised, e.g. an address without its
   * +tag); null: any. A sign-in as someone else is refused, so one account's
   * data never lands in another's place.
   */
  expectedAccount?(state: IntegrationState): string | null;
  /**
   * The slug of the drive it files documents into ("mail", "calendar"): no
   * workflow is built while it is missing
   */
  drive?: "mail" | "calendar";
  /** Seconds between backfill slices; absent: no backfill */
  backfillPollSeconds?: number;
  /** One backfill slice, for backfills the reconciler adds (a gap) */
  backfillSliceSeconds?: number;
  /** The live workflow: its name, trigger and steps */
  live(ctx: ProviderContext): {
    name: string;
    trigger: TriggerSpec;
    steps: StepSpec[];
    /** How a changed trigger config reads, e.g. "checked every hour, not every 15 minutes" */
    config: DriftWords["config"];
  };
  /**
   * The steps one backfill slice runs; they read the window as
   * {{trigger.payload.ranges.<range>.from/to}}, range being the queue's
   * cursor (its lowercased name: slice, day).
   */
  backfillSteps(ctx: ProviderContext, range: string): StepSpec[];
}
