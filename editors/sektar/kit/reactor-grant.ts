// Letting Sektar write to a person's documents (ADR 0008). The person's own key
// signs a statement naming this environment's runner key, one per integration,
// with no wallet step; the reconciler then signs publishes as them. The step
// also makes the reactor connection a new environment does not have yet.
import {
  addDocument,
  createDelegation,
  decodeDelegation,
  dispatchActions,
  type DelegationClaims,
} from "@powerhousedao/reactor-browser";
import { ambientRenownTokenProvider } from "@powerhousedao/reactor-browser/graphql-client";
import {
  actions as connectionActions,
  REACTOR_CONNECTOR_ID,
} from "@powerhousedao/workflow/document-models/connection";
import { actions, type IntegrationAction } from "document-models/integration";
import type { IntegrationState } from "document-models/integration";
import { useEffect, useState } from "react";
import { useWorkflowRuntimeUrl } from "./workflow-runtime.js";

const CONNECTION_TYPE = "powerhouse/connection";
const CONNECTION_NAME = "Reactor access";
/** What a statement lets the runner sign. Nothing else. */
const DELEGATED_OPERATIONS = ["PUBLISH_WORKFLOW"];
/** A statement renews on a visit with less than this left. */
const RENEW_WITHIN_SECONDS = 10 * 24 * 60 * 60;

/** The host's own answer: a document could name someone else's key. */
export type RunnerFacts = {
  delegate: string;
  environment: string | null;
  requiresPerson: boolean;
  reactorConnectionId: string | null;
};

/** The person doing the granting, as Renown's session has them. */
export type Granter = {
  issuer: Parameters<typeof createDelegation>[0]["issuer"];
  address: string;
  credential: Parameters<typeof createDelegation>[0]["credential"];
};

/** The reconciler's route, on the switchboard that serves the runtime. */
export function runnerUrl(workflowRuntimeUrl: string): string {
  const { origin } = new URL(workflowRuntimeUrl);
  return `${origin}/api/@powerhousedao/sektar/runner`;
}

/** Null when this host has no such route: it behaves as it always has. */
export async function fetchRunnerFacts(
  workflowRuntimeUrl: string,
): Promise<RunnerFacts | null> {
  const token = await ambientRenownTokenProvider();
  const response = await fetch(runnerUrl(workflowRuntimeUrl), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as RunnerFacts | null;
}

/** The host's answer; undefined until known. `refresh` asks again. */
export function useRunnerFacts(): {
  facts: RunnerFacts | null | undefined;
  refresh: () => void;
} {
  const url = useWorkflowRuntimeUrl();
  const [facts, setFacts] = useState<RunnerFacts | null | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    void fetchRunnerFacts(url).then((answer) => {
      if (live) setFacts(answer);
    });
    return () => {
      live = false;
    };
  }, [url, asked]);
  return { facts, refresh: () => setAsked((n) => n + 1) };
}

/** The actions that make a new connection document the reactor connection. */
export function reactorConnectionActions(now: Date) {
  return [
    connectionActions.setConnectionName({ name: CONNECTION_NAME }),
    connectionActions.setName(CONNECTION_NAME),
    connectionActions.setConnector({
      connectorId: REACTOR_CONNECTOR_ID,
      authType: "REACTOR",
    }),
    connectionActions.setConfig({ config: { endpoint: "local" } }),
    // Nothing to fill in, so it is ready as made.
    connectionActions.recordCheckResult({
      status: "OK",
      checkedAt: now.toISOString(),
    }),
  ];
}

/** Makes the reactor connection, unless the host says it has one. */
export async function ensureReactorConnection(
  facts: RunnerFacts,
  workflowsDriveId: string | undefined,
): Promise<void> {
  if (facts.reactorConnectionId) return;
  if (!workflowsDriveId) throw new Error("The Workflows drive is not open");
  const node = await addDocument(
    workflowsDriveId,
    CONNECTION_NAME,
    CONNECTION_TYPE,
  );
  await dispatchActions(reactorConnectionActions(new Date()), node.id);
}

/**
 * Whether this host takes a statement at all. An open host publishes as it
 * always has, whoever happens to be signed in to it.
 */
export function wantsStatement(
  facts: RunnerFacts | null | undefined,
): facts is RunnerFacts {
  return Boolean(facts?.requiresPerson && facts.environment);
}

/** The session the statement is signed with, or null with nobody signed in. */
export function granterOf(
  renown:
    | {
        crypto: { issuer: Granter["issuer"] };
        user?: {
          address: string;
          credential?: Granter["credential"] | undefined;
        };
      }
    | null
    | undefined,
): Granter | null {
  const user = renown?.user;
  if (!renown || !user?.credential) return null;
  return {
    issuer: renown.crypto.issuer,
    address: user.address,
    credential: user.credential,
  };
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Signs a statement for one integration: the action that records it. */
export async function grantAction(
  granter: Granter,
  facts: RunnerFacts,
  integrationId: string,
): Promise<IntegrationAction> {
  if (!facts.environment) {
    throw new Error("This environment has no key to name");
  }
  const statement = await createDelegation({
    issuer: granter.issuer,
    credential: granter.credential,
    delegate: facts.delegate,
    environment: facts.environment,
    scope: {
      ops: DELEGATED_OPERATIONS,
      res: `sektar/integration:${integrationId}`,
    },
  });
  const claims: DelegationClaims = decodeDelegation(statement)!;
  return actions.setGrant({
    statement,
    person: granter.address,
    grantedAt: iso(claims.iat),
    expiresAt: iso(claims.exp),
  });
}

/**
 * Whether this person's visit should renew this integration's statement: it is
 * theirs, it names the key the host uses now, and it is running out.
 */
export function shouldRenew(
  state: Pick<IntegrationState, "grant">,
  granter: Pick<Granter, "address">,
  facts: Pick<RunnerFacts, "delegate">,
  nowSeconds: number,
): boolean {
  const grant = state.grant;
  if (!grant || grant.person.toLowerCase() !== granter.address.toLowerCase()) {
    return false;
  }
  const claims = decodeDelegation(grant.statement);
  if (!claims || claims.aud !== facts.delegate) return false;
  return claims.exp - nowSeconds < RENEW_WITHIN_SECONDS;
}
