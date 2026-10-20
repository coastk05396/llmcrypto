import { useId, useState, type FormEvent } from "react";
import { stepUp } from "../lib/api-auth";
import { stepUpCopy, type Copy } from "../lib/auth-copy";
import { useSession } from "../lib/session";
import { CopyBanner } from "./Feedback";
import { TelegramFlow } from "./TelegramFlow";
import { WalletSignIn } from "./WalletLogin";

function PasswordStepUp({ onDone }: { onDone(): void }) {
  const { handleFailure } = useSession();
  const uid = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<Copy | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setCopy(null);
    const r = await stepUp({ password });
    setBusy(false);
    if (r.ok) { setPassword(""); return onDone(); }
    if (handleFailure(r.error)) return;
    setCopy(stepUpCopy(r.error));
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="form-stack" aria-busy={busy}>
      {copy && <CopyBanner copy={copy} />}
      <div className="field">
        <label htmlFor={`${uid}-pw`}>Confirm your password</label>
        <input id={`${uid}-pw`} type="password" autoComplete="current-password" maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="actions"><button type="submit" className="btn btn--primary" aria-disabled={busy}>{busy ? "Verifying" : "Verify"}</button></div>
    </form>
  );
}

/**
 * Re-proves the method this session was created with, after the API answered 403 STEP_UP_REQUIRED.
 * Wallet sessions sign in again (the new session replaces this one); password and Telegram sessions use POST /api/session/step-up.
 * The caller keeps its form state and retries after onDone.
 */
export function StepUpPanel({ onDone }: { onDone(): void }) {
  const { state, setSession } = useSession();
  const kind = state.status === "signed-in" ? state.session.sessionKind : "wallet";
  return (
    <div className="form-stack" data-testid="step-up">
      <p><strong>Verify it is you.</strong> This change needs a recent sign-in. Your entries are kept; verify, then repeat the action.</p>
      {kind === "password" && <PasswordStepUp onDone={onDone} />}
      {kind === "telegram" && <TelegramFlow purpose="step_up" verify={(codeId) => stepUp({ codeId })} onDone={onDone} startLabel="Get a Telegram code" verifyLabel="Verify code" />}
      {kind === "wallet" && <WalletSignIn onDone={(s) => { setSession(s); onDone(); }} />}
      {kind === "api_key" && <p className="banner banner--warning">An API-key session cannot make this change. Sign in with a wallet, password or Telegram.</p>}
    </div>
  );
}
