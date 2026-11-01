import type { OperationWithContext } from "document-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_TYPE, FolderSync, REACTOR_DRIVE_TYPE, type FolderSyncRuntime } from "./processor.js";

const DRIVE = "drive-1";
const SWEEP_MS = 5_000;
const QUIET_MS = 5_000;

const fileChange = (documentId: string): OperationWithContext =>
  ({
    operation: { timestampUtcMs: new Date().toISOString(), action: { type: "SET_TITLE", input: {} } },
    context: { documentId, documentType: FILE_TYPE, scope: "global", branch: "main" },
  }) as unknown as OperationWithContext;

const driveChange = (folderId: string): OperationWithContext =>
  ({
    operation: { timestampUtcMs: new Date().toISOString(), action: { type: "ADD_FOLDER", input: { folderId } } },
    context: { documentId: DRIVE, documentType: REACTOR_DRIVE_TYPE, scope: "document", branch: "main" },
  }) as unknown as OperationWithContext;

const filter = { branch: ["main"], documentId: ["*"], documentType: [FILE_TYPE], scope: ["global"] };

describe("FolderSync on a change in the drive", () => {
  let listNodes: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    listNodes = vi.fn().mockResolvedValue({ results: [], options: { cursor: "", limit: 500 } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A processor past the look at start-up for requests left waiting. */
  async function started(): Promise<FolderSync> {
    const runtime = { read: { drives: { listNodes }, get: vi.fn() } } as unknown as FolderSyncRuntime;
    const processor = new FolderSync("namespace", filter, {} as never, DRIVE).withRuntime(DRIVE, runtime);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    listNodes.mockClear();
    return processor;
  }

  it("answers before reading the drive's nodes, so nothing waits on the tree", async () => {
    const processor = await started();

    await processor.onOperations([fileChange("file-1")]);

    expect(listNodes).not.toHaveBeenCalled();
  });

  it("does not wait for a look at the tree that is already running", async () => {
    const processor = await started();
    listNodes.mockReturnValue(new Promise(() => {}));
    await processor.onOperations([fileChange("file-1")]);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(listNodes).toHaveBeenCalledTimes(1);

    await expect(processor.onOperations([fileChange("file-2")])).resolves.toBeUndefined();
  });

  it("looks at the tree once for a burst of changes", async () => {
    const processor = await started();

    await processor.onOperations([fileChange("file-1")]);
    await vi.advanceTimersByTimeAsync(1_000);
    await processor.onOperations([fileChange("file-1")]);
    await vi.advanceTimersByTimeAsync(1_000);
    await processor.onOperations([driveChange("folder-1")]);
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(listNodes).toHaveBeenCalledTimes(1);
  });

  it("does not read the tree when nothing changed", async () => {
    const processor = await started();

    await processor.onOperations([]);
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(listNodes).not.toHaveBeenCalled();
  });
});
