import { useCallback } from "react";
import { Link, useParams } from "react-router";
import type { UsageDetail } from "@llmcrypto/contracts";
import { CopyButton } from "../components/CopyButton";
import { Badge } from "../components/StatusBadge";
import { describeFailure } from "../lib/api";
import { formatCount, formatUtc } from "../lib/format";
import { formatUsdDisplay } from "../lib/keys";
import { findRequest } from "../lib/request-lookup";
import { useLoad } from "../lib/use-load";
import { REQUEST_STATUS } from "../lib/usage-view";

function Rate({ perMtok }: { perMtok: string | null }) {
  return perMtok === null ? <>No separate rate</> : <>{formatUsdDisplay(perMtok)} USD per 1M tokens</>;
}

function Detail({ r }: { r: UsageDetail }) {
  const s = REQUEST_STATUS[r.status];
  const rows: { label: string; tokens: string; rate: string | null | undefined }[] = [
    { label: "Input (uncached)", tokens: r.inputTokens, rate: r.rateSnapshot.inputMicrousdPerMtok },
    { label: "Cached input", tokens: r.cachedInputTokens, rate: r.rateSnapshot.cachedInputMicrousdPerMtok },
    { label: "Output", tokens: r.outputTokens, rate: r.rateSnapshot.outputMicrousdPerMtok },
  ];
  return (
    <>
      <div className="deposit__head">
        <p>Request <code data-testid="request-id">{r.requestId}</code> <CopyButton text={r.requestId} what="request ID" /></p>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p>{s.what}</p>

      <section aria-labelledby="cost-head" className="section--ruled">
        <h2 id="cost-head" className="section-title">Cost</h2>
        <p className="amount" data-testid="charge">{formatUsdDisplay(r.chargeMicrousd)} <span className="unit">USD</span></p>
        <p className="small muted">
          {r.status === "USAGE_PENDING" ? "Provider usage is not final, so this is not a settled charge. The reservation stays open until reconciliation resolves the usage." : r.status === "SETTLED" ? "Final charge, posted once to the ledger." : "Charge recorded so far for this state."}
          {" "}Charge is tokens times the rate for each category, rounded up once.
        </p>
      </section>

      <section aria-labelledby="sum-head" className="section--ruled">
        <h2 id="sum-head" className="section-title">Summary</h2>
        <dl className="facts">
          <div><dt>Model</dt><dd><code>{r.model}</code></dd></div>
          <div><dt>Time</dt><dd><time dateTime={r.createdAt}>{formatUtc(r.createdAt)}</time></dd></div>
          <div><dt>Status</dt><dd>{s.label}</dd></div>
          <div><dt>Key</dt><dd>{r.keyId ? <code>{r.keyId}</code> : "Not recorded"}</dd></div>
          <div><dt>Project</dt><dd>{r.projectId ? <code>{r.projectId}</code> : "None"}</dd></div>
          <div><dt>Run ID</dt><dd>{r.runId ? <code>{r.runId}</code> : "Unknown (the caller sent none)"}</dd></div>
          <div><dt>Parent ID</dt><dd>{r.parentId ? <code>{r.parentId}</code> : "Unknown (the caller sent none)"}</dd></div>
          <div><dt>Correlation ID</dt><dd>{r.correlationId ? <code>{r.correlationId}</code> : "None"}</dd></div>
          <div><dt>Protocol</dt><dd>{r.protocol}{r.stream ? " · streaming" : " · non-streaming"}</dd></div>
          <div><dt>Outcome</dt><dd>{r.outcome ?? "Unknown"}</dd></div>
          <div><dt>Finish reason</dt><dd>{r.finishReason ?? "Not reported"}</dd></div>
          <div><dt>Latency</dt><dd>{r.latencyMs === null ? "Not recorded" : `${r.latencyMs} ms`}</dd></div>
          <div><dt>Failure code</dt><dd>{r.failureCode ?? "None"}</dd></div>
          <div><dt>Finished</dt><dd>{r.finishedAt ? formatUtc(r.finishedAt) : "Not recorded"}</dd></div>
          <div><dt>Price version</dt><dd><code>{r.priceVersion}</code></dd></div>
        </dl>
      </section>

      <section aria-labelledby="tok-head" className="section--ruled">
        <h2 id="tok-head" className="section-title">Token usage and rates</h2>
        <div className="table-wrap" role="region" aria-label="Token usage table" tabIndex={0}>
          <table className="data-table" data-testid="token-table">
            <caption className="sr-only">Tokens by category with the rate applied</caption>
            <thead><tr><th scope="col">Category</th><th scope="col" className="num">Tokens</th><th scope="col">Rate</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.label}>
                  <th scope="row">{x.label}</th>
                  <td className="num">{formatCount(x.tokens)}</td>
                  <td>{<Rate perMtok={x.rate ?? null} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" data-testid="rate-note">
          Rates are the frozen snapshot for price version <code>{r.priceVersion}</code>. Cached tokens are not part of the input count.
        </p>
      </section>

      <section aria-labelledby="ledger-head" className="section--ruled"><h2 id="ledger-head" className="section-title">Ledger evidence</h2><p>Computed charge: {formatUsdDisplay(r.computedChargeMicrousd)} USD. Absorbed by service: {formatUsdDisplay(r.absorbedMicrousd)} USD.</p>{r.ledgerTransactionId && <p>Transaction <code>{r.ledgerTransactionId}</code></p>}{r.ledgerEntries.length === 0 ? <p>No posted ledger entries for this request.</p> : <ul className="evidence-list">{r.ledgerEntries.map((e) => <li key={e.id}>{e.kind}: {e.amountMicrousd} micro-USD · <code>{e.transactionId}</code></li>)}</ul>}</section>
      <p className="small muted">Prompt content is not stored or shown. Ledger entries for this request appear on the <Link to="/app/credits">Credits</Link> page.</p>
    </>
  );
}

export function RequestDetail() {
  const { id = "" } = useParams();
  const fetcher = useCallback((signal: AbortSignal) => findRequest(id, signal), [id]);
  const [state, reload] = useLoad(fetcher);

  return (
    <div className="page-body console-page">
      <nav aria-label="Breadcrumb" className="breadcrumb"><Link to="/app/usage">Usage</Link> <span aria-hidden="true">/</span> <span aria-current="page">Request</span></nav>
      <h1 className="page-title">Request detail</h1>
      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && <div className="skeleton" role="status" aria-label="Loading request"><span /><span /></div>}
        {state.status === "error" && (
          <div className="banner banner--danger" role="alert">
            <span className="banner__title">Could not load this request</span>
            <span>{describeFailure(state.failure)}</span>
            <button type="button" className="btn btn--secondary btn--small" onClick={reload}>Retry</button>
          </div>
        )}
        {state.status === "ready" && state.data.record && <Detail r={state.data.record} />}
        {state.status === "ready" && !state.data.record && (
          <div className="empty" data-testid="request-not-found">
            <h2>Request not found</h2>
            <p className="muted">
              No request with this ID is visible to your account.
            </p>
            <Link to="/app/usage" className="btn btn--secondary">Back to usage</Link>
          </div>
        )}
      </div>
    </div>
  );
}
