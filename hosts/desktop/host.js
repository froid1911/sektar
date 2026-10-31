// @ts-check
// The desktop shape: a production switchboard next to the BUILT Connect,
// supervised by the desktop runner (@powerhousedao/desktop — run/serve are
// the generic compound; `dev` opens a native shell window; `build` stages
// the shippable stack). Run `ph run connect build` once, then
// `ph run desktop`. At `run`, each member uses its own default mode below;
// `ph run desktop <verb>` forwards uniformly. Members derive from the sibling
// hosts (full inclusion); the server member serves the switchboard host's
// drives, and the connect member attaches every drive the server reports
// (declared and plugin-created) as REMOTES, by `$map` over its outputs.
import config from "../../powerhouse.config.json" with { type: "json" };
import switchboard from "../switchboard/host.js";
import connect from "../connect/host.js";
import { outputs as server } from "../switchboard/outputs.js";

/** @satisfies {PHHost} */
export default {
  name: "desktop",

  runner: {
    module: "@powerhousedao/desktop/runner",
    // NATIVE WINDOW: two ways to get one (headless verbs need neither).
    //
    // 1. BUILDER-OWNED IDENTITY (recommended, no Rust): run
    //    `ph generate desktop-shell` to scaffold hosts/desktop/app.json.
    //    `ph run desktop dev` projects it into a generated Tauri shell that
    //    depends on the published ph-desktop-shell crate and opens the window
    //    around this stack; `ph run desktop build` produces installers for
    //    this OS (nsis / app+dmg / deb+appimage). Needs Rust + the Tauri CLI.
    //
    // 2. PREBUILT/HAND-MAINTAINED shell: point `shell.project` at a checkout.
    // shell: {
    //   project: "../ph-win-desktop",
    //   window: { title: "sektar", width: 1440, height: 900 },
    //   tray: true,
    //   fileAssociations: [".phd"],
    // },
  },

  profile: {
    appId: "inc.powerhouse.desktop.sektar",
    name: "Sektar",
  },

  config: {
    startOrder: ["desktop-switchboard", "desktop-connect"],
    cspRegistrySync: true, // patch the baked CSP for the runtime registry
    runtimeRecord: true, // single-instance record under .ph/run/
  },

  children: {
    // `build` builds members in this order: Connect's build clears dist/
    // (the package's dist/node with it), so the switchboard's package build
    // runs after it. `config.startOrder` orders the running members.
    "desktop-connect": {
      host: "connect",
      // serve the BUILT Connect; the loopback port doubles as a shell's
      // readiness probe. Connect's server proxies the switchboard's paths and
      // serves its URLs as ${origin}, as on the cli and vetra hosts: what the
      // browser calls on its own origin, such as the assistant's gateway,
      // would otherwise get the app's HTML back.
      runner: {
        defaultVerb: "serve",
        port: config.studio?.port ?? 3000,
        proxy: { target: server.origin },
      },
      // Attach every drive the server member serves as a remote, by the URL
      // it reports (key-sorted). The Workflows drive is among them; the
      // inherited workflows plugin names the same URL, and Connect attaches
      // a URL once.
      reactor: {
        ...connect.reactor,
        drives: {
          $map: {
            over: { $output: { host: "switchboard", path: ["drives"] } },
            to: {
              slug: { $key: true },
              remote: { url: server.drives.$item.url },
            },
          },
        },
      },
    },
    "desktop-switchboard": {
      host: "switchboard",
      // (runner key-merges over the switchboard host's own: its plugins
      // are inherited.)
      //
      // Sign-in is enforced as on the cloud host, which sets the same through
      // env (hosts/cli/cli.env.example). A person's own computer has nobody to
      // write ADMINS, so the first person to sign in becomes the owner, which
      // is safe only because this host answers on loopback alone. Credentials
      // are kept, so once signed in it works with no network (ADR 0008 §11).
      config: {
        switchboard: {
          server: { host: "127.0.0.1" },
          auth: {
            enabled: true,
            requireAuthenticatedCaller: true,
            resolveIdentity: true,
            ownerClaim: true,
            offlineCredentials: true,
          },
        },
      },
      reactor: {
        protocol: switchboard.reactor.protocol,
        backends: {
          main: {
            // the switchboard's own reactor; backend kind is required
            kind: "in-process",
            // Per-user data dir; ${userData} resolves at the runner (a shell
            // points it at the OS profile via PH_USER_DATA_DIR).
            storage: {
              kind: "path",
              dataDir: "${userData}/.ph/reactor-storage",
            },
            // the reactor can fetch models Connect installs at runtime
            packages: { dynamic: true },
          },
        },
        // the reactor section is a full statement: keep the host's drives
        drives: switchboard.reactor.drives,
      },
    },
  },
};
