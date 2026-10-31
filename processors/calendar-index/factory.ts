import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { CALENDAR_EVENT_DOCUMENT_TYPE, CalendarIndex } from "./processor.js";

export const calendarIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drives it indexes: Calendar.
    if (!bindsToAny(driveHeader, ["calendar"])) return [];
    // One index per drive, so two drives' calendars stay apart.
    const namespace = CalendarIndex.getNamespace(driveHeader.id);
    const store =
      await module.relationalDb.createNamespace<CalendarIndex>(namespace);

    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT.
    const filter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [CALENDAR_EVENT_DOCUMENT_TYPE],
      scope: ["global", "document"],
    };

    // The drive id lets the processor drop its namespace on the drive's deletion.
    const processor = new CalendarIndex(namespace, filter, store, driveHeader.id);

    // Nothing in the runtime calls this, so without it the first write hits
    // a database with no tables.
    await processor.initAndUpgrade();

    return [{ processor, filter }];
  };
