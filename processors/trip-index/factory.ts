import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { TRIP_DOCUMENT_TYPE, TripIndex } from "./processor.js";

export const tripIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: Trips.
    if (!bindsToAny(driveHeader, ["trips"])) return [];
    // One index per drive, so two drives' trips stay apart.
    const namespace = TripIndex.getNamespace(driveHeader.id);
    const store =
      await module.relationalDb.createNamespace<TripIndex>(namespace);

    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [TRIP_DOCUMENT_TYPE],
      scope: ["global", "document"],
    };

    // The drive id lets the processor drop its namespace on the drive's deletion.
    const processor = new TripIndex(namespace, filter, store, driveHeader.id);

    // Nothing in the runtime calls this, so without it the first write hits
    // a database with no tables.
    await processor.initAndUpgrade();

    return [{ processor, filter }];
  };
