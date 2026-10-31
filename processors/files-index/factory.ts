import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import {
  DRIVE_DOCUMENT_TYPES,
  FILE_DOCUMENT_TYPE,
  FilesIndex,
  REACTOR_DRIVE_DOCUMENT_TYPE,
  SYNC_DOCUMENT_TYPE,
} from "./processor.js";

/** The drive the host files declare for them. */
const FILES_DRIVE = "files";

export const filesIndexFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drive the Files app opens. Every other drive (Mail with its
    // thousands of messages, the studio's) would replay its whole history
    // through this processor for nothing.
    if (!bindsToAny(driveHeader, [FILES_DRIVE])) return [];

    const namespace = FilesIndex.getNamespace(driveHeader.id);
    const store = await module.relationalDb.createNamespace<FilesIndex>(namespace);
    const reactorDrive = driveHeader.documentType === REACTOR_DRIVE_DOCUMENT_TYPE;

    // Two filters over one index: this drive's own operations (its nodes),
    // and every File and folder-sync document's. The drive filter names the
    // drive; a broad one would stream every drive's history. The two
    // processors share one write queue (see FilesIndex).
    // Scope "document" carries DELETE_DOCUMENT and PURGE_DOCUMENT, and a
    // reactor-drive's folders and relationships.
    const driveFilter: ProcessorFilter = {
      branch: ["main"],
      documentId: [driveHeader.id],
      documentType: DRIVE_DOCUMENT_TYPES,
      scope: ["global", "document"],
    };
    const fileFilter: ProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: [FILE_DOCUMENT_TYPE, SYNC_DOCUMENT_TYPE],
      scope: ["global", "document"],
    };
    const nodes = new FilesIndex(namespace, driveFilter, store, driveHeader.id).forDrive(driveHeader.documentType);
    const files = new FilesIndex(namespace, fileFilter, store, driveHeader.id).forDrive(driveHeader.documentType);
    await nodes.initAndUpgrade();
    return [
      // A legacy drive's rows depend on its latest node list alone: a replay
      // needs only the latest state. A reactor-drive's are replayed from
      // every structure operation, which carry what they need in the action.
      { processor: nodes, filter: driveFilter, replayState: reactorDrive ? "operations" : "collapse" },
      // A File's or mapping's row depends on its latest state alone.
      { processor: files, filter: fileFilter, replayState: "collapse" },
    ];
  };
