import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import type { UsageRecord } from "@llmcrypto/contracts";
import { ExportPanel } from "../components/ExportPanel";
import { Badge } from "../components/StatusBadge";
import { describeFailure, listUsage } from "../lib/api";
import { formatCount, formatUtc } from "../lib/format";
import { formatUsdDisplay } from "../lib/keys";
import { useSession } from "../lib/session";
import { usePaged } from "../lib/use-paged";
import { EMPTY_FILTERS, REQUEST_STATES, REQUEST_STATUS, toFilters, toQuery, type UsageFormValues } from "../lib/usage-view";

export function Usage() {
  const { state: sessionState } = useSession();
  const restricted = sessionState.status === "signed-in" && sessionState.session.restricted;
  const uid = useId();
  const [params] = useSearchParams();
  const initial: UsageFormValues = { ...EMPTY_FILTERS, runId: params.get("runId") ?? "" };
  const [form, setForm] = useState<UsageFormValues>(initial);
  const [applied, setApplied] = useState<UsageFormValues>(initial);
  const [issues, setIssues] = useState<{ field: keyof UsageFormValues; message: string }[]>([]);
  const { filters } = useMemo(() => toFilters(applied), [applied]);
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => listUsage(toQuery({ ...filters }, cursor, 50), signal), [filters]);
  const usage = usePaged<UsageRecord>(fetchPage);
  const filtered = Object.keys(filters).length > 0;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const r = toFilters(form);
    setIssues(r.issues);
    if (r.issues.length) {
      requestAnimationFrame(() => document.getElementById(`${uid}-${r.issues[0]?.field}`)?.focus());
      return;
    }
    setApplied(form);
  }
  const issueFor = (f: keyof UsageFormValues) => issues.find((i) => i.field === f)?.message;
  const set = (k: keyof UsageFormValues) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page-body console-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Console</p>
          <h1 className="page-title">Usage and logs</h1>
        </div>
        <Link to="/app/usage/agent-runs" className="btn btn--secondary">Agent runs</Link>
      </div>
      <p className="muted lead">Each request, with its model, token categories and final charge. Prompt text is not stored.</p>

      <form className="toolbar toolbar--filters" onSubmit={onSubmit} noValidate aria-label="Usage filters">
        <div className="field">
          <label htmlFor={`${uid}-from`}>From (UTC date)</label>
          <input id={`${uid}-from`} type="date" value={form.from} onChange={set("from")} aria-invalid={issueFor("from") ? true : undefined} />
          {issueFor("from") && <p className="field__error">{issueFor("from")}</p>}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-to`}>To (UTC date)</label>
          <input id={`${uid}-to`} type="date" value={form.to} onChange={set("to")} aria-invalid={issueFor("to") ? true : undefined} />
          {issueFor("to") && <p className="field__error">{issueFor("to")}</p>}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-model`}>Model ID</label>
          <input id={`${uid}-model`} type="text" autoComplete="off" value={form.model} onChange={set("model")} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-status`}>Status</label>
          <select id={`${uid}-status`} value={form.status} onChange={set("status")}>
            <option value="">Any status</option>
            {REQUEST_STATES.map((s) => <option key={s} value={s}>{REQUEST_STATUS[s].label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-runId`}>Run ID</label>
          <input id={`${uid}-runId`} type="text" autoComplete="off" value={form.runId} onChange={set("runId")} />
        </div>
        <div className="actions toolbar__actions">
          <button type="submit" className="btn btn--primary">Apply filters</button>
          <button type="button" className="btn btn--secondary" onClick={() => { setForm(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setIssues([]); }}>Clear filters</button>
        </div>
      </form>

      <div aria-busy={usage.state.status === "loading"}>
        {usage.state.status === "loading" && <div className="skeleton" role="status" aria-label="Loading usage"><span /><span /><span /></div>}
        {usage.state.status === "error" && (
          <div className="banner banner--danger" role="alert">
            <span className="banner__title">Could not load usage</span>
            <span>{describeFailure(usage.state.failure)}{usage.state.failure.kind === "http" && usage.state.failure.requestId ? ` Reference ${usage.state.failure.requestId}.` : ""}</span>
            <button type="button" className="btn btn--secondary btn--small" onClick={usage.reload}>Retry</button>
          </div>
        )}
        {usage.state.status === "ready" && usage.state.items.length === 0 && (
          <div className="empty" data-testid="usage-empty">
            <h2>{filtered ? "No requests match these filters" : "No requests yet"}</h2>
            <p className="muted">{filtered ? "Widen the date range or clear a filter." : "Requests appear here after you send one with an API key."}</p>
            {filtered && <button type="button" className="btn btn--secondary" onClick={() => { setForm(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }}>Clear filters</button>}
          </div>
        )}
        {usage.state.status === "ready" && usage.state.items.length > 0 && (
          <>
            <div className="table-wrap" role="region" aria-label="Usage table" tabIndex={0}>
              <table className="data-table" data-testid="usage-table">
                <caption className="sr-only">Requests, newest first. Input tokens are uncached input; cached input is shown separately.</caption>
                <thead>
                  <tr>
                    <th scope="col">Time (UTC)</th><th scope="col">Model</th><th scope="col">Status</th>
                    <th scope="col">Run</th>
                    <th scope="col" className="num">Input</th><th scope="col" className="num">Cached</th><th scope="col" className="num">Output</th>
                    <th scope="col" className="num">Charge (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.state.items.map((r) => {
                    const s = REQUEST_STATUS[r.status];
                    return (
                      <tr key={r.id}>
                        <th scope="row"><Link to={`/app/usage/${encodeURIComponent(r.requestId)}`} state={{ record: r }}><time dateTime={r.createdAt}>{formatUtc(r.createdAt)}</time></Link></th>
                        <td><code>{r.model}</code></td>
                        <td><Badge tone={s.tone}>{s.label}</Badge></td>
                        <td>{r.runId ? <code>{r.runId}</code> : <span className="muted">Unknown</span>}</td>
                        <td className="num">{formatCount(r.inputTokens)}</td>
                        <td className="num">{formatCount(r.cachedInputTokens)}</td>
                        <td className="num">{formatCount(r.outputTokens)}</td>
                        <td className="num">{formatUsdDisplay(r.chargeMicrousd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {usage.state.moreError && <p className="banner banner--danger" role="alert"><span>Could not load more. {describeFailure(usage.state.moreError)}</span></p>}
            <p className="small muted" data-testid="usage-count">{usage.state.items.length} request{usage.state.items.length === 1 ? "" : "s"} loaded{usage.state.nextCursor ? ", more available" : ", end of results"}.</p>
            {usage.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={usage.state.loadingMore} onClick={usage.loadMore}>{usage.state.loadingMore ? "Loading" : "Load more requests"}</button>}
          </>
        )}
      </div>

      {restricted ? (
        <p className="muted small" data-testid="export-unavailable">Exports are not available in a restricted API-key session.</p>
      ) : (
        <ExportPanel filters={filters} />
      )}
    </div>
  );
}
