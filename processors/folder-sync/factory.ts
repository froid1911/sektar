import type {
  IProcessorHostModule,
  ProcessorApp,
  ProcessorFactoryBuilder,
  ProcessorFilter,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { bindsToAny } from "processors/drives";
import { DRIVE_TYPES, FILE_TYPE, FolderSync, SYNC_TYPE } from "./processor.js";

/** The drive the host files declare for them. */
const FILES_DRIVE = "files";

export const folderSyncFactoryBuilder: ProcessorFactoryBuilder =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader, _processorApp?: ProcessorApp) => {
    // Only the drive the Files app opens: every other drive (Mail with its
    // thousands of messages) would replay its whole history through here.
    if (!bindsToAny(driveHeader, [FILES_DRIVE])) return [];

    const namespace = FolderSync.getNamespace(driveHeader.id);
    const store = await module.relationalDb.createNamespace<FolderSync>(namespace);

    // The mappings (every drive's; the processor keeps to its own), and what
    // an ON_CHANGE mapping watches: this drive's nodes and the Files' content.
    const mappingFilter: ProcessorFilter = { branch: ["main"], documentId: ["*"], documentType: [SYNC_TYPE], scope: ["global"] };
    // A legacy drive's node actions are global; a reactor-drive's folders and links are document-scope.
    const driveFilter: ProcessorFilter = { branch: ["main"], documentId: [driveHeader.id], documentType: DRIVE_TYPES, scope: ["global", "document"] };
    const fileFilter: ProcessorFilter = { branch: ["main"], documentId: ["*"], documentType: [FILE_TYPE], scope: ["global"] };

    const processor = new FolderSync(namespace, mappingFilter, store, driveHeader.id).withRuntime(driveHeader.id, {
      read: module.read,
      attachments: module.attachments,
      dispatch: module.dispatch,
      // The host module has no drive write half of its own: the client's is
      // the one `dispatch.createInDrive` writes through too.
      drives: module.client.write.drives,
    });
    await processor.initAndUpgrade();

    return [
      // Reads the drive through the client and ignores history: a replay
      // needs no state.
      { processor, filter: mappingFilter, replayState: "operations" },
      { processor, filter: driveFilter, replayState: "operations" },
      { processor, filter: fileFilter, replayState: "operations" },
    ];
  };
