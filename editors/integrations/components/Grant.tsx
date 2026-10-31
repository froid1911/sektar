import {
  dispatchActions,
  useRenown,
  useRenownAuth,
} from "@powerhousedao/reactor-browser";
import { generateId } from "document-model";
import { actions } from "document-models/integration";
import { useState } from "react";
import { useHubDrive } from "../../sektar/kit/integration-index.js";
import type { IntegrationItem } from "../../sektar/kit/integration-index.js";
import {
  ensureReactorConnection,
  fetchRunnerFacts,
  grantAction,
  granterOf,
  wantsStatement,
} from "../../sektar/kit/reactor-grant.js";
import { useWorkflowRuntimeUrl } from "../../sektar/kit/workflow-runtime.js";
import { Button } from "../../sektar/kit/ui.js";

/**
 * The approval on a card whose reconciler stopped for one: never granted, run
 * out, or withdrawn. One button, whatever the reason: it makes the reactor
 * connection if there is none, signs a statement as the signed-in person, and
 * asks the reconciler to look again. Nobody signed in: the button signs in
 * first, and is pressed again.
 */
export function Grant({
  integration,
}: {
  integration: Pick<IntegrationItem, "id">;
}) {
  const url = useWorkflowRuntimeUrl();
  const renown = useRenown();
  const { login } = useRenownAuth();
  const workflows = useHubDrive("workflows");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granter = granterOf(renown);

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      const facts = await fetchRunnerFacts(url);
      // A host that needs a person answers nobody until they have signed in.
      if (!granter && (!facts || facts.requiresPerson)) {
        login();
        return;
      }
      if (!facts) throw new Error("This environment did not answer");
      await ensureReactorConnection(facts, workflows?.header.id);
      await dispatchActions(
        [
          ...(granter && wantsStatement(facts)
            ? [await grantAction(granter, facts, integration.id)]
            : []),
          actions.requestCheck({
            id: generateId(),
            requestedAt: new Date().toISOString(),
            requestedBy: "grant",
          }),
        ],
        integration.id,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sk-stack sk-stack--2">
      <div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void allow()}
          disabled={busy}
        >
          {busy ? "Allowing…" : "Let Sektar write to your documents"}
        </Button>
      </div>
      {error && (
        <p className="sk-small sk-text-danger" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
