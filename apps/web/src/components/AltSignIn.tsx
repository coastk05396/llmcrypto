import { useId, useRef, useState, type FormEvent } from "react";
import type { PasswordSignupResponse, SessionView } from "@llmcrypto/contracts";
import { keySignIn, passwordRecover, passwordSignIn, passwordSignup, telegramSignIn } from "../lib/api-auth";
import { keySessionCopy, passwordSignInCopy, recoveryCopy, signupCopy, type Copy } from "../lib/auth-copy";
import { CopyBanner } from "./Feedback";
import { RecoveryCodesPanel } from "./RecoveryCodes";
import { TelegramFlow } from "./TelegramFlow";

type Mode = "signin" | "signup" | "recover";

function PasswordPanel({ onDone }: { onDone(s: SessionView): void }) {
  const uid = useId();
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<Copy | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [created, setCreated] = useState<PasswordSignupResponse | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  function fail(c: Copy) {
    setCopy(c);
    requestAnimationFrame(() => alertRef.current?.focus());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setCopy(null);
    setRecovered(false);
    if (mode === "signin") {
      const r = await passwordSignIn({ username: username.trim(), password });
      setBusy(false);
      if (r.ok) { setPassword(""); return onDone(r.data); }
      return fail(passwordSignInCopy(r.error));
    }
    if (mode === "signup") {
      const r = await passwordSignup({ username: username.trim(), password });
      setBusy(false);
      if (r.ok) { setPassword(""); setCreated(r.data); return; }
      return fail(signupCopy(r.error));
    }
    const r = await passwordRecover({ username: username.trim(), recoveryCode: recoveryCode.trim(), newPassword: password });
    setBusy(false);
    if (r.ok) {
      setPassword("");
      setRecoveryCode("");
      setRecovered(true);
      setMode("signin");
      return;
    }
    fail(recoveryCopy(r.error));
  }

  if (created) {
    // The session already exists server side; hold it until the user has stored the codes.
    return (
      <div className="method-panel">
        <h3>Account created</h3>
        <RecoveryCodesPanel codes={created.recovery.recoveryCodes} expiresAt={created.recovery.expiresAt} doneLabel="Continue to console" onDone={() => onDone(created.session)} />
      </div>
    );
  }

  const title = mode === "signin" ? "Password" : mode === "signup" ? "Create an account with a password" : "Recover a password";
  return (
    <div className="method-panel">
      <h3>{title}</h3>
      {recovered && <p className="banner banner--success" role="status"><span className="banner__title">Password changed</span><span>All sessions were ended. Sign in with the new password.</span></p>}
      <form onSubmit={(e) => void submit(e)} noValidate aria-busy={busy} className="form-stack">
        <div ref={alertRef} tabIndex={-1}>{copy && <CopyBanner copy={copy} />}</div>
        <div className="field">
          <label htmlFor={`${uid}-u`}>Username</label>
          <input id={`${uid}-u`} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        {mode === "recover" && (
          <div className="field">
            <label htmlFor={`${uid}-rc`}>Recovery code</label>
            <input id={`${uid}-rc`} type="text" autoComplete="off" spellCheck={false} maxLength={64} required value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor={`${uid}-p`}>{mode === "recover" ? "New password" : "Password"}</label>
          <input id={`${uid}-p`} type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={mode === "signin" ? undefined : `${uid}-ph`} />
          {mode !== "signin" && <p id={`${uid}-ph`} className="small muted">At least 12 characters. Length matters more than symbols.</p>}
        </div>
        <div className="actions">
          <button type="submit" className="btn btn--primary" aria-disabled={busy}>
            {busy ? "Working" : mode === "signin" ? "Sign in with password" : mode === "signup" ? "Create account" : "Set new password"}
          </button>
          {mode === "signin" ? (
            <>
              <button type="button" className="link-button" onClick={() => { setMode("signup"); setCopy(null); }}>Create an account</button>
              <button type="button" className="link-button" onClick={() => { setMode("recover"); setCopy(null); }}>Use a recovery code</button>
            </>
          ) : (
            <button type="button" className="link-button" onClick={() => { setMode("signin"); setCopy(null); }}>Back to sign in</button>
          )}
        </div>
        {mode === "signup" && <p className="small muted">A new account starts with no wallets. You will get single-use recovery codes once; email recovery does not exist.</p>}
      </form>
    </div>
  );
}

function KeyPanel({ onDone }: { onDone(s: SessionView): void }) {
  const uid = useId();
  const [apiKey, setApiKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<Copy | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setCopy(null);
    const r = await keySignIn({ apiKey: apiKey.trim() });
    setBusy(false);
    if (r.ok) { setApiKey(""); return onDone(r.data); }
    setCopy(keySessionCopy(r.error));
  }
  return (
    <div className="method-panel">
      <h3>API key (restricted view)</h3>
      <p className="small muted">Opens a read-only view of that key&apos;s own usage. It cannot show secrets, change security, manage keys, see balance or export. The key needs the usage:read permission; the session lasts at most 8 hours.</p>
      <form onSubmit={(e) => void submit(e)} noValidate aria-busy={busy} className="form-stack">
        {copy && <CopyBanner copy={copy} />}
        <div className="field">
          <label htmlFor={`${uid}-k`}>API key</label>
          <div className="input-row">
            <input id={`${uid}-k`} type={show ? "text" : "password"} autoComplete="off" spellCheck={false} maxLength={256} required value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <button type="button" className="btn btn--secondary btn--small" aria-pressed={show} onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
          </div>
        </div>
        <div className="actions"><button type="submit" className="btn btn--primary" aria-disabled={busy}>{busy ? "Opening" : "Open restricted view"}</button></div>
      </form>
    </div>
  );
}

/** Secondary sign-in methods behind a disclosure; wallets stay primary. */
export function AltSignIn({ onDone }: { onDone(s: SessionView): void }) {
  return (
    <details className="alt-methods">
      <summary>Other ways to sign in</summary>
      <PasswordPanel onDone={onDone} />
      <div className="method-panel">
        <h3>Telegram code</h3>
        <p className="small muted">You will get a one-time code to send to the bot from Telegram. A Telegram account that is new here creates a new account.</p>
        <TelegramFlow purpose="login" verify={telegramSignIn} onDone={onDone} startLabel="Get a Telegram code" verifyLabel="Verify code" />
      </div>
      <KeyPanel onDone={onDone} />
    </details>
  );
}
