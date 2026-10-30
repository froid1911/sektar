# Sektar — clarity for smarter business finances

A Powerhouse prototype of an administrative-automation product for SMEs:
bank and card transactions, incoming and outgoing invoices, expense claims,
and the customers and suppliers behind them. Every record is a document on the
Sektar drive; the app is a custom Connect shell styled with the Sektar design
system.

A new environment starts empty: each page shows its own actions and what to do
next, and the books fill as you add records or connect an integration.

## Layout

| Path | What |
|---|---|
| `specs/*.json` | The four document-model specs (`ph generate document-model -d specs/<name>.json` regenerates `document-models/`) |
| `document-models/{bank-account,invoice,expense-report,contact}` | Generated models; hand-written reducers come from the specs; `v1/tests/scenario.test.ts` per model |
| `editors/sektar/design/` | The Sektar design system, vendored unmodified by `scripts/sync-design-system.mjs` (tokens, base for reference, components, utilities, the icon and brand-mark sprites, logos, shapes; `SNAPSHOT.md` records the source files) plus `app.css`, the app layer |
| `scripts/` | `sync-design-system.mjs` (re-vendor the design system), `build-icons.mjs` (app icons, splash, background and explorer icons from the design-system SVGs, via the monorepo's sharp) |
| `editors/sektar/kit/` | `ui.tsx` React wrappers over the `sk-*` classes (lockup, page header, detail header, meta strip, pills, responsive selector, rich list rows, feed, stepper, chips, charts…), `theme.ts` the Connect→design-system theme bridge, `format.ts` labels/money/dates, `data.ts` reactor hooks and writers |
| `editors/sektar/components/` | `InvoiceDetail`, `ExpenseDetail`, `ContactDetail`, `TransactionDetail` — shared by the boards (side panels) and the document editors |
| `editors/*-editor/` | One document editor per model, under Connect's `DocumentToolbar` |
| `processors/search-index/` | Relational processor: one `search_entries` row per document and per bank transaction, rebuilt from each operation's resulting state (or patched from the action input). Runs in the tab's in-process reactor and on the switchboard |
| `editors/sektar/kit/search.ts` + `routes/_app/search.tsx` | Global search: live PGlite query over the processor's table (`useRelationalQuery`), results page, deep links (`/invoices?open=…`) |
| `hosts/connect/routes/-shared/search-bar.tsx` | The top-bar search: the design system's pill input group with the ⌘K / Ctrl K hint, results menu grouped by kind, arrow-key navigation, Enter for the full page, `/` to focus |
| `hosts/connect/routes/-shared/user-menu.tsx` | Sign in / user chip via Renown (`useRenownAuth`): redirect to renown.id and back, profile link, copy address, sign out |
| `editors/sektar/` | The drive app (`preferredEditor: "sektar"`) |
| `hosts/connect/routes/` | The custom shell (`_app.tsx`: product switch on the lockup, per-product nav, promo card, user menu, drawer navigation on phones, top bar with search), the product registry (`-shared/products.ts`, `-shared/product-switch.tsx`), the five Finance Operations surfaces (dashboard, transactions, invoices, expenses, contacts) and the Productivity Center welcome page (`_app/productivity.tsx`) |
| `hosts/*/host.js` | Connect, switchboard, CLI, desktop, assistant and vetra hosts; `hosts/desktop/app.json` is the desktop identity |
| `icons/` | App icon set, splash, home background and explorer icons, generated from the design-system SVGs |
| `style.css` | Tailwind entry: Connect's theme, the vendored design system, and a `@theme inline` bridge exposing `--sk-*` tokens as `*-sk-*` utilities |
| `qa/screens/` | Playwright QC captures (light/dark, desktop/phone); `qa/index.html` is the contact sheet |

## Local monorepo link

Sektar builds against unreleased Powerhouse code: `package.json` and the
`pnpm-workspace.yaml` overrides link every `@powerhousedao/*` package and
`document-model` from a local checkout of the
[monorepo](https://github.com/powerhouse-inc/powerhouse) on the
`feat/host-icons` branch, with the sibling convention
`link:../powerhouse/<pkg-path>`. The committed `pnpm-lock.yaml` records those
paths.

1. Get the monorepo, either as the sibling `../powerhouse`:

   ```sh
   git clone -b feat/host-icons https://github.com/powerhouse-inc/powerhouse ../powerhouse
   ```

   or anywhere else (another clone, a worktree) and export its path as
   `POWERHOUSE_DIR` — absolute, or relative to this project's root.

2. Build it: `pnpm install && pnpm build` in the monorepo.

3. Install here:

   ```sh
   pnpm install                                         # sibling ../powerhouse
   POWERHOUSE_DIR=~/src/powerhouse pnpm install --no-frozen-lockfile   # elsewhere
   git restore pnpm-lock.yaml                           # after a POWERHOUSE_DIR install
   ```

`.pnpmfile.cjs` does the redirect: with `POWERHOUSE_DIR` set it rewrites every
`link:../powerhouse/` spec, in the manifests and in the workspace overrides, to
that directory; unset, it changes nothing. A `POWERHOUSE_DIR` install writes
your machine's paths into `pnpm-lock.yaml` — restore it and never commit it.
pnpm scripts do not reinstall (`verifyDepsBeforeRun: false` in
`pnpm-workspace.yaml`), so `node_modules` keeps pointing at your checkout
until the next explicit `pnpm install`: pass `POWERHOUSE_DIR` to every one (a
plain one relinks to `../powerhouse`), and run it yourself after pulling
dependency changes. Adding or
upgrading a dependency needs a default install (sibling `../powerhouse`) so the
lockfile you commit has the shared paths. pnpm records the pnpmfile's checksum
in the lockfile: after editing `.pnpmfile.cjs`, run
`pnpm install --lockfile-only` with `POWERHOUSE_DIR` unset and commit both.

## Run

```sh
pnpm install                                      # see "Local monorepo link"
pnpm build                                        # dist/ — the reactor loads the models from here
FEATURE_UNIFORM_RUNNERS_ENABLED=true ph run connect dev   # http://localhost:6540
```

Desktop (needs Rust + the Tauri CLI). `hosts/desktop/app.json` names the
loading page's light and dark splash (the lockup composition from
`scripts/build-icons.mjs`), dark colours and the corner art; the shell
regenerates `tauri-shell/ui/index.html` from it on each run:

```sh
ph run connect build && pnpm build                # connect build empties dist/, so build the package after it
FEATURE_UNIFORM_RUNNERS_ENABLED=true ph run desktop dev
```

Assistant (OpenAI-compatible chat API on :4910 — `assistant.port` in
`powerhouse.config.json` — reactor = the project switchboard).
The agent has read tools over that switchboard — `listDrives`, `listDocuments`
(by drive and document type) and `getDocument` — so it answers from the actual
documents ("which invoices are overdue?" names them with amounts). Writes stay
with people: it names the operation it would apply.

```sh
FEATURE_UNIFORM_RUNNERS_ENABLED=true ph run switchboard
OPENROUTER_API_KEY=sk-or-… FEATURE_UNIFORM_RUNNERS_ENABLED=true ph run assistant
```

Checks: `pnpm tsc`, `pnpm lint`, `pnpm test:coverage` (reducers ≥ 95 % branches).
`pnpm tsc` is no-emit on purpose: with declaration emit on, the route tree's
imports of Connect's own routes made tsc write `.d.ts` files next to Connect's
sources in the monorepo, and the route scanner then picked those up as routes
(`$.d`, `settings.d`) and broke the build. The remaining TS6059 "not under
rootDir" errors come from the same imports and are a builder-tools issue, not
a project one.

## Signing in

The top bar's "Sign in" goes through Renown, exactly like Connect's own
sidebar: the same `useRenownAuth` hook, the same redirect to renown.id with a
`returnUrl` back to the current page, and Connect consumes the returned
`?user=<did>` at boot. The project configures no wallet adapters, so the
in-page (Privy / wallet) modal is not offered; add `connect.renown.adapters`
to `powerhouse.config.json` to get it. In the desktop app the webview itself
navigates to renown.id and back to `http://127.0.0.1:6540/…`.

## Design system

The design system is vendored, never edited: `node scripts/sync-design-system.mjs`
copies the current `sektar-design-elements/design-system` into
`editors/sektar/design/` (rewriting asset urls, regenerating the sprite
modules, pruning what the kit retired) and writes `SNAPSHOT.md`. Fraunces stays
on Google Fonts on purpose (the self-hosted build is not worth the download);
every rule still pins `"WONK" 0` for the day it is self-hosted.

Dark mode: the design system reads `data-theme="dark"` on `<html>`; Connect
writes `.dark`. `kit/theme.ts` mirrors Connect's resolved theme onto the
attribute (and removes it for "system", the design system's own auto mode), so
both agree without a patched tokens file.

The shell follows the reference dashboard: the live lockup with the product
line in the sidebar, the promo banner card above the user menu, the top bar
with the pill search filling the bar. The lockup is the design system's
product switcher: it opens a list of the products (Productivity Center,
Finance Operations), and picking one changes the product line, the
navigation, the drive link and the page while the shell, top bar and account
stay. The product follows the URL; shared pages (settings, search) keep the
last one, remembered per browser. Productivity Center is a welcome page for
now, with a button into its "Workflows" drive. That drive is the switchboard's:
the workflows plugin in `hosts/switchboard/host.js` seeds it (named in the
entry's `config.drive`) with Workflow Studio as its drive app, and the
workflows plugin in `hosts/connect/host.js` loads Workflow Studio and attaches
that drive as a remote (the studio reaches its runtime through the drive's
switchboard, so a local drive would not do). Finance Operations' pages live
under `/finops/*`; the main page opens Productivity Center. On desktop the
top bar's menu button collapses the sidebar to the design system's icon rail
and back. Under 960px the sidebar becomes the drawer behind that button; under 640px of
content width the top bar shows the page title and a search button that opens
the search as a sheet, grids collapse to one column and tables stack into
two-line rows (the transactions table keeps the date · description · category
· amount column order those rules assume).

Patterns used: page header with art, detail header + meta strip + key–value in
panels and editors, pills with counts (contacts), the responsive selector
(invoice direction, bank accounts), rich list rows (contacts, attention list),
activity feed (invoice history), stepper (claim status), attachment chips
(receipts), bars with a value axis, compact ring + progress rows (books
readiness), hero and promo cards. Not used: slides, timer, preview panel,
product switch, the workspace panes (the boards keep their columns and side
panels).

## Design notes

- Components consume semantic `--sk-*` tokens only, so light/dark is free
  once the theme attribute is in place (see above).
- Layout and responsive behaviour come from the design system's own CSS
  (`sk-grid`, `sk-shell`, `sk-board`), not from Tailwind responsive variants,
  because a project's `md:` utilities currently lose to Connect's precompiled
  base utilities. The `@theme inline` bridge keeps working unchanged once
  Connect's compile gets its `ph:` prefix.
- Icons are the Sektar sprite (`<Icon name="invoice" />`), 2–3 tones that
  recolour with the theme.
- Connect scrolls its root element, not the window: the sidebar and top bar
  are `position: sticky` inside that container (`align-self: start` on the
  grid item, `min-height: 0` to beat the design system's `min-height: 100%`);
  the drawer is `position: fixed` for the same reason.
- The shell calls `initTheme()` (reactor-browser): Connect registers its
  theme-change listener in the skeleton/load components a custom shell
  replaces, so without it the light/dark toggles are inert.
- `Address` is a reserved scalar name in Powerhouse's codegen: a state type
  called `Address` compiles in the app but makes the switchboard's attachment
  read model reject every operation of that model ("the effective GraphQL
  schema is invalid"). The contact model's type is `PostalAddress` for that
  reason.
- The in-process reactor runs the project's processors in the tab, so search
  works offline and in the desktop app. This needed one Connect fix:
  `createProcessorHostModule` now publishes the tab's PGlite for the
  relational hooks (the worker path already did).
