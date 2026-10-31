/**
 * What the reconciler may do for an integration, judged afresh on each pass
 * (ADR 0008): sign its publishes as the person who granted it, publish as the
 * host as it always has, or stop and ask. It never publishes as nobody on a host
 * that needs a person: the run would have no user, and read nothing.
 */
import type { DelegationClaims, DelegationCredentialStatus } from "@renown/sdk/node";
import {
  checkDelegationCredential,
  decodeDelegation,
  parsePkhDid,
  verifyDelegation,
} from "@renown/sdk/node";
import type { IntegrationGrant } from "document-models/integration";

/** What a delegate may sign, and all it signs. */
export const PUBLISH_WORKFLOW = "PUBLISH_WORKFLOW";

export type Person = { address: string; networkId: string; chainId: number };

/** Why the reconciler stopped: nothing was granted, it ran out, or it was withdrawn. */
export type GrantGap = "missing" | "ended" | "revoked" | "invalid";

export type ReconcileGrant =
  /** Publish through the host, as a host with no delegations always has. */
  | { kind: "host" }
  /** Sign publishes as the person. */
  | { kind: "delegated"; person: Person; statement: string; expiresAt: string }
  /** Stop, and ask for the grant. */
  | { kind: "needed"; gap: GrantGap; endedAt?: string };

export type HostFacts = {
  /** The host's own key; null where it has none. */
  environment: string | null;
  /** Who the host is signed in as; null when nobody. */
  address: string | null;
  /** Reads need a person here. */
  requiresPerson: boolean;
};

export type JudgeGrantParams = {
  integrationId: string;
  grant: IntegrationGrant | null | undefined;
  host: HostFacts;
  /** The runner key; null when it could not be read. */
  delegate: string | null;
  /** Epoch seconds. */
  now: number;
  /** What Renown last said of the first link. */
  credential: (claims: DelegationClaims) => Promise<DelegationCredentialStatus>;
};

/** The resource a statement for an integration names. */
export function integrationResource(integrationId: string): string {
  return `sektar/integration:${integrationId}`;
}

function personOf(claims: DelegationClaims): Person | null {
  try {
    const { networkId, chainId } = parsePkhDid(claims.sub);
    return {
      address: claims.prf.issuer.ethereumAddress,
      networkId,
      chainId,
    };
  } catch {
    return null;
  }
}

export async function judgeGrant(
  params: JudgeGrantParams,
): Promise<ReconcileGrant> {
  const { integrationId, grant, host, delegate, now, credential } = params;
  if (!grant) {
    return host.requiresPerson && !host.address
      ? { kind: "needed", gap: "missing" }
      : { kind: "host" };
  }

  const claims = decodeDelegation(grant.statement);
  const person = claims ? personOf(claims) : null;
  if (!claims || !person || !delegate) {
    return { kind: "needed", gap: "invalid" };
  }
  const endedAt = new Date(claims.exp * 1000).toISOString();
  if (now >= claims.exp) return { kind: "needed", gap: "ended", endedAt };

  const verdict = await verifyDelegation(grant.statement, {
    user: person,
    key: delegate,
    signedAt: now,
    actionType: PUBLISH_WORKFLOW,
  });
  if (
    !verdict.ok ||
    claims.env !== host.environment ||
    claims.scp.res !== integrationResource(integrationId)
  ) {
    return { kind: "needed", gap: "invalid" };
  }

  // Only a definite answer stops anything. Expiry of the first link is not
  // one: link one is judged at issuance, and credentials last only days.
  if ((await credential(claims)) === "revoked") {
    return { kind: "needed", gap: "revoked" };
  }
  return {
    kind: "delegated",
    person,
    statement: grant.statement,
    expiresAt: endedAt,
  };
}

type Check = typeof checkDelegationCredential;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Asks Renown about a statement's credential at most hourly. A revocation is
 * remembered for that statement. No answer is `unknown`, warned about once and
 * never a reason to stop: an offline computer must go on working.
 */
export class CredentialWatch {
  private readonly seen = new Map<
    string,
    { status: DelegationCredentialStatus; at: number }
  >();

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly check: Check = checkDelegationCredential,
    private readonly clock: () => number = Date.now,
    private readonly everyMs: number = HOUR_MS,
  ) {}

  async status(claims: DelegationClaims): Promise<DelegationCredentialStatus> {
    const last = this.seen.get(claims.jti);
    const now = this.clock();
    if (last?.status === "revoked") return last.status;
    if (last && now - last.at < this.everyMs) return last.status;
    const { status } = await this.check({
      address: claims.prf.issuer.ethereumAddress,
      chainId: parsePkhDid(claims.sub).chainId,
      appDid: claims.iss,
      expirationDate: claims.prf.expirationDate,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
    });
    if (status === "unknown" && last?.status !== "unknown") {
      console.warn(
        "[integration-reconciler] Renown did not answer about a grant's credential; carrying on",
      );
    }
    this.seen.set(claims.jti, { status, at: now });
    return status;
  }
}
