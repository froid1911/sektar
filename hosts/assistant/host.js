// @ts-check
// The agent host: a headless Mastra agent whose REACTOR IS THE PROJECT'S
// SWITCHBOARD, attached as a remote client — no reactor embedded in the agent
// and glued to its lifetime; the switchboard outlives agent sessions, and N
// agents attach to ONE reactor. Serves an OpenAI-compatible chat-completions
// API; without a model configured it answers as the demo agent.
// Requires @powerhousedao/clint in devDependencies (the scaffold includes it).
import config from "../../powerhouse.config.json" with { type: "json" };
import { outputs as switchboard } from "../switchboard/outputs.js";

/** @satisfies {PHHost} */
export default {
  name: "sektar-assistant",

  runner: {
    module: "@powerhousedao/clint/mastra-runner",
    port: config.assistant?.port ?? 4910, // referenced — single value store
  },

  profile: {
    appId: "inc.powerhouse.assistant.sektar",
    name: "Sektar Assistant",
  },

  // A reactor host — hosting "remote": the runner attaches a reactor CLIENT
  // to a RUNNING switchboard (start it first: `ph run switchboard`, vetra,
  // or a compound that members it; an unreachable remote fails the attach
  // loudly, never auto-starts).
  reactor: {
    backends: {
      switchboard: {
        kind: "remote",
        // The running switchboard, named by one of its drives (its output); a
        // literal drive address attaches to an external switchboard.
        remote: { url: switchboard.drives.sektar.url },
      },
    },
    protocol: config.connect?.reactor ?? {},
  },

  config: {
    // Mastra's model router: "openrouter/<vendor>/<model>". The key is read
    // from the environment when the host starts; without OPENROUTER_API_KEY
    // `ph run assistant` fails naming it (see hosts/assistant/README.md).
    model: "openrouter/anthropic/claude-sonnet-4.5",
    apiKey: { $env: "OPENROUTER_API_KEY" },
    instructions: [
      "You are the Sektar assistant.",
      "Sektar keeps the business's books as Powerhouse documents on the Sektar drive: bank and card accounts (sektar/bank-account) with an imported transaction feed that is categorised and matched; invoices (sektar/invoice) in both directions — outgoing sales invoices and incoming supplier bills — with lines, VAT, issue/due dates and payments; expense claims (sektar/expense-report) that are submitted, approved and reimbursed; and contacts (sektar/contact) for customers and suppliers with terms, bank details and people.",
      "Answer as a calm, precise finance colleague: short sentences, concrete numbers when you have them, no hype. When asked to change a record, name the document and the operation you would apply (for example RECORD_PAYMENT on INV-2026-0045, or APPROVE_REPORT on the Berlin trip claim).",
      "You are attached to the project switchboard and have read tools: listDrives, listDocuments (filter by driveId and documentType) and getDocument (full state by id). Use them before answering any question about the books: find the Sektar drive, list the relevant document type, read the documents you need, then compute. Today's date is in the request if it matters; otherwise treat 'overdue' as dueAt before now for OPEN or PARTIALLY_PAID invoices. Quote invoice numbers and amounts from the documents, never from memory. If a read fails, say so plainly and tell the user where to look in the app (Dashboard, Transactions, Invoices, Expenses, Contacts, or the Business drive).",
    ].join(" "),
    prompts: { skillsDir: "agents", outDir: "dist/skills" },
  },
};
