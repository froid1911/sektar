# Sektar in a container: the `cli` host

One container runs Sektar's production stack, the `cli` host: the switchboard (API, workflows, Postgres storage) and the Connect app, supervised together by `ph run cli serve`. A second container runs Postgres.

Files here:

| File | What |
|---|---|
| `host.js` | The `cli` host: what runs, and how the two parts talk |
| `oauth-relay.js` | Switchboard plugin of the `cli` host: Google sign-in through the sektar.io relay in the cloud (below) |
| `Dockerfile` | The image. Generic: builds any Powerhouse project's host (`PH_HOST`) from source |
| `docker-entrypoint.sh` | Checks the database setting, then runs `ph run $PH_HOST serve` |
| `docker-compose.yml` | Postgres + the cli container, for local use and as the deployment reference |
| `cli.env.example` | Every setting the container takes; copy to `cli.env` |

## Quick start

```sh
cd hosts/cli
cp cli.env.example cli.env        # fill in PH_WORKFLOWS_SECRETS_MASTER_KEY, ADMINS, PUBLIC_URL
docker compose up --build
```

Connect: http://localhost:3000 (port from `CONNECT_PORT`). The switchboard directly (GraphQL, MCP): http://localhost:4001 (`SWITCHBOARD_PORT`).

## How it works

- **One process tree per container.** `ph run cli serve` starts the switchboard, waits for it, then starts Connect, and stops both in reverse order on SIGTERM. `tini` is PID 1 and forwards the signal.
- **The browser only ever talks to one origin.**
  - Connect's server proxies the switchboard's paths to it (`/graphql` with its websocket, `/d/*` except page loads, `/attachments`, `/mcp`, `/api/*`).
  - Connect's served config names the switchboard as `${origin}`, which the browser replaces with the page's own origin.
  - So the same image works behind any domain, load balancer or TLS terminator without rebuilding. Publish only the Connect port; the switchboard port is optional (direct API and MCP access).
- **Built once, configured at start.**
  - The image build runs `ph run cli build`: the project package (`dist/`, the document models, processors, subgraphs and workflow pieces the switchboard loads) and the Connect app (`.ph/connect-build`).
  - Everything deployment-specific comes from the environment at start.
- **Storage.**
  - Documents, read models and workflow state live in Postgres. The reactor runs its own migrations at start; there is no separate migration step.
  - What the switchboard keeps outside the database lives on the `/data` volume (`PH_USER_DATA_DIR`): its identity key pair (the server's Renown identity), attachments, and registry packages.
  - Keep the volume, or the server comes back with a new identity.

### Production differences from the developer setup

- No Portle: publishing through a tunnel is the desktop's and Vetra Studio's job.
- No Vetra Studio plugins: those belong to the `vetra` host's `dev` verb.
- Postgres instead of PGlite.
- Connect is the built app on a static server (`serve`), not the Vite dev server (`run`/`dev`).

## Configuration the container takes

Set as environment variables (Compose: `cli.env`, plus the database URL in `docker-compose.yml`).

### Required

| Variable | What |
|---|---|
| `PH_SWITCHBOARD_DATABASE_URL` | `postgres://user:password@host:5432/db`, used for both the reactor store and the read model. Without it the entrypoint refuses to start (set `PH_ALLOW_PGLITE=1` to run on PGlite under `/data` instead). |
| `PH_WORKFLOWS_SECRETS_MASTER_KEY` | 64 hex chars (`openssl rand -hex 32`). Encrypts the workflow connections' OAuth tokens in the database. On Postgres the switchboard refuses to start without it, and refuses a different key later: store it like a database password. |
| `PUBLIC_URL` | The public origin, e.g. `https://sektar.example.com`. The switchboard builds absolute links from it, among them the OAuth callback. |
| `ADMINS` | Comma-separated Ethereum addresses allowed to manage the instance. |

### Access (with the defaults in `cli.env.example`)

| Variable | What |
|---|---|
| `AUTH_ENABLED=true` | Renown sign-in. |
| `REQUIRE_AUTHENTICATED_CALLER=true` | Anonymous callers get 401; Connect shows a sign-in page. |
| `RESOLVE_CALLER_IDENTITY=true` | Callers are identified from their Renown credentials. |
| `INSPECTION_ADMIN_ENABLED=true` | Admins see the reactor's operational views. |

### The Assistant's included key (optional)

| Variable | What |
|---|---|
| `OPENROUTER_API_KEY` | An OpenRouter key this instance comes with. Vetra's LLM broker sets it on a cloud environment, capped at the plan's budget. On `serve` the entrypoint writes it to `/app/.ph/included-openrouter-key` (mode 600), the switchboard's demo key (`ai.demoKeyFile` in `powerhouse.config.json`), and unsets it. The Assistant's setup card then offers **Use the key included with your Sektar** to an admin: one click stores it like a typed key. Unset, nothing is offered. A key stored this way is a copy: when the plan's key changes, **Reset key** and use it again. |

### Files to mount

| Path in the container | What |
|---|---|
| `/client_secret_sektar-web-app.json` | Optional. Your own Google OAuth **web** client for the publisher app `sektar-google`. `powerhouse.config.json` (`workflows.oauthApps`) names it relative to `/app`, which is why it sits at the root. Mounted, sign-ins of the Gmail and Calendar integrations use it, always: it takes precedence over the relay. |
| `/client_secret_sektar_desktop-app.json` | The **desktop** client; only used when the switchboard runs on the user's own machine. Mount it, or leave it out. |
| `/data` (volume) | See Storage above. |

A web client you mount needs this **authorized redirect URI** in the Google Cloud console:
`<PUBLIC_URL>/api/@powerhousedao/workflow/oauth/callback`

### Google sign-in: own client or the relay

How the Gmail and Calendar integrations sign in to Google depends on where
the container runs. `oauth-relay.js` decides it once at start and logs one
`[sektar:oauth-relay]` line saying which way it went.

- **Your own web client mounted** (self-hosting): sign-in goes straight to
  Google with your client, as configured. Register the redirect URI above.
  The relay is never asked.
- **No web client mounted, `PUBLIC_URL` public** (Vetra cloud, `*.vetra.io`):
  the host asks `GET <relay base>/api/oauth/hosts/<PUBLIC_URL host>` (3 s
  timeout, 3 attempts). Only on `{"accepted": true}` does `sektar-google`
  sign in through the relay: Google sends the person back through
  `<relay base>/api/oauth/callback`, which forwards the sign-in to this
  environment, and the code exchange and every refresh go through
  `<relay base>/api/oauth/token`, which adds the publisher's client secret.
  sektar.io keeps neither codes nor tokens; the tokens stay in this
  environment's database. Nothing to configure: it is automatic on Vetra
  cloud hosts. A host the relay does not accept (a custom domain, a
  self-hosted one) keeps the hand-off to the computer that runs Sektar.
- **`PUBLIC_URL` unset or loopback** (your own machine): as configured
  (the desktop client); nothing is asked.

| Variable | Default | What |
|---|---|---|
| `SEKTAR_OAUTH_RELAY_BASE` | `https://sektar.vetra.io` | The relay's origin; set it to a staging deployment of sektar.io to test. |

### Tuning and optional

| Variable | Default | What |
|---|---|---|
| `NODE_OPTIONS` | `--max-old-space-size=4096` | Heap of the host process |
| `PH_WORKFLOWS_WORKER_MEMORY_MB` | `2048` | Heap per workflow worker |
| `PH_ATTACHMENT_URL_SIGNING_SECRET` | unset | Signs attachment download links. Unset, filesystem downloads are refused (the log says so at start). |
| `LOG_LEVEL` | `info` | |

### Build arguments

| Argument | Default | What |
|---|---|---|
| `PH_HOST` | `cli` | Which host to build and run (`hosts/<PH_HOST>/host.js`) |
| `NODE_VERSION` | `24` | |
| `PNPM_VERSION` | `12.10.1` | The pnpm the lockfile was made with |

## Generic image, other projects

Nothing in `Dockerfile` or `docker-entrypoint.sh` names Sektar. A Powerhouse project with uniform-runner hosts uses them as they are:
- **Build:** `docker build -f <path>/Dockerfile --build-arg PH_HOST=<host> .` from its root.
- **Configure:** the switchboard reads the same variables in every project.
- **Project-specific:** only the files to mount (OAuth client files, if the project's config names any) and the host file itself.

## Locally without Docker

```sh
docker compose up -d postgres     # published on localhost:5434
PH_SWITCHBOARD_DATABASE_URL=postgres://sektar:sektar@localhost:5434/sektar \
  PH_WORKFLOWS_SECRETS_MASTER_KEY=<64 hex> FEATURE_UNIFORM_RUNNERS_ENABLED=1 \
  ph run cli build && ph run cli serve
```

## On Vetra

`.github/workflows/vetra.yml` builds this image as the App's FUSION image on
every deploy. Vetra runs it as a host when the environment's FUSION env sets
`PH_HOST=cli` (the variable the entrypoint reads): it then gets the
environment's Postgres as `PH_SWITCHBOARD_DATABASE_URL`, a kept `/data`
volume, `PUBLIC_URL`, port 6540 and a heap that follows the size, and the
platform switchboard and Connect are not run beside it. Set
`PH_WORKFLOWS_SECRETS_MASTER_KEY` as a secret, `ADMINS` and the access
settings above as plain env.

The image takes care of the rest itself:

- **Secrets it keeps.** Without `PH_WORKFLOWS_SECRETS_MASTER_KEY` or
  `PH_ATTACHMENT_URL_SIGNING_SECRET`, the entrypoint generates each once and
  keeps it on the volume (`/data/workflows-master-key`,
  `/data/attachment-url-signing-secret`, mode 600). An explicit value wins.
  Moving the instance means moving `/data` with its database.
- **Access.** `AUTH_ENABLED`, `REQUIRE_AUTHENTICATED_CALLER` and
  `RESOLVE_CALLER_IDENTITY` default to `true`; set `ADMINS`.
- **Restarts.** Stale `ph run` records on the volume are cleared at start.

Releases (`v*` tags) build this image as the App's `host` artifact on the
LATEST channel; a Sektar cloud licence on Vetra runs the latest release with the
holder as `ADMINS`. Main pushes do not build it.

## Known issues (2026-10-29, monorepo 6.2.3-dev.81)

- **`ph run cli build` fails on a `$map` over the switchboard's outputs** (seen on 6.2.3-dev.80). `host.js` lists Connect's drives as output tokens instead.
- **Size:** the image is ~2.8 GB, almost all of it `node_modules` (the runtime keeps the full install because `ph-cli` and Connect's server are dev tools). Slimming it is a follow-up.
- **The Gmail add-on** comes from npm at run time. A hand-edited copy of it adds rate-limit retries on the developer machine, but that copy is not part of the image.
