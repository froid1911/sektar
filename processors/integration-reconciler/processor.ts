/**
 * The integration reconciler: on the switchboard that runs an integration,
 * makes the system match what the integration document asks for, and writes
 * back what it built and found (reconcile.ts). It acts on re-read state, one
 * pass per integration at a time, never on an operation's payload: a replay
 * cannot do anything twice. Passes run when an integration changes, at
 * startup, and every minute (a sign-in finishes on the connection, which this
 * processor does not watch; REQUEST_CHECK asks for an immediate pass).
 */
import type {
  IProcessor,
  IProcessorHostModule,
  OperationWithContext,
} from "@powerhousedao/reactor-browser";
import {
  actions as connectionActions,
  utils as connectionUtils,
} from "@powerhousedao/workflow/document-models/connection";
import { utils as workflowUtils } from "@powerhousedao/workflow/document-models/workflow";
import { generateId } from "document-model";
import { utils as queueUtils } from "document-models/original-source-queue";
import type { QueueState } from "../../editors/backfills/progress.js";
import type { IntegrationState } from "document-models/integration";
import { hostname } from "node:os";
import type {
  RuntimeHealth,
  StepRetry,
  WorkflowFacts,
} from "./workflow-spec.js";
import {
  reconcileIntegration,
  type ConnectionFacts,
  type ReconcileIO,
} from "./reconcile.js";
import { resolveDriveId } from "processors/drive-ids";
import {
  noteRecorded,
  withRecorded,
  type RecordedResources,
} from "./recorded-resources.js";
import { runnerIdentity } from "./runner.js";

export const INTEGRATION_TYPE = "sektar/integration";
/** The switchboard's own reactor connection: steps that write documents use it. */
const REACTOR_CONNECTOR = "@powerhousedao/reactor#reactor";
/** Where backfill queues live (hosts/*: slug "backfills", drive app backfills) */
const BACKFILLS_DRIVE = "backfills";
const SWEEP_MS = 60_000;
const STARTUP_MS = 5_000;

type Module = Pick<IProcessorHostModule, "read" | "dispatch" | "getReadModel">;

/** The workflow runtime's read model (Powerhouse reactor-workflow): present where the runtime runs. */
const WORKFLOW_TRIGGERS_READ_MODEL = "workflow-triggers";
type WorkflowHealthReader = {
  health(workflowId: string): Promise<RuntimeHealth>;
};

export class IntegrationReconciler implements IProcessor {
  private queue: Promise<void> = Promise.resolve();
  private readonly waiting = new Set<string>();
  /** Per integration, what this runner recorded and has not read back (recorded-resources.ts) */
  private readonly recorded = new Map<string, RecordedResources>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  // The machine locally; the PUBLIC_URL host in an environment (runner.ts)
  private readonly identity = runnerIdentity(process.env.PUBLIC_URL, hostname());

  constructor(
    private readonly driveId: string,
    private readonly module: Module,
  ) {}

  /** Starts the startup pass and the minute sweep. */
  start(): void {
    const startup = setTimeout(() => this.sweep(), STARTUP_MS);
    const sweep = setInterval(() => this.sweep(), SWEEP_MS);
    startup.unref?.();
    sweep.unref?.();
    this.timers = [startup, sweep];
  }

  onOperations(operations: OperationWithContext[]): Promise<void> {
    for (const { context } of operations) {
      if (context.documentType === INTEGRATION_TYPE) {
        this.consider(context.documentId);
      }
    }
    return Promise.resolve();
  }

  onDisconnect(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    return Promise.resolve();
  }

  private sweep(): void {
    if (this.stopped) return;
    void this.module.read
      .find({ type: INTEGRATION_TYPE, parentId: this.driveId })
      .then((page) => {
        for (const doc of page.results) this.consider(doc.header.id);
      })
      .catch((error: unknown) =>
        console.warn(`[integration-reconciler] sweep failed: ${String(error)}`),
      );
  }

  /** Queues one pass for the integration, unless one is already waiting. */
  private consider(id: string): void {
    if (this.stopped || this.waiting.has(id)) return;
    this.waiting.add(id);
    this.queue = this.queue.then(async () => {
      this.waiting.delete(id);
      try {
        await this.pass(id);
      } catch (error) {
        console.warn(
          `[integration-reconciler] ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  private async pass(id: string): Promise<void> {
    let doc;
    try {
      doc = await this.module.read.get(id);
    } catch {
      return; // deleted
    }
    const read = (doc.state as unknown as { global: IntegrationState }).global;
    // What the last pass recorded may not be readable yet: never make it twice
    const overlay = withRecorded(
      read.resources,
      this.recorded.get(id) ?? {},
      Date.now(),
    );
    if (Object.keys(overlay.recorded).length > 0) {
      this.recorded.set(id, overlay.recorded);
    } else {
      this.recorded.delete(id);
    }
    await reconcileIntegration(
      {
        id,
        name: doc.header.name,
        state: { ...read, resources: overlay.resources },
      },
      this.io(id),
    );
  }

  private io(integrationId: string): ReconcileIO {
    const { read, dispatch } = this.module;
    return {
      me: this.identity.me,
      environment: this.identity.environment,
      now: () => new Date().toISOString(),
      readConnection: async (id) => {
        let doc;
        try {
          doc = await read.get(id);
        } catch {
          return null;
        }
        const g = (
          doc.state as unknown as {
            global: {
              status: string;
              secretRefs: { name: string }[];
              config: Record<string, unknown> | null;
              accountLabel?: string | null;
            };
          }
        ).global;
        const strings = (v: unknown) =>
          Array.isArray(v)
            ? v.filter((x): x is string => typeof x === "string")
            : null;
        const facts: ConnectionFacts = {
          status: g.status,
          signedIn: g.secretRefs.some((r) => r.name === "token"),
          scopes: strings(g.config?.oauth_scopes) ?? [],
          granted: strings(g.config?.oauth_granted_scopes),
          accountLabel: g.accountLabel ?? null,
        };
        return facts;
      },
      createConnection: async (spec) => {
        const workflows = await read.get("workflows");
        const document = connectionUtils.createDocument();
        document.header.name = spec.name;
        const created = await dispatch.createInDrive(
          workflows.header.id,
          document,
        );
        const id = created.documentId || document.header.id;
        await dispatch.execute(id, "main", [
          connectionActions.setConnectionName({ name: spec.name }),
          connectionActions.setConnector({
            connectorId: spec.connectorId,
            authType: "OAUTH2",
          }),
          connectionActions.setConfig({ config: spec.config }),
        ]);
        return id;
      },
      setConnectionConfig: async (id, config) => {
        // Value by value: the runtime's own keys (oauth_granted_scopes) stay
        await dispatch.execute(
          id,
          "main",
          Object.entries(config).map(([name, value]) =>
            connectionActions.setConfigValue({ name, value }),
          ),
        );
      },
      dispatch: async (list) => {
        await dispatch.execute(integrationId, "main", list);
        this.recorded.set(
          integrationId,
          noteRecorded(this.recorded.get(integrationId) ?? {}, list, Date.now()),
        );
      },
      deleteDocument: async (id) => {
        try {
          await dispatch.deleteDocument(id);
        } catch (error) {
          // Already gone is what removal wants.
          if (!/not found/i.test(String(error))) throw error;
        }
      },
      deleteIntegration: async () => {
        await dispatch.deleteDocument(integrationId);
      },
      newId: () => generateId(),
      // The converted drive where it exists, else the one made under the slug
      drive: (slug) => resolveDriveId(read, slug),
      findReactorConnection: async () => {
        const page = await read.find({ type: "powerhouse/connection" });
        const found = page.results.find((doc) => {
          const g = (
            doc.state as unknown as {
              global: { connectorId?: string; authType?: string };
            }
          ).global;
          return (
            g.connectorId === REACTOR_CONNECTOR && g.authType === "REACTOR"
          );
        });
        return found?.header.id ?? null;
      },
      readWorkflow: async (id) => {
        let doc;
        try {
          doc = await read.get(id);
        } catch {
          return null;
        }
        const g = (
          doc.state as unknown as {
            global: {
              status: string;
              version: number;
              managedBy?: { documentId: string } | null;
              published: {
                version: number;
                trigger: {
                  triggerName: string;
                  connectionId: string | null;
                  reactorConnectionId?: string | null;
                  config: Record<string, unknown>;
                } | null;
                steps?: {
                  id: string;
                  key: string;
                  connectionId?: string | null;
                  config?: Record<string, unknown> | null;
                }[];
                policy?: { defaultRetry?: StepRetry | null } | null;
              } | null;
            };
          }
        ).global;
        const trigger = g.published?.trigger ?? null;
        const facts: WorkflowFacts = {
          status: g.status,
          version: g.version,
          publishedVersion: g.published?.version ?? null,
          triggerName: trigger?.triggerName ?? null,
          triggerConnectionId: trigger?.connectionId ?? null,
          triggerConfig: trigger?.config ?? null,
          triggerReactorConnectionId: trigger?.reactorConnectionId ?? null,
          managedBy: g.managedBy?.documentId ?? null,
          defaultRetry: g.published?.policy?.defaultRetry ?? null,
          steps: (g.published?.steps ?? []).map((step) => ({
            id: step.id,
            key: step.key,
            connectionId: step.connectionId ?? null,
            config: step.config ?? null,
          })),
        };
        return facts;
      },
      createWorkflow: async (name, list) => {
        const workflows = await read.get("workflows");
        const document = workflowUtils.createDocument();
        document.header.name = name;
        const created = await dispatch.createInDrive(
          workflows.header.id,
          document,
        );
        const id = created.documentId || document.header.id;
        await dispatch.execute(id, "main", list);
        return id;
      },
      updateWorkflow: async (id, list) => {
        await dispatch.execute(id, "main", list);
      },
      createQueue: async (name, list) => {
        const backfills = await resolveDriveId(read, BACKFILLS_DRIVE);
        if (!backfills) {
          throw new Error(
            this.identity.environment
              ? "The Backfills drive is not in this environment yet"
              : "The Backfills drive is not on this computer yet",
          );
        }
        const document = queueUtils.createDocument();
        document.header.name = name;
        const created = await dispatch.createInDrive(
          backfills,
          document,
        );
        const id = created.documentId || document.header.id;
        await dispatch.execute(id, "main", list);
        return id;
      },
      readQueue: async (id) => {
        try {
          const doc = await read.get(id);
          return (doc.state as unknown as { global: QueueState }).global;
        } catch {
          return null;
        }
      },
      workflowHealth: async (id) => {
        let reader: WorkflowHealthReader;
        try {
          reader = this.module.getReadModel<WorkflowHealthReader>(
            WORKFLOW_TRIGGERS_READ_MODEL,
          );
        } catch {
          return null; // no runtime on this host
        }
        // An older runtime without health(): nothing to say
        if (typeof reader.health !== "function") return null;
        return reader.health(id);
      },
    };
  }
}
