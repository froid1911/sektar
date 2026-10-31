// @ts-check
import config from "../../powerhouse.config.json" with { type: "json" };

/** @satisfies {PHHost} */
export default {
  name: "sektar-switchboard",

  runner: {
    module: "@powerhousedao/ph-cli/runners/switchboard",
    port: config.reactor?.port ?? 4001, // referenced — single value store

    // THE COMPOSITION — the switchboard defaults, each line removable (a
    // curated API deletes what it does not serve). Presence is activation.
    plugins: [
      "@powerhousedao/switchboard/plugins/mcp",
      "@powerhousedao/switchboard/plugins/attachments",
      // Portle: the publication gate (`portleReadiness`) and, later, the
      // relay tunnel. Presence is activation; it takes no config.
      "@powerhousedao/portle/switchboard",
      // Workflows: the runtime AND the drive it serves (seeded here, opens in
      // Workflow Studio). The connect host attaches this same drive through
      // its own workflows plugin — one link, declared on both ends.
      {
        module: "@powerhousedao/switchboard/plugins/workflows",
        config: {
          drive: { slug: "workflows", name: "Workflows", projectHash: false },
        },
      },
      // The assistant's gateway: holds the OpenRouter key as a host secret and
      // serves the welcome page's chat, for admins. It needs sign-in (it does
      // not mount without AUTH_ENABLED and ADMINS) and the workflows runtime
      // above, whose encrypted store holds the key.
      // defaultModel: the newest Qwen on OpenRouter with image input and tool
      // calling, picked on 2026-10-30; admins can change it on a running host.
      {
        module: "@powerhousedao/switchboard/plugins/ai",
        config: {
          defaultModel: "qwen/qwen3.8-max-prime",
          appTitle: "Sektar",
          appUrl: "https://sektar.io",
        },
      },
    ],
  },

  // `auth` is read from powerhouse.config.json by the server itself.
  // `protocol` is SINGLE-SOURCED: this references the same connect.reactor
  // block of powerhouse.config.json that the connect host receives via its
  // config — one store for the replay/admission consensus, projected here
  // onto the server's REACTOR_* / CREATE_SIGNATURE_POLICY env. A pre-set env
  // var contradicting it fails boot by name.
  reactor: {
    protocol: config.connect?.reactor ?? {},
    // The drive this switchboard serves. The cli/desktop compounds read this
    // list and point Connect at it (as a remote client / remote drive), so
    // the drive is OWNED in exactly one place.
    drives: [
      {
        slug: "sektar",
        documentType: "powerhouse/reactor-drive",
        name: "Sektar",
        preferredEditor: "sektar",
        icon: "./icons/sektar_symbol_64x64.png",
      },
      // Mail: captured emails (sektar/email), opened by the Mail workspace.
      {
        slug: "mail",
        documentType: "powerhouse/reactor-drive",
        name: "Mail",
        preferredEditor: "email-workspace",
        icon: "./icons/sektar_symbol_64x64.png",
      },
      // Backfills: Original Source Queues (distyra/original-source-queue),
      // defined in the Backfills workspace and walked by workflows on the
      // For Every trigger, which reach the queue through this switchboard.
      {
        slug: "backfills",
        documentType: "powerhouse/reactor-drive",
        name: "Backfills",
        preferredEditor: "backfills",
        icon: "./icons/sektar_symbol_64x64.png",
      },
      // Integrations: sektar/integration documents, opened by the
      // Integrations drive app. What the user asked for (an account kept in
      // sync) lives here; the reconciler builds the workflows behind it.
      {
        slug: "integrations",
        documentType: "powerhouse/reactor-drive",
        name: "Integrations",
        preferredEditor: "integrations",
        icon: "./icons/sektar_symbol_64x64.png",
      },
      // Calendar: sektar/calendar-event documents that calendar integrations
      // bring in, a folder per calendar, opened by the Calendar drive app.
      // A drive seeded before the app existed is bound by Connect's shell.
      {
        slug: "calendar",
        documentType: "powerhouse/reactor-drive",
        name: "Calendar",
        preferredEditor: "calendar",
        icon: "./icons/sektar_symbol_64x64.png",
      },
      // Files: any document or file, opened by the Files drive app.
      {
        slug: "files",
        documentType: "powerhouse/reactor-drive",
        name: "Files",
        preferredEditor: "files",
        icon: "./icons/sektar_symbol_64x64.png",
      },
      // Trips: business trips (sektar/trip), opened by the Trips drive app.
      {
        slug: "trips",
        documentType: "powerhouse/reactor-drive",
        name: "Trips",
        preferredEditor: "trips",
        icon: "./icons/sektar_symbol_64x64.png",
      },
    ],
  },
};
