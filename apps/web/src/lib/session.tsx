import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionView } from "@llmcrypto/contracts";
import { deleteSession, getSession, type ApiFailure } from "./api";
import { renewSession } from "./api-auth";

export type SessionState =
  | { status: "checking" }
  | { status: "unreachable"; failure: ApiFailure }
  | { status: "signed-out"; reason: "none" | "expired" | "signed-out" | "method-removed" }
  | { status: "signed-in"; session: SessionView };

interface Ctx {
  state: SessionState;
  /** Called after a successful sign-in. */
  setSession(s: SessionView): void;
  /** Feed any API failure through this: a 401 flips to the sign-in screen with an "expired" notice. Returns true if handled. */
  handleFailure(f: ApiFailure): boolean;
  signOut(): Promise<boolean>;
  recheck(): void;
  /**
   * Extends the session (POST /api/session/renew). `extended` is false when the server did not move the expiry later (absolute ceiling);
   * the caller says so instead of pretending. A 401 flips to sign-in through handleFailure.
   */
  renew(): Promise<{ ok: true; extended: boolean } | { ok: false; failure: ApiFailure }>;
  /**
   * Call after removing a sign-in method: the server revokes every session made with it, possibly this one.
   * Re-reads the session and, when it is gone, shows the sign-in screen with an explanation. Returns true if still signed in.
   */
  confirmStillSignedIn(): Promise<boolean>;
}
const SessionContext = createContext<Ctx | null>(null);

export function useSession(): Ctx {
  const c = useContext(SessionContext);
  if (!c) throw new Error("SessionProvider missing");
  return c;
}

/** Session truth comes only from GET /api/session. Nothing about it is persisted in browser storage. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "checking" });
  const wasSignedIn = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const recheck = useCallback(() => {
    setState({ status: "checking" });
    void getSession().then((r) => {
      if (!r.ok) setState({ status: "unreachable", failure: r.error });
      else if (r.data) {
        wasSignedIn.current = true;
        setState({ status: "signed-in", session: r.data });
      } else setState({ status: "signed-out", reason: "none" });
    });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void getSession(ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      if (!r.ok) setState({ status: "unreachable", failure: r.error });
      else if (r.data) {
        wasSignedIn.current = true;
        setState({ status: "signed-in", session: r.data });
      } else setState({ status: "signed-out", reason: "none" });
    });
    return () => ac.abort();
  }, []);

  // Local expiry timer: when the server-stated expiry passes, fall back to a usable sign-in screen.
  const expiresAt = state.status === "signed-in" ? state.session.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const ms = Date.parse(expiresAt) - Date.now();
    if (ms > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => setState({ status: "signed-out", reason: "expired" }), Math.max(0, ms));
    return () => window.clearTimeout(t);
  }, [expiresAt]);

  const handleFailure = useCallback((f: ApiFailure): boolean => {
    if (f.kind === "http" && f.status === 401) {
      setState({ status: "signed-out", reason: wasSignedIn.current ? "expired" : "none" });
      return true;
    }
    return false;
  }, []);

  const setSession = useCallback((s: SessionView) => {
    wasSignedIn.current = true;
    setState({ status: "signed-in", session: s });
  }, []);

  const signOut = useCallback(async () => {
    const r = await deleteSession();
    if (r.ok || (r.error.kind === "http" && r.error.status === 401)) {
      wasSignedIn.current = false;
      setState({ status: "signed-out", reason: "signed-out" });
      return true;
    }
    return false;
  }, []);

  const renew = useCallback(async () => {
    const before = stateRef.current.status === "signed-in" ? Date.parse(stateRef.current.session.expiresAt) : 0;
    const r = await renewSession();
    if (!r.ok) {
      handleFailure(r.error);
      return { ok: false as const, failure: r.error };
    }
    wasSignedIn.current = true;
    setState({ status: "signed-in", session: r.data });
    return { ok: true as const, extended: Date.parse(r.data.expiresAt) > before };
  }, [handleFailure]);

  const confirmStillSignedIn = useCallback(async () => {
    const r = await getSession();
    if (r.ok && r.data) {
      setState({ status: "signed-in", session: r.data });
      return true;
    }
    if (r.ok) {
      wasSignedIn.current = false;
      setState({ status: "signed-out", reason: "method-removed" });
      return false;
    }
    return true; // could not tell: keep the current view; the next API call will reveal a revoked session
  }, []);

  const value = useMemo(
    () => ({ state, setSession, handleFailure, signOut, recheck, renew, confirmStillSignedIn }),
    [state, setSession, handleFailure, signOut, recheck, renew, confirmStillSignedIn],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
