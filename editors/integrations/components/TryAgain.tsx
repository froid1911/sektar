import { dispatchActions } from "@powerhousedao/reactor-browser";
import { generateId } from "document-model";
import { actions } from "document-models/integration";
import { useState } from "react";
import {
  restartParked,
  useWorkflowRuntimeUrl,
} from "../../sektar/kit/workflow-runtime.js";
import { Button } from "../../sektar/kit/ui.js";
import type { IntegrationItem } from "../../sektar/kit/integration-index.js";

/**
 * "Try again" for a workflow the runtime parked after a failed run
 * (restartParked: the failed run, the firings refused while parked, then the
 * park lifted). Then it asks the reconciler to look again so the card
 * catches up.
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
      const failure = await restartParked(url, workflowId, setProgress);
      if (failure) {
        setError(failure);
        return;
      }
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
