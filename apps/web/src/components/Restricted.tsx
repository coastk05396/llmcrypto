import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useSession } from "../lib/session";

/**
 * Wraps pages a restricted (API-key) session cannot use. The API refuses them anyway; this keeps the UI from offering
 * actions that can only fail. The restricted index goes to Usage, the one page that works.
 */
export function FullSessionOnly({ children, index }: { children: ReactNode; index?: boolean }) {
  const { state } = useSession();
  if (state.status === "signed-in" && state.session.restricted) {
    if (index) return <Navigate to="/app/usage" replace />;
    return (
      <div className="page-body console-page">
        <h1 className="page-title">Not available</h1>
        <p className="banner banner--info" role="note" data-testid="restricted-block">
          <span className="banner__title">Restricted session</span>
          <span>This page is not available when you signed in with an API key. Sign out and use a wallet, password or Telegram.</span>
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
