import {
  initTheme,
  setPreferredEditorOnNode,
  useDrives,
} from "@powerhousedao/reactor-browser";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import bannerDark from "../../../editors/sektar/design/shapes/sektar-growth-four-column-combined-dark.svg";
import bannerLight from "../../../editors/sektar/design/shapes/sektar-growth-four-column-combined-light.svg";
import {
  Button,
  cx,
  Icon,
  PromoCard,
  Skeleton,
  Sprite,
} from "../../../editors/sektar/kit/ui.js";
import { findDrive } from "../../../processors/drives/index.js";
import { AssistantChatHolder } from "./-shared/assistant-chat.js";
import { ProductSwitch } from "./-shared/product-switch.js";
import {
  driveFor,
  navMatches,
  PRODUCTS,
  productFor,
  rememberProduct,
  rememberedProduct,
  type NavItem,
  type Product,
} from "./-shared/products.js";
import { SearchBar } from "./-shared/search-bar.js";
import { SearchContext } from "./-shared/search.js";
import { SyncStatus } from "./-shared/sync-status.js";
import { UserMenu } from "./-shared/user-menu.js";
import { UserNamePrompt } from "./-shared/user-name-prompt.js";

// Sektar replaces Connect's layout with the design system's app shell: the
// sidebar (the product switch on the brand lockup, the product's work
// surfaces, its drive, promo, the user), a top bar with the search, and the
// content beside it. Under 1064px (264px of sidebar + 800px for a three-pane
// workspace; app.css carries the same number) the
// sidebar becomes a drawer behind the top bar's menu button, as in the design
// system's phone dashboard. Core routes (the drive at /d/sektar, settings)
// render inside the same shell.
export const Route = createFileRoute("/_app")({
  // The main page opens the default product (Productivity Center).
  beforeLoad: ({ location }) => {
    if (location.pathname === "/" || location.pathname === "") {
      throw redirect({ to: "/productivity" });
    }
  },
  component: Shell,
});

/**
 * Drives seeded before their drive app existed (the host leaves an existing
 * drive as it is) open in Connect's default view. Each nav item that names
 * an app binds its drive once, and only a drive with no app yet: a choice
 * someone made in Connect stays.
 */
function useBindDriveApps() {
  const drives = useDrives();
  const tried = useRef(new Set<string>());
  useEffect(() => {
    for (const item of PRODUCTS.flatMap((p) => [
      ...p.nav,
      ...(p.beforeDrive ?? []),
      ...(p.afterDrive ?? []),
      ...(p.linked ?? []),
    ])) {
      if (!item.app || !item.to.startsWith("/d/")) continue;
      const slug = item.to.slice(3);
      const drive = findDrive(drives, slug);
      if (!drive || drive.header.meta?.preferredEditor) continue;
      if (tried.current.has(drive.header.id)) continue;
      tried.current.add(drive.header.id);
      setPreferredEditorOnNode(drive.header.id, item.app).catch(
        (e: unknown) => {
          console.warn(`[sektar] could not bind the ${slug} drive app`, e);
        },
      );
    }
  }, [drives]);
}

function pageTitle(pathname: string, product: Product) {
  const nav = [
    ...product.nav,
    ...(product.beforeDrive ?? []),
    ...(product.afterDrive ?? []),
    ...(product.linked ?? []),
  ].find((n) => navMatches(pathname, n.to));
  if (nav) return nav.label;
  if (pathname.startsWith("/d/")) return product.drive.label;
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/search")) return "Search";
  return "Sektar";
}

function Shell() {
  // Connect wires the theme-change handler in its own skeleton/load screens,
  // which a custom shell replaces: register it here so the light/dark/auto
  // toggles (ours and Connect's settings page) keep working.
  initTheme();
  const [query, setQuery] = useState("");
  const search = useMemo(() => ({ query, setQuery }), [query]);
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  // The product follows the URL; shared pages keep the last one, which is
  // remembered per browser so a reload lands in the same product.
  const [lastProduct, setLastProduct] = useState(rememberedProduct);
  const product = productFor(pathname, lastProduct);
  useEffect(() => {
    if (product.id === lastProduct) return;
    setLastProduct(product.id);
    rememberProduct(product.id);
  }, [product.id, lastProduct]);
  const [drawer, setDrawer] = useState(false);
  useBindDriveApps();
  // Desktop: the menu button collapses the sidebar to the design system's
  // 72px icon rail (and back); the choice is remembered per browser.
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem("sk:sidebar") === "rail";
    } catch {
      return false;
    }
  });
  const toggleMenu = () => {
    if (window.matchMedia("(max-width: 1063px)").matches) {
      setDrawer(true);
      return;
    }
    setRail((v) => {
      try {
        localStorage.setItem("sk:sidebar", v ? "full" : "rail");
      } catch {
        // remembered only when storage is available
      }
      return !v;
    });
  };

  // A navigation closes the drawer; so does Escape, and growing past the
  // phone breakpoint (the grid sidebar is back).
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    const mq = window.matchMedia("(min-width: 1064px)");
    const onSize = () => {
      if (mq.matches) setDrawer(false);
    };
    document.addEventListener("keydown", onKey, true);
    mq.addEventListener("change", onSize);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      mq.removeEventListener("change", onSize);
    };
  }, [drawer]);

  return (
    <SearchContext.Provider value={search}>
      <AssistantChatHolder>
        <div
          className={cx(
            "sk-app sk-shell",
            rail && "sk-shell--rail",
            drawer && "is-drawer-open",
          )}
        >
          <Sprite />
          <Sidebar product={product} />
          <div className="sk-shell__main">
            <TopBar
              title={pageTitle(pathname, product)}
              product={product}
              onMenu={toggleMenu}
            />
            {/* Flush: the content area carries no padding of its own. Routed
                pages (.sk-page) bring the design system's page padding; drive
                apps, Workflow Studio and Connect's settings fill edge to edge. */}
            <main className="sk-shell__content sk-shell__content--flush">
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </main>
          </div>
          <div className="sk-drawer" aria-hidden={!drawer}>
            <div
              className="sk-drawer__scrim"
              onClick={() => setDrawer(false)}
            />
            <Sidebar
              product={product}
              inDrawer
              onNavigate={() => setDrawer(false)}
            />
          </div>
          <UserNamePrompt />
        </div>
      </AssistantChatHolder>
    </SearchContext.Provider>
  );
}

function Sidebar({
  product,
  inDrawer,
  onNavigate,
}: {
  product: Product;
  inDrawer?: boolean;
  /** Drawer: any link (even the current page's) closes it */
  onNavigate?: () => void;
}) {
  // The product's drive by slug; by id when a store still holds two with
  // that slug (see driveFor), by slug until the drives have loaded.
  const drives = useDrives();
  const driveParam = driveFor(drives, product)?.param ?? product.drive.slug;
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  return (
    <aside className="sk-sidebar" aria-label="Main">
      {inDrawer && (
        <Button
          variant="ghost"
          iconOnly
          icon="close"
          className="sk-drawer__close"
          aria-label="Close menu"
          onClick={onNavigate}
        />
      )}
      <div className="sk-sidebar__brand">
        <ProductSwitch product={product} onPick={onNavigate} />
      </div>

      <ul className="sk-nav">
        {product.nav.map((item) => (
          <NavLink
            key={item.to}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
        <li className="sk-nav__group">
          <hr className="sk-divider" style={{ margin: 0 }} />
        </li>
        {(product.beforeDrive ?? []).map((item) => (
          <NavLink
            key={item.to}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
        {product.drive.inSidebar !== false && (
        <li>
          <Link
            to="/d/$driveSlug/{-$nodeSlug}"
            params={{ driveSlug: driveParam }}
            className="sk-nav__item"
            onClick={onNavigate}
            activeProps={{
              className: "sk-nav__item is-active",
              "aria-current": "page",
            }}
          >
            <Icon name="folder" />
            <span className="sk-nav__label">{product.drive.label}</span>
          </Link>
        </li>
        )}
        {(product.afterDrive ?? []).map((item) => (
          <NavLink
            key={item.to}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
        <li>
          <Link
            to="/settings"
            className="sk-nav__item"
            onClick={onNavigate}
            activeProps={{
              className: "sk-nav__item is-active",
              "aria-current": "page",
            }}
          >
            <Icon name="settings" />
            <span className="sk-nav__label">Settings</span>
          </Link>
        </li>
      </ul>

      <div className="sk-sidebar__footer">
        {product.id === "finance" && (
          <PromoCard
            art={{ light: bannerLight, dark: bannerDark }}
            title="Connect a bank"
            action={
              <Link
                to="/finops/transactions"
                search={{ import: "1" }}
                className="sk-btn sk-btn--primary sk-btn--sm"
                onClick={onNavigate}
              >
                Import a feed
              </Link>
            }
          >
            Paste a statement and Sektar sorts and matches it.
          </PromoCard>
        )}
        <UserMenu />
      </div>
    </aside>
  );
}

/** One sidebar entry: a route, active when the URL is that page. */
function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = navMatches(pathname, item.to);
  return (
    <li>
      <Link
        to={item.to}
        className={active ? "sk-nav__item is-active" : "sk-nav__item"}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
      >
        <Icon name={item.icon} />
        <span className="sk-nav__label">{item.label}</span>
      </Link>
    </li>
  );
}

function TopBar({
  title,
  product,
  onMenu,
}: {
  title: string;
  product: Product;
  onMenu: () => void;
}) {
  const [searching, setSearching] = useState(false);
  return (
    <header className={cx("sk-topbar", searching && "is-searching")}>
      <button
        type="button"
        className="sk-btn sk-btn--icon sk-btn--ghost sk-topbar__menu"
        aria-label="Menu"
        title="Show or hide the sidebar"
        onClick={onMenu}
      >
        <Icon name="menu" />
      </button>
      <span className="sk-topbar__title">{title}</span>
      <SearchBar autoFocus={searching} onClose={() => setSearching(false)} />
      <span className="sk-topbar__spacer" />
      <div className="sk-topbar__actions">
        <button
          type="button"
          className="sk-btn sk-btn--icon sk-btn--ghost sk-topbar__search-btn"
          aria-label={searching ? "Close search" : "Search"}
          aria-expanded={searching}
          onClick={() => setSearching((v) => !v)}
        >
          <Icon name={searching ? "close" : "search"} mono={searching} />
        </button>
        {/* Every integration in one line; reads documents, so it may suspend */}
        <Suspense fallback={null}>
          <SyncStatus />
        </Suspense>
        <button
          type="button"
          className="sk-btn sk-btn--ghost sk-btn--icon"
          aria-label="Notifications"
        >
          <Icon name="bell" />
        </button>
        {/* The sidebar (and its footer) is a drawer on small screens, so the
            sign-in / user chip surfaces here too. */}
        <span className="sk-topbar__user">
          <UserMenu />
        </span>
      </div>
    </header>
  );
}

function PageSkeleton() {
  return (
    <div className="sk-page sk-stack sk-stack--6">
      <Skeleton width={240} height={32} />
      <div className="sk-grid sk-grid--4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={96} />
        ))}
      </div>
      <Skeleton height={360} />
    </div>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1>{children}</h1>;
}
