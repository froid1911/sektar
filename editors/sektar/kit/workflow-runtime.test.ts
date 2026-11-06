import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cannotReplay,
  retryFailedRun,
  runsToRetry,
  type RunSummary,
} from "./workflow-runtime.js";

vi.mock("@powerhousedao/reactor-browser/graphql-client", () => ({
  ambientRenownTokenProvider: () => Promise.resolve(undefined),
}));

const slice = (day: number) => ({
  ranges: { day: { from: `2017-01-${day}`, to: `2017-01-${day + 1}` } },
});
const run = (
  id: string,
  status: string,
  day: number,
  patch: Partial<RunSummary> = {},
): RunSummary => ({
  id,
  status,
  error: null,
  triggerKind: "piece:for-every",
  triggerPayload: slice(day),
  ...patch,
});
const skipped = (id: string, day: number) =>
  run(id, "CANCELLED", day, {
    error: "Skipped: this workflow is PARKED (Parked after a failed run …)",
  });
const ids = (r: ReturnType<typeof runsToRetry>) =>
  r && { failed: r.failed?.id ?? null, skipped: r.skipped.map((x) => x.id) };

describe("runsToRetry", () => {
  it("is the failed run, then the firings refused while parked, oldest first", () => {
    expect(
      ids(
        runsToRetry([
          skipped("s23", 23),
          skipped("s22", 22),
          skipped("s21", 21),
          run("f", "FAILED", 20),
          run("ok", "SUCCEEDED", 19),
        ]),
      ),
    ).toEqual({ failed: "f", skipped: ["s21", "s22", "s23"] });
    expect(ids(runsToRetry([run("f", "FAILED", 20)]))).toEqual({
      failed: "f",
      skipped: [],
    });
  });

  it("looks past an earlier Try again and leaves out what it brought in", () => {
    expect(
      ids(
        runsToRetry([
          run("m21", "SUCCEEDED", 21, { triggerKind: "manual" }),
          run("r20", "SUCCEEDED", 20, { triggerKind: "rerun" }),
          skipped("s22", 22),
          skipped("s21", 21),
          run("f", "FAILED", 20),
        ]),
      ),
    ).toEqual({ failed: null, skipped: ["s22"] });
  });

  it("is nothing when the trigger's newest outcome is not a failure", () => {
    expect(
      runsToRetry([run("ok", "SUCCEEDED", 21), run("f", "FAILED", 20)]),
    ).toBeNull();
    expect(
      runsToRetry([
        run("c", "CANCELLED", 21, { error: "Cancelled by the user" }),
        run("f", "FAILED", 20),
      ]),
    ).toBeNull();
    expect(runsToRetry([skipped("s1", 21)])).toBeNull();
    expect(runsToRetry([])).toBeNull();
  });
});

// As the runtime words them (reactor-workflow's coordinator).
const REDACTED_REPLAY =
  'Journaled output of step "get_events" was redacted and cannot be replayed; fire the workflow again instead of rerunning it';
const TRUNCATED_REPLAY =
  'Step "map_events" failed: Output of step "get_events" is unavailable: it succeeded in the run being rerun, but the run journal truncated its output past the payload cap. The step is not re-run, because it had side effects. Fire the workflow again instead of rerunning it.';

describe("cannotReplay", () => {
  it("is a rerun the runtime cannot resume from its journal", () => {
    expect(
      cannotReplay({ runId: "r", status: "FAILED", error: REDACTED_REPLAY }),
    ).toBe(true);
    expect(
      cannotReplay({ runId: "r", status: "FAILED", error: TRUNCATED_REPLAY }),
    ).toBe(true);
  });

  it("is not a rerun that ran and failed, or succeeded", () => {
    expect(
      cannotReplay({
        runId: "r",
        status: "FAILED",
        error:
          'Step "upsert_events" failed: Piece action timed out after 30000ms',
      }),
    ).toBe(false);
    expect(cannotReplay({ runId: "r", status: "FAILED", error: null })).toBe(
      false,
    );
    expect(cannotReplay({ runId: "r", status: "SUCCEEDED", error: null })).toBe(
      false,
    );
  });
});

describe("retryFailedRun", () => {
  const url = "https://switchboard.test/graphql/workflow-runtime";
  const answers = (
    ...results: { runId: string; status: string; error: string | null }[]
  ) => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as (typeof calls)[number];
        calls.push(request);
        const result = results[calls.length - 1];
        const field = request.query.includes("rerun(") ? "rerun" : "fire";
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { workflowRuntime: { [field]: result } } }),
          ),
        );
      }),
    );
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("fires the run's payload again when the runtime cannot replay it", async () => {
    const calls = answers(
      { runId: "r1", status: "FAILED", error: REDACTED_REPLAY },
      { runId: "m1", status: "SUCCEEDED", error: null },
    );
    const result = await retryFailedRun(url, "wf", {
      id: "f",
      triggerPayload: slice(20),
    });
    expect(result).toEqual({ runId: "m1", status: "SUCCEEDED", error: null });
    expect(calls.map((c) => c.variables)).toEqual([
      { runId: "f" },
      { workflowId: "wf", payload: slice(20) },
    ]);
  });

  it("is the rerun's own outcome otherwise", async () => {
    const failed = {
      runId: "r1",
      status: "FAILED",
      error:
        'Step "upsert_events" failed: Piece action timed out after 30000ms',
    };
    const calls = answers(failed);
    expect(
      await retryFailedRun(url, "wf", { id: "f", triggerPayload: slice(20) }),
    ).toEqual(failed);
    expect(calls).toHaveLength(1);
  });

  it("brings the slice in once: a second Try again looks past the rerun and the fire", () => {
    expect(
      ids(
        runsToRetry([
          run("m20", "SUCCEEDED", 20, { triggerKind: "manual" }),
          run("r20", "FAILED", 20, {
            triggerKind: "rerun",
            error: REDACTED_REPLAY,
          }),
          run("f", "FAILED", 20),
        ]),
      ),
    ).toEqual({ failed: null, skipped: [] });
  });
});
