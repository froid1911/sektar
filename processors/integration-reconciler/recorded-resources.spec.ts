import { describe, expect, it } from "vitest";
import type { IntegrationState } from "document-models/integration";
import {
  noteRecorded,
  RECORDED_TTL_MS,
  withRecorded,
} from "./recorded-resources.js";

type Resources = IntegrationState["resources"];
const none = {
  connectionId: null,
  liveWorkflowId: null,
  backfillWorkflowId: null,
  pluggedItemId: null,
} as unknown as Resources;
const record = (input: Record<string, string | null>) => ({
  type: "RECORD_RESOURCES",
  input,
});

describe("recorded resources", () => {
  it("notes the set fields of RECORD_RESOURCES only, as the reducer applies them", () => {
    const noted = noteRecorded(
      {},
      [
        { type: "RECORD_CHECK", input: { connectionId: "x" } },
        record({ connectionId: "conn-a", liveWorkflowId: null }),
      ],
      1000,
    );
    expect(noted).toEqual({ connectionId: { value: "conn-a", at: 1000 } });
  });

  it("lets the next pass see the connection the last one made before it is read back", () => {
    // 2026-10-30: two passes 600 ms apart each made a Google connection
    const recorded = noteRecorded({}, [record({ connectionId: "conn-a" })], 0);
    const pass2 = withRecorded(none, recorded, 600);
    expect(pass2.resources.connectionId).toBe("conn-a");
    expect(pass2.recorded.connectionId?.value).toBe("conn-a");
  });

  it("drops what the read state shows, and what never got there in time", () => {
    const recorded = noteRecorded(
      {},
      [record({ connectionId: "conn-a", liveWorkflowId: "wf-1" })],
      0,
    );
    const caughtUp = withRecorded(
      { ...none, connectionId: "conn-a" } as Resources,
      recorded,
      10,
    );
    expect(caughtUp.recorded).toEqual({
      liveWorkflowId: { value: "wf-1", at: 0 },
    });
    expect(caughtUp.resources.liveWorkflowId).toBe("wf-1");

    const late = withRecorded(none, recorded, RECORDED_TTL_MS + 1);
    expect(late.recorded).toEqual({});
    expect(late.resources).toBe(none);
  });

  it("prefers the newer record over an older value still being read", () => {
    const recorded = noteRecorded({}, [record({ connectionId: "conn-b" })], 0);
    const pass = withRecorded(
      { ...none, connectionId: "conn-a" } as Resources,
      recorded,
      5,
    );
    expect(pass.resources.connectionId).toBe("conn-b");
  });
});
