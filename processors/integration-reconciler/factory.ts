import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { INTEGRATION_TYPE, IntegrationReconciler } from "./processor.js";

/** The drive the host files declare for them. */
const INTEGRATIONS_DRIVE = "integrations";

export const integrationReconcilerFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
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
    });
    processor.start();
    // Re-reads each integration; a replay needs no state.
    return [{ processor, filter, replayState: "operations" as const }];
  };
