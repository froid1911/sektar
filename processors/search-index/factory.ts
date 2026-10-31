import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { SearchIndex } from "./processor.js";

export const searchIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: the business drive.
    if (!bindsToAny(driveHeader, ["sektar"])) return [];
    // Create a namespace for the processor and the provided drive id
    const namespace = SearchIndex.getNamespace(driveHeader.id);

    // Create a namespaced db for the processor
    const store =
      await module.relationalDb.createNamespace<SearchIndex>(namespace);

    // Create a filter for the processor. An omitted field matches every value.
    // Only `documentId` honours "*", so "*" elsewhere would match nothing.
    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [
        "sektar/bank-account",
        "sektar/invoice",
        "sektar/expense-report",
        "sektar/contact",
      ],
      scope: ["global", "document"],
    };

    // The drive id lets the processor drop its namespace on the drive's deletion
    const processor = new SearchIndex(namespace, filter, store, driveHeader.id);

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
