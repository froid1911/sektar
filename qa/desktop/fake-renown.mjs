// A Renown for the acceptance tests: the routes Sektar's sign-in reaches, with
// real signed credentials, so everything past it is the real thing.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(
  new URL("../../../powerhouse/packages/desktop/package.json", import.meta.url),
);
const sibling = (name) => import(pathToFileURL(require.resolve(name)).href);
const { privateKeyToAccount } = await sibling("viem/accounts");
const { buildAndSignCredential } = await sibling("@renown/sdk/node");

/** Anvil's well-known test accounts. */
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];
export const accounts = KEYS.map((key) => privateKeyToAccount(key));

/** One pixel, of each format the app keeps. */
const AVATARS = {
  "image/png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
  "image/jpeg": Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z",
    "base64",
  ),
};

export async function startFakeRenown(port) {
  const sessions = new Map();
  const credentials = new Map();
  const requests = [];
  const state = { avatarType: "image/png" };

  async function credentialFor(account, appId) {
    const key = `${account.address.toLowerCase()}|${appId}`;
    if (!credentials.has(key)) {
      credentials.set(
        key,
        await buildAndSignCredential({
          signTypedData: (args) => account.signTypedData(args),
          address: account.address,
          chainId: 1,
          app: "connect",
          appId,
        }),
      );
    }
    return credentials.get(key);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    requests.push({ path: url.pathname, origin: request.headers.origin });
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    };
    const json = (body, status = 200) => {
      response.writeHead(status, {
        ...headers,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(body));
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      return response.end();
    }
    if (url.pathname === "/console") {
      sessions.set(url.searchParams.get("session"), {
        connect: url.searchParams.get("connect"),
        account: undefined,
      });
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end("<p>Fake Renown. You can close this.</p>");
    }
    const session = url.pathname.match(/^\/api\/console\/session\/(.+)$/)?.[1];
    if (session) {
      const found = sessions.get(session);
      if (!found?.account) return json({ sessionId: session, status: "pending" });
      await credentialFor(found.account, found.connect);
      return json({
        sessionId: session,
        status: "ready",
        address: found.account.address,
        chainId: 1,
        did: `did:pkh:eip155:1:${found.account.address.toLowerCase()}`,
        credentialId: "cred",
        userDocumentId: "doc",
      });
    }
    if (url.pathname === "/api/auth/credential") {
      const address = url.searchParams.get("address")?.toLowerCase();
      const account = accounts.find((a) => a.address.toLowerCase() === address);
      const appId = url.searchParams.get("appId");
      const held = account && credentials.get(`${address}|${appId}`);
      return held ? json({ credential: held }) : json({ error: "none" }, 404);
    }
    if (url.pathname === "/api/profile") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { ethAddress } = JSON.parse(body);
      const index = accounts.findIndex(
        (a) => a.address.toLowerCase() === ethAddress.toLowerCase(),
      );
      return json({
        profile: {
          documentId: `user-${index}`,
          ethAddress,
          username: `person${index}`,
          userImage: `http://127.0.0.1:${port}/avatar`,
        },
      });
    }
    if (url.pathname === "/avatar") {
      response.writeHead(200, { ...headers, "Content-Type": state.avatarType });
      return response.end(AVATARS[state.avatarType]);
    }
    return json({ error: "not found" }, 404);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    state,
    /** Plays the person approving the newest session. */
    async approve(account, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const waiting = [...sessions.values()].find((s) => !s.account);
        if (waiting) {
          waiting.account = account;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Nobody opened the Renown console");
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
