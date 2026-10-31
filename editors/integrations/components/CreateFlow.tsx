import {
  addDocument,
  dispatchActions,
  useRenown,
  useRenownAuth,
  useSelectedDrive,
} from "@powerhousedao/reactor-browser";
import type {
  IntegrationAccess,
  IntegrationKind,
  IntervalUnit,
} from "document-models/integration";
import { generateId } from "document-model";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  KIND_COPY,
  accessOptions,
  createActions,
  defaultChoices,
  defaultName,
  defaultSince,
  INTEGRATION_TYPE,
  INTERVALS,
  KINDS,
  kindInfo,
  providerInfo,
  providersFor,
  type AccessOption,
  type CreateChoices,
} from "../../sektar/kit/integrations.js";
import {
  Alert,
  Badge,
  Button,
  Field,
  Icon,
  Input,
  Select,
  Steps,
  Switch,
} from "../../sektar/kit/ui.js";
import { createAccount, useSektarDrive } from "../../sektar/kit/data.js";
import { useHubDrive } from "../../sektar/kit/integration-index.js";
import {
  ensureReactorConnection,
  grantAction,
  granterOf,
  useRunnerFacts,
  wantsStatement,
} from "../../sektar/kit/reactor-grant.js";
import {
  useSignInPlace,
  type SignInPlace,
} from "../../sektar/kit/sign-in-place.js";
import { BankAccounts, BankConnect } from "./BankSetup.js";

/**
 * The flow's steps, as they appear in the hash (`#add/before`, `#add`, …).
 * `add/before` is shown only where the sign-in is handed over to the
 * computer that runs Sektar: the user acknowledges, before configuring
 * anything, that the sign-in finishes there. On that computer, and in an
 * environment where the sign-in finishes in this browser (the cloud flow),
 * the flow starts at `add`.
 */
export const STEPS = [
  "add/before",
  "add",
  "add/connect",
  "add/how-much",
  "add/grant",
  "add/name",
] as const;
export type CreateStep = (typeof STEPS)[number];

/** Without the step that lets Sektar write: only a new environment needs it. */
const CONFIGURE: readonly CreateStep[] = STEPS.slice(1).filter(
  (step) => step !== "add/grant",
);
const CONFIGURE_WITH_GRANT: readonly CreateStep[] = STEPS.slice(1);
const TITLES = ["What to bring in", "Connect", "How much", "Name and create"];
const TITLES_WITH_GRANT = [
  "What to bring in",
  "Connect",
  "How much",
  "Allow",
  "Name and create",
];

/**
 * Where Add integration starts: the handoff notice first, unless the
 * sign-in finishes in this browser (sign-in-place.ts: a loopback page is
 * the runner's own; elsewhere the switchboard says whether it can finish
 * here).
 */
export function firstStep(place: SignInPlace): CreateStep {
  return place === "handoff" ? "add/before" : "add";
}

/**
 * Creating an integration, in the user's words (design system: Patterns ·
 * Integrations · Create): what to bring in; connecting the account, with what
 * Sektar may do there chosen first, so nobody wonders about their data in the
 * steps after; how much; a name. Create writes only the integration document:
 * the reconciler on the runner does the rest, after the sign-in there. In the
 * cloud flow the sign-in finishes in this environment: no handoff notice
 * before, no "continue on your computer" after; Create lands on the card,
 * whose Sign in with Google finishes it.
 */
export function CreateFlow({
  step,
  go,
  onDone,
  onCancel,
}: {
  step: CreateStep;
  go: (step: CreateStep) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const now = useMemo(() => new Date(), []);
  const { place } = useSignInPlace();
  // On the runner (a loopback page) the sign-in comes back to this machine
  const runner = place === "local";
  // In an environment whose switchboard finishes the sign-in itself
  const cloud = place === "cloud";
  const direct = runner || cloud;
  const environmentWord = runner ? "computer" : "environment";
  const [drive] = useSelectedDrive();
  const sektarDrive = useSektarDrive();
  const workflows = useHubDrive("workflows");
  const renown = useRenown();
  const { login } = useRenownAuth();
  const { facts, refresh } = useRunnerFacts();
  const granter = granterOf(renown);
  // A new environment: nothing can write documents until someone allows it.
  const grantStep = Boolean(facts) && !facts?.reactorConnectionId;
  // Asked once per flow, so allowing does not take the step away under them.
  const [granting, setGranting] = useState<boolean | null>(null);
  useEffect(() => {
    if (facts !== undefined && granting === null) setGranting(grantStep);
  }, [facts, grantStep, granting]);
  const withGrant = granting === true;
  const configure = withGrant ? CONFIGURE_WITH_GRANT : CONFIGURE;
  const nameStep = configure.length - 1;
  const [allowed, setAllowed] = useState(false);
  const [kind, setKind] = useState<IntegrationKind | null>(null);
  const [choices, setChoices] = useState<CreateChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where the sign-in is handed over, nothing is configured before the
  // handoff is acknowledged.
  const [acknowledged, setAcknowledged] = useState(runner);
  const [finished, setFinished] = useState<string | null>(null);

  const configureTitles = withGrant ? TITLES_WITH_GRANT : TITLES;
  const flow = direct ? configure : ["add/before", ...configure];
  const titles = direct
    ? configureTitles
    : ["Before you start", ...configureTitles];
  const base = direct ? 0 : 1;
  // A reload or a deep link past a step without its choice starts over.
  const wanted = Math.max(0, configure.indexOf(step));
  const conf = choices ? wanted : kind ? Math.min(wanted, 1) : 0;
  const before = !cloud && (!acknowledged || step === "add/before");
  const at = before ? 0 : base + conf;
  const patch = (p: Partial<CreateChoices>) =>
    setChoices((c) => (c ? { ...c, ...p } : c));

  const afterHowMuch: CreateStep = withGrant ? "add/grant" : "add/name";
  const beforeName: CreateStep = withGrant ? "add/grant" : "add/how-much";

  const allow = async () => {
    if (!facts) return;
    setBusy(true);
    setError(null);
    try {
      if (facts.requiresPerson && !granter) {
        login();
        return;
      }
      await ensureReactorConnection(facts, workflows?.header.id);
      setAllowed(true);
      refresh();
      go("add/name");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickKind = (k: IntegrationKind) => {
    if (k !== kind) setChoices(null);
    setKind(k);
    go("add/connect");
  };
  const pickProvider = (provider: string) => {
    if (!kind) return;
    setChoices((c) =>
      c && c.provider === provider ? c : defaultChoices(kind, provider, now),
    );
  };

  const create = async () => {
    if (!choices || !drive) return;
    setBusy(true);
    setError(null);
    try {
      const name =
        choices.name.trim() || defaultName(choices.kind, choices.provider);
      let ready = choices;
      if (choices.kind === "TRANSACTIONS") {
        // New bank accounts first: the integration names them
        if (!sektarDrive) throw new Error("The Business drive is not open");
        const accounts = [];
        for (const a of choices.accounts ?? []) {
          const bankAccountId =
            a.bankAccountId ??
            (await createAccount(sektarDrive, {
              name: a.name,
              institution: choices.bankName,
              iban: a.ibanMasked ?? undefined,
              kind: (a.kind ?? "CURRENT") as Parameters<
                typeof createAccount
              >[1]["kind"],
              currency: a.currency ?? undefined,
            }));
          accounts.push({ ...a, bankAccountId });
        }
        ready = { ...choices, accounts };
      }
      const node = await addDocument(drive.header.id, name, INTEGRATION_TYPE);
      // One statement per integration, signed silently: the step above asked.
      const granted =
        granter && wantsStatement(facts)
          ? [await grantAction(granter, facts, node.id)]
          : [];
      await dispatchActions(
        [...createActions(ready, now, generateId), ...granted],
        node.id,
      );
      // Nothing to sign in to for a bank on a key this computer holds; in
      // the cloud flow the card's Sign in finishes it, here
      if (direct || choices.kind === "TRANSACTIONS") onDone();
      else {
        setFinished(name);
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (finished) {
    body = (
      <Panel title={`${finished} is set up`} lead="One step left.">
        <div className="sk-intg-handoff">
          <Steps
            current={1}
            steps={[
              { title: "Configure on this device", desc: "Done" },
              {
                title: "Continue on your computer",
                desc: "Open Sektar there and sign in to start",
              },
            ]}
          />
        </div>
        <div className="sk-row sk-row--end">
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </Panel>
    );
  } else if (before) {
    body = (
      <Panel
        title="Sektar is local-first"
        lead="Sign-in happens on your computer."
      >
        <div className="sk-intg-handoff">
          <Steps
            current={0}
            steps={[
              {
                title: "Configure on this device",
                desc: "What to bring in, access and how much",
              },
              {
                title: "Finish on your computer",
                desc: "Sign in the next time you open Sektar there",
              },
            ]}
          />
        </div>
        <details className="sk-intg-more">
          <summary>Read more</summary>
          <p className="sk-small">
            Sektar runs on your own computer, not on our servers. That computer
            fetches what you connect and keeps your sign-in, so your data and
            your access stay with you. Google sends a sign-in back to the
            computer that asked for it, which is why it happens there and never
            passes through Sektar. Set up the rest here now; the next time you
            open Sektar on your computer, it asks you to sign in and everything
            starts.
          </p>
        </details>
        <div className="sk-row sk-row--between">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setAcknowledged(true);
              go("add");
            }}
          >
            Continue
          </Button>
        </div>
      </Panel>
    );
  } else if (conf === 0) {
    body = (
      <Panel
        title="What do you want to bring in?"
        lead="You can add more later."
        back={direct ? undefined : () => go("add/before")}
      >
        <div className="sk-intg-tiles">
          {KINDS.map((k) => (
            <Tile
              key={k.kind}
              disabled={!k.available}
              selected={kind === k.kind}
              onClick={() => pickKind(k.kind)}
              mark={<Icon name={k.icon} />}
              title={k.label}
              lead={k.lead}
              badge={k.available ? undefined : "Coming soon"}
            />
          ))}
        </div>
      </Panel>
    );
  } else if (conf === 1 && kind) {
    const info = kindInfo(kind);
    const provider = providerInfo(choices?.provider);
    body = (
      <Panel
        title={`Connect your ${info?.label.toLowerCase() ?? "account"}`}
        lead="Where it is, and what Sektar may do."
        back={() => go("add")}
      >
        <div className="sk-intg-tiles">
          {providersFor(kind).map((p) => (
            <Tile
              key={p.id}
              disabled={!p.available}
              selected={choices?.provider === p.id}
              onClick={() => pickProvider(p.id)}
              mark={p.mark || <Icon name={info?.icon ?? "sync"} />}
              title={p.label}
              lead={p.lead}
              badge={p.available ? undefined : p.badge}
            />
          ))}
        </div>
        {choices && provider && (
          <>
            <AccessChoice
              options={accessOptions(choices.provider)}
              value={choices.access}
              onChange={(access) => patch({ access })}
              hint={
                choices.kind === "TRANSACTIONS"
                  ? "Your bank asked you to agree when you connected it in Distyra; Sektar only reads."
                  : undefined
              }
            />
            {choices.kind === "TRANSACTIONS" && (
              <BankConnect choices={choices} patch={patch} />
            )}
            <Footer
              back={() => go("add")}
              next={() => go("add/how-much")}
              nextLabel="Continue"
              disabled={
                choices.kind === "TRANSACTIONS" &&
                !(choices.connectionId && choices.bankConnectionId)
              }
            />
          </>
        )}
      </Panel>
    );
  } else if (conf === 2 && choices && choices.kind === "TRANSACTIONS") {
    body = (
      <Panel
        title="Which accounts?"
        lead={`From ${choices.bankName ?? "your bank"}, each onto a bank account in Sektar.`}
        back={() => go("add/connect")}
      >
        <BankAccounts choices={choices} patch={patch} />
        <Footer
          back={() => go("add/connect")}
          next={() => go(afterHowMuch)}
          nextLabel="Continue"
          disabled={(choices.accounts ?? []).length === 0}
        />
      </Panel>
    );
  } else if (conf === 2 && choices) {
    const history = choices.history;
    const interval = `${choices.every.value}-${choices.every.unit}`;
    const copy = KIND_COPY[choices.kind] ?? KIND_COPY.CALENDAR!;
    body = (
      <Panel
        title="How much?"
        lead="You can change this later."
        back={() => go("add/connect")}
      >
        <div className="sk-intg-row">
          <div>
            <div className="sk-integration__label">{copy.sourceLabel}</div>
            <div className="sk-integration__meta">{copy.sourceMeta}</div>
          </div>
        </div>
        <div className="sk-intg-row">
          <div>
            <div className="sk-integration__label">Changes as they happen</div>
            <div className="sk-integration__meta">{copy.liveMeta}</div>
          </div>
          <Switch
            checked={choices.live}
            onChange={(live) => patch({ live })}
            label="Live updates"
          />
        </div>
        {choices.live && (
          <Field label="Check every">
            <Select
              value={interval}
              onChange={(e) => {
                const found = (copy.intervals ?? INTERVALS).find(
                  (i) => `${i.value}-${i.unit}` === e.target.value,
                );
                if (found)
                  patch({
                    every: {
                      value: found.value,
                      unit: found.unit as IntervalUnit,
                    },
                  });
              }}
              style={{ maxWidth: 240 }}
            >
              {(copy.intervals ?? INTERVALS).map((i) => (
                <option
                  key={`${i.value}-${i.unit}`}
                  value={`${i.value}-${i.unit}`}
                >
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <fieldset className="sk-stack sk-stack--3 sk-intg-fieldset">
          <legend className="sk-label">{copy.historyLegend}</legend>
          <label className="sk-check">
            <input
              type="radio"
              name="intg-history"
              checked={history.kind === "none"}
              onChange={() => patch({ history: { kind: "none" } })}
            />{" "}
            None, only from today
          </label>
          <label className="sk-check sk-intg-since">
            <input
              type="radio"
              name="intg-history"
              checked={history.kind === "since"}
              onChange={() =>
                patch({
                  history: {
                    kind: "since",
                    date:
                      history.kind === "since"
                        ? history.date
                        : defaultSince(now),
                  },
                })
              }
            />{" "}
            Since
            <Input
              type="date"
              size="sm"
              value={
                history.kind === "since" ? history.date : defaultSince(now)
              }
              max={now.toISOString().slice(0, 10)}
              onChange={(e) =>
                patch({ history: { kind: "since", date: e.target.value } })
              }
              aria-label="Since"
            />
          </label>
          <label className="sk-check">
            <input
              type="radio"
              name="intg-history"
              checked={history.kind === "everything"}
              onChange={() => patch({ history: { kind: "everything" } })}
            />{" "}
            Everything in the account
          </label>
          {copy.ahead && (
            <span className="sk-hint">Each includes the next 12 months.</span>
          )}
        </fieldset>
        <Footer
          back={() => go("add/connect")}
          next={() => go(afterHowMuch)}
          nextLabel="Continue"
        />
      </Panel>
    );
  } else if (withGrant && conf === 3 && choices) {
    body = (
      <Panel
        title="Let Sektar write to your documents"
        lead="Workflows bring things in for you. They need your say-so once."
        back={() => go("add/how-much")}
      >
        <div className="sk-intg-access">
          <div
            className="sk-intg-access__option is-selected"
            style={{ cursor: "default" }}
          >
            <ul className="sk-intg-access__list">
              <li>
                <Icon name="check" size={16} mono className="sk-intg-yes" />
                Write what you set up here to your documents
              </li>
              <li>
                <Icon name="check" size={16} mono className="sk-intg-yes" />
                Keep it up to date while you are away
              </li>
              <li className="sk-text-muted">
                <Icon name="close" size={16} mono className="sk-intg-no" />
                Anything outside this {environmentWord}
              </li>
            </ul>
          </div>
        </div>
        {error && (
          <Alert tone="danger" title="Could not allow it">
            {error}
          </Alert>
        )}
        <Footer
          back={() => go("add/how-much")}
          next={() => void allow()}
          nextLabel={
            busy
              ? "Allowing…"
              : facts?.requiresPerson && !granter
                ? "Sign in"
                : allowed
                  ? "Continue"
                  : "Allow"
          }
          disabled={busy}
        />
      </Panel>
    );
  } else if (conf === nameStep && choices) {
    body = (
      <Panel
        title="Name it"
        lead="As it appears on the page."
        back={() => go(beforeName)}
      >
        <Field label="Name">
          <Input
            value={choices.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder={defaultName(choices.kind, choices.provider)}
            maxLength={80}
          />
        </Field>
        {error && (
          <Alert tone="danger" title="Could not create the integration">
            {error}
          </Alert>
        )}
        <Footer
          back={() => go(beforeName)}
          next={() => void create()}
          nextLabel={busy ? "Creating…" : "Create"}
          disabled={busy || !drive}
        />
      </Panel>
    );
  }

  const done = (i: number) =>
    i < base
      ? "Local-first"
      : i - base === 0
        ? kindInfo(kind)?.label
        : i - base === 1 && choices
          ? `${providerInfo(choices.provider)?.label ?? ""} · ${choices.access === "READ_WRITE" ? "read and write" : "read only"}`
          : undefined;

  return (
    <div className="sk-intg-create">
      <div className="sk-intg-create__steps">
        <Steps
          steps={titles.map((title, i) => ({
            title,
            desc: i < at ? done(i) : undefined,
          }))}
          current={finished ? flow.length : at}
        />
      </div>
      {!finished && (
        <div className="sk-intg-create__phone-step sk-small sk-text-muted">
          Step {at + 1} of {flow.length} · {titles[at]}
        </div>
      )}
      {body}
    </div>
  );
}

/** What Sektar may do with the account: the options side by side, with what each allows and rules out. */
function AccessChoice({
  options,
  value,
  onChange,
  hint,
}: {
  options: AccessOption[];
  value: IntegrationAccess;
  onChange: (access: IntegrationAccess) => void;
  hint?: string;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="sk-intg-fieldset sk-stack sk-stack--3">
      <legend className="sk-label sk-mb-1">What Sektar may do</legend>
      <div className="sk-intg-access">
        {options.map((o) => (
          <label
            key={o.access}
            className={
              value === o.access
                ? "sk-intg-access__option is-selected"
                : "sk-intg-access__option"
            }
          >
            <span className="sk-intg-access__head">
              <input
                type="radio"
                name="intg-access"
                checked={value === o.access}
                onChange={() => onChange(o.access)}
              />
              <span className="sk-weight-medium">{o.label}</span>
            </span>
            <ul className="sk-intg-access__list">
              {o.can.map((c) => (
                <li key={c}>
                  <Icon name="check" size={16} mono className="sk-intg-yes" />
                  {c}
                </li>
              ))}
              {o.cannot.map((c) => (
                <li key={c} className="sk-text-muted">
                  <Icon name="close" size={16} mono className="sk-intg-no" />
                  {c}
                </li>
              ))}
            </ul>
            <span className="sk-caption sk-text-muted">{o.permission}</span>
          </label>
        ))}
      </div>
      <span className="sk-hint">
        {hint ??
          "You confirm this when you sign in. Changing it later means signing in again."}
      </span>
    </fieldset>
  );
}

function Panel({
  title,
  lead,
  back,
  children,
}: {
  title: string;
  lead?: string;
  back?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="sk-card sk-stack sk-stack--6 sk-intg-create__panel">
      {back && (
        <button
          type="button"
          className="sk-btn sk-btn--ghost sk-btn--sm sk-intg-create__back"
          onClick={back}
        >
          <Icon name="chevron-right" size={16} className="sk-intg-flip" /> Back
        </button>
      )}
      <div>
        <h2 className="sk-h3" style={{ margin: 0 }}>
          {title}
        </h2>
        {lead && <p className="sk-small sk-text-muted sk-mt-1">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

function Tile({
  mark,
  title,
  lead,
  badge,
  selected,
  disabled,
  onClick,
}: {
  mark: ReactNode;
  title: string;
  lead: string;
  badge?: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={["sk-action-tile", "sk-intg-tile", selected && "is-selected"]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="sk-avatar sk-avatar--square sk-avatar--lg">{mark}</span>
      <span>{title}</span>
      <span className="sk-caption sk-text-muted sk-intg-tile__lead">
        {lead}
      </span>
      {badge && <Badge tone="outline">{badge}</Badge>}
    </button>
  );
}

function Footer({
  back,
  next,
  nextLabel,
  disabled,
}: {
  back: () => void;
  next: () => void;
  nextLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="sk-row sk-row--between">
      <Button variant="ghost" onClick={back}>
        Back
      </Button>
      <Button variant="primary" onClick={next} disabled={disabled}>
        {nextLabel}
      </Button>
    </div>
  );
}
