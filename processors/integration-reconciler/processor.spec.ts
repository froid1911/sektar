import {
  actions,
  reducer,
  utils,
  type IntegrationDocument,
} from "document-models/integration/v1";
import {
  buildAndSignCredential,
  createDelegation,
  createRenownTrustPolicy,
  MemoryKeyStorage,
  RenownCryptoBuilder,
  type IRenownCrypto,
  type SignCredentialTypedData,
} from "@renown/sdk/node";
import type { Action } from "document-model";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActions,
  defaultChoices,
} from "../../editors/sektar/kit/integrations.js";
import { integrationResource } from "./grant.js";
import { connectionFor } from "./reconcile.js";
import { findReactorConnection, IntegrationReconciler } from "./processor.js";
import { loadRunnerKey } from "./runner-key.js";

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
const CONNECTION = "conn-google";
const REACTOR_CONNECTION = "conn-reactor";
const NOW = new Date(2026, 9, 28, 9, 30);

const newKey = (): Promise<IRenownCrypto> =>
  new RenownCryptoBuilder().withKeyPairStorage(new MemoryKeyStorage()).build();

/** A connection signed in for everything an integration asks. */
const signedIn = (scopes: string[]) => ({
  header: { id: CONNECTION },
  state: {
    global: {
      status: "OK",
      secretRefs: [{ name: "token" }],
      config: { oauth_scopes: scopes, oauth_granted_scopes: scopes },
      accountLabel: "person@example.com",
    },
  },
});

const reactorConnection = (status = "OK") => ({
  header: { id: REACTOR_CONNECTION },
  state: {
    global: {
      connectorId: "@powerhousedao/reactor#reactor",
      authType: "REACTOR",
      status,
    },
  },
});

describe("the reconciler on a host that needs a person", () => {
  let dir: string;
  let previous: string | undefined;
  let session: IRenownCrypto;
  let hostKey: IRenownCrypto;
  let runner: IRenownCrypto;
  let credential: Awaited<ReturnType<typeof buildAndSignCredential>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "reconciler-"));
    previous = process.env.PH_USER_DATA_DIR;
    process.env.PH_USER_DATA_DIR = dir;
    session = await newKey();
    hostKey = await newKey();
    runner = await loadRunnerKey();
    credential = await buildAndSignCredential({
      signTypedData: ((args) =>
        PERSON.signTypedData(args)) as SignCredentialTypedData,
      address: PERSON.address,
      chainId: 1,
      app: "connect",
      appId: session.did,
    });
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.PH_USER_DATA_DIR;
    else process.env.PH_USER_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("no network in this test")),
    );
    return () => vi.unstubAllGlobals();
  });

  /** One integration, signed in, on a host with no address. */
  function harness() {
    let doc: IntegrationDocument = utils.createDocument();
    for (const action of createActions(
      defaultChoices("CALENDAR", "google-calendar", NOW),
      NOW,
      () => `id-${String(Math.random())}`,
    )) {
      doc = reducer(doc, action);
    }
    doc = reducer(doc, actions.recordResources({ connectionId: CONNECTION }));
    let created = 0;
    const executed: { id: string; list: Action[] }[] = [];
    const scopes = connectionFor("Calendar", doc.state.global)!.config
      .oauth_scopes as string[];
    const module = {
      host: { key: hostKey.did, address: null, requiresPerson: true },
      getReadModel: () => {
        throw new Error("no runtime here");
      },
      dispatch: {
        createInDrive: () =>
          Promise.resolve({ documentId: `wf-${String(++created)}` }),
        deleteDocument: () => Promise.resolve(),
        execute: (id: string, _branch: string, list: Action[]) => {
          if (id === INTEGRATION) {
            for (const action of list) {
              doc = reducer(doc, action as never);
            }
          } else {
            executed.push({ id, list });
          }
          return Promise.resolve({ id: "job", status: "PENDING" });
        },
      },
      read: {
        get: (id: string) => {
          if (id === INTEGRATION) {
            return Promise.resolve({
              header: { id, name: "Calendar" },
              state: doc.state,
            });
          }
          if (id === CONNECTION) return Promise.resolve(signedIn(scopes));
          if (id.startsWith("wf-")) return Promise.reject(new Error("gone"));
          return Promise.resolve({ header: { id } });
        },
        find: () => Promise.resolve({ results: [reactorConnection()] }),
        getOperations: () => Promise.resolve({ results: [] }),
      },
    };
    const reconciler = new IntegrationReconciler(
      "drive",
      module as unknown as ConstructorParameters<
        typeof IntegrationReconciler
      >[1],
    );
    const pass = async () => {
      await reconciler.onOperations([
        {
          context: {
            documentType: "sektar/integration",
            documentId: INTEGRATION,
          },
        },
      ] as never);
      await (reconciler as unknown as { queue: Promise<void> }).queue;
    };
    return {
      pass,
      executed,
      doc: () => doc,
      grantWith: async (delegate = runner.did) => {
        const statement = await createDelegation({
          issuer: session.issuer,
          credential,
          delegate,
          environment: hostKey.did,
          scope: {
            ops: ["PUBLISH_WORKFLOW"],
            res: integrationResource(INTEGRATION),
          },
        });
        doc = reducer(
          doc,
          actions.setGrant({
            statement,
            person: PERSON.address,
            grantedAt: NOW.toISOString(),
            expiresAt: NOW.toISOString(),
          }),
        );
        return statement;
      },
    };
  }

  it("publishes nothing as nobody, and asks", async () => {
    const h = harness();
    await h.pass();
    expect(h.executed).toEqual([]);
    expect(h.doc().state.global.check?.issues.at(0)).toMatchObject({
      code: "NEEDS_GRANT",
      fixable: true,
    });
  });

  it("signs the publish as the person, and leaves the rest to the host", async () => {
    const h = harness();
    const statement = await h.grantWith();
    await h.pass();

    const [{ id, list }] = h.executed;
    const publish = list.find((a) => a.type === "PUBLISH_WORKFLOW")!;
    const signer = publish.context!.signer!;
    expect(signer.user.address).toBe(PERSON.address);
    expect(signer.app.key).toBe(runner.did);
    expect(signer.app.key).not.toBe(hostKey.did);
    expect(signer.signatures[0][3]).toBe(statement);
    for (const action of list.filter((a) => a !== publish)) {
      expect(action.context?.signer).toBeUndefined();
    }

    // What this switchboard's own trust policy says of it, at first write.
    const policy = createRenownTrustPolicy({
      delegationOnly: true,
      self: {
        key: hostKey.did,
        user: { address: "", networkId: "", chainId: 0 },
      },
    });
    expect(
      await policy.authorizeSigner(signer, runner.did, id, {
        path: "mutation",
        actionType: publish.type,
      }),
    ).toBe(true);
  });

  it("goes on signing with Renown unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness();
    await h.grantWith();
    await h.pass();
    expect(h.executed.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("refuses to sign for a statement naming another key", async () => {
    const h = harness();
    await h.grantWith((await newKey()).did);
    await h.pass();
    expect(h.executed).toEqual([]);
    expect(h.doc().state.global.check?.issues.at(0)?.code).toBe("NEEDS_GRANT");
  });
});

describe("findReactorConnection", () => {
  const read = (results: unknown[]) =>
    ({ find: () => Promise.resolve({ results }) }) as never;

  it("takes a working connection", async () => {
    expect(await findReactorConnection(read([reactorConnection()]))).toBe(
      REACTOR_CONNECTION,
    );
  });

  it("skips a revoked connection, which grants nothing", async () => {
    expect(
      await findReactorConnection(read([reactorConnection("REVOKED")])),
    ).toBeNull();
  });

  it("finds the working one past a revoked one", async () => {
    const working = reactorConnection();
    working.header.id = "conn-good";
    expect(
      await findReactorConnection(
        read([reactorConnection("REVOKED"), working]),
      ),
    ).toBe("conn-good");
  });

  it("ignores other connections", async () => {
    expect(
      await findReactorConnection(
        read([
          {
            header: { id: "google" },
            state: { global: { connectorId: "x", authType: "OAUTH2" } },
          },
        ]),
      ),
    ).toBeNull();
  });
});
