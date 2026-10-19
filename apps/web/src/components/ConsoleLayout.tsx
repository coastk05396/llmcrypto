import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { getFeatures, getOperatorSession } from "../lib/api-tools";
import { SessionProvider, useSession } from "../lib/session";
import { useLoad } from "../lib/use-load";
import { SignIn } from "../pages/SignIn";
import { ChartIcon, GridIcon, KeyIcon, ListIcon, MoreIcon, ShieldIcon, WalletIcon } from "./Icons";
import { SessionExpiry } from "./SessionExpiry";
import { PublicChrome } from "./Layout";
import { ThemeControl } from "./Theme";

interface NavItem { to: string; label: string; icon: ReactNode; end: boolean; bottom: boolean }
const NAV: NavItem[] = [
  { to: "/app", label: "Overview", icon: <GridIcon />, end: true, bottom: true },
  { to: "/app/usage", label: "Usage", icon: <ListIcon />, end: true, bottom: true },
  { to: "/app/usage/agent-runs", label: "Agent runs", icon: <ChartIcon />, end: false, bottom: false },
  { to: "/app/credits", label: "Credits", icon: <WalletIcon />, end: false, bottom: true },
  { to: "/app/keys", label: "API keys", icon: <KeyIcon />, end: false, bottom: true },
  { to: "/app/security", label: "Security", icon: <ShieldIcon />, end: false, bottom: false },
];
/** Advanced and optional features sit one level deeper (collapsed "More" group; "More" page at narrow widths). */
export const MORE_NAV: { to: string; label: string; blurb: string }[] = [
  { to: "/app/security", label: "Security", blurb: "Sign-in methods, password, recovery codes, session." },
  { to: "/app/usage/agent-runs", label: "Agent runs", blurb: "Requests grouped by run." },
  { to: "/app/tuning", label: "Tuning", blurb: "Opt-in controls: cache accounting, route comparison, LoopGuard." },
  { to: "/app/context", label: "Context steering", blurb: "Opt-in guidance and project context added to requests." },
  { to: "/app/memory", label: "Project memory", blurb: "Notes you choose to store per project." },
  { to: "/app/repository", label: "Repository graph", blurb: "Beta archive import and source evidence." },
  { to: "/app/design", label: "Design", blurb: "Beta metered proposals and revisions." },
  { to: "/app/operations", label: "Operations", blurb: "Separate operator grant and session elevation required." },
  { to: "/app/connectivity", label: "Connectivity", blurb: "Telegram and WhatsApp alerts." },
  { to: "/app/audit", label: "Audit log", blurb: "Who changed what on this account, including operator actions." },
];

/**
 * The More entries this deployment and user can actually use. Beta areas appear only when GET /api/features says so, and
 * Operations only for an operator grant; while that is unknown (or the call fails) they stay hidden, never greyed out.
 */
export function useMoreNav(): typeof MORE_NAV {
  const [flags] = useLoad(getFeatures);
  const [op] = useLoad(getOperatorSession);
  const f = flags.status === "ready" ? flags.data : null;
  const isOperator = op.status === "ready" && op.data.isOperator;
  return MORE_NAV.filter((i) =>
    i.to === "/app/repository" ? f?.repositoryGraph === true : i.to === "/app/design" ? f?.designBeta === true : i.to === "/app/operations" ? isOperator : true);
}
const RESTRICTED_NAV: NavItem[] = [
  { to: "/app/usage", label: "Usage", icon: <ListIcon />, end: true, bottom: true },
  { to: "/app/usage/agent-runs", label: "Agent runs", icon: <ChartIcon />, end: false, bottom: true },
];
const MORE_ROUTES = ["/app/audit", "/app/repository", "/app/design", "/app/operations", "/app/tuning", "/app/context", "/app/memory", "/app/connectivity"];

const TITLES: Record<string, string> = {
  "/app/repository": "Repository graph", "/app/design": "Design", "/app/operations": "Operations",
  "/app": "Overview", "/app/keys": "API keys", "/app/security": "Security", "/app/usage": "Usage and logs",
  "/app/usage/agent-runs": "Agent runs", "/app/credits": "Credits", "/app/tuning": "Tuning", "/app/context": "Context steering",
  "/app/memory": "Project memory", "/app/audit": "Audit log", "/app/connectivity": "Connectivity", "/app/more": "More",
};

function accountLabel(name: string | null, id: string): string {
  return name ?? (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);
}

function ConsoleShell() {
  const { state, signOut } = useSession();
  const { pathname } = useLocation();
  const [signOutError, setSignOutError] = useState(false);

  useEffect(() => {
    document.title = `${TITLES[pathname] ?? (pathname.startsWith("/app/usage/") ? "Request detail" : "Console")} | LLM Gateway`;
    window.scrollTo(0, 0);
    const h1 = document.querySelector<HTMLElement>("#main h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }, [pathname]);

  if (state.status !== "signed-in") return null;
  const { account } = state.session;
  const label = accountLabel(account.name, account.id);
  const restricted = state.session.restricted;
  const moreNav = useMoreNav();
  const nav = restricted ? RESTRICTED_NAV : NAV;
  const bottom = restricted ? RESTRICTED_NAV : [...NAV.filter((i) => i.bottom), { to: "/app/more", label: "More", icon: <MoreIcon />, end: false, bottom: true }];
  const inMore = MORE_ROUTES.some((r) => pathname.startsWith(r));

  async function onSignOut() {
    setSignOutError(false);
    if (!(await signOut())) setSignOutError(true);
  }

  return (
    <div className="console">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="console__bar">
        <Link to="/" className="wordmark" aria-label="LLM Gateway, home">
          <span className="wordmark__mark" aria-hidden="true">LG</span>
          <span className="console__wordmark-text">LLM Gateway</span>
        </Link>
        <div className="console__bar-tools">
          <ThemeControl compact />
          <button type="button" className="btn btn--secondary btn--small only-narrow" onClick={() => void onSignOut()}>Sign out</button>
        </div>
      </header>
      <aside className="console__rail">
        <nav aria-label="Console">
          <ul>
            {nav.map((i) => (
              <li key={i.to}><NavLink to={i.to} end={i.end}>{i.icon}<span>{i.label}</span></NavLink></li>
            ))}
          </ul>
          {!restricted && (
            <details className="more-group" open={inMore}>
              <summary>More</summary>
              <ul>
                {moreNav.filter((i) => MORE_ROUTES.includes(i.to)).map((i) => (
                  <li key={i.to}><NavLink to={i.to} end={false}><span>{i.label}</span></NavLink></li>
                ))}
              </ul>
            </details>
          )}
        </nav>
        <div className="console__account">
          <p className="eyebrow">Account</p>
          <p className="console__account-name" title={account.id}><code>{label}</code></p>
          <p className="small muted">{restricted ? "API key (restricted)" : state.session.membership.role}</p>
          <button type="button" className="btn btn--secondary btn--small" onClick={() => void onSignOut()}>Sign out</button>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="console__main">
        {restricted && (
          <p className="banner banner--info restricted-bar" role="note" data-testid="restricted-banner">
            <span className="banner__title">Restricted session (API key)</span>
            <span>You can read this key&apos;s own usage. Balance, keys, security, memory, tuning, connectivity and exports are not available in this session. Sign in with a wallet, password or Telegram for those.</span>
          </p>
        )}
        <SessionExpiry />
        {signOutError && <p className="banner banner--danger" role="alert"><span className="banner__title">Could not sign out</span><span>The API did not confirm. Try again.</span></p>}
        <Outlet />
      </main>
      <nav className="bottom-nav bottom-nav--console" aria-label="Console">
        <ul>
          {bottom.map((i) => (
            <li key={i.to}><NavLink to={i.to} end={i.end}>{i.icon}<span>{i.label}</span></NavLink></li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Gate() {
  const { state } = useSession();
  if (state.status === "signed-in") return <ConsoleShell />;
  return <PublicChrome><SignIn /></PublicChrome>;
}

export function ConsoleLayout() {
  return <SessionProvider><Gate /></SessionProvider>;
}
