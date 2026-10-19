import { useEffect, useState } from "react";
import { useSession } from "../lib/session";

const WARN_MS = 5 * 60_000;

/**
 * Warns shortly before the session ends and offers POST /api/session/renew. Renewal slides expiry up to an absolute
 * ceiling; at the ceiling the expiry does not move and we say so instead of promising more time.
 */
export function SessionExpiry() {
  const { state, renew } = useSession();
  const [now, setNow] = useState(() => Date.now());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  if (state.status !== "signed-in") return null;
  const left = Date.parse(state.session.expiresAt) - now;
  if (left > WARN_MS && !msg) return null;

  async function extend() {
    if (busy) return;
    setBusy(true);
    const r = await renew();
    setBusy(false);
    setNow(Date.now());
    if (!r.ok) setMsg("Could not extend the session. Sign in again before it ends.");
    else setMsg(r.extended ? "" : "This session is at its maximum length and cannot be extended. Sign in again before it ends.");
  }
  const mins = Math.max(0, Math.ceil(left / 60_000));
  return (
    <div className="banner banner--warning" role="status" data-testid="session-expiry">
      <span className="banner__title">{left <= WARN_MS ? `Your session ends in about ${mins} minute${mins === 1 ? "" : "s"}` : "Session"}</span>
      {msg && <span>{msg}</span>}
      {left <= WARN_MS && <button type="button" className="btn btn--secondary btn--small" aria-disabled={busy} onClick={() => void extend()}>{busy ? "Extending" : "Extend session"}</button>}
    </div>
  );
}
