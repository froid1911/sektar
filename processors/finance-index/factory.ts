import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { FINANCE_DOCUMENT_TYPES, FinanceIndex } from "./processor.js";

export const financeIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: the business drive.
    if (!bindsToAny(driveHeader, ["sektar"])) return [];
    // One index per drive: the books are read within their drive.
    const namespace = FinanceIndex.getNamespace(driveHeader.id);
    const store =
      await module.relationalDb.createNamespace<FinanceIndex>(namespace);

    // An omitted field matches every value; only `documentId` honours "*".
    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [...FINANCE_DOCUMENT_TYPES],
      scope: ["global", "document"],
    };

    // The drive id lets the processor drop its namespace on the drive's deletion.
    const processor = new FinanceIndex(namespace, filter, store, driveHeader.id);

    // Nothing in the runtime calls this, so without it the first write hits
    // a database with no tables.
    await processor.initAndUpgrade();

    return [{ processor, filter }];
  };
