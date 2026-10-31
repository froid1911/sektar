// @ts-check
// vetra is the GENERIC compound over the project's switchboard and connect
// members, each composed with the Vetra Studio plugins — there is no
// vetra-specific runner. Studio is verb-scoped: `ph run vetra dev` gets the
// Vite package loader + studio UI + codegen reload; `ph run vetra` (run) is
// the same stack headless. Members spread their sibling host's composition
// (full inclusion) and add studio.
// Requires @powerhousedao/vetra-studio in devDependencies (private until its
// first publish — link the workspace package meanwhile; added to the
// versioned scaffold deps at that publish event, same as host-core/clint).
import config from "../../powerhouse.config.json" with { type: "json" };
import switchboard from "../switchboard/host.js";
import connect from "../connect/host.js";

// Every drive the switchboard host serves (the business drive, Mail,
// Backfills, Files, Trips): the studio switchboard serves the same list, and
// the studio Connect attaches each one as a remote, being a remote client of it.
const servedDrives = switchboard.reactor.drives ?? [];

/** @satisfies {PHHost} */
export default {
  name: "vetra",

  runner: {
    module: "@powerhousedao/host-core/runners/compound",
    defaultVerb: "dev",
  },

  children: {
    "vetra-switchboard": {
      host: "switchboard",
      runner: {
        plugins: [
          ...switchboard.runner.plugins,
          { module: "@powerhousedao/vetra-studio/switchboard", verbs: ["dev"] },
        ],
      },
      // Every drive the switchboard host serves plus the studio drives: the
      // studio Connect is a pure remote client of this member (below), so the
      // business drives have to live here.
      reactor: {
        ...switchboard.reactor,
        drives: [
          ...servedDrives,
          { slug: "vetra", name: "Vetra", preferredEditor: "vetra-drive-app" },
          { slug: "vetra-preview", name: "Vetra Preview" },
        ],
      },
    },
    "vetra-studio": {
      host: "connect",
      runner: {
        port: config.vetra?.connectPort ?? 3001,
        plugins: [
          ...connect.runner.plugins,
          { module: "@powerhousedao/vetra-studio/connect", verbs: ["dev"] },
        ],
        // The studio's server proxies the switchboard's paths (/graphql,
        // /d/*, /attachments, /mcp, /api/*) to the studio switchboard, so
        // the browser talks to its own origin for everything and the served
        // config names the switchboard as ${origin}. The same config then
        // holds from http://localhost:<port> and from a published site
        // (Portle), where the edge makes the same split.
        proxy: { target: `http://127.0.0.1:${switchboard.runner.port}` },
      },
      // The studio Connect is a pure REMOTE CLIENT of the studio switchboard
      // (as the cli host's Connect is): no reactor and no PGlite in the tab,
      // every read and write proxied over GraphQL. A synchronized remote
      // drive would replicate the Mail drive into the browser, thousands of
      // messages with bodies, and re-derive the whole history into a sync
      // outbox on every fresh tab, which stalled the switchboard for minutes.
      // The studio drives (vetra, preview) are attached by the studio plugin.
      // ${origin}: the page's own origin (see runner.proxy above). A remote
      // backend is named by one of the switchboard's drives (the GraphQL
      // endpoint names no drive): ${origin}/d/<the business drive> is the
      // switchboard at ${origin}, its GraphQL at ${origin}/graphql.
      reactor: {
        backends: {
          sb: {
            kind: "remote",
            remote: { url: "${origin}/d/sektar" },
          },
        },
        drives: servedDrives.map((d) => ({
          slug: d.slug,
          remote: { url: "${origin}/d/" + d.slug },
        })),
      },
    },
  },
};
