import { useId, useRef, useState, type FormEvent } from "react";
import type { AuthMethods, LinkedIdentity, TelegramIdentity } from "@llmcrypto/contracts";
import { CopyBanner, LoadError, Skeleton, StatusLine } from "../components/Feedback";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/Modal";
import { RecoveryCodesPanel } from "../components/RecoveryCodes";
import { StepUpPanel } from "../components/StepUpPanel";
import { TelegramFlow } from "../components/TelegramFlow";
import { WalletLink } from "../components/WalletLogin";
import { unlinkIdentity } from "../lib/api";
import { addPassword, linkTelegram, listAuthMethods, regenerateRecoveryCodes, removePassword, unlinkTelegram } from "../lib/api-auth";
import { isStepUpRequired, removeMethodCopy, signupCopy, type Copy } from "../lib/auth-copy";
import { protocolLabel } from "../lib/identities";
import { useSession } from "../lib/session";
import { useLoad } from "../lib/use-load";

type Target =
  | { kind: "wallet"; item: LinkedIdentity }
  | { kind: "telegram"; item: TelegramIdentity }
  | { kind: "password"; item: { username: string } };

const targetCopy = (t: Target) =>
  t.kind === "wallet"
    ? { title: "Remove this wallet?", what: `The ${protocolLabel(t.item)} wallet`, body: <>Remove the {protocolLabel(t.item)} wallet <code>{t.item.address}</code> from your sign-in methods. You will no longer be able to sign in with it.</>, action: "Remove wallet", done: `${protocolLabel(t.item)} wallet removed` }
    : t.kind === "telegram"
      ? { title: "Remove this Telegram account?", what: "This Telegram account", body: <>Remove Telegram account <code>{t.item.telegramUserId}</code> from your sign-in methods.</>, action: "Remove Telegram", done: "Telegram account removed" }
      : { title: "Remove the password?", what: "The password", body: <>Remove the password for <code>{t.item.username}</code>. Its recovery codes stop working.</>, action: "Remove password", done: "Password removed" };

function RemoveDialog({ target, onClose, onDone }: { target: Target | null; onClose(): void; onDone(msg: string): void }) {
  const { handleFailure, confirmStillSignedIn } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ copy: Copy; stepUp: boolean } | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    setErr(null);
    const r = target.kind === "wallet" ? await unlinkIdentity(target.item.id) : target.kind === "telegram" ? await unlinkTelegram(target.item.id) : await removePassword();
    setBusy(false);
    const copy = targetCopy(target);
    if (r.ok) {
      // Removing a method ends every session made with it, possibly this one.
      if (await confirmStillSignedIn()) onDone(copy.done);
      return;
    }
    if (handleFailure(r.error)) return;
    const c = removeMethodCopy(r.error, copy.what);
    if (r.error.kind === "http" && r.error.code === "NOT_FOUND") return onDone(c.body);
    setErr({ copy: c, stepUp: isStepUpRequired(r.error) });
  }

  const t = target ? targetCopy(target) : null;
  return (
    <Modal open={target !== null} title={t?.title ?? "Remove"} onRequestClose={() => { if (!busy) { setErr(null); onClose(); } }} initialFocus={cancel}>
      {target && t && (
        <div className="form-stack">
          <p>{t.body}</p>
          <p className="small muted">Sessions started with this method end immediately, including this one if you signed in with it.</p>
          {err && <CopyBanner copy={err.copy}>{err.stepUp && <StepUpPanel onDone={() => setErr(null)} />}</CopyBanner>}
          <div className="actions">
            <button ref={cancel} type="button" className="btn btn--secondary" disabled={busy} onClick={() => { setErr(null); onClose(); }}>Cancel</button>
            <button type="button" className="btn btn--danger" aria-disabled={busy} onClick={() => void confirm()}>{busy ? "Removing" : t.action}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AddPassword({ onAdded }: { onAdded(codes: { recoveryCodes: string[]; expiresAt: string }): void }) {
  const uid = useId();
  const { handleFailure } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<Copy | null>(null);
  const [stepUp, setStepUp] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setCopy(null);
    setStepUp(false);
    const r = await addPassword({ username: username.trim(), password });
    setBusy(false);
    if (r.ok) { setPassword(""); return onAdded(r.data); }
    if (handleFailure(r.error)) return;
    if (isStepUpRequired(r.error)) { setStepUp(true); return; }
    setCopy(signupCopy(r.error));
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="form-stack" aria-busy={busy}>
      {copy && <CopyBanner copy={copy} />}
      <div className="field">
        <label htmlFor={`${uid}-u`}>Username</label>
        <input id={`${uid}-u`} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-p`}>Password</label>
        <input id={`${uid}-p`} type="password" autoComplete="new-password" maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={`${uid}-h`} />
        <p id={`${uid}-h`} className="small muted">At least 12 characters. You will get single-use recovery codes, shown once.</p>
      </div>
      <div className="actions"><button type="submit" className="btn btn--primary" aria-disabled={busy}>{busy ? "Adding" : "Set password"}</button></div>
      {stepUp && <div className="banner banner--warning" role="alert"><span className="banner__title">Verify it is you first</span><StepUpPanel onDone={() => setStepUp(false)} /></div>}
    </form>
  );
}

export function Security() {
  const { state, renew } = useSession();
  const [methods, reload] = useLoad(listAuthMethods);
  const [removing, setRemoving] = useState<Target | null>(null);
  const [notice, setNotice] = useState("");
  const [codes, setCodes] = useState<{ recoveryCodes: string[]; expiresAt: string } | null>(null);
  const [regenStepUp, setRegenStepUp] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<Copy | null>(null);
  const [tgStepUp, setTgStepUp] = useState(false);

  const m: AuthMethods | null = methods.status === "ready" ? methods.data : null;
  const total = m ? m.wallets.length + m.telegram.length + (m.password ? 1 : 0) : 0;
  const onlyOne = m !== null && total === 1;
  const session = state.status === "signed-in" ? state.session : null;

  async function regenerate() {
    if (regenBusy) return;
    setRegenBusy(true);
    setRegenError(null);
    setRegenStepUp(false);
    const r = await regenerateRecoveryCodes();
    setRegenBusy(false);
    if (r.ok) { setCodes(r.data); reload(); return; }
    if (isStepUpRequired(r.error)) return setRegenStepUp(true);
    setRegenError(removeMethodCopy(r.error, "Recovery codes"));
  }

  const lastBlock = (label: string) => ({
    "aria-disabled": onlyOne,
    "aria-describedby": onlyOne ? "last-method" : undefined,
    "aria-label": label,
  });

  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">Security</h1>
      <p className="muted lead">Ways to sign in to this account: wallets, a password and Telegram. Adding a method needs proof from that method; accounts are never merged automatically.</p>

      <StatusLine>{notice}</StatusLine>

      <section aria-labelledby="linked-head">
        <h2 id="linked-head" className="section-title">Sign-in methods</h2>
        {methods.status === "loading" && <Skeleton label="Loading sign-in methods" />}
        {methods.status === "error" && <LoadError what="sign-in methods" failure={methods.failure} onRetry={reload} />}
        {m && total === 0 && <div className="empty"><h3>No sign-in methods</h3><p className="muted">Add one below.</p></div>}
        {m && m.wallets.length > 0 && (
          <ul className="key-list" aria-label="Linked wallets">
            {m.wallets.map((i) => (
              <li key={i.id} className="key-row">
                <div className="key-row__main"><h3 className="key-row__name">{protocolLabel(i)} wallet</h3></div>
                <dl className="key-row__facts">
                  <div><dt>Address</dt><dd><code>{i.address}</code> <CopyButton text={i.address} what={`${protocolLabel(i)} address`} /></dd></div>
                  <div><dt>Network policy</dt><dd><code>{i.chainPolicy}</code></dd></div>
                  <div><dt>Linked</dt><dd>{new Date(i.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                </dl>
                <div className="key-row__actions">
                  <button type="button" className="btn btn--secondary btn--small" {...lastBlock(`Remove ${protocolLabel(i)} wallet ${i.address}`)} onClick={() => { if (!onlyOne) setRemoving({ kind: "wallet", item: i }); }}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {m && m.telegram.length > 0 && (
          <ul className="key-list" aria-label="Linked Telegram accounts">
            {m.telegram.map((i) => (
              <li key={i.id} className="key-row">
                <div className="key-row__main"><h3 className="key-row__name">Telegram account</h3></div>
                <dl className="key-row__facts">
                  <div><dt>Telegram user ID</dt><dd><code>{i.telegramUserId}</code></dd></div>
                  <div><dt>Linked</dt><dd>{new Date(i.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                </dl>
                <div className="key-row__actions">
                  <button type="button" className="btn btn--secondary btn--small" {...lastBlock(`Remove Telegram account ${i.telegramUserId}`)} onClick={() => { if (!onlyOne) setRemoving({ kind: "telegram", item: i }); }}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {m?.password && (
          <ul className="key-list" aria-label="Password">
            <li className="key-row">
              <div className="key-row__main"><h3 className="key-row__name">Password</h3></div>
              <dl className="key-row__facts">
                <div><dt>Username</dt><dd><code>{m.password.username}</code></dd></div>
                <div><dt>Unused recovery codes</dt><dd data-testid="unused-codes">{m.password.unusedRecoveryCodes}</dd></div>
              </dl>
              <div className="key-row__actions">
                <button type="button" className="btn btn--secondary btn--small" aria-disabled={regenBusy} onClick={() => void regenerate()}>{regenBusy ? "Making codes" : "New recovery codes"}</button>
                <button type="button" className="btn btn--secondary btn--small" {...lastBlock("Remove password")} onClick={() => { if (!onlyOne) setRemoving({ kind: "password", item: m.password! }); }}>Remove</button>
              </div>
            </li>
          </ul>
        )}
        {regenError && <CopyBanner copy={regenError} />}
        {regenStepUp && <div className="banner banner--warning" role="alert"><span className="banner__title">Verify it is you first</span><StepUpPanel onDone={() => setRegenStepUp(false)} /></div>}
        {onlyOne && <p id="last-method" className="banner banner--info"><span className="banner__title">Only sign-in method</span><span>You cannot remove your only sign-in method. Add another first.</span></p>}
      </section>

      {m && !m.password && (
        <section aria-labelledby="pw-head" className="section--ruled">
          <h2 id="pw-head" className="section-title">Add a password</h2>
          <p className="muted">Lets you sign in without a wallet. Recovery codes are the only way back if you forget it: email recovery does not exist.</p>
          <AddPassword onAdded={(c) => { setCodes(c); reload(); }} />
        </section>
      )}

      <section aria-labelledby="tg-head" className="section--ruled">
        <h2 id="tg-head" className="section-title">Link Telegram</h2>
        <p className="muted">Get a one-time code, send it to the bot from your Telegram account, then verify. If that Telegram account already belongs to another account it is refused; accounts are never merged.</p>
        <TelegramFlow
          purpose="link"
          verify={linkTelegram}
          onDone={() => { setNotice("Telegram account linked"); reload(); }}
          startLabel="Get a Telegram code"
          verifyLabel="Verify and link"
          onStepUp={() => setTgStepUp(true)}
        />
        {tgStepUp && <div className="banner banner--warning" role="alert"><span className="banner__title">Verify it is you first</span><StepUpPanel onDone={() => setTgStepUp(false)} /></div>}
      </section>

      <section aria-labelledby="link-head" className="section--ruled">
        <h2 id="link-head" className="section-title">Link another wallet</h2>
        <p className="muted">Your wallet will ask you to sign a message that links it to this account. It does not send funds. If the wallet already belongs to another account the link is refused.</p>
        <WalletLink onDone={(i) => { setNotice(`${protocolLabel(i)} wallet linked`); reload(); }} />
      </section>

      {session && (
        <section aria-labelledby="sess-head" className="section--ruled">
          <h2 id="sess-head" className="section-title">This session</h2>
          <dl className="facts facts--grid">
            <div><dt>Signed in with</dt><dd data-testid="session-kind">{session.sessionKind}</dd></div>
            <div><dt>Expires</dt><dd><time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></dd></div>
          </dl>
          <div className="actions">
            <button type="button" className="btn btn--secondary" onClick={() => void renew().then((r) => setNotice(r.ok ? (r.extended ? "Session extended" : "The session is already at its maximum length; sign in again before it ends") : "Could not extend the session"))}>Extend session</button>
          </div>
        </section>
      )}

      <Modal open={codes !== null} title="Your recovery codes" onRequestClose={() => { /* must confirm storage with the checkbox */ }}>
        {codes && <RecoveryCodesPanel codes={codes.recoveryCodes} expiresAt={codes.expiresAt} onDone={() => { setCodes(null); setNotice("Recovery codes saved"); }} />}
      </Modal>
      <RemoveDialog target={removing} onClose={() => setRemoving(null)} onDone={(msg) => { setRemoving(null); setNotice(msg); reload(); }} />
    </div>
  );
}
