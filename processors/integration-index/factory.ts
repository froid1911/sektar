import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { INTEGRATION_INDEX_TYPES, IntegrationIndex } from "./processor.js";

export const integrationIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: Integrations, Backfills (queues) and Workflows (connections).
    if (!bindsToAny(driveHeader, ["integrations", "backfills", "workflows"])) return [];
    // One index per drive: the integrations, backfills and workflows drives
    // each fill the table of the type they hold.
    const namespace = IntegrationIndex.getNamespace(driveHeader.id);
    const store =
      await module.relationalDb.createNamespace<IntegrationIndex>(namespace);

    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [...INTEGRATION_INDEX_TYPES],
      scope: ["global", "document"],
    };

    // The drive id lets the processor drop its namespace on the drive's deletion.
    const processor = new IntegrationIndex(
      namespace,
      filter,
      store,
      driveHeader.id,
    );

    // Nothing in the runtime calls this, so without it the first write hits
    // a database with no tables.
    await processor.initAndUpgrade();

    return [{ processor, filter }];
  };
