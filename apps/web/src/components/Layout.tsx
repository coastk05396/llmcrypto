import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { ThemeControl } from "./Theme";
import { BookIcon, ChartIcon, CloseIcon, HomeIcon, MenuIcon, UserIcon, WrenchIcon } from "./Icons";

const TITLES: Record<string, string> = {
  "/": "LLM Gateway",
  "/setup": "Setup guides | LLM Gateway",
  "/diag": "Usage comparison | LLM Gateway",
  "/docs": "API docs | LLM Gateway",
  "/app": "Sign in | LLM Gateway",
};

interface NavItem {
  label: string;
  to: string;
  hash?: string;
}
const SECTION_LINKS: NavItem[] = [
  { label: "Models", to: "/", hash: "#catalog" },
  { label: "Quickstart", to: "/", hash: "#quickstart" },
  { label: "Billing", to: "/", hash: "#billing" },
  { label: "FAQ", to: "/", hash: "#faq" },
];
const PAGE_LINKS: NavItem[] = [
  { label: "Setup", to: "/setup" },
  { label: "Diagnostics", to: "/diag" },
  { label: "Docs", to: "/docs" },
];

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Title, focus and hash-scroll handling for client-side navigation. */
function RouteEffects() {
  const { pathname, hash } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    document.title = TITLES[pathname] ?? (pathname.startsWith("/app/") ? TITLES["/app"]! : "Page not found | LLM Gateway");
    if (hash) {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el) {
        el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        if (!first.current) el.focus({ preventScroll: true });
        first.current = false;
        return;
      }
    }
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname, hash]);
  return null;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
}

function Header({ menuOpen, setMenuOpen, menuButton }: { menuOpen: boolean; setMenuOpen: (v: boolean) => void; menuButton: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link to="/" className="wordmark" aria-label="LLM Gateway, home">
          <span className="wordmark__mark" aria-hidden="true">LG</span>
          <span>LLM Gateway</span>
        </Link>
        <nav className="site-nav" aria-label="Primary">
          <ul>
            {SECTION_LINKS.map((l) => (
              <li key={l.label}><Link to={{ pathname: l.to, hash: l.hash ?? "" }}>{l.label}</Link></li>
            ))}
            {PAGE_LINKS.map((l) => (
              <li key={l.label}><NavLink to={l.to}>{l.label}</NavLink></li>
            ))}
          </ul>
        </nav>
        <div className="site-header__tools">
          <div className="only-wide"><ThemeControl compact /></div>
          <NavLink to="/app" className="btn btn--primary btn--small only-wide">Sign in</NavLink>
          <button
            ref={menuButton}
            type="button"
            className="btn btn--secondary btn--small menu-btn"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
            <span>{menuOpen ? "Close" : "Menu"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function MobileMenu({ onClose, menuButton }: { onClose: () => void; menuButton: React.RefObject<HTMLButtonElement | null> }) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current || !menuButton.current) return;
      const list = [menuButton.current, ...focusables(panel.current)];
      const first = list[0] as HTMLElement;
      const last = list[list.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === heading.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, menuButton]);

  return (
    <div id="mobile-menu" ref={panel} className="mobile-menu" role="dialog" aria-modal="true" aria-labelledby="mobile-menu-title">
      <h2 id="mobile-menu-title" ref={heading} tabIndex={-1} className="mobile-menu__title">Menu</h2>
      <nav aria-label="Menu">
        <ul className="mobile-menu__list">
          {[...SECTION_LINKS, ...PAGE_LINKS, { label: "Sign in", to: "/app" }].map((l) => (
            <li key={l.label}>
              <Link to={{ pathname: l.to, hash: l.hash ?? "" }} onClick={onClose}>{l.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mobile-menu__theme">
        <p className="eyebrow">Theme</p>
        <ThemeControl />
      </div>
    </div>
  );
}

function BottomNav() {
  const items = [
    { to: "/", label: "Home", icon: <HomeIcon />, end: true },
    { to: "/setup", label: "Setup", icon: <WrenchIcon /> },
    { to: "/diag", label: "Diagnostics", icon: <ChartIcon /> },
    { to: "/docs", label: "Docs", icon: <BookIcon /> },
    { to: "/app", label: "Sign in", icon: <UserIcon /> },
  ];
  return (
    <nav className="bottom-nav" aria-label="Quick navigation">
      <ul>
        {items.map((i) => (
          <li key={i.to}>
            <NavLink to={i.to} end={i.end ?? false}>{i.icon}<span>{i.label}</span></NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__grid">
        <div>
          <p className="wordmark wordmark--static"><span className="wordmark__mark" aria-hidden="true">LG</span><span>LLM Gateway</span></p>
          <p className="muted">Pre-release. The product name is a placeholder. Account, billing and gateway features are under development and are not yet available.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="footer-links">
            <li><Link to={{ pathname: "/", hash: "#catalog" }}>Models</Link></li>
            <li><Link to="/setup">Setup guides</Link></li>
            <li><Link to="/diag">Usage comparison</Link></li>
            <li><Link to="/docs">API docs</Link></li>
            <li><Link to="/app">Sign in</Link></li>
          </ul>
        </nav>
        <div>
          <p className="eyebrow">Theme</p>
          <ThemeControl />
        </div>
      </div>
    </footer>
  );
}

export function Layout() {
  return <PublicChrome><Outlet /></PublicChrome>;
}

/** Public header, menu, footer and bottom navigation around arbitrary content (also used for the signed-out console). */
export function PublicChrome({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { pathname, hash } = useLocation();

  const close = useCallback(() => {
    setMenuOpen(false);
    menuButton.current?.focus();
  }, []);

  // Navigating closes the menu without stealing focus from the new page.
  useEffect(() => setMenuOpen(false), [pathname, hash]);

  useEffect(() => {
    document.documentElement.classList.toggle("menu-open", menuOpen);
    return () => document.documentElement.classList.remove("menu-open");
  }, [menuOpen]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 64rem)");
    const onChange = () => mql.matches && setMenuOpen(false);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <Header menuOpen={menuOpen} setMenuOpen={(v) => (v ? setMenuOpen(true) : close())} menuButton={menuButton} />
      {menuOpen && <MobileMenu onClose={close} menuButton={menuButton} />}
      <div className="page" inert={menuOpen}>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <Footer />
      </div>
      <div inert={menuOpen}><BottomNav /></div>
      <RouteEffects />
    </>
  );
}
