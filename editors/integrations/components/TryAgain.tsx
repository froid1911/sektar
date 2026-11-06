import { dispatchActions } from "@powerhousedao/reactor-browser";
import { generateId } from "document-model";
import { actions } from "document-models/integration";
import { useState } from "react";
import {
  fireWith,
  isParked,
  latestRuns,
  retryFailedRun,
  runsToRetry,
  setWorkflowStatus,
  useWorkflowRuntimeUrl,
} from "../../sektar/kit/workflow-runtime.js";
import { Button } from "../../sektar/kit/ui.js";
import type { IntegrationItem } from "../../sektar/kit/integration-index.js";

/** How long to wait for the runtime to see the switch-off before switching back on */
const RELEASE_WAIT_MS = 20_000;
const RELEASE_EVERY_MS = 1_000;

/**
 * "Try again" for a workflow the runtime parked after a failed run. It reruns
 * the failed run (fired again with its payload when the runtime cannot replay
 * it), then fires again every firing the runtime refused while
 * parked (a backfill's skipped slices, oldest first), stopping at the first
 * that still fails; pressed again, it picks up where it stopped. When they
 * go through, it switches the workflow off, waits until the runtime has
 * released the park, and switches it on again: two separate
 * writes through the switchboard (one synced batch of both does not lift the
 * park). Then it asks the reconciler to look again so the card catches up.
 */
export function TryAgain({
  integration,
  workflowId,
}: {
  integration: Pick<IntegrationItem, "id">;
  workflowId: string;
}) {
  const url = useWorkflowRuntimeUrl();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setProgress("Trying again…");
    setError(null);
    try {
      const pending = runsToRetry(await latestRuns(url, workflowId));
      const failed = pending?.failed;
      const steps = pending
        ? [
            ...(failed ? [() => retryFailedRun(url, workflowId, failed)] : []),
            ...pending.skipped.map(
              (run) => () => fireWith(url, workflowId, run.triggerPayload),
            ),
          ]
        : [];
      for (const [i, step] of steps.entries()) {
        if (steps.length > 1) {
          setProgress(`Trying again… ${i + 1} of ${steps.length}`);
        }
        const result = await step();
        if (result.status !== "SUCCEEDED") {
          setError(
            result.error ?? `The run ended ${result.status.toLowerCase()}`,
          );
          return;
        }
      }
      setProgress("Starting it again…");
      await setWorkflowStatus(url, workflowId, "DISABLED");
      const until = Date.now() + RELEASE_WAIT_MS;
      while ((await isParked(url, workflowId)) && Date.now() < until) {
        await new Promise((r) => window.setTimeout(r, RELEASE_EVERY_MS));
      }
      await setWorkflowStatus(url, workflowId, "ENABLED");
      await dispatchActions(
        [
          actions.requestCheck({
            id: generateId(),
            requestedAt: new Date().toISOString(),
          }),
        ],
        integration.id,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="sk-stack sk-stack--2">
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void retry()}
          disabled={progress !== null}
        >
          {progress ?? "Try again"}
        </Button>
      </div>
      {error && (
        <p className="sk-small sk-text-danger" style={{ margin: 0 }}>
          Still failing: {error}
        </p>
      )}
    </div>
  );
}
