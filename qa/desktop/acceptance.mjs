// The Desktop App's acceptance tests: the real app, real files, driven through
// WebView2's debugging port. Windows only. What they check is the "Sektar Desktop
// App" section of sektar.io/docs (sektar-marketing-site/docs/where-sektar-runs.mdx).
//
//   node --test qa/desktop/acceptance.mjs
//
// SEKTAR_EXE picks the app: an installed one, or by default the debug build from
// `ph run desktop dev`, which runs the stack from this checkout, or from a staged
// stack in SEKTAR_STACK, which tries one without compiling an app. Every test runs
// on its own scratch root through PH_DESKTOP_ROOT, so nothing here can reach the
// real store in .ph. Resolves Playwright and ethers from the sibling checkouts,
// so this project takes on no test dependencies for it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accounts, startFakeRenown } from "./fake-renown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..", "..");
const workspace = path.resolve(project, "..");

const { chromium } = createRequire(
  path.join(workspace, "sektar-marketing-site", "package.json"),
)("@playwright/test");
const { Wallet } = await import(
  pathToFileURL(
    createRequire(path.join(workspace, "powerhouse/packages/desktop/package.json")).resolve(
      "ethers",
    ),
  ).href
);

const RENOWN_PORT = 4977;
const DEBUG_PORT = 9222;
const CONNECT_PORT = 6540;
const SWITCHBOARD_PORT = 7540;
const IDENTIFIER = "inc.powerhouse.desktop.sektar";
const LOCAL_DATA = path.join(process.env.LOCALAPPDATA, IDENTIFIER);
const PASSWORD = "correct horse battery";
const OLD_DATA = path.join(process.env.APPDATA, `${IDENTIFIER}.bak-20261031`, ".ph");

const installed = process.env.SEKTAR_EXE;
const exe =
  installed ?? path.join(project, "hosts/desktop/tauri-shell/target/debug/sektar.exe");
const stagedStack = process.env.SEKTAR_STACK;
const packaged = installed ?? stagedStack;
const stackEnv = installed
  ? {}
  : {
      PH_RUN_PROJECT: stagedStack ?? project,
      PH_RUN_CLI: stagedStack
        ? path.join(stagedStack, "node_modules/@powerhousedao/ph-run/dist/cli.mjs")
        : path.join(
            fs.realpathSync(path.join(project, "node_modules/@powerhousedao/ph-cli")),
            "dist/cli.mjs",
          ),
      PH_WIN_CONNECT_PORT: String(CONNECT_PORT),
      FEATURE_UNIFORM_RUNNERS_ENABLED: "1",
    };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const address = (account) => account.address.toLowerCase();

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function until(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

function scratchRoot(name) {
  const root = path.join(os.tmpdir(), "sektar-acceptance", `${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writeSettings(root, settings = {}) {
  const renown = { url: `http://127.0.0.1:${RENOWN_PORT}`, ...settings.renown };
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ ...settings, renown }, null, 2),
  );
}

/** Forgets the window's session, as a new computer would have none. WebView2's
    processes hold the folder for a moment after the app has gone. */
async function clearWindow() {
  const folder = path.join(LOCAL_DATA, "EBWebView");
  await until(() => {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }, "the window's data to be released");
}

/** How postgres left a store, from its own control file. */
function storeState(folder, store) {
  const control = path.join(folder, ".ph", store, "global", "pg_control");
  const state = fs.readFileSync(control).readUInt32LE(16);
  return { 1: "shut down", 6: "in production" }[state] ?? `state ${state}`;
}

const storesLeftBy = (folder) => [
  storeState(folder, "reactor-storage"),
  storeState(folder, "read-storage"),
];

/** Workflow leases still in a stack's stores, once it has stopped. */
async function workflowLeases(folder) {
  const api = fs.realpathSync(path.join(project, "node_modules/@powerhousedao/reactor-api"));
  const pglite = createRequire(path.join(api, "package.json")).resolve("@electric-sql/pglite");
  const { PGlite } = await import(pathToFileURL(pglite).href);
  let tables = 0;
  let leases = 0;
  for (const store of ["reactor-storage", "read-storage"]) {
    const db = new PGlite(path.join(folder, ".ph", store));
    const { rows } = await db.query(
      `select n.nspname as schema from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relname = 'workflow_singleton'`,
    );
    for (const { schema } of rows) {
      tables++;
      const count = await db.query(`select count(*)::int as n from "${schema}".workflow_singleton`);
      leases += count.rows[0].n;
    }
    await db.close();
  }
  assert.ok(tables > 0, "no lease table: this checked nothing");
  return leases;
}

function logText() {
  const file = path.join(LOCAL_DATA, "logs", "ph-win.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

async function launch(root, env = {}) {
  await until(
    async () =>
      !(await isListening(CONNECT_PORT)) &&
      !(await isListening(SWITCHBOARD_PORT)) &&
      !(await isListening(DEBUG_PORT)),
    "the ports to be free",
  );
  const app = spawn(exe, [], {
    env: {
      ...process.env,
      ...stackEnv,
      PH_DESKTOP_ROOT: root,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
      ...env,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => app.once("exit", resolve));
  await until(() => isListening(DEBUG_PORT), "the window's debugging port");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const page = await until(
    () => browser.contexts()[0]?.pages()[0],
    "the window's page",
  );
  return {
    browser,
    page,
    exited,
    /** As clicking the window's X, which Windows sends as a message. */
    closeWindow() {
      spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${app.pid}).CloseMainWindow()`,
      ]);
    },
    /** The app alone, as a crash would: what it started stays behind. */
    die() {
      spawnSync("taskkill", ["/PID", String(app.pid), "/F"]);
    },
    async stop() {
      await browser.close().catch(() => {});
      spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
      await until(
        async () => !(await isListening(CONNECT_PORT)),
        "the app to stop",
        30_000,
      );
    },
  };
}

const signInPage = (page) =>
  page.waitForSelector("#sign-in h1", { timeout: 60_000 });

/** Connect is up, and past its sign-in gate: this is the app's own shell. */
const connectIsOpen = async (page) => {
  await page.waitForURL(
    (url) => url.port === String(CONNECT_PORT) && !url.pathname.includes("sign-in"),
    { timeout: 180_000 },
  );
  await page.waitForSelector(".sk-sidebar, .sk-shell", { timeout: 120_000 });
};

async function createLocalKey(page) {
  await page.click("#local");
  await page.fill("#password", PASSWORD);
  await page.fill("#repeat", PASSWORD);
  await page.click("#create");
}

async function signInWithRenown(page, renown, account) {
  await page.click("#renown");
  await renown.approve(account);
}

/** A real document, made through the client the app itself uses. */
const makeDocument = (page) =>
  page.evaluate(async () => {
    const document = await window.ph.reactorClient.createEmpty(
      "powerhouse/document-drive",
    );
    return document.header.id;
  });

const canOpen = (page, id) =>
  page.evaluate(
    (id) =>
      window.ph.reactorClient.get(id).then(
        () => true,
        () => false,
      ),
    id,
  );

/** The switchboard answers strangers with a refusal. */
async function anonymousStatus() {
  const response = await fetch(`http://127.0.0.1:${SWITCHBOARD_PORT}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ __typename }" }),
  });
  return response.status;
}

/** What's in the app's own folder, which outlives every identity. */
function appFiles() {
  const stack = path.join(path.dirname(installed), "stack");
  const list = (folder) => fs.readdirSync(path.join(stack, folder)).sort();
  return { stack: list("."), state: list(".ph") };
}

let renown;
let appFilesAtStart;

before(async () => {
  renown = await startFakeRenown(RENOWN_PORT);
  if (installed) appFilesAtStart = appFiles();
});
after(async () => {
  await renown.close();
});

test("nothing starts before someone signs in", async () => {
  await clearWindow();
  const root = scratchRoot("before");
  const app = await launch(root);
  try {
    await signInPage(app.page);
    assert.equal(await isListening(SWITCHBOARD_PORT), false);
    assert.match(await app.page.textContent("#sign-in"), /Sign in with Renown/);
    assert.ok((await app.page.textContent(".folder")).includes(root));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    await app.stop();
  }
});

test("a local key: created, unlocked, and its identity is the admin", async () => {
  await clearWindow();
  const root = scratchRoot("local");
  writeSettings(root);
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);

    // The key is a keystore another wallet can open.
    const keystore = fs.readFileSync(path.join(root, "local.key"), "utf8");
    const wallet = await Wallet.fromEncryptedJson(keystore, PASSWORD);
    assert.equal(JSON.parse(keystore).version, 3);
    assert.ok(!keystore.includes(wallet.privateKey.slice(2)));

    // Everything is in the identity's folder, and the root holds only the rest.
    assert.deepEqual(fs.readdirSync(root).sort(), ["local", "local.key", "settings.json"]);
    assert.ok(fs.existsSync(path.join(root, "local/.ph/reactor-storage")));
    assert.ok(fs.existsSync(path.join(root, "local/backups")));

    // Sign-in is enforced, and the AI gateway, which needs an admin, is on.
    assert.equal(await anonymousStatus(), 401);
    assert.doesNotMatch(logText(), /AI gateway is not mounted/);
    assert.match(logText(), new RegExp(`ADMINS=${wallet.address.toLowerCase()}`));
    assert.match(logText(), /RENOWN_SOURCE=kept/);
    if (installed) assert.match(logText(), /NODE_ENV=production/);
    assert.doesNotMatch(logText(), /are refused until it is/);

    // The window keeps no documents of its own.
    const stores = await app.page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    );
    assert.deepEqual(
      stores.filter((name) => /pglite|reactor/i.test(name)),
      [],
      `stores: ${stores}`,
    );
    await app.stop();

    // A wrong password opens nothing.
    app = await launch(root);
    await signInPage(app.page);
    await app.page.click("#as-local");
    await app.page.fill("#password", "not the password");
    await app.page.click("#unlock");
    await app.page.waitForSelector(".notice");
    assert.match(await app.page.textContent(".notice"), /doesn't unlock/);
    assert.equal(await isListening(SWITCHBOARD_PORT), false);

    // The right one does, from the list of identities.
    await app.page.fill("#password", PASSWORD);
    await app.page.click("#unlock");
    await connectIsOpen(app.page);
  } finally {
    await app.stop();
  }
});

test("replacing the local key keeps the folder, and the new key is the admin", async () => {
  await clearWindow();
  const root = scratchRoot("replace");
  writeSettings(root);
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    const document = await makeDocument(app.page);
    await app.stop();
    const oldKey = JSON.parse(fs.readFileSync(path.join(root, "local.key"), "utf8"));

    app = await launch(root);
    await signInPage(app.page);
    await app.page.click("#as-local");
    await app.page.click("#replace");
    await app.page.fill("#password", "a new password");
    await app.page.fill("#repeat", "a new password");
    await app.page.click("#create");
    await connectIsOpen(app.page);

    const newKey = JSON.parse(fs.readFileSync(path.join(root, "local.key"), "utf8"));
    assert.notEqual(newKey.address, oldKey.address);
    assert.ok(await canOpen(app.page, document));
    assert.match(logText(), new RegExp(`ADMINS=0x${newKey.address}`));
  } finally {
    await app.stop();
  }
});

test("Renown identities each get their own folder, and can be switched", async () => {
  await clearWindow();
  const root = scratchRoot("renown");
  writeSettings(root);
  const [first, second] = accounts;
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await signInWithRenown(app.page, renown, first);
    await connectIsOpen(app.page);
    assert.ok(fs.existsSync(path.join(root, address(first), ".ph/reactor-storage")));
    assert.match(logText(), new RegExp(`ADMINS=${address(first)}`));
    assert.doesNotMatch(logText(), /RENOWN_SOURCE=kept/);
    const mine = await makeDocument(app.page);
    assert.ok(await canOpen(app.page, mine));

    // The menu takes you back to who's using Sektar.
    await app.page.evaluate(() => window.phDesktop.switchIdentity());
    await app.page.waitForSelector("#renown", { timeout: 60_000 });
    assert.equal(await isListening(SWITCHBOARD_PORT), false);

    // Nothing of the first identity's is left open for the next one's start.
    const firstFolder = path.join(root, address(first));
    assert.deepEqual(storesLeftBy(firstFolder), ["shut down", "shut down"]);
    assert.equal(await workflowLeases(firstFolder), 0);

    await signInWithRenown(app.page, renown, second);
    await connectIsOpen(app.page);
    assert.ok(fs.existsSync(path.join(root, address(second), ".ph/reactor-storage")));
    assert.match(logText(), new RegExp(`ADMINS=${address(second)}`));

    // Neither identity can open the other's documents.
    assert.equal(await canOpen(app.page, mine), false);
    const theirs = await makeDocument(app.page);
    await app.page.evaluate(() => window.phDesktop.switchIdentity());
    await app.page.click(`#as-${address(first)}`, { timeout: 60_000 });
    await connectIsOpen(app.page);
    assert.ok(await canOpen(app.page, mine));
    assert.equal(await canOpen(app.page, theirs), false);
  } finally {
    await app.stop();
  }
});

test("known identities are listed with their names and avatars, offline too", async () => {
  await clearWindow();
  const root = scratchRoot("listed");
  writeSettings(root);
  const [first] = accounts;
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await signInWithRenown(app.page, renown, first);
    await connectIsOpen(app.page);
    await app.stop();
    const folder = path.join(root, address(first));
    assert.ok(fs.existsSync(path.join(folder, "profile-cached.png")));
    const profile = JSON.parse(
      fs.readFileSync(path.join(folder, "profile-cached.json"), "utf8"),
    );
    assert.equal(profile.name, "person0");
    assert.deepEqual(Object.keys(profile).sort(), ["address", "name"]);

    // A new avatar in another format replaces the old one.
    renown.state.avatarType = "image/jpeg";
    await clearWindow();
    app = await launch(root);
    await signInPage(app.page);
    const row = await app.page.textContent(`#as-${address(first)}`);
    assert.match(row, /person0/);
    await signInWithRenown(app.page, renown, first);
    await connectIsOpen(app.page);
    assert.ok(fs.existsSync(path.join(folder, "profile-cached.jpg")));
    assert.ok(!fs.existsSync(path.join(folder, "profile-cached.png")));
  } finally {
    renown.state.avatarType = "image/png";
    await app.stop();
  }
});

test("someone who has signed in keeps working with Renown out of reach", async () => {
  await clearWindow();
  const root = scratchRoot("offline");
  writeSettings(root);
  const [first, second] = accounts;
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await signInWithRenown(app.page, renown, first);
    await connectIsOpen(app.page);
    await app.page.evaluate(() => window.phDesktop.switchIdentity());
    await app.page.waitForSelector("#renown", { timeout: 60_000 });
    await signInWithRenown(app.page, renown, second);
    await connectIsOpen(app.page);
    await app.stop();

    await renown.close();
    app = await launch(root);
    await signInPage(app.page);

    // Someone else's turn on this computer, needing no network at all.
    await app.page.click(`#as-${address(first)}`);
    await connectIsOpen(app.page);
    await sleep(70_000); // Past the switchboard's memory of a verified caller.
    await app.page.reload();
    await connectIsOpen(app.page);
    assert.match(logText(), new RegExp(`ADMINS=${address(first)}`));
  } finally {
    await app.stop();
    renown = await startFakeRenown(RENOWN_PORT);
  }
});

test("the local identity needs no Renown at all", async () => {
  await clearWindow();
  const root = scratchRoot("no-renown");
  // Nothing answers here, and nothing should need to.
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ renown: { url: "http://127.0.0.1:9" } }),
  );
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    await sleep(70_000);
    await app.page.reload();
    await connectIsOpen(app.page);
  } finally {
    await app.stop();
  }
});

test("settings reach the stack, and can't weaken sign-in", async () => {
  await clearWindow();
  const root = scratchRoot("settings");
  writeSettings(root, {
    memory: { mainMb: 3333, workflowWorkerMb: 1234 },
    logLevel: "warn",
    AUTH_ENABLED: "false",
    REQUIRE_AUTHENTICATED_CALLER: "false",
  });
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    assert.match(logText(), /--max-old-space-size=3333/);
    assert.match(logText(), /PH_WORKFLOWS_WORKER_MEMORY_MB=1234/);
    assert.match(logText(), /LOG_LEVEL=warn/);
    assert.match(logText(), /ignoring AUTH_ENABLED/);
    assert.equal(await anonymousStatus(), 401);
  } finally {
    await app.stop();
  }
});

test("starting again right after being killed keeps the assistant", async () => {
  await clearWindow();
  const root = scratchRoot("restart");
  writeSettings(root);
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    await until(
      () => logText().includes("Workflow runtime started"),
      "the automations to start",
    );
    // As a crash would, stores open and the lease still held.
    await app.stop();
    assert.deepEqual(storesLeftBy(path.join(root, "local")), ["in production", "in production"]);

    app = await launch(root);
    await signInPage(app.page);
    await app.page.click("#as-local");
    await app.page.fill("#password", PASSWORD);
    await app.page.click("#unlock");
    await connectIsOpen(app.page);
    assert.doesNotMatch(logText(), /another live process/);

    // An admin with no key yet is asked for one, and nobody has to refresh.
    await app.page.waitForSelector(".sk-assistant__key", { timeout: 60_000 });
    assert.doesNotMatch(
      await app.page.textContent("body"),
      /assistant is not available/,
    );
  } finally {
    await app.stop();
  }
});

test("quitting closes the stores, and says so meanwhile", async () => {
  await clearWindow();
  const root = scratchRoot("quit");
  writeSettings(root, { window: { closeQuits: true } });
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    await until(
      () => logText().includes("Workflow runtime started"),
      "the automations to start",
    );

    const shown = [];
    await app.page.exposeBinding("phShown", (_, text) => shown.push(text));
    await app.page.evaluate(() =>
      new MutationObserver((changes) => {
        for (const { addedNodes } of changes) {
          for (const node of addedNodes) {
            if (node.getAttribute?.("role") === "status") window.phShown(node.textContent);
          }
        }
      }).observe(document.body, { childList: true }),
    );
    app.closeWindow();
    await app.exited;

    assert.deepEqual(shown, ["Closing Sektar…"]);
    assert.match(logText(), /stack stopped after \d+ ms/);
    assert.equal(await isListening(CONNECT_PORT), false);
    assert.equal(await isListening(SWITCHBOARD_PORT), false);
    const folder = path.join(root, "local");
    assert.deepEqual(storesLeftBy(folder), ["shut down", "shut down"]);
    assert.equal(await workflowLeases(folder), 0);
  } finally {
    await app.stop();
  }
});

test("if the app dies, the stack closes its own stores", async () => {
  await clearWindow();
  const root = scratchRoot("orphan");
  writeSettings(root);
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    app.die();
    await app.exited;
    await until(
      async () =>
        !(await isListening(CONNECT_PORT)) && !(await isListening(SWITCHBOARD_PORT)),
      "the stack to stop by itself",
      30_000,
    );
    const folder = path.join(root, "local");
    await until(
      () => storesLeftBy(folder).every((state) => state === "shut down"),
      "the stores to close",
      30_000,
    );
  } finally {
    await app.stop();
  }
});

test("the packaged app loads Sektar's own pieces and document models", { skip: !packaged }, async () => {
  await clearWindow();
  const root = scratchRoot("own-package");
  writeSettings(root);
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    await until(
      () => logText().includes("Workflow runtime started"),
      "the automations to start",
    );
    assert.doesNotMatch(logText(), /has no version in/);
    assert.doesNotMatch(logText(), /no importable document-models entry/);
    assert.doesNotMatch(logText(), /is not available; runs/);
    assert.match(logText(), /Loaded \d+ piece\(s\) from package .*stack: .*distyra/);
  } finally {
    await app.stop();
  }
});

// Only on a build with a demo key, and it asks the real OpenRouter whether the
// key is good, which spends nothing.
const hasDemoKey =
  Boolean(installed) && fs.existsSync(path.join(path.dirname(installed ?? ""), "stack/ai"));

test("an admin can use the demo key, and choose auto-approve", { skip: !hasDemoKey }, async () => {
  await clearWindow();
  const root = scratchRoot("demo-key");
  writeSettings(root);
  const app = await launch(root);
  const checkbox = '.sk-assistant__key input[type="checkbox"]';
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);

    // A new identity is asked its name first.
    const name = '.sk-name-dialog input[name="user-name"]';
    await app.page.fill(name, "Tester", { timeout: 60_000 });
    await app.page.press(name, "Enter");

    await app.page.getByRole("button", { name: "Use the demo key" }).click({ timeout: 60_000 });
    await app.page.waitForSelector(checkbox, { timeout: 30_000 });
    assert.doesNotMatch(await app.page.content(), /sk-or-v1-[a-z0-9]{20,}/);
    await app.page.waitForFunction(() =>
      document.body.textContent.includes("asks you first"),
    );

    await app.page.check(checkbox);
    await app.page.waitForFunction(() =>
      document.body.textContent.includes("made without asking"),
    );

    // It lasts, as the page has only this identity's choice to go on.
    await app.page.reload();
    await connectIsOpen(app.page);
    await app.page.waitForSelector(checkbox, { timeout: 60_000 });
    assert.equal(await app.page.isChecked(checkbox), true);
  } finally {
    await app.stop();
  }
});

test("each account to connect opens at its own category", async () => {
  await clearWindow();
  const root = scratchRoot("categories");
  writeSettings(root);
  const app = await launch(root);
  const entries = ".sk-assistant-side__kinds li";
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    const name = '.sk-name-dialog input[name="user-name"]';
    await app.page.fill(name, "Tester", { timeout: 60_000 });
    await app.page.press(name, "Enter");

    for (const [entry, title] of [
      ["Email", "Connect your email"],
      ["Calendar", "Connect your calendar"],
      ["Bank transactions", "Connect your bank transactions"],
    ]) {
      await app.page.goto(`http://127.0.0.1:${CONNECT_PORT}/productivity`);
      await app.page.waitForSelector(entries, { timeout: 60_000 });
      await app.page.locator(entries, { hasText: entry }).first().click();
      await app.page.getByRole("heading", { name: title }).waitFor({ timeout: 30_000 });
    }
  } finally {
    await app.stop();
  }
});

test("automations can be left off, for when one stops Sektar from starting", async () => {
  await clearWindow();
  let root = scratchRoot("automations-on");
  writeSettings(root);
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    await until(
      () => logText().includes("Workflow runtime started"),
      "the automations to start",
    );
    await app.stop();

    root = scratchRoot("automations-off");
    writeSettings(root, { automations: false });
    app = await launch(root);
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    assert.match(logText(), /PH_WORKFLOWS_ENABLED=false/);
    assert.doesNotMatch(logText(), /Workflow runtime started/);
  } finally {
    await app.stop();
  }
});

test("a broken settings.json stops the start, and says why", async () => {
  await clearWindow();
  const root = scratchRoot("broken");
  fs.writeFileSync(path.join(root, "settings.json"), "{ not json");
  const app = await launch(root);
  try {
    await signInPage(app.page);
    assert.match(await app.page.textContent("#sign-in h1"), /settings\.json can't be read/);
    assert.equal(await isListening(SWITCHBOARD_PORT), false);
  } finally {
    await app.stop();
  }
});

test("telemetry stays on this computer, and diagnostics can be turned off", async () => {
  await clearWindow();
  let root = scratchRoot("telemetry-on");
  writeSettings(root);
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    assert.match(logText(), /PH_NO_TELEMETRY=1/);
    assert.match(logText(), /PH_TELEMETRY=on/);
    const diagnostics = path.join(root, "local/.ph/telemetry");
    await until(
      () => fs.existsSync(diagnostics) && fs.readdirSync(diagnostics).length > 0,
      "diagnostics in the identity's folder",
      90_000,
    );
    await app.stop();

    root = scratchRoot("telemetry-off");
    writeSettings(root, { telemetry: { diagnostics: false } });
    app = await launch(root);
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    assert.match(logText(), /PH_TELEMETRY=off/);
    const dir = path.join(root, "local/.ph/telemetry");
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0);
  } finally {
    await app.stop();
  }
});

test("Connect and the switchboard both use the chosen Renown", async () => {
  await clearWindow();
  const root = scratchRoot("instance");
  writeSettings(root);
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await signInWithRenown(app.page, renown, accounts[0]);
    await connectIsOpen(app.page);
    renown.requests.length = 0;
    await app.page.reload();
    await connectIsOpen(app.page);
    await until(
      () => renown.requests.some((r) => r.origin === `http://127.0.0.1:${CONNECT_PORT}`),
      "Connect to ask the chosen Renown",
    );
    assert.equal(await anonymousStatus(), 401);
  } finally {
    await app.stop();
  }
});

test("a missing folder is reported, not recreated", async () => {
  await clearWindow();
  const root = path.join(scratchRoot("missing"), "unplugged");
  const app = await launch(root);
  try {
    await signInPage(app.page);
    assert.match(await app.page.textContent("#sign-in h1"), /can't find/);
    assert.ok(!fs.existsSync(root));
  } finally {
    await app.stop();
  }
});

test("a folder that syncs gets a warning", async () => {
  await clearWindow();
  const root = path.join(scratchRoot("synced"), "OneDrive", "Sektar");
  fs.mkdirSync(root, { recursive: true });
  const app = await launch(root);
  try {
    await signInPage(app.page);
    assert.match(await app.page.textContent("#sign-in"), /syncs with OneDrive/);
  } finally {
    await app.stop();
  }
});

test("the sign-in commands close once the stack is up", async () => {
  await clearWindow();
  const root = scratchRoot("closed");
  writeSettings(root);
  const app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await connectIsOpen(app.page);
    const refused = await app.page.evaluate(async (password) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const attempt = (command, args) =>
        invoke(command, args).then(
          () => `${command} answered`,
          (error) => String(error),
        );
      return [
        await attempt("desktop_state"),
        await attempt("local_unlock", {
          password,
          appDid: "did:key:zThief",
          appName: "connect",
        }),
        await attempt("start_stack", { identity: "local" }),
      ];
    }, PASSWORD);
    for (const answer of refused) assert.match(answer, /already started/);
  } finally {
    await app.stop();
  }
});

test("documents from before sign-in are offered, and move only on a yes", async () => {
  assert.ok(fs.existsSync(OLD_DATA), "the set-aside store");
  await clearWindow();
  const root = scratchRoot("old-data");
  writeSettings(root);
  fs.cpSync(OLD_DATA, path.join(root, ".ph"), { recursive: true });
  fs.mkdirSync(path.join(root, "pglite"));
  let app = await launch(root);
  try {
    await signInPage(app.page);
    await createLocalKey(app.page);
    await app.page.waitForSelector("#leave", { timeout: 60_000 });
    await app.page.click("#leave");
    await connectIsOpen(app.page);
    assert.ok(fs.existsSync(path.join(root, ".ph", ".keypair.json")));
    await app.stop();

    const second = accounts[1];
    app = await launch(root);
    await signInPage(app.page);
    await signInWithRenown(app.page, renown, second);
    await app.page.waitForSelector("#adopt", { timeout: 60_000 });
    await app.page.click("#adopt");
    await connectIsOpen(app.page);
    assert.ok(fs.existsSync(path.join(root, address(second), ".ph/.keypair.json")));
    assert.ok(!fs.existsSync(path.join(root, ".ph")));
    assert.ok(!fs.existsSync(path.join(root, "pglite")));
  } finally {
    await app.stop();
  }
});

test("nothing anyone did is left in the app's own folder", { skip: !installed }, () => {
  assert.deepEqual(appFiles(), appFilesAtStart);
});
