// Does a built desktop app start? Two checks that need no window driving, so
// they run on every OS's build in CI (.github/workflows/desktop.yml):
//
//  1. The app, with no environment, finds the stack it bundles and the port in
//     the stack's shell.json: its log names that port and doesn't say "nothing
//     to supervise". The sign-in page holds the stack back, so that's all the
//     app shows before someone signs in.
//  2. The stack, under the app's own node, started as the shell starts it after
//     a sign-in: Connect serves its page and the switchboard answers through it,
//     it stops when asked, it logs no missing package or branding file, and it
//     leaves its own folder as it found it (inside a signed app, that folder
//     is part of the signature).
//
//   node qa/desktop/smoke.mjs --app <app executable> --node <the app's node> --stack <its stack folder>
//
// Run it with no Sektar open: a second instance hands over to the first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..", "..");
const { values: args } = parseArgs({
  options: {
    app: { type: "string" },
    node: { type: "string" },
    stack: { type: "string" },
  },
});
for (const name of ["app", "node", "stack"]) {
  if (!args[name]) throw new Error(`--${name} is required`);
  args[name] = path.resolve(args[name]);
  if (!fs.existsSync(args[name]))
    throw new Error(`--${name}: ${args[name]} isn't there`);
}

const { identifier } = JSON.parse(
  fs.readFileSync(path.join(project, "hosts", "desktop", "app.json"), "utf8"),
);
const { connectPort } = JSON.parse(
  fs.readFileSync(path.join(args.stack, "shell.json"), "utf8"),
);
const origin = `http://127.0.0.1:${connectPort}`;

/** Where Tauri puts the app's log (its app_log_dir). */
function logFile() {
  const dir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Logs", identifier)
      : path.join(
          process.platform === "win32"
            ? process.env.LOCALAPPDATA
            : (process.env.XDG_DATA_HOME ??
                path.join(os.homedir(), ".local", "share")),
          identifier,
          "logs",
        );
  return path.join(dir, "ph-win.log");
}

/** What the stack logs when it's broken in a way a start doesn't show. */
const BROKEN = [
  /\[branding\]/,
  /Cannot find (package|module)/,
  /Error initializing processor factory/,
];

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`FAIL ${message}`);
};
const pass = (message) => console.log(`ok   ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sektar-smoke-"));

/** This environment without what points a shell or a stack somewhere. */
function plainEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      /^(PH_RUN_|PH_WIN_|PH_USER_DATA_DIR$|FEATURE_UNIFORM_RUNNERS_ENABLED$|NODE_ENV$|ADMINS$)/.test(
        name,
      )
    ) {
      delete env[name];
    }
  }
  return env;
}

/** Ends a process and what it started. */
function end(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

const exited = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null)
      resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });

async function portAnswers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Every file under a folder, with its size. */
function snapshot(dir) {
  const files = new Map();
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, full), fs.statSync(full).size);
  }
  return files;
}

async function theAppFindsItsStack() {
  const log = logFile();
  const launched = Date.now();
  const app = spawn(args.app, [], {
    // Its own root, so nothing here touches a real profile.
    env: { ...plainEnv(), PH_DESKTOP_ROOT: path.join(scratch, "root") },
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  app.on("error", (error) => fail(`the app didn't launch: ${error.message}`));
  let text = "";
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && app.exitCode === null) {
    const fresh =
      fs.existsSync(log) && fs.statSync(log).mtimeMs >= launched - 1000;
    text = fresh ? fs.readFileSync(log, "utf8") : "";
    if (/connect port\s*:/.test(text) || text.includes("nothing to supervise"))
      break;
    await sleep(500);
  }
  // A moment more, for a "nothing to supervise" that follows the port.
  await sleep(1000);
  text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : text;
  end(app);
  await exited(app);

  const port = /connect port\s*:\s*(\d+)/.exec(text)?.[1];
  if (!text) fail(`the app wrote no log at ${log}`);
  else if (text.includes("nothing to supervise"))
    fail("the app found no stack to run (nothing to supervise)");
  else if (port !== String(connectPort))
    fail(
      `the app waits on port ${port ?? "(none)"}, the stack's shell.json says ${connectPort}`,
    );
  else pass(`the app finds its stack and waits on port ${connectPort}`);
  if (failures.length > 0) console.error(`--- ${log}\n${text}`);
}

async function theStackRuns() {
  if (await portAnswers(connectPort)) {
    fail(`something already answers on ${connectPort}: close it first`);
    return;
  }
  const cli = path.join(
    args.stack,
    "node_modules",
    "@powerhousedao",
    "ph-run",
    "dist",
    "cli.mjs",
  );
  const before = snapshot(args.stack);
  // As the shell starts it once someone has signed in.
  const stack = spawn(args.node, [cli, "run", "desktop"], {
    cwd: args.stack,
    env: {
      ...plainEnv(),
      FEATURE_UNIFORM_RUNNERS_ENABLED: "1",
      PH_USER_DATA_DIR: path.join(scratch, "user"),
      PH_STOP_ON_STDIN: "1",
      NODE_ENV: "production",
      PH_ATTACHMENT_URL_SIGNING_SECRET: randomBytes(32).toString("hex"),
      ADMINS: "0x0000000000000000000000000000000000000001",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let output = "";
  stack.stdout.on("data", (chunk) => (output += chunk));
  stack.stderr.on("data", (chunk) => (output += chunk));
  stack.on("error", (error) =>
    fail(`the stack didn't launch: ${error.message}`),
  );
  const started = Date.now();

  let page;
  while (Date.now() - started < 240_000 && stack.exitCode === null) {
    try {
      page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) });
      if (page.ok) break;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  if (!page?.ok) {
    fail(
      stack.exitCode === null
        ? `Connect didn't answer on ${origin} within 240 s`
        : `the stack exited (${stack.exitCode}) before Connect answered`,
    );
  } else {
    pass(
      `Connect serves ${origin} after ${Math.round((Date.now() - started) / 1000)} s`,
    );
    const graphql = await fetch(`${origin}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => error);
    // Before a sign-in its answer is a 401. Connect's own would be its page.
    const type =
      graphql instanceof Response
        ? (graphql.headers.get("content-type") ?? "")
        : "";
    if (
      graphql instanceof Response &&
      graphql.status < 500 &&
      !type.includes("html")
    ) {
      pass(`the switchboard answers through Connect (${graphql.status})`);
    } else {
      fail(
        `the switchboard didn't answer through Connect: ${graphql instanceof Response ? `${graphql.status} ${type}` : graphql.message}`,
      );
    }
  }

  if (stack.exitCode === null) {
    stack.stdin.write("stop\n");
    const stopped = await Promise.race([
      exited(stack),
      sleep(30_000).then(() => "timeout"),
    ]);
    if (stopped === "timeout") {
      fail("the stack didn't stop within 30 s of being asked");
      end(stack);
      await exited(stack);
    } else {
      pass(`the stack stops when asked (exit ${stopped})`);
    }
  }

  for (const pattern of BROKEN) {
    const line = output.split(/\r?\n/).find((l) => pattern.test(l));
    if (line) fail(`the stack logged: ${line.trim()}`);
  }

  const after = snapshot(args.stack);
  const changed = [
    ...[...after.keys()]
      .filter((file) => !before.has(file))
      .map((file) => `added ${file}`),
    ...[...before.keys()]
      .filter((file) => !after.has(file))
      .map((file) => `removed ${file}`),
    ...[...after.keys()]
      .filter(
        (file) => before.has(file) && before.get(file) !== after.get(file),
      )
      .map((file) => `changed ${file}`),
  ];
  if (changed.length > 0)
    fail(
      `the stack wrote into its own folder:\n  ${changed.slice(0, 20).join("\n  ")}`,
    );
  else pass("the stack's folder is as it was");

  if (failures.length > 0)
    console.error(`--- stack output\n${output.slice(-6000)}`);
}

try {
  await theAppFindsItsStack();
  await theStackRuns();
} finally {
  fs.rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nthe desktop app starts");
