import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import {
  findReactorConnection,
  INTEGRATION_TYPE,
  IntegrationReconciler,
} from "./processor.js";
import { loadRunnerKey } from "./runner-key.js";

/** The drive the host files declare for them. */
const INTEGRATIONS_DRIVE = "integrations";

/**
 * What the grant step asks before it signs: which key to name, for which
 * environment, whether a person is needed here, and whether the reactor
 * connection exists. It comes from the host and not from a document, so a
 * writer of a document cannot get a person to sign for their own key.
 */
function serveRunnerFacts(module: IProcessorHostModule): void {
  try {
    module.http?.get("runner", async () => {
      const key = await loadRunnerKey();
      return Response.json({
        delegate: key.did,
        environment: module.host?.key ?? null,
        requiresPerson: module.host?.requiresPerson ?? false,
        reactorConnectionId: await findReactorConnection(module.read),
      });
    });
  } catch (error) {
    // This runs while the package's factory is built, so a throw here would
    // cost every processor of the package and not only the grant step.
    console.warn("[integration-reconciler] no runner route:", error);
  }
}

export const integrationReconcilerFactoryBuilder: ProcessorFactoryBuilder = (
  module: IProcessorHostModule,
) => {
  serveRunnerFacts(module);
  return async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    if (!bindsToAny(driveHeader, [INTEGRATIONS_DRIVE])) {
      return [];
    }
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [INTEGRATION_TYPE],
      scope: ["global"],
    };
    const processor = new IntegrationReconciler(driveHeader.id, {
      read: module.read,
      dispatch: module.dispatch,
      getReadModel: <T>(name: string) => module.getReadModel<T>(name),
      host: module.host,
    });
    processor.start();
    // Re-reads each integration; a replay needs no state.
    return [{ processor, filter, replayState: "operations" as const }];
  };
};
