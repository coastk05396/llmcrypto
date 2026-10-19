import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { AltSignIn } from "../components/AltSignIn";
import { WalletSignIn } from "../components/WalletLogin";
import { describeFailure } from "../lib/api";
import { useSession } from "../lib/session";

/** Rendered by the console gate whenever there is no usable session, at the path the visitor asked for. */
export function SignIn() {
  const { state, setSession, recheck } = useSession();
  const { pathname } = useLocation();
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (state.status === "signed-out" && state.reason === "expired") h1.current?.focus(); }, [state]);

  return (
    <div className="container page-body">
      <p className="eyebrow">Console</p>
      <h1 className="page-title" ref={h1} tabIndex={-1}>Sign in</h1>

      <div className="split split--even">
        <div>
          <p className="lead">Signing a wallet challenge proves you control an address. It does not send funds.</p>
          <p className="muted">EVM and TRON wallets are separate accounts until you explicitly link them from Security. Password, Telegram code and API key are under other ways to sign in.</p>
        </div>

        <div>
          {state.status === "checking" && (
            <p className="banner banner--info" role="status"><span className="banner__title">Checking session</span><span>Asking the API whether you are signed in.</span></p>
          )}
          {state.status === "unreachable" && (
            <div className="banner banner--danger" role="alert">
              <span className="banner__title">API unavailable</span>
              <span>{describeFailure(state.failure)} You cannot sign in right now, and no account data can be shown.</span>
              <button type="button" className="btn btn--secondary btn--small" onClick={recheck}>Retry</button>
            </div>
          )}
          {state.status === "signed-out" && state.reason === "expired" && (
            <p className="banner banner--warning" role="status"><span className="banner__title">Your session expired</span><span>Sign in again to continue.</span></p>
          )}
          {state.status === "signed-out" && state.reason === "none" && pathname !== "/app" && (
            <p className="banner banner--info" role="status"><span className="banner__title">Sign in to view this page</span><span>You will return here after signing in.</span></p>
          )}
          {state.status === "signed-out" && state.reason === "signed-out" && (
            <p className="banner banner--success" role="status"><span className="banner__title">Signed out</span><span>Your session was ended.</span></p>
          )}
          {state.status === "signed-out" && state.reason === "method-removed" && (
            <p className="banner banner--warning" role="status"><span className="banner__title">You were signed out</span><span>You removed the sign-in method this session used, so the server ended it. Sign in with another method.</span></p>
          )}
          {(state.status === "signed-out" || state.status === "unreachable") && (
            <>
              <WalletSignIn onDone={setSession} />
              <AltSignIn onDone={setSession} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
