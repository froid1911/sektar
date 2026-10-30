import {
  dispatchActions,
  useRenown,
} from "@powerhousedao/reactor-browser";
import { useEffect, useRef } from "react";
import type { IntegrationItem } from "../../sektar/kit/integration-index.js";
import {
  grantAction,
  granterOf,
  shouldRenew,
  useRunnerFacts,
  wantsStatement,
} from "../../sektar/kit/reactor-grant.js";

/**
 * A visit from the person who granted an integration renews its statement when
 * it is running out. Signing is silent and local, so it needs no network and
 * nobody is asked anything. Each integration is tried once per page load: a
 * failure here is what the card's button is for.
 */
export function useRenewGrants(items: readonly IntegrationItem[]): void {
  const renown = useRenown();
  const { facts } = useRunnerFacts();
  const tried = useRef(new Set<string>());
  const granter = granterOf(renown);

  useEffect(() => {
    if (!wantsStatement(facts) || !granter) return;
    const now = Math.floor(Date.now() / 1000);
    for (const item of items) {
      if (tried.current.has(item.id)) continue;
      if (!shouldRenew(item.state, granter, facts, now)) continue;
      tried.current.add(item.id);
      void grantAction(granter, facts, item.id)
        .then((action) => dispatchActions([action], item.id))
        .catch((error: unknown) => {
          console.warn(`Could not renew an approval: ${String(error)}`);
        });
    }
  }, [items, facts, granter]);
}
