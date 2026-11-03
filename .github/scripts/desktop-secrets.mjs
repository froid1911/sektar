// What a desktop build ships that the repository doesn't hold: Google's
// desktop OAuth client and the assistant's demo key, both meant to be in the
// installer (a desktop client can't keep a secret, and signs in with PKCE; the
// demo key is a low-limit key for test users). Each is written where
// powerhouse.config.json names it, from the workflow's secrets. One that isn't
// set is left out, as on a fork's pull request, and the build says so.
import fs from "node:fs";
import path from "node:path";

const config = JSON.parse(fs.readFileSync("powerhouse.config.json", "utf8"));

function write(file, value, what) {
  if (!file) {
    console.log(`${what}: powerhouse.config.json names no file`);
    return;
  }
  if (!value) {
    console.log(`${what}: no secret, so this build ships none`);
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
  console.log(`${what}: written to ${file}`);
}

const google = config.workflows?.oauthApps?.find(
  (app) => app.id === "sektar-google",
);
write(
  google?.clients?.desktop,
  process.env.GOOGLE_DESKTOP_OAUTH_CLIENT,
  "Google desktop client",
);
write(config.ai?.demoKeyFile, process.env.OPENROUTER_DEMO_KEY, "AI demo key");
