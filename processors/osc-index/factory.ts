import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { OscIndex } from "./processor.js";

export const oscIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: the business drive (where original source collections are filed).
    if (!bindsToAny(driveHeader, ["sektar"])) return [];
    // Create a namespace for the processor and the provided drive id
    const namespace = OscIndex.getNamespace(driveHeader.id);

    // Create a namespaced db for the processor
    const store =
      await module.relationalDb.createNamespace<OscIndex>(namespace);

    // Create a filter for the processor. An omitted field matches every value.
    // Only `documentId` honours "*", so "*" elsewhere would match nothing.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: ["distyra/original-source-collection"],
      scope: ["global"],
    };

    // Create the processor
    // The processor re-reads documents rather than replaying identifier
    // moves, so it needs the reactor the host already holds.
    const processor = new OscIndex(namespace, filter, store).withClient(
      module.client,
    );

    // Run the processor's migrations. Nothing in the runtime calls this, so
    // without it the first write hits a database with no tables.
    await processor.initAndUpgrade();

    return [
      {
        processor,
        filter,
      },
    ];
  };
