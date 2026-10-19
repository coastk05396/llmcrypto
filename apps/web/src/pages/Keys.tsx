import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ApiKey, KeyScope } from "@llmcrypto/contracts";
import { useCatalog } from "../components/CatalogProvider";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/Modal";
import { Badge } from "../components/StatusBadge";
import { WalletSignIn } from "../components/WalletLogin";
import { createKey, describeFailure, listKeys, revokeKey } from "../lib/api";
import {
  AttemptKeys, SCOPE_LABELS, describeCreateFailure, formatUsdDisplay, keyStatus, validateKeyForm,
  type FormIssue, type KeyErrorView, type KeyFormValues,
} from "../lib/keys";
import { useSession } from "../lib/session";
import { useLoad } from "../lib/use-load";

const SCOPES: KeyScope[] = ["gateway:invoke", "usage:read"];
const EMPTY_FORM: KeyFormValues = { name: "", scopes: ["gateway:invoke"], models: [], spendCapUsd: "", expiresOn: "" };

const when = (iso: string | null, none: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : none);

function StatusBadge({ k }: { k: ApiKey }) {
  const s = keyStatus(k, new Date());
  return s === "active" ? <Badge tone="success">Active</Badge> : s === "revoked" ? <Badge tone="danger">Revoked</Badge> : <Badge tone="warning">Expired</Badge>;
}

type Reveal =
  | { kind: "secret"; key: ApiKey; secret: string }
  | { kind: "non-recoverable"; key: ApiKey };

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(r: Reveal): void }) {
  const { handleFailure } = useSession();
  const catalog = useCatalog();
  const models = catalog.state.status === "ready" && catalog.state.source === "api" ? catalog.state.data.items : null;
  const [form, setForm] = useState<KeyFormValues>(EMPTY_FORM);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [serverError, setServerError] = useState<KeyErrorView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attempts = useRef(new AttemptKeys());
  const summary = useRef<HTMLDivElement>(null);
  const uid = useId();

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setIssues([]);
      setServerError(null);
      attempts.current.reset();
    }
  }, [open]);

  const issueFor = (f: FormIssue["field"]) => issues.find((i) => i.field === f)?.message;
  const fieldErrorFor = (name: string) => serverError?.kind === "form" ? serverError.fields.filter((e) => e.field === name || e.field.startsWith(`${name}[`)).map((e) => e.message) : [];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const { issues: found, request } = validateKeyForm(form, new Date());
    setIssues(found);
    setServerError(null);
    if (!request) {
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setSubmitting(true);
    const r = await createKey(request, attempts.current.keyFor(request));
    setSubmitting(false);
    if (r.ok) {
      attempts.current.reset();
      onCreated(r.data.secretStatus === "PROVIDED" ? { kind: "secret", key: r.data.key, secret: r.data.secret } : { kind: "non-recoverable", key: r.data.key });
      return;
    }
    if (handleFailure(r.error)) return;
    setServerError(describeCreateFailure(r.error));
    requestAnimationFrame(() => summary.current?.focus());
  }

  const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const errCount = issues.length + (serverError ? 1 : 0);

  return (
    <Modal open={open} title="Create API key" onRequestClose={() => { if (!submitting) onClose(); }}>
      <form onSubmit={(e) => void onSubmit(e)} noValidate aria-busy={submitting} className="form-stack">
        <div ref={summary} tabIndex={-1} role={errCount ? "alert" : undefined} className={errCount ? "banner banner--danger" : "sr-only"}>
          {issues.length > 0 && (
            <>
              <span className="banner__title">Fix {issues.length === 1 ? "this field" : "these fields"} to continue</span>
              <ul>{issues.map((i) => <li key={i.field}><a href={`#${uid}-${i.field}`} onClick={(ev) => { ev.preventDefault(); document.getElementById(`${uid}-${i.field}`)?.focus(); }}>{i.message}</a></li>)}</ul>
            </>
          )}
          {serverError?.kind === "form" && (
            <>
              <span className="banner__title">{serverError.message}</span>
              {serverError.fields.length > 0 && <ul>{serverError.fields.map((f, i) => <li key={i}>{f.field}: {f.message}</li>)}</ul>}
            </>
          )}
          {serverError?.kind === "retry" && <><span className="banner__title">Key not created</span><span>{serverError.message}</span></>}
          {serverError?.kind === "step_up" && (
            <>
              <span className="banner__title">Sign in again to create keys</span>
              <span>For safety, creating a key needs a recent wallet sign-in. Verify with your wallet, then press Create key again; your form is kept.</span>
              <WalletSignIn onDone={() => setServerError(null)} />
            </>
          )}
        </div>

        <div className="field">
          <label htmlFor={`${uid}-name`}>Name</label>
          <input id={`${uid}-name`} type="text" maxLength={100} value={form.name} autoComplete="off" required
            aria-invalid={issueFor("name") ? true : undefined} aria-describedby={issueFor("name") ? `${uid}-name-err` : undefined}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          {issueFor("name") && <p id={`${uid}-name-err`} className="field__error">{issueFor("name")}</p>}
        </div>

        <fieldset className="field fieldset">
          <legend>Permissions</legend>
          {SCOPES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" id={s === SCOPES[0] ? `${uid}-scopes` : undefined} checked={form.scopes.includes(s)} onChange={() => setForm({ ...form, scopes: toggle(form.scopes, s) })} />
              <span>{SCOPE_LABELS[s]} <code>{s}</code></span>
            </label>
          ))}
          {issueFor("scopes") && <p className="field__error">{issueFor("scopes")}</p>}
        </fieldset>

        <fieldset className="field fieldset">
          <legend>Model allowlist</legend>
          {models ? (
            <>
              <p className="small muted">Leave all unchecked to allow every model.</p>
              {models.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={form.models.includes(m.id)} onChange={() => setForm({ ...form, models: toggle(form.models, m.id) })} />
                  <span>{m.displayName} <code>{m.id}</code></span>
                </label>
              ))}
            </>
          ) : (
            <p className="small muted">The model list could not be loaded, so this key will allow every model.</p>
          )}
          {fieldErrorFor("modelAllowlist").map((m, i) => <p key={i} className="field__error">{m}</p>)}
        </fieldset>

        <div className="field">
          <label htmlFor={`${uid}-spendCapUsd`}>Spend cap in USD (optional)</label>
          <input id={`${uid}-spendCapUsd`} type="text" inputMode="decimal" value={form.spendCapUsd} autoComplete="off" placeholder="No cap"
            aria-invalid={issueFor("spendCapUsd") ? true : undefined} aria-describedby={`${uid}-cap-help${issueFor("spendCapUsd") ? ` ${uid}-cap-err` : ""}`}
            onChange={(e) => setForm({ ...form, spendCapUsd: e.target.value })} />
          <p id={`${uid}-cap-help`} className="small muted">Stored with the key. Enforcement on gateway requests arrives with the gateway release.</p>
          {issueFor("spendCapUsd") && <p id={`${uid}-cap-err`} className="field__error">{issueFor("spendCapUsd")}</p>}
          {fieldErrorFor("spendCapMicrousd").map((m, i) => <p key={i} className="field__error">{m}</p>)}
        </div>

        <div className="field">
          <label htmlFor={`${uid}-expiresOn`}>Expires on (optional, end of day UTC)</label>
          <input id={`${uid}-expiresOn`} type="date" value={form.expiresOn}
            aria-invalid={issueFor("expiresOn") ? true : undefined} aria-describedby={issueFor("expiresOn") ? `${uid}-exp-err` : undefined}
            onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
          {issueFor("expiresOn") && <p id={`${uid}-exp-err`} className="field__error">{issueFor("expiresOn")}</p>}
          {fieldErrorFor("expiresAt").map((m, i) => <p key={i} className="field__error">{m}</p>)}
        </div>

        <div className="actions">
          <button type="submit" className="btn btn--primary" aria-disabled={submitting} onClick={(e) => { if (submitting) e.preventDefault(); }}>{submitting ? "Creating" : "Create key"}</button>
          <button type="button" className="btn btn--secondary" disabled={submitting} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** Secret exists only in this component's props/state while open; closing unmounts it (Modal renders nothing when closed). */
function RevealDialog({ reveal, onClose }: { reveal: Reveal | null; onClose(): void }) {
  const [stored, setStored] = useState(false);
  const [confirmEsc, setConfirmEsc] = useState(false);
  useEffect(() => { setStored(false); setConfirmEsc(false); }, [reveal]);
  const secret = reveal?.kind === "secret" ? reveal.secret : null;
  const code = useRef<HTMLElement>(null);
  return (
    <Modal open={reveal !== null} title={secret ? "Copy your key now, it will not be shown again" : "Secret not recoverable"} onRequestClose={() => { if (stored || !secret) onClose(); else setConfirmEsc(true); }}>
      {reveal && (
        <div className="form-stack">
          {secret ? (
            <>
              <p>Key <strong>{reveal.key.name}</strong> was created. Store the secret in a password manager or secret store now. We keep only a one-way digest, so we cannot show it again.</p>
              <div className="code">
                <div className="code__bar">
                  <span className="code__label">Secret</span>
                  <CopyButton text={secret} what="API key secret" selectTarget={() => code.current} />
                </div>
                <pre tabIndex={0} role="region" aria-label="API key secret"><code ref={code} data-testid="secret">{secret}</code></pre>
              </div>
              <label className="check">
                <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
                <span>I have stored this key</span>
              </label>
              {confirmEsc && !stored && (
                <p className="banner banner--warning" role="alert"><span className="banner__title">Close without storing?</span><span>Tick the box after you have saved the key. If you close now the secret is gone and you must create a new key.</span></p>
              )}
              <div className="actions">
                <button type="button" className="btn btn--primary" disabled={!stored} onClick={onClose}>Close</button>
                {confirmEsc && <button type="button" className="btn btn--secondary" onClick={onClose}>Discard secret and close</button>}
              </div>
            </>
          ) : (
            <>
              <p className="banner banner--warning"><span className="banner__title">The secret cannot be shown again</span><span>Key <strong>{reveal.key.name}</strong> exists, but its secret is no longer recoverable. Revoke it and create a new key. No second key was made.</span></p>
              <div className="actions"><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function RevokeDialog({ target, onClose, onRevoked }: { target: ApiKey | null; onClose(): void; onRevoked(k: ApiKey): void }) {
  const { handleFailure } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { setBusy(false); setError(null); }, [target]);

  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    const r = await revokeKey(target.id);
    setBusy(false);
    if (r.ok) return onRevoked(target);
    if (handleFailure(r.error)) return;
    setError(r.error.kind === "http" && r.error.code === "STEP_UP_REQUIRED" ? "Sign in again with your wallet (Security page), then retry." : `Could not revoke. ${describeFailure(r.error)}`);
  }
  return (
    <Modal open={target !== null} title="Revoke this key?" onRequestClose={() => { if (!busy) onClose(); }} initialFocus={cancel}>
      {target && (
        <div className="form-stack">
          <p>Revoke <strong>{target.name}</strong> (<code>{target.prefix}…</code>). Requests using this key will fail immediately. This cannot be undone.</p>
          {error && <p className="banner banner--danger" role="alert"><span className="banner__title">Not revoked</span><span>{error}</span></p>}
          <div className="actions">
            <button ref={cancel} type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn--danger" onClick={() => void confirm()} aria-disabled={busy}>{busy ? "Revoking" : "Revoke key"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Keys() {
  const [keys, reload] = useLoad(listKeys);
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [notice, setNotice] = useState("");
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const closeReveal = useCallback(() => setReveal(null), []);
  // The secret lives only in `reveal` state; leaving the page unmounts it, and Modal renders nothing when closed.

  const items = useMemo(() => (keys.status === "ready" ? keys.data.items : []), [keys]);

  return (
    <div className="page-body console-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Console</p>
          <h1 className="page-title">API keys</h1>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>Create key</button>
      </div>
      <p className="muted lead">Keys authenticate gateway requests. A secret is shown once, at creation. To rotate, create a new key, switch over, then revoke the old one.</p>

      <div role="status" aria-live="polite" className="status-line">{notice}</div>

      {keys.status === "loading" && (
        <div className="skeleton" role="status" aria-label="Loading keys"><span /><span /><span /></div>
      )}
      {keys.status === "error" && (
        <div className="banner banner--danger" role="alert">
          <span className="banner__title">Could not load keys</span>
          <span>{keys.failure.kind === "http" && keys.failure.code === "FORBIDDEN" ? "Your role cannot manage API keys. Ask an owner or admin." : describeFailure(keys.failure)}{keys.failure.kind === "http" && keys.failure.requestId ? ` Reference ${keys.failure.requestId}.` : ""}</span>
          <button type="button" className="btn btn--secondary btn--small" onClick={reload}>Retry</button>
        </div>
      )}
      {keys.status === "ready" && items.length === 0 && (
        <div className="empty">
          <h2>No API keys yet</h2>
          <p className="muted">Create a key to send your first request. You will see the secret once.</p>
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>Create key</button>
        </div>
      )}
      {keys.status === "ready" && items.length > 0 && (
        <ul className="key-list" aria-label="API keys">
          {items.map((k) => {
            const status = keyStatus(k, new Date());
            return (
              <li key={k.id} className="key-row">
                <div className="key-row__main">
                  <h2 className="key-row__name" tabIndex={-1} ref={(el) => { if (el) rowRefs.current.set(k.id, el); else rowRefs.current.delete(k.id); }}>{k.name}</h2>
                  <StatusBadge k={k} />
                </div>
                <dl className="key-row__facts">
                  <div><dt>Key</dt><dd><code>{k.prefix}…</code></dd></div>
                  <div><dt>Permissions</dt><dd>{k.scopes.map((s) => SCOPE_LABELS[s]).join(", ")}</dd></div>
                  <div><dt>Models</dt><dd>{k.modelAllowlist.length ? k.modelAllowlist.join(", ") : "All models"}</dd></div>
                  <div><dt>Spend cap</dt><dd>{k.spendCapMicrousd ? `${formatUsdDisplay(k.spendCapMicrousd)} USD` : "No cap"}</dd></div>
                  <div><dt>Last used</dt><dd>{when(k.lastUsedAt, "Never")}</dd></div>
                  <div><dt>Created</dt><dd>{when(k.createdAt, "")}</dd></div>
                  <div><dt>Expires</dt><dd>{when(k.expiresAt, "Never")}</dd></div>
                </dl>
                {status !== "revoked" && (
                  <div className="key-row__actions">
                    <button type="button" className="btn btn--secondary btn--small" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>Revoke</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(r) => { setCreating(false); setReveal(r); reload(); }}
      />
      <RevealDialog reveal={reveal} onClose={closeReveal} />
      <RevokeDialog
        target={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={(k) => {
          setRevoking(null);
          setNotice(`Key ${k.name} revoked`);
          reload();
          window.setTimeout(() => rowRefs.current.get(k.id)?.focus(), 150);
        }}
      />
    </div>
  );
}
