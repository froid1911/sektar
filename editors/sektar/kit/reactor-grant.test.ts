import {
  buildAndSignCredential,
  decodeDelegation,
  MemoryKeyStorage,
  RenownCryptoBuilder,
  type IRenownCrypto,
  type SignCredentialTypedData,
} from "@renown/sdk/node";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ensureReactorConnection,
  fetchRunnerFacts,
  wantsStatement,
  grantAction,
  granterOf,
  reactorConnectionActions,
  runnerUrl,
  shouldRenew,
  type Granter,
  type RunnerFacts,
} from "./reactor-grant.js";

const addDocument = vi.fn();
const dispatchActions = vi.fn();

vi.mock("@powerhousedao/reactor-browser", async () => {
  const sdk = await import("@renown/sdk/node");
  return {
    addDocument: (...args: unknown[]) => addDocument(...args) as unknown,
    createDelegation: sdk.createDelegation,
    decodeDelegation: sdk.decodeDelegation,
    dispatchActions: (...args: unknown[]) =>
      dispatchActions(...args) as unknown,
  };
});
vi.mock("@powerhousedao/reactor-browser/graphql-client", () => ({
  ambientRenownTokenProvider: () => Promise.resolve("a-token"),
}));
vi.mock("./workflow-runtime.js", () => ({ useWorkflowRuntimeUrl: () => "" }));

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

const newKey = (): Promise<IRenownCrypto> =>
  new RenownCryptoBuilder().withKeyPairStorage(new MemoryKeyStorage()).build();

describe("granting", () => {
  let session: IRenownCrypto;
  let granter: Granter;
  let facts: RunnerFacts;

  beforeAll(async () => {
    session = await newKey();
    const credential = await buildAndSignCredential({
      signTypedData: ((args) =>
        PERSON.signTypedData(args)) as SignCredentialTypedData,
      address: PERSON.address,
      chainId: 1,
      app: "connect",
      appId: session.did,
    });
    granter = granterOf({
      crypto: session,
      user: { address: PERSON.address, credential },
    })!;
    facts = {
      delegate: (await newKey()).did,
      environment: (await newKey()).did,
      requiresPerson: true,
      reactorConnectionId: null,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe("who grants", () => {
    it("needs someone signed in, with a credential", () => {
      expect(granterOf(undefined)).toBeNull();
      expect(granterOf(null)).toBeNull();
      expect(granterOf({ crypto: session })).toBeNull();
      expect(
        granterOf({ crypto: session, user: { address: PERSON.address } }),
      ).toBeNull();
    });
  });

  describe("who takes a statement", () => {
    it("is a host that needs a person and has a key to name", () => {
      expect(wantsStatement(facts)).toBe(true);
      expect(wantsStatement({ ...facts, environment: null })).toBe(false);
    });

    it("is not an open host, whoever is signed in to it", () => {
      expect(wantsStatement({ ...facts, requiresPerson: false })).toBe(false);
      expect(wantsStatement(null)).toBe(false);
      expect(wantsStatement(undefined)).toBe(false);
    });
  });

  describe("the statement", () => {
    it("names the host's key and environment, one integration, and publishing only", async () => {
      const action = await grantAction(granter, facts, "i-1");
      const input = action.input as {
        statement: string;
        person: string;
        grantedAt: string;
        expiresAt: string;
      };
      expect(action.type).toBe("SET_GRANT");
      expect(input.person).toBe(PERSON.address);
      expect(decodeDelegation(input.statement)).toMatchObject({
        iss: session.did,
        aud: facts.delegate,
        env: facts.environment,
        scp: { ops: ["PUBLISH_WORKFLOW"], res: "sektar/integration:i-1" },
      });
    });

    it("refuses a host with no key of its own", async () => {
      await expect(
        grantAction(granter, { ...facts, environment: null }, "i-1"),
      ).rejects.toThrow(/no key to name/);
    });
  });

  describe("the reactor connection", () => {
    it("is made in the Workflows drive when the host has none", async () => {
      addDocument.mockResolvedValue({ id: "conn-1" });
      await ensureReactorConnection(facts, "workflows-drive");
      expect(addDocument).toHaveBeenCalledWith(
        "workflows-drive",
        "Reactor access",
        "powerhouse/connection",
      );
      const [list, id] = dispatchActions.mock.calls[0] as [
        { type: string }[],
        string,
      ];
      expect(id).toBe("conn-1");
      expect(list.map((a) => a.type)).toContain("SET_CONNECTOR");
    });

    it("is left alone when there is one", async () => {
      await ensureReactorConnection(
        { ...facts, reactorConnectionId: "conn-1" },
        "workflows-drive",
      );
      expect(addDocument).not.toHaveBeenCalled();
    });

    it("says so when the Workflows drive is not there", async () => {
      await expect(ensureReactorConnection(facts, undefined)).rejects.toThrow(
        /Workflows drive/,
      );
    });

    it("comes out as the reconciler looks for it", () => {
      const list = reactorConnectionActions(new Date(0));
      const connector = list.find((a) => a.type === "SET_CONNECTOR");
      expect(connector?.input).toEqual({
        connectorId: "@powerhousedao/reactor#reactor",
        authType: "REACTOR",
      });
    });
  });

  describe("renewing", () => {
    const stateWith = async (lifetimeSeconds?: number) => {
      const { createDelegation } = await import("@renown/sdk/node");
      const statement = await createDelegation({
        issuer: granter.issuer,
        credential: granter.credential,
        delegate: facts.delegate,
        environment: facts.environment!,
        scope: { ops: ["PUBLISH_WORKFLOW"], res: "sektar/integration:i-1" },
        ...(lifetimeSeconds ? { lifetimeSeconds } : {}),
      });
      return {
        grant: {
          statement,
          person: PERSON.address,
          grantedAt: "2026-10-30T00:00:00.000Z",
          expiresAt: "2026-11-29T00:00:00.000Z",
        },
      };
    };
    const now = () => Math.floor(Date.now() / 1000);

    it("renews with under ten days left", async () => {
      const state = await stateWith(5 * 24 * 60 * 60);
      expect(shouldRenew(state, granter, facts, now())).toBe(true);
    });

    it("leaves a fresh statement alone", async () => {
      expect(shouldRenew(await stateWith(), granter, facts, now())).toBe(false);
    });

    it("renews one already ended: no network is needed to sign", async () => {
      const state = await stateWith(60);
      expect(
        shouldRenew(state, granter, facts, now() + 400 * 24 * 60 * 60),
      ).toBe(true);
    });

    it("leaves another person's approval alone", async () => {
      const state = await stateWith(60);
      expect(
        shouldRenew(state, { address: "0xsomeone" }, facts, now()),
      ).toBe(false);
    });

    it("leaves a statement for another runner key to the card", async () => {
      const state = await stateWith(60);
      expect(
        shouldRenew(state, granter, { delegate: "did:key:zOther" }, now()),
      ).toBe(false);
    });

    it("has nothing to renew with no grant", () => {
      expect(shouldRenew({ grant: null }, granter, facts, now())).toBe(false);
    });
  });

  describe("asking the host", () => {
    const URL_ = "https://acme.vetra.io/graphql/workflow-runtime";

    it("asks the reconciler's route on the same host, with the bearer", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(facts)),
      );
      vi.stubGlobal("fetch", fetchSpy);
      expect(await fetchRunnerFacts(URL_)).toEqual(facts);
      expect(fetchSpy).toHaveBeenCalledWith(runnerUrl(URL_), {
        headers: { authorization: "Bearer a-token" },
      });
      expect(runnerUrl(URL_)).toBe(
        "https://acme.vetra.io/api/@powerhousedao/sektar/runner",
      );
    });

    it("answers null on a host without the route, which then behaves as ever", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("", { status: 404 })),
      );
      expect(await fetchRunnerFacts(URL_)).toBeNull();
    });

    it("answers null when the host cannot be reached", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
      expect(await fetchRunnerFacts(URL_)).toBeNull();
    });
  });
});
