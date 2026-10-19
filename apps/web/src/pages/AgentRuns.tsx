import { useCallback } from "react";
import { Link } from "react-router";
import type { AgentRun } from "@llmcrypto/contracts";
import { Badge } from "../components/StatusBadge";
import { describeFailure, listAgentRuns } from "../lib/api";
import { formatCount, formatUtc } from "../lib/format";
import { formatUsdDisplay } from "../lib/keys";
import { usePaged } from "../lib/use-paged";
import { toQuery } from "../lib/usage-view";

export function AgentRuns() {
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => listAgentRuns(toQuery({}, cursor, 50), signal), []);
  const runs = usePaged<AgentRun>(fetchPage);
  return (
    <div className="page-body console-page">
      <nav aria-label="Breadcrumb" className="breadcrumb"><Link to="/app/usage">Usage</Link> <span aria-hidden="true">/</span> <span aria-current="page">Agent runs</span></nav>
      <h1 className="page-title">Agent runs</h1>
      <p className="muted lead">Requests grouped by the run ID your client sent (<code>X-Run-Id</code>). Requests sent without one are grouped as unknown and are never matched to a run by guesswork.</p>
      <div aria-busy={runs.state.status === "loading"}>
        {runs.state.status === "loading" && <div className="skeleton" role="status" aria-label="Loading agent runs"><span /><span /></div>}
        {runs.state.status === "error" && (
          <div className="banner banner--danger" role="alert">
            <span className="banner__title">Could not load agent runs</span>
            <span>{describeFailure(runs.state.failure)}</span>
            <button type="button" className="btn btn--secondary btn--small" onClick={runs.reload}>Retry</button>
          </div>
        )}
        {runs.state.status === "ready" && runs.state.items.length === 0 && (
          <div className="empty"><h2>No runs yet</h2><p className="muted">Send requests with an <code>X-Run-Id</code> header to see them grouped here.</p></div>
        )}
        {runs.state.status === "ready" && runs.state.items.length > 0 && (
          <>
            <div className="table-wrap" role="region" aria-label="Agent runs table" tabIndex={0}>
              <table className="data-table" data-testid="runs-table">
                <caption className="sr-only">Runs with request counts, tokens, charge and problem counts</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th><th scope="col">First request (UTC)</th><th scope="col">Last request (UTC)</th>
                    <th scope="col" className="num">Requests</th><th scope="col" className="num">Input</th><th scope="col" className="num">Cached</th><th scope="col" className="num">Output</th>
                    <th scope="col" className="num">Charge (USD)</th><th scope="col" className="num">Failed</th><th scope="col" className="num">Pending</th><th scope="col" className="num">Limit-rejected</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.state.items.map((r, i) => (
                    <tr key={`${r.runId ?? "unknown"}|${r.projectId ?? ""}|${i}`}>
                      <th scope="row">
                        {r.correlation === "known" && r.runId
                          ? <Link to={`/app/usage?runId=${encodeURIComponent(r.runId)}`}><code>{r.runId}</code></Link>
                          : <Badge tone="neutral">Unknown run</Badge>}
                        {r.correlation === "unknown" && <span className="small muted"> No run ID sent{r.projectId ? ` (project ${r.projectId})` : ""}</span>}
                      </th>
                      <td><time dateTime={r.firstAt}>{formatUtc(r.firstAt)}</time></td>
                      <td><time dateTime={r.lastAt}>{formatUtc(r.lastAt)}</time></td>
                      <td className="num">{formatCount(r.requestCount)}</td>
                      <td className="num">{formatCount(r.inputTokens)}</td>
                      <td className="num">{formatCount(r.cachedInputTokens)}</td>
                      <td className="num">{formatCount(r.outputTokens)}</td>
                      <td className="num">{formatUsdDisplay(r.chargeMicrousd)}</td>
                      <td className="num">{formatCount(r.failedCount)}</td>
                      <td className="num">{formatCount(r.pendingCount)}</td>
                      <td className="num">{formatCount(r.limitRejectedCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs.state.moreError && <p className="banner banner--danger" role="alert"><span>Could not load more. {describeFailure(runs.state.moreError)}</span></p>}
            {runs.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={runs.state.loadingMore} onClick={runs.loadMore}>{runs.state.loadingMore ? "Loading" : "Load more runs"}</button>}
          </>
        )}
      </div>
    </div>
  );
}
