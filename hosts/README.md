# hosts/

Each subfolder defines one host: an application this project can run via
`ph run <host-name> [verb]`. A host.js is a static projection of
powerhouse.config.json — plain data, default-exported:

```js
export default {
  name, // display identity (never seeds storage identity — renaming is safe)
  runner, // { module, ...process options } — ph run imports and calls runner.module
  config, // handed to the runner's runtime whole
  reactor, // reactor runners only (projection arrives in a later phase)
  children, // compound runners only — reactor XOR children
};
```

Rules: a host.js may import the project's powerhouse.config.json and its
sibling hosts' `../<host>/host.js` and generated `../<host>/outputs.js`,
nothing else; `process.` is banned (read the environment with
`{ $env: "NAME" }`); the export must survive a JSON round trip (no
functions); `ph <host-name>` is sugar for `ph run <host-name>` (built-in
commands win name collisions).

Another host's outputs (URLs, drive ids, …) are read with output tokens:
`switchboard.drives.workflows.url` from `../switchboard/outputs.js`, or
literally `{ $output: { host: "switchboard", path: ["drives", "workflows", "url"] } }`.
They resolve when the host starts — from the producer's live run record when
run alone (`ph run switchboard` first), from the member's live outputs inside
a compound. `{ $map: { over, to } }` renders a list from a collection output:
the `cli` and `desktop` Connect members attach one remote drive per drive the
switchboard serves (`slug: { $key: true }`, `url: switchboard.drives.$item.url`).
`ph generate hosts` regenerates each producer's `outputs.js` and
`types.d.ts`; every host carries `/** @satisfies {PHHost} */`, and
`npm run tsc` type-checks them (`tsc -p hosts`).

Scaffolded hosts: `connect` (studio dev server), `switchboard` (API/reactor
server), `vetra` (compound: both, dev mode — what `ph vetra` runs),
`desktop` (production switchboard + built Connect on the generic compound),
`assistant` (headless agent API on the project switchboard) and `cli`
(switchboard + Connect together, Connect as a remote client).
The runners come from the linked monorepo checkout (`../powerhouse`, or
`$POWERHOUSE_DIR`), built — see README.md, "Local monorepo link".

### Sign-in on the `desktop` host

`desktop` signs in before anything runs. `hosts/desktop/app.json` has
`signIn: true`, so the shell opens a page of its own and holds the stack back
until someone has picked an identity, with Renown or with a local key. What the
user sees is documented on the website, in `docs/where-sektar-runs.mdx`, which
is the spec for all of this.

The data folder the user chose holds `settings.json`, `local.key` and one folder
per identity:

```
<root>/
  settings.json          read before anything starts, never holds a secret
  local.key              the local identity's key, in a password-encrypted keystore
  local/                 the local identity, whichever key it has
  0x…/                   one per Renown identity
    .ph/                 the stack's storage: ${userData}/.ph
    backups/
    profile-cached.json  public information only
    profile-cached.<ext> the avatar
```

The shell points `${userData}` at the identity's folder and sets `ADMINS` to its
address, so the identity decides both whose storage this is and who runs it.
The switchboard's auth comes through `config.switchboard` on its server member
rather than env, since nobody edits an env file on a person's own computer
(`docs/adr/0008-delegated-signers.md` in the monorepo):

- The server binds `127.0.0.1`.
- Verified credentials stay in `${userData}/.ph/.credentials.json`, so once
  signed in it works with Renown unreachable. A revocation lands the next time
  it is online.
- A local identity runs with `RENOWN_SOURCE=kept`: its credential is at no
  Renown, so only what is kept there counts, and Renown is never asked.
- `ownerClaim` stays on for a host run without the shell, where nothing sets
  `ADMINS`. Set, `ADMINS` wins over it.

The page is served from Connect's address, since the browser keeps a Renown
session per origin, which is why this host turns Connect's service worker off.
Connect is a remote client here, as on `cli`, so the window holds nothing of a
person's and it can be handed to the next identity. Signing in needs
`window.phDesktop.openExternal` from the shell; without it Connect keeps
Renown's redirect.

### Reactor-client topologies (what runs the reactor, and where)

The `reactor.backends` of a Connect host select which of four clients it
runs — one field, derived from the backend topology:

| host                       | backends         | reactorClient | reactor + storage                                                            |
| -------------------------- | ---------------- | ------------- | ---------------------------------------------------------------------------- |
| `connect` (standalone)     | one `in-process` | `in-process`  | the tab's own reactor on the main thread (PGlite in-page)                    |
| `cli` → connect member     | one `remote`     | `remote`      | NO local reactor — a pure client to the switchboard over GraphQL (no PGlite) |
| `desktop` → connect member | one `remote`     | `remote`      | as `cli`: the window outlives any one identity, so it must hold nothing      |

A **remote client** proxies to the switchboard and stores nothing locally (no
PGlite); a **synchronized remote drive** would keep a local replica and
therefore need PGlite by design. The `worker` mode (reactor in a SharedWorker)
is the fourth option; Sektar's connect host uses `in-process` because the built
Connect's worker cannot import the local package.

The project drive (`sektar`) is OWNED by the switchboard; standalone Connect
has its own local copy (the same declaration, read from the switchboard
host); the `cli`/`desktop` compounds re-point Connect at the switchboard's —
every drive it serves, the plugin-created Workflows drive included. `vetra`'s
switchboard member serves the same drives plus the studio ones.

### Building Sektar.app against a local monorepo checkout

`ph run desktop build` vendors ph-cli and its runtime into the app's stack
from the npm registry. Until the code these hosts need is released, vendor
it from a monorepo checkout instead: pack it, then point the build at the
tarballs with `PH_DESKTOP_LOCAL_PACKAGES` (an env var, so no machine path
lands in a host file; a relative path resolves against this project).

```sh
# from this project's root; MONOREPO is the linked checkout (README.md,
# "Local monorepo link"), its dists built
MONOREPO="${POWERHOUSE_DIR:-../powerhouse}"
# 1. pack ph-cli, host-core and every workspace package they depend on
rm -rf .ph/local-packages
pnpm -C "$MONOREPO" pack:desktop-stack --pack-destination "$PWD/.ph/local-packages"
# 2. build members, stage the stack, produce Sektar.app (+ .dmg) and launch it
PH_DESKTOP_LOCAL_PACKAGES=.ph/local-packages FEATURE_UNIFORM_RUNNERS_ENABLED=true \
  npx ph-cli run desktop build
open hosts/desktop/tauri-shell/target/release/bundle/macos/Sektar.app
```

On Windows the installer step can't open a path over 260 characters, and the
stack's deepest files sit about 195 characters below `dist-stack`, so a checkout
in a deep folder fails at `makensis` with `failed opening file`, after everything
else has built. Map the shell folder to a drive, replace the folder with that
drive in `target/release/nsis/x64/installer.nsi`, and run `makensis` on it there.
Nothing else needs rebuilding. The paths fit once installed.

Every tarball overrides its package throughout the stack, as the local and
registry builds share a version number. Re-pack after rebuilding the
monorepo's dists; the build refuses two tarballs of one package, so clear
the directory first. `desktop-connect` precedes `desktop-switchboard` in
`children` because `build` runs members in that order and Connect's build
clears `dist/`, the package's `dist/node` included.
