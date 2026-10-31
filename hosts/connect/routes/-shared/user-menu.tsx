import { useRenownAuth, useTheme } from "@powerhousedao/reactor-browser";
import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  cx,
  Icon,
  type IconName,
} from "../../../../editors/sektar/kit/ui.js";
import { UserNameDialog } from "../../../../editors/sektar/kit/user-name-dialog.js";
import {
  setUserName,
  useUserName,
} from "../../../../editors/sektar/kit/user-name.js";

// Who is signed in, via Renown — the same hook Connect's own sidebar uses.
// Signed out: a "Sign in" button. With no wallet adapters configured (this
// project) `login()` sends the tab to renown.id and Renown returns to this URL
// with `?user=<did>`, which Connect consumes at boot. Signed in: the design
// system's user chip with a small menu (profile, copy address, theme, sign
// out).

/** The desktop shell around this window: there, an identity is who the app
 * started for, so leaving it means going back to the sign-in page. */
function desktopShell() {
  return (
    window as Window & {
      phDesktop?: { switchIdentity(): Promise<void> };
    }
  ).phDesktop;
}

export function UserMenu() {
  const auth = useRenownAuth();
  const desktop = desktopShell();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [naming, setNaming] = useState(false);
  const userName = useUserName();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!auth.user) {
    const busy = auth.pending || auth.status === "checking";
    return (
      <div className="sk-user-menu">
        <button
          type="button"
          className="sk-btn sk-btn--primary sk-btn--sm"
          onClick={() => auth.login()}
          disabled={busy}
          aria-busy={busy}
          title={auth.error?.message ?? "Sign in with Renown"}
        >
          <Icon name="shield" size={16} />
          {auth.pending
            ? "Signing in…"
            : auth.status === "checking"
              ? "Checking…"
              : "Sign in"}
        </button>
        {auth.error && (
          <span className="sk-caption sk-text-danger sk-hide-mobile">
            {auth.error.message}
          </span>
        )}
      </div>
    );
  }

  const name = auth.displayName ?? auth.displayAddress ?? "Signed in";
  const meta =
    auth.displayName && auth.displayAddress ? auth.displayAddress : "Renown";
  const copy = () => {
    if (!auth.address) return;
    void navigator.clipboard.writeText(auth.address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="sk-user-menu" ref={ref}>
      <button
        type="button"
        className="sk-user sk-user--button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={name} src={auth.avatarUrl} variant="sage" />
        <span className="sk-user__text sk-hide-mobile">
          <span className="sk-user__name">{name}</span>
          <span className="sk-user__meta">{meta}</span>
        </span>
        <Icon name="chevron-down" size={16} mono className="sk-text-muted" />
      </button>
      {open && (
        <ul className="sk-menu sk-user-menu__panel" role="menu">
          <li className="sk-user-menu__head">
            <div className="sk-weight-medium sk-truncate">{name}</div>
            {auth.address && (
              <div className="sk-caption sk-text-muted sk-truncate">
                {auth.address}
              </div>
            )}
          </li>
          <li className="sk-menu__sep" role="separator" />
          {auth.profileId && (
            <li>
              <button
                type="button"
                role="menuitem"
                className="sk-menu__item"
                onClick={() => {
                  auth.openProfile();
                  setOpen(false);
                }}
              >
                <Icon name="arrow-up-right" mono /> Profile on Renown
              </button>
            </li>
          )}
          <li>
            <button
              type="button"
              role="menuitem"
              className="sk-menu__item"
              onClick={copy}
            >
              <Icon name="copy" mono /> {copied ? "Copied" : "Copy address"}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className="sk-menu__item"
              onClick={() => {
                setNaming(true);
                setOpen(false);
              }}
            >
              <Icon name="customers" mono /> Change your name
            </button>
          </li>
          <li className="sk-menu__sep" role="separator" />
          <li className="sk-user-menu__theme">
            <span className="sk-caption sk-text-muted">Theme</span>
            <ThemeSwitch />
          </li>
          <li className="sk-menu__sep" role="separator" />
          <li>
            <button
              type="button"
              role="menuitem"
              className="sk-menu__item sk-menu__item--danger"
              onClick={() => {
                setOpen(false);
                if (desktop) void desktop.switchIdentity();
                else void auth.logout();
              }}
            >
              <Icon name="close" mono />{" "}
              {desktop ? "Switch identity" : "Sign out"}
            </button>
          </li>
        </ul>
      )}
      {naming && (
        <UserNameDialog
          name={userName}
          onSave={(name) => {
            setUserName(name);
            setNaming(false);
          }}
          onCancel={() => setNaming(false)}
        />
      )}
    </div>
  );
}

/** Light, dark, or following the device. */
function ThemeSwitch() {
  const { theme, isSystem, setTheme } = useTheme();
  const current = isSystem ? "system" : theme;
  const options: {
    value: "light" | "dark" | "system";
    icon: IconName;
    label: string;
  }[] = [
    { value: "light", icon: "sun", label: "Light" },
    { value: "dark", icon: "moon", label: "Dark" },
    { value: "system", icon: "monitor", label: "System" },
  ];
  return (
    <div className="sk-segmented" role="group" aria-label="Theme">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={cx(
            "sk-segmented__item",
            current === o.value && "is-active",
          )}
          aria-pressed={current === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setTheme(o.value)}
        >
          <Icon name={o.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
