import {
  finishRun,
  reducer,
  requestSync,
  resolveIssue,
  requestPull,
  completePull,
  isFolderSyncDocument,
  setEnabled,
  setIssues,
  setLocalPath,
  setOptions,
  setTarget,
  startRun,
  utils,
  type FolderSyncDocument,
} from "document-models/folder-sync/v1";
import { describe, expect, it } from "vitest";

const AT = "2026-10-21T09:00:00.000Z";
const LATER = "2026-10-21T09:01:30.000Z";

type Action = Parameters<typeof reducer>[1];
const apply = (doc: FolderSyncDocument, ...actions: Action[]) =>
  actions.reduce((d, a) => reducer(d, a), doc);
const lastError = (doc: FolderSyncDocument) => doc.operations.global.at(-1)?.error;
/** Applies one action that must fail, and checks the state did not move. */
function rejects(doc: FolderSyncDocument, action: Action, message: RegExp) {
  const before = JSON.stringify(doc.state.global);
  const next = reducer(doc, action);
  expect(lastError(next)).toMatch(message);
  expect(JSON.stringify(next.state.global)).toBe(before);
  return next;
}

/** The Q3 receipts folder mapped onto the Dropbox copy, as the app would set it up. */
function q3() {
  return apply(
    utils.createDocument(),
    setTarget({ driveId: "files-drive", folderId: "q3-folder", folderPath: "kwartaalaangiftes/2026-Q3" }),
    setLocalPath({ localPath: "  D:\\Dropbox (Personal)\\KSDC\\kwartaalaangiftes\\2026-Q3  " }),
  );
}

describe("a folder sync, from mapping to runs", () => {
  it("starts unmapped, enabled, manual and never run", () => {
    const s = utils.createDocument().state.global;
    expect(s).toMatchObject({
      driveId: null,
      localPath: null,
      direction: "TO_DISK",
      enabled: true,
      status: "NEVER",
      runs: [],
      issues: [],
    });
    expect(s.options).toEqual({
      trigger: "MANUAL",
      includeSubfolders: true,
      content: "SOURCE",
      otherDocuments: "SKIP",
      onRemoved: "KEEP",
      onConflict: "SKIP",
      fromDisk: "OFF",
      writeFiles: true,
    });
    expect(s.pulls).toEqual([]);
  });

  it("maps a drive folder, or the drive's root, onto an absolute local path", () => {
    let doc = q3();
    expect(doc.state.global).toMatchObject({
      driveId: "files-drive",
      folderId: "q3-folder",
      folderPath: "kwartaalaangiftes/2026-Q3",
      localPath: "D:\\Dropbox (Personal)\\KSDC\\kwartaalaangiftes\\2026-Q3",
    });

    doc = apply(doc, setTarget({ driveId: "files-drive" }));
    expect(doc.state.global.folderId).toBeNull();
    expect(doc.state.global.folderPath).toBeNull();

    for (const localPath of ["/home/wouter/ksdc", "\\\\nas\\share\\ksdc", "c:/sync"]) {
      doc = apply(doc, setLocalPath({ localPath }));
      expect(doc.state.global.localPath).toBe(localPath);
    }
    for (const localPath of ["ksdc/2026", "", "   ", "D:relative"]) {
      doc = rejects(doc, setLocalPath({ localPath }), /not an absolute path/);
    }
  });

  it("changes only the options it is given", () => {
    let doc = apply(
      q3(),
      setOptions({
        trigger: "ON_CHANGE",
        includeSubfolders: false,
        content: "SOURCE_AND_RENDITIONS",
        otherDocuments: "EXPORT_PHD",
        onRemoved: "DELETE",
        onConflict: "KEEP_BOTH",
        fromDisk: "AUTO_PULL_WITH_DELETES",
        writeFiles: false,
      }),
    );
    const all = {
      trigger: "ON_CHANGE",
      includeSubfolders: false,
      content: "SOURCE_AND_RENDITIONS",
      otherDocuments: "EXPORT_PHD",
      onRemoved: "DELETE",
      onConflict: "KEEP_BOTH",
      fromDisk: "AUTO_PULL_WITH_DELETES",
      writeFiles: false,
    };
    expect(doc.state.global.options).toEqual(all);
    doc = apply(doc, setOptions({}), setOptions({ includeSubfolders: null, writeFiles: null }));
    expect(doc.state.global.options).toEqual(all);
    doc = apply(doc, setOptions({ includeSubfolders: true, onConflict: "OVERWRITE" }));
    expect(doc.state.global.options).toEqual({ ...all, includeSubfolders: true, onConflict: "OVERWRITE" });
  });

  it("is asked for a run only once mapped and enabled", () => {
    const blank = utils.createDocument();
    rejects(blank, requestSync({ id: "r0", requestedAt: AT }), /drive folder and the local path/);
    rejects(
      apply(blank, setTarget({ driveId: "files-drive" })),
      requestSync({ id: "r0", requestedAt: AT }),
      /drive folder and the local path/,
    );
    const off = apply(q3(), setEnabled({ enabled: false }));
    expect(off.state.global.enabled).toBe(false);
    rejects(off, requestSync({ id: "r0", requestedAt: AT }), /Enable the mapping/);

    const asked = apply(off, setEnabled({ enabled: true }), requestSync({ id: "r1", requestedAt: AT }));
    expect(asked.state.global.status).toBe("REQUESTED");
    expect(asked.state.global.request).toEqual({ id: "r1", requestedAt: AT, requestedBy: null, full: false });

    const byWorkflow = apply(asked, requestSync({ id: "r2", requestedAt: LATER, requestedBy: "workflow", full: true }));
    expect(byWorkflow.state.global.request).toEqual({ id: "r2", requestedAt: LATER, requestedBy: "workflow", full: true });
  });

  it("records a run from start to finish, and what it could not write", () => {
    let doc = apply(
      q3(),
      requestSync({ id: "r1", requestedAt: AT, requestedBy: "app" }),
      startRun({
        id: "run-1",
        requestId: "r1",
        startedAt: AT,
        full: true,
        driveRevision: 18087,
        hostName: "wkamp-pc",
        hostPlatform: "win32",
        reactorId: "switchboard-7540",
      }),
    );
    expect(doc.state.global.status).toBe("RUNNING");
    expect(doc.state.global.host).toEqual({ name: "wkamp-pc", platform: "win32", reactorId: "switchboard-7540" });
    expect(doc.state.global.runs[0]).toMatchObject({ id: "run-1", status: "RUNNING", full: true, driveRevision: 18087, written: 0, finishedAt: null });
    doc = rejects(doc, startRun({ id: "run-1", startedAt: AT }), /Run run-1 exists/);

    // Asked again while it runs: the status stays RUNNING, the request waits.
    doc = apply(doc, requestSync({ id: "r2", requestedAt: LATER }));
    expect(doc.state.global.status).toBe("RUNNING");

    doc = rejects(doc, finishRun({ id: "run-x", finishedAt: LATER, status: "OK" }), /No run run-x/);
    doc = rejects(doc, finishRun({ id: "run-1", finishedAt: LATER, status: "RUNNING" }), /cannot be RUNNING/);
    doc = apply(
      doc,
      finishRun({ id: "run-1", finishedAt: LATER, status: "PARTIAL", written: 31, unchanged: 4, deleted: 0, skipped: 1, conflicts: 1, errors: 0, bytesWritten: 15_728_640 }),
    );
    expect(doc.state.global.runs[0]).toMatchObject({ status: "PARTIAL", written: 31, unchanged: 4, conflicts: 1, bytesWritten: 15_728_640, finishedAt: LATER, error: null });
    // r2 arrived during run-1, so a run is still owed.
    expect(doc.state.global.status).toBe("REQUESTED");
    doc = rejects(doc, finishRun({ id: "run-1", finishedAt: LATER, status: "OK" }), /finished at/);

    doc = apply(
      doc,
      setIssues({
        issues: [
          { id: "i1", kind: "CONFLICT", nodeId: "n1", documentId: "d1", relativePath: "receipts/20260902-asiagourmet.pdf", message: "Changed on disk since it was written", at: LATER },
          { id: "i2", kind: "NO_SOURCE", message: "The File has no source yet", at: LATER },
        ],
      }),
    );
    expect(doc.state.global.issues[1]).toEqual({ id: "i2", kind: "NO_SOURCE", nodeId: null, documentId: null, relativePath: null, message: "The File has no source yet", at: LATER });
    doc = rejects(
      doc,
      setIssues({ issues: [{ id: "i3", kind: "ERROR", message: "a", at: AT }, { id: "i3", kind: "ERROR", message: "b", at: AT }] }),
      /share an id/,
    );
    doc = apply(doc, resolveIssue({ id: "i1" }));
    expect(doc.state.global.issues.map((x) => x.id)).toEqual(["i2"]);
    doc = rejects(doc, resolveIssue({ id: "i1" }), /No issue i1/);
  });

  it("ends in the status of the run that answered the latest request", () => {
    const run = (doc: FolderSyncDocument, id: string, status: "OK" | "PARTIAL" | "ERROR" | "CANCELLED", requestId: string | null) =>
      apply(doc, startRun({ id, requestId, startedAt: AT }), finishRun({ id, finishedAt: LATER, status, error: status === "ERROR" ? "EACCES" : undefined }));
    const asked = apply(q3(), requestSync({ id: "r1", requestedAt: AT }));
    expect(run(asked, "a", "OK", "r1").state.global.status).toBe("OK");
    expect(run(asked, "b", "PARTIAL", "r1").state.global.status).toBe("PARTIAL");
    const failed = run(asked, "c", "ERROR", "r1");
    expect(failed.state.global.status).toBe("ERROR");
    expect(failed.state.global.runs[0]).toMatchObject({ error: "EACCES", written: 0, bytesWritten: 0 });
    expect(run(asked, "d", "CANCELLED", "r1").state.global.status).toBe("ERROR");
    // A run nobody asked for (an ON_CHANGE run) on a never-requested mapping.
    const unasked = run(q3(), "e", "OK", null);
    expect(unasked.state.global.status).toBe("OK");
    expect(unasked.state.global.runs[0].requestId).toBeNull();
  });

  it("keeps the latest twenty runs", () => {
    let doc = q3();
    for (let n = 1; n <= 23; n++) doc = apply(doc, startRun({ id: `run-${n}`, startedAt: AT }), finishRun({ id: `run-${n}`, finishedAt: LATER, status: "OK" }));
    expect(doc.state.global.runs).toHaveLength(20);
    expect(doc.state.global.runs[0].id).toBe("run-23");
    expect(doc.state.global.runs.at(-1)?.id).toBe("run-4");
  });
});

describe("changes from disk", () => {
  it("are pulled only when asked for, on a mapping that takes them", () => {
    rejects(utils.createDocument(), requestPull({ id: "p0", requestedAt: AT }), /drive folder and the local path/);
    rejects(apply(q3(), setEnabled({ enabled: false })), requestPull({ id: "p0", requestedAt: AT }), /Enable the mapping/);
    let doc = rejects(q3(), requestPull({ id: "p0", requestedAt: AT }), /Turn on changes from disk/);

    doc = apply(doc, setOptions({ fromDisk: "PLACEHOLDERS" }), requestPull({ id: "p1", requestedAt: AT, requestedBy: "app", nodeIds: ["n1", "n2", "n1"] }));
    expect(doc.state.global.pulls).toEqual([{ id: "p1", requestedAt: AT, requestedBy: "app", nodeIds: ["n1", "n2"] }]);
    expect(doc.state.global.status).toBe("REQUESTED");
    doc = rejects(doc, requestPull({ id: "p1", requestedAt: AT }), /Pull p1 exists/);

    // Every placeholder, asked for while a run is going: the run stays RUNNING.
    doc = apply(doc, startRun({ id: "run-1", startedAt: AT }), requestPull({ id: "p2", requestedAt: LATER }));
    expect(doc.state.global.status).toBe("RUNNING");
    expect(doc.state.global.pulls?.[1]).toEqual({ id: "p2", requestedAt: LATER, requestedBy: null, nodeIds: [] });

    // A run that leaves pulls behind is still owed a run.
    doc = apply(doc, completePull({ id: "p1" }), finishRun({ id: "run-1", finishedAt: LATER, status: "OK", placeholders: 3, pulled: 2 }));
    expect(doc.state.global.runs[0]).toMatchObject({ placeholders: 3, pulled: 2 });
    expect(doc.state.global.status).toBe("REQUESTED");
    doc = rejects(doc, completePull({ id: "p1" }), /No pull p1/);
    doc = apply(doc, completePull({ id: "p2" }), startRun({ id: "run-2", startedAt: LATER }), finishRun({ id: "run-2", finishedAt: LATER, status: "OK" }));
    expect(doc.state.global.status).toBe("OK");
    expect(doc.state.global.runs[0]).toMatchObject({ placeholders: 0, pulled: 0 });
  });

  it("fills in what a mapping from before them lacks", () => {
    const doc = apply(q3(), startRun({ id: "old", startedAt: AT }));
    // State as it was stored before reverse sync existed.
    const legacy = structuredClone(doc.state.global) as unknown as Record<string, unknown> & { options: Record<string, unknown>; runs: Record<string, unknown>[] };
    delete legacy.pulls;
    delete legacy.options.fromDisk;
    delete legacy.runs[0].placeholders;
    delete legacy.runs[0].pulled;
    const old = { ...doc, state: { ...doc.state, global: legacy as unknown as FolderSyncDocument["state"]["global"] } };
    // Its stored initialState lacks them too, and no operation changes that: it must still validate.
    const initial = structuredClone(legacy) as unknown as FolderSyncDocument["state"]["global"];
    expect(isFolderSyncDocument({ ...old, initialState: { ...old.initialState, global: initial } })).toBe(true);
    const next = apply(old, setEnabled({ enabled: true }));
    expect(next.state.global.options.fromDisk).toBe("OFF");
    expect(next.state.global.pulls).toEqual([]);
    expect(next.state.global.runs[0]).toMatchObject({ placeholders: 0, pulled: 0 });
  });
});
