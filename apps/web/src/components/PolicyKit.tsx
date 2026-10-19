import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { EvidenceStatus, OptimizationConfig, OptimizationControl, OptimizationFeature, OptimizationPolicy, OptimizationReport } from "@llmcrypto/contracts";
import { describeFailure } from "../lib/api";
import { getPolicy, getReport, listControls, listEvidence, listPolicyVersions, revertPolicy, updatePolicy } from "../lib/api-product";
import { forbiddenCopy, isStepUpRequired, isVersionConflict } from "../lib/auth-copy";
import { formatCount, formatSignedUsd, formatUtc } from "../lib/format";
import { formatUsdDisplay } from "../lib/keys";
import { FEATURE_LABEL, enablesSensitive, formatDetail, normalizeConfig, sameConfig, summarizeConfig, validateConfig, type PolicyIssue } from "../lib/policy";
import { useSession } from "../lib/session";
import { usePaged } from "../lib/use-paged";
import { useLoad } from "../lib/use-load";
import { LoadError, Skeleton } from "./Feedback";
import { Modal } from "./Modal";
import { Badge, type BadgeTone } from "./StatusBadge";
import { StepUpPanel } from "./StepUpPanel";

// ---------------------------------------------------------------- editor state

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; version: number; unchanged: boolean }
  | { kind: "conflict" }
  | { kind: "step-up" }
  | { kind: "error"; message: string; fields: string[] };

/** Loads the control catalog and the current policy; holds an editable draft that is saved as a new version with expectedVersion. */
export function usePolicyEditor() {
  const { handleFailure } = useSession();
  const [controls, reloadControls] = useLoad(listControls);
  const [policy, reloadPolicy] = useLoad(getPolicy);
  const [draft, setDraft] = useState<OptimizationConfig | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const base = policy.status === "ready" ? policy.data : null;
  const version = base?.version ?? null;

  useEffect(() => {
    if (base) setDraft(base.config);
  }, [base]);

  const issues: PolicyIssue[] = useMemo(() => (draft ? validateConfig(draft) : []), [draft]);
  const dirty = base !== null && draft !== null && !sameConfig(base.config, normalizeConfig(draft));

  const submit = useCallback(async (note: string) => {
    if (!base || !draft) return;
    setSave({ kind: "saving" });
    const config = normalizeConfig(draft);
    const r = await updatePolicy({ expectedVersion: base.version, config, ...(note.trim() ? { note: note.trim() } : {}) });
    if (r.ok) {
      setSave({ kind: "saved", version: r.data.version, unchanged: r.data.version === base.version });
      reloadPolicy();
      return;
    }
    if (handleFailure(r.error)) return;
    if (isVersionConflict(r.error)) return setSave({ kind: "conflict" });
    if (isStepUpRequired(r.error)) return setSave({ kind: "step-up" });
    const f = r.error.kind === "http" ? r.error.fieldErrors.map((e) => `${e.field}: ${e.message}`) : [];
    setSave({ kind: "error", message: forbiddenCopy(r.error, "optimization policy") ?? describeFailure(r.error), fields: f });
  }, [base, draft, handleFailure, reloadPolicy]);

  const discard = useCallback(() => {
    if (base) setDraft(base.config);
    setSave({ kind: "idle" });
  }, [base]);
  const reloadAll = useCallback(() => { setSave({ kind: "idle" }); reloadPolicy(); reloadControls(); }, [reloadPolicy, reloadControls]);

  return { controls, policy, base, version, draft, setDraft, issues, dirty, save, setSave, submit, discard, reloadAll, reloadPolicy };
}
export type PolicyEditor = ReturnType<typeof usePolicyEditor>;

// ---------------------------------------------------------------- pieces

export function PolicyStatus({ policy, onRetry }: { policy: PolicyEditor["policy"]; onRetry(): void }) {
  if (policy.status === "loading") return <Skeleton label="Loading policy" />;
  if (policy.status === "error") return <LoadError what="the optimization policy" failure={policy.failure} onRetry={onRetry} />;
  const p = policy.data;
  return (
    <p className="muted" data-testid="policy-version">
      Policy version <strong>{p.version}</strong>
      {p.version === 0 ? " (defaults: everything off)" : ` saved ${formatUtc(p.createdAt ?? "")}${p.revertedFrom !== null ? `, reverted from version ${p.revertedFrom}` : ""}${p.note ? `, note: ${p.note}` : ""}`}.
      {" "}Each save creates a new version; nothing is ever overwritten.
    </p>
  );
}

interface ControlProps {
  control: OptimizationControl | undefined;
  /** Fallback title if the catalog failed to load. */
  title: string;
  enabled: boolean;
  onToggle(on: boolean): void;
  children?: ReactNode;
}

/** One control: what it does, what it adds or sends, the tradeoff, then an explicit opt-in. Unavailable controls get no switch. */
export function ControlCard({ control, title, enabled, onToggle, children }: ControlProps) {
  const uid = useId();
  const unavailable = control?.availability === "unavailable";
  return (
    <section className="control" aria-labelledby={`${uid}-h`} data-testid={`control-${control?.feature ?? title}`}>
      <div className="control__head">
        <h3 id={`${uid}-h`} className="control__title">{control?.title ?? title}</h3>
        {unavailable ? <Badge tone="neutral">Unavailable</Badge> : enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
      </div>
      {control ? (
        <dl className="control__facts">
          <div><dt>What it does</dt><dd>{control.description}</dd></div>
          <div><dt>What changes or leaves your account</dt><dd>{control.privacyImpact}</dd></div>
          <div><dt>Tradeoff</dt><dd>{control.tradeoff}</dd></div>
        </dl>
      ) : (
        <p className="muted">Control details could not be loaded. Controls stay off until you can read what they do.</p>
      )}
      {unavailable ? (
        <p className="banner banner--info" data-testid="unavailable-reason"><span className="banner__title">Not available</span><span>{control?.unavailableReason ?? "This control cannot be turned on yet."}</span></p>
      ) : control ? (
        <div className="consent">
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} aria-describedby={`${uid}-c`} />
            <span>Turn on {control.title}</span>
          </label>
          <p id={`${uid}-c`} className="small muted">Off by default. By turning it on you opt in to the change described above. You can turn it off or revert at any time; every change is a new version.</p>
        </div>
      ) : null}
      {enabled && !unavailable && children}
    </section>
  );
}

export function SavePanel({ ed }: { ed: PolicyEditor }) {
  const uid = useId();
  const [note, setNote] = useState("");
  const { save, issues, dirty, base, draft } = ed;
  const saving = save.kind === "saving";
  const sensitive = base && draft ? enablesSensitive(base.config, normalizeConfig(draft)) : false;
  const blocked = issues.length > 0 ? "Fix the highlighted fields first." : !dirty ? "No changes to save." : null;
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (save.kind === "conflict" || save.kind === "error") summary.current?.focus(); }, [save.kind]);
  return (
    <div className="form-stack" aria-busy={saving}>
      <div ref={summary} tabIndex={-1}>
        {save.kind === "conflict" && (
          <div className="banner banner--warning" role="alert" data-testid="policy-conflict">
            <span className="banner__title">The policy changed somewhere else</span>
            <span>Your edits were not saved because a newer version exists. Reload to see it; your unsaved edits will be discarded.</span>
            <button type="button" className="btn btn--secondary btn--small" onClick={ed.reloadAll}>Reload latest policy</button>
          </div>
        )}
        {save.kind === "error" && (
          <div className="banner banner--danger" role="alert">
            <span className="banner__title">Policy not saved</span><span>{save.message}</span>
            {save.fields.length > 0 && <ul>{save.fields.map((f) => <li key={f}>{f}</li>)}</ul>}
          </div>
        )}
        {save.kind === "step-up" && (
          <div className="banner banner--warning" role="alert">
            <span className="banner__title">Verify it is you first</span>
            <span>Turning on guidance, project context or blocking needs a recent sign-in. Your edits are kept.</span>
            <StepUpPanel onDone={() => ed.setSave({ kind: "idle" })} />
          </div>
        )}
      </div>
      {issues.length > 0 && <ul className="field__error" aria-label="Problems">{issues.map((i) => <li key={i.field + i.message}>{i.message}</li>)}</ul>}
      <div className="field">
        <label htmlFor={`${uid}-note`}>Note for this version (optional)</label>
        <input id={`${uid}-note`} type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="actions">
        <button type="button" className="btn btn--primary" aria-disabled={saving || blocked !== null} aria-describedby={blocked ? `${uid}-why` : undefined}
          onClick={() => { if (!saving && blocked === null) void ed.submit(note); }}>
          {saving ? "Saving" : base ? `Save as version ${base.version + 1}` : "Save"}
        </button>
        <button type="button" className="btn btn--secondary" disabled={!dirty || saving} onClick={ed.discard}>Discard edits</button>
      </div>
      {blocked && <p id={`${uid}-why`} className="small muted">{blocked}</p>}
      {sensitive && dirty && <p className="small muted">This change needs a recent sign-in; you will be asked to verify if yours is too old.</p>}
      {save.kind === "saved" && <p className="banner banner--success" role="status"><span className="banner__title">{save.unchanged ? "No new version" : `Saved as version ${save.version}`}</span><span>{save.unchanged ? "The policy was already identical." : "It applies to new requests; requests already served keep the version that governed them."}</span></p>}
    </div>
  );
}

export function HistoryPanel({ ed }: { ed: PolicyEditor }) {
  const current = ed.version;
  // A new fetcher identity (the current version changed) reloads the list after a save or revert.
  const fetchVersions = useCallback((signal: AbortSignal) => { void current; return listPolicyVersions(signal); }, [current]);
  const [versions, reload] = useLoad(fetchVersions);
  const { handleFailure } = useSession();
  const [target, setTarget] = useState<OptimizationPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; stepUp: boolean; conflict: boolean } | null>(null);
  const [done, setDone] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);

  async function confirm() {
    if (!target || current === null || busy) return;
    setBusy(true);
    setErr(null);
    const r = await revertPolicy({ toVersion: target.version, expectedVersion: current });
    setBusy(false);
    if (r.ok) {
      setDone(`Reverted: version ${target.version} re-applied as new version ${r.data.version}`);
      setTarget(null);
      ed.reloadPolicy();
      return;
    }
    if (handleFailure(r.error)) return;
    setErr({ message: forbiddenCopy(r.error, "optimization policy") ?? describeFailure(r.error), stepUp: isStepUpRequired(r.error), conflict: isVersionConflict(r.error) });
  }

  return (
    <section aria-labelledby="hist-head" className="section--ruled">
      <h2 id="hist-head" className="section-title">Versions and revert</h2>
      <p className="muted">Reverting appends a new version that copies an older one. History is never rewritten. Version 0 is the all-off default.</p>
      <div role="status" aria-live="polite" className="status-line">{done}</div>
      {versions.status === "loading" && <Skeleton label="Loading versions" />}
      {versions.status === "error" && <LoadError what="versions" failure={versions.failure} onRetry={reload} />}
      {versions.status === "ready" && (
        <div className="table-wrap" role="region" aria-label="Policy versions" tabIndex={0}>
          <table className="data-table" data-testid="policy-versions">
            <caption className="sr-only">Policy versions, newest first</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Saved (UTC)</th><th scope="col">What is on</th><th scope="col">Note</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {versions.data.items.map((v) => {
                const on = summarizeConfig(v.config);
                return (
                  <tr key={v.version}>
                    <th scope="row">{v.version}{v.version === current ? " (current)" : ""}</th>
                    <td>{v.createdAt ? formatUtc(v.createdAt) : "Default"}</td>
                    <td>{on.length ? on.join("; ") : "Everything off"}{v.revertedFrom !== null ? ` (reverted from ${v.revertedFrom})` : ""}</td>
                    <td>{v.note ?? ""}</td>
                    <td>{v.version !== current && <button type="button" className="btn btn--secondary btn--small" aria-label={`Revert to version ${v.version}`} onClick={() => { setErr(null); setTarget(v); }}>Revert</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={target !== null} title={`Revert to version ${target?.version ?? ""}?`} onRequestClose={() => { if (!busy) setTarget(null); }} initialFocus={cancel}>
        {target && (
          <div className="form-stack">
            <p>This creates version {(current ?? 0) + 1} with the settings of version {target.version}:</p>
            <ul>{(summarizeConfig(target.config).length ? summarizeConfig(target.config) : ["Everything off"]).map((l) => <li key={l}>{l}</li>)}</ul>
            {err && (
              <div className="banner banner--danger" role="alert">
                <span className="banner__title">{err.conflict ? "The policy changed somewhere else" : "Not reverted"}</span>
                <span>{err.conflict ? "A newer version exists. Reload and choose again." : err.message}</span>
                {err.stepUp && <StepUpPanel onDone={() => setErr(null)} />}
                {err.conflict && <button type="button" className="btn btn--secondary btn--small" onClick={() => { setTarget(null); ed.reloadAll(); reload(); }}>Reload latest policy</button>}
              </div>
            )}
            <div className="actions">
              <button ref={cancel} type="button" className="btn btn--secondary" disabled={busy} onClick={() => setTarget(null)}>Cancel</button>
              <button type="button" className="btn btn--primary" aria-disabled={busy} onClick={() => void confirm()}>{busy ? "Reverting" : "Revert"}</button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

const EVIDENCE_TONE: Record<EvidenceStatus, BadgeTone> = { applied: "success", skipped: "neutral", advisory: "info", blocked: "warning" };

export function EvidenceSection({ features, intro }: { features: OptimizationFeature[]; intro: string }) {
  const uid = useId();
  const [feature, setFeature] = useState<OptimizationFeature | "">("");
  const [status, setStatus] = useState<EvidenceStatus | "">("");
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => {
    const q = new URLSearchParams({ limit: "50" });
    if (feature) q.set("feature", feature);
    if (status) q.set("status", status);
    if (cursor) q.set("cursor", cursor);
    return listEvidence(q.toString(), signal);
  }, [feature, status]);
  const ev = usePaged(fetchPage);
  return (
    <section aria-labelledby={`${uid}-h`} className="section--ruled">
      <h2 id={`${uid}-h`} className="section-title">Evidence</h2>
      <p className="muted">{intro} Evidence rows hold counts and reasons only: never prompt text or note text.</p>
      <div className="toolbar toolbar--filters">
        <div className="field">
          <label htmlFor={`${uid}-f`}>Control</label>
          <select id={`${uid}-f`} value={feature} onChange={(e) => setFeature(e.target.value as OptimizationFeature | "")}>
            <option value="">All controls</option>
            {features.map((f) => <option key={f} value={f}>{FEATURE_LABEL[f]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-s`}>Outcome</label>
          <select id={`${uid}-s`} value={status} onChange={(e) => setStatus(e.target.value as EvidenceStatus | "")}>
            <option value="">Any</option>
            {(["applied", "skipped", "advisory", "blocked"] as const).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      {ev.state.status === "loading" && <Skeleton label="Loading evidence" />}
      {ev.state.status === "error" && <LoadError what="evidence" failure={ev.state.failure} onRetry={ev.reload} />}
      {ev.state.status === "ready" && ev.state.items.length === 0 && (
        <div className="empty"><h3>No evidence yet</h3><p className="muted">Evidence appears here when a request is served while a control is on. A control that is off records nothing.</p></div>
      )}
      {ev.state.status === "ready" && ev.state.items.length > 0 && (
        <>
          <div className="table-wrap" role="region" aria-label="Evidence table" tabIndex={0}>
            <table className="data-table" data-testid="evidence-table">
              <caption className="sr-only">Optimization evidence, newest first</caption>
              <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Request</th><th scope="col">Control</th><th scope="col">Outcome</th><th scope="col">Reason</th><th scope="col">Details</th><th scope="col">Policy</th></tr></thead>
              <tbody>
                {ev.state.items.map((e) => (
                  <tr key={e.id}>
                    <th scope="row"><time dateTime={e.createdAt}>{formatUtc(e.createdAt)}</time></th>
                    <td><Link to={`/app/usage/${encodeURIComponent(e.requestId)}`}><code>{e.requestId}</code></Link></td>
                    <td>{FEATURE_LABEL[e.feature]}</td>
                    <td><Badge tone={EVIDENCE_TONE[e.status]}>{e.status}</Badge></td>
                    <td>{e.reason ?? ""}</td>
                    <td>
                      {formatDetail(e.detail)}
                      {e.routeComparison && (
                        <span className="small muted"> Estimate at current rates (not a routing change): actual {formatUsdDisplay(e.routeComparison.actualChargeMicrousd)} USD; {e.routeComparison.alternatives.map((a) => `${a.model} ${formatUsdDisplay(a.estimatedChargeMicrousd)}`).join(", ") || "no alternatives"}.</span>
                      )}
                    </td>
                    <td className="num">{e.policyVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ev.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={ev.state.loadingMore} onClick={ev.loadMore}>{ev.state.loadingMore ? "Loading" : "Load more evidence"}</button>}
          {ev.state.moreError && <p className="field__error" role="alert">Could not load more. {describeFailure(ev.state.moreError)}</p>}
        </>
      )}
    </section>
  );
}

function Insufficient({ reason, children }: { reason: string; children?: ReactNode }) {
  return (
    <div className="banner banner--info" data-testid="insufficient-data">
      <span className="banner__title">Insufficient data</span>
      <span>{reason}</span>
      {children}
    </div>
  );
}

export type ReportPart = "cache" | "guidance" | "context" | "route" | "loop";

export function ReportSection({ parts }: { parts: ReportPart[] }) {
  const [report, reload] = useLoad<OptimizationReport>(getReport);
  return (
    <section aria-labelledby="report-head" className="section--ruled">
      <h2 id="report-head" className="section-title">Report</h2>
      <p className="muted">Only measured numbers are shown. Where there is no baseline to compare against the report says so. No saving is claimed for guidance or project context.</p>
      {report.status === "loading" && <Skeleton label="Loading report" />}
      {report.status === "error" && <LoadError what="the report" failure={report.failure} onRetry={reload} />}
      {report.status === "ready" && <ReportBody r={report.data} parts={parts} />}
    </section>
  );
}

function ReportBody({ r, parts }: { r: OptimizationReport; parts: ReportPart[] }) {
  const has = (p: ReportPart) => parts.includes(p);
  return (
    <div className="form-stack" data-testid="report">
      {has("cache") && (
        <div>
          <h3>Cache accounting</h3>
          {r.cacheAccounting.status === "insufficient_data" ? (
            <Insufficient reason={r.cacheAccounting.reason}><span className="small">Requests considered: {formatCount(r.cacheAccounting.requests)}.</span></Insufficient>
          ) : (
            <dl className="facts facts--grid" data-testid="cache-report">
              <div><dt>Requests</dt><dd>{formatCount(r.cacheAccounting.requests)}</dd></div>
              <div><dt>Input tokens (uncached)</dt><dd>{formatCount(r.cacheAccounting.inputTokens)}</dd></div>
              <div><dt>Cached input tokens</dt><dd>{formatCount(r.cacheAccounting.cachedInputTokens)}</dd></div>
              <div><dt>Output tokens</dt><dd>{formatCount(r.cacheAccounting.outputTokens)}</dd></div>
              <div><dt>Cost without cached discount</dt><dd>{formatUsdDisplay(r.cacheAccounting.baselineMicrousd)} USD</dd></div>
              <div><dt>Actual cost</dt><dd>{formatUsdDisplay(r.cacheAccounting.actualMicrousd)} USD</dd></div>
              <div><dt>Difference from the provider&apos;s cached discount</dt><dd>{formatSignedUsd(r.cacheAccounting.differenceMicrousd)} USD</dd></div>
            </dl>
          )}
          <p className="small muted">Accounting only: the same recorded tokens priced with and without the cached discount. It does not cause caching.</p>
        </div>
      )}
      {has("guidance") && (
        <div>
          <h3>Concise guidance</h3>
          <Insufficient reason={r.conciseGuidance.reason}>
            <span className="small">Applied to {formatCount(r.conciseGuidance.appliedRequests)} requests, adding {formatCount(r.conciseGuidance.addedUtf8Bytes)} bytes of input. Whether answers got shorter or cheaper is not measured.</span>
          </Insufficient>
        </div>
      )}
      {has("context") && (
        <div>
          <h3>Project context</h3>
          <Insufficient reason={r.projectContext.reason}>
            <span className="small">Applied to {formatCount(r.projectContext.appliedRequests)} requests, adding {formatCount(r.projectContext.addedUtf8Bytes)} bytes of input. No saving is measured or claimed.</span>
          </Insufficient>
        </div>
      )}
      {has("route") && (
        <div>
          <h3>Route comparison</h3>
          <p>Informational: evaluated {formatCount(r.routeComparison.evaluatedRequests)} requests. Estimates at current rates for other models; the route is never changed.</p>
        </div>
      )}
      {has("loop") && (
        <div>
          <h3>LoopGuard</h3>
          <dl className="facts facts--grid">
            <div><dt>Advisory flags</dt><dd>{formatCount(r.loopGuard.advisoryRequests)}</dd></div>
            <div><dt>Blocked</dt><dd>{formatCount(r.loopGuard.blockedRequests)}</dd></div>
          </dl>
          <p className="small muted">{r.loopGuard.note}</p>
        </div>
      )}
    </div>
  );
}
