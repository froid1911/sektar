import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { EMAIL_DOCUMENT_TYPE, EmailIndex } from "./processor.js";

export const emailIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: Mail.
    if (!bindsToAny(driveHeader, ["mail"])) return [];
    // One index per drive: a mailbox is listed within its drive, and the
    // namespace keeps two drives' mail apart.
    const namespace = EmailIndex.getNamespace(driveHeader.id);
    const store =
      await module.relationalDb.createNamespace<EmailIndex>(namespace);

    // An omitted field matches every value; only `documentId` honours "*".
    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [EMAIL_DOCUMENT_TYPE],
      scope: ["global", "document"],
    };

    // The drive id lets the processor drop its namespace on the drive's deletion.
    const processor = new EmailIndex(namespace, filter, store, driveHeader.id);

    // Nothing in the runtime calls this, so without it the first write hits
    // a database with no tables.
    await processor.initAndUpgrade();

    return [{ processor, filter }];
  };
