import {
  buildAndSignCredential,
  createDelegation,
  decodeDelegation,
  MemoryKeyStorage,
  RenownCryptoBuilder,
  type DelegationCredentialStatus,
  type IRenownCrypto,
  type PowerhouseVerifiableCredential,
  type SignCredentialTypedData,
} from "@renown/sdk/node";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CredentialWatch,
  credentialStatusOn,
  integrationResource,
  judgeGrant,
  type HostFacts,
} from "./grant.js";

// viem is the SDK's own dependency; Sektar does not declare it.
type Account = {
  address: `0x${string}`;
  signTypedData(args: unknown): Promise<`0x${string}`>;
};
const { privateKeyToAccount } = createRequire(
  import.meta.resolve("@renown/sdk/node"),
)("viem/accounts") as {
  privateKeyToAccount: (key: `0x${string}`) => Account;
};

// A well-known Anvil dev key; never used for anything real.
const PERSON = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const INTEGRATION = "i-1";

const newKey = (): Promise<IRenownCrypto> =>
  new RenownCryptoBuilder().withKeyPairStorage(new MemoryKeyStorage()).build();

describe("credentialStatusOn", () => {
  const claims = {} as Parameters<CredentialWatch["status"]>[0];

  it("never asks Renown about a local key's credentials", async () => {
    const watch = { status: vi.fn(() => Promise.resolve("revoked" as const)) };

    const status = await credentialStatusOn("kept", watch)(claims);

    expect(status).toBe("unknown");
    expect(watch.status).not.toHaveBeenCalled();
  });

  it.each([undefined, "remote", "self"])(
    "keeps asking on a %s host, where a revocation means something",
    async (source) => {
      const watch = { status: vi.fn(() => Promise.resolve("revoked" as const)) };

      expect(await credentialStatusOn(source, watch)(claims)).toBe("revoked");
    },
  );
});

describe("judging a grant", () => {
  let session: IRenownCrypto;
  let delegate: IRenownCrypto;
  let hostKey: IRenownCrypto;
  let credential: PowerhouseVerifiableCredential;
  let host: HostFacts;

  const statementFor = (
    overrides: Partial<Parameters<typeof createDelegation>[0]> = {},
  ) =>
    createDelegation({
      issuer: session.issuer,
      credential,
      delegate: delegate.did,
      environment: hostKey.did,
      scope: {
        ops: ["PUBLISH_WORKFLOW"],
        res: integrationResource(INTEGRATION),
      },
      ...overrides,
    });

  const grantOf = (statement: string) => ({
    statement,
    person: PERSON.address,
    grantedAt: "2026-10-30T00:00:00.000Z",
    expiresAt: "2026-11-29T00:00:00.000Z",
  });

  const judge = (
    grant: ReturnType<typeof grantOf> | null,
    overrides: Partial<Parameters<typeof judgeGrant>[0]> = {},
  ) =>
    judgeGrant({
      integrationId: INTEGRATION,
      grant,
      host,
      delegate: delegate.did,
      now: Math.floor(Date.now() / 1000),
      credential: () => Promise.resolve("active"),
      ...overrides,
    });

  beforeAll(async () => {
    session = await newKey();
    delegate = await newKey();
    hostKey = await newKey();
    credential = await buildAndSignCredential({
      signTypedData: ((args) =>
        PERSON.signTypedData(args)) as SignCredentialTypedData,
      address: PERSON.address,
      chainId: 1,
      app: "connect",
      appId: session.did,
    });
    host = { environment: hostKey.did, address: null, requiresPerson: true };
  });

  it("signs as the person with a good statement", async () => {
    const statement = await statementFor();
    const grant = await judge(grantOf(statement));
    expect(grant).toMatchObject({
      kind: "delegated",
      statement,
      person: { address: PERSON.address, networkId: "eip155", chainId: 1 },
    });
  });

  it("asks for a grant on a host that needs a person and has none", async () => {
    expect(await judge(null)).toEqual({ kind: "needed", gap: "missing" });
  });

  it("publishes as the host where a host with no delegations always did", async () => {
    expect(
      await judge(null, { host: { ...host, requiresPerson: false } }),
    ).toEqual({ kind: "host" });
    expect(await judge(null, { host: { ...host, address: "0xhost" } })).toEqual(
      { kind: "host" },
    );
  });

  it("stops at the statement's end, and says when", async () => {
    const statement = await statementFor({ lifetimeSeconds: 60 });
    const { exp } = decodeDelegation(statement)!;
    expect(await judge(grantOf(statement), { now: exp })).toEqual({
      kind: "needed",
      gap: "ended",
      endedAt: new Date(exp * 1000).toISOString(),
    });
  });

  it("does not fall back to the host when a person's grant has ended", async () => {
    const statement = await statementFor({ lifetimeSeconds: 60 });
    const { exp } = decodeDelegation(statement)!;
    const grant = await judge(grantOf(statement), {
      now: exp + 1,
      host: { ...host, address: "0xhost", requiresPerson: false },
    });
    expect(grant.kind).toBe("needed");
  });

  it("stops on a revocation", async () => {
    const grant = await judge(grantOf(await statementFor()), {
      credential: () => Promise.resolve("revoked"),
    });
    expect(grant).toEqual({ kind: "needed", gap: "revoked" });
  });

  it.each<DelegationCredentialStatus>(["unknown", "expired"])(
    "carries on when Renown says %s",
    async (status) => {
      const grant = await judge(grantOf(await statementFor()), {
        credential: () => Promise.resolve(status),
      });
      expect(grant.kind).toBe("delegated");
    },
  );

  it("refuses a statement naming another key", async () => {
    const other = await newKey();
    const grant = await judge(
      grantOf(await statementFor({ delegate: other.did })),
    );
    expect(grant).toEqual({ kind: "needed", gap: "invalid" });
  });

  it("refuses a statement for another environment", async () => {
    const elsewhere = await newKey();
    const grant = await judge(
      grantOf(await statementFor({ environment: elsewhere.did })),
    );
    expect(grant).toEqual({ kind: "needed", gap: "invalid" });
  });

  it("refuses a statement for another integration", async () => {
    const grant = await judge(grantOf(await statementFor()), {
      integrationId: "i-2",
    });
    expect(grant).toEqual({ kind: "needed", gap: "invalid" });
  });

  it("refuses when the runner key cannot be read, or the statement is junk", async () => {
    expect(
      await judge(grantOf(await statementFor()), { delegate: null }),
    ).toEqual({ kind: "needed", gap: "invalid" });
    expect(await judge(grantOf("not.a.statement"))).toEqual({
      kind: "needed",
      gap: "invalid",
    });
  });

  it("never asks Renown to sign or stop for a statement it refused", async () => {
    const credentialCheck = vi.fn();
    await judge(grantOf("not.a.statement"), { credential: credentialCheck });
    expect(credentialCheck).not.toHaveBeenCalled();
  });

  describe("CredentialWatch", () => {
    const watching = (
      answers: DelegationCredentialStatus[],
      start = 0,
    ): {
      watch: CredentialWatch;
      check: ReturnType<typeof vi.fn>;
      tick: (ms: number) => void;
    } => {
      let now = start;
      const check = vi.fn();
      for (const status of answers) check.mockResolvedValueOnce({ status });
      return {
        watch: new CredentialWatch(
          "https://renown.test",
          check as never,
          () => now,
          1_000,
        ),
        check,
        tick: (ms) => {
          now += ms;
        },
      };
    };

    it("asks at most once per interval", async () => {
      const claims = decodeDelegation(await statementFor())!;
      const { watch, check, tick } = watching(["active", "active"]);
      await watch.status(claims);
      await watch.status(claims);
      expect(check).toHaveBeenCalledOnce();
      tick(2_000);
      await watch.status(claims);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("passes the credential's date, and warns once while Renown is away", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const claims = decodeDelegation(await statementFor())!;
      const { watch, check, tick } = watching(["unknown", "unknown"]);
      expect(await watch.status(claims)).toBe("unknown");
      tick(2_000);
      expect(await watch.status(claims)).toBe("unknown");
      expect(check.mock.calls[0][0]).toMatchObject({
        expirationDate: credential.expirationDate,
        appDid: session.did,
      });
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it("remembers a revocation for that statement", async () => {
      const claims = decodeDelegation(await statementFor())!;
      const { watch, check, tick } = watching(["revoked"]);
      await watch.status(claims);
      tick(10_000);
      expect(await watch.status(claims)).toBe("revoked");
      expect(check).toHaveBeenCalledOnce();
    });
  });
});
