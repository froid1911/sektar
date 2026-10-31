import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { KEYED_TYPES } from "./keys.js";
import { KeyIndex } from "./processor.js";

export const keyIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: Mail and Calendar (the drives the upsert piece files keyed documents into).
    if (!bindsToAny(driveHeader, ["mail", "calendar"])) return [];
    // One index per drive: a lookup is always scoped to the drive a batch
    // writes into, and the namespace keeps two drives' keys apart.
    const namespace = KeyIndex.getNamespace(driveHeader.id);
    const store = await module.relationalDb.createNamespace<KeyIndex>(namespace);

    // An omitted field matches every value; only `documentId` honours "*".
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: KEYED_TYPES.map((t) => t.documentType),
      scope: ["global"],
    };

    const processor = new KeyIndex(namespace, filter, store).withTypes(
      KEYED_TYPES,
    );

    // Nothing in the runtime calls this, so without it the first write hits
    // a database with no tables.
    await processor.initAndUpgrade();

    return [{ processor, filter }];
  };
