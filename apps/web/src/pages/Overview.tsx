import { useMemo } from "react";
import { Link } from "react-router";
import type { ApiKey, Balance } from "@llmcrypto/contracts";
import { Badge } from "../components/StatusBadge";
import { CodeBlock } from "../components/CodeBlock";
import { useCatalog } from "../components/CatalogProvider";
import { describeFailure, getBalance, listKeys, listUsage, type ApiFailure } from "../lib/api";
import { formatCount, formatUtc } from "../lib/format";
import { REQUEST_STATUS, toQuery } from "../lib/usage-view";
import { useLoad } from "../lib/use-load";
import { activeKeyCount, formatUsdDisplay } from "../lib/keys";
import { useSession } from "../lib/session";
import { API_KEY_PLACEHOLDER, MODEL_PLACEHOLDER, firstRequestCurl } from "../lib/snippets";

function Skeleton({ label }: { label: string }) {
  return <div className="skeleton" role="status" aria-label={label}><span /></div>;
}

function LoadError({ what, failure, onRetry }: { what: string; failure: ApiFailure; onRetry(): void }) {
  return (
    <div className="banner banner--danger" role="alert">
      <span className="banner__title">Could not load {what}</span>
      <span>{describeFailure(failure)}</span>
      <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>Retry</button>
    </div>
  );
}

const fetchRecent = (signal: AbortSignal) => listUsage(toQuery({}, null, 8), signal);

export function Overview() {
  const { state: sess } = useSession();
  const [balance, reloadBalance] = useLoad<Balance>(getBalance);
  const [keys, reloadKeys] = useLoad(listKeys);
  const [recent, reloadRecent] = useLoad(fetchRecent);
  const catalog = useCatalog();

  const keyList: ApiKey[] | null = keys.status === "ready" ? keys.data.items : null;
  const active = useMemo(() => (keyList ? activeKeyCount(keyList, new Date()) : null), [keyList]);
  const modelId = catalog.state.status === "ready" && catalog.state.source === "api" ? (catalog.state.data.items[0]?.id ?? MODEL_PLACEHOLDER) : MODEL_PLACEHOLDER;
  const recentCost = recent.status === "ready" ? recent.data.items.reduce((s, r) => s + BigInt(r.chargeMicrousd), 0n).toString() : null;
  const funded = balance.status === "ready" && BigInt(balance.data.availableMicrousd) > 0n;
  const role = sess.status === "signed-in" ? sess.session.membership.role : null;
  const canSeeKeys = role === "owner" || role === "admin";

  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <div className="page-head">
        <h1 className="page-title">Overview</h1>
        <Link to="/app/credits" className="btn btn--primary">Add credit</Link>
      </div>

      <section aria-labelledby="ledger-head" aria-busy={balance.status === "loading" || keys.status === "loading"}>
        <h2 id="ledger-head" className="sr-only">Balance and keys</h2>
        <dl className="ledger-header">
          <div className="ledger-header__cell ledger-header__cell--lead">
            <dt>Available credit</dt>
            <dd>
              {balance.status === "loading" && <Skeleton label="Loading balance" />}
              {balance.status === "ready" && <span className="amount" data-testid="available">{formatUsdDisplay(balance.data.availableMicrousd)} <span className="unit">USD</span></span>}
              {balance.status === "error" && <span className="amount amount--na">Balance unavailable</span>}
            </dd>
          </div>
          <div className="ledger-header__cell">
            <dt>Held for in-flight requests</dt>
            <dd>
              {balance.status === "loading" && <Skeleton label="Loading held balance" />}
              {balance.status === "ready" && <span className="amount amount--small" data-testid="held">{formatUsdDisplay(balance.data.heldMicrousd)} <span className="unit">USD</span></span>}
              {balance.status === "error" && <span className="muted">Unavailable</span>}
            </dd>
          </div>
          <div className="ledger-header__cell">
            <dt>Cost of the latest {recent.status === "ready" ? recent.data.items.length : ""} requests</dt>
            <dd>
              {recent.status === "loading" && <Skeleton label="Loading recent cost" />}
              {recent.status === "ready" && <span className="amount amount--small" data-testid="recent-cost">{formatUsdDisplay(recentCost ?? "0")} <span className="unit">USD</span></span>}
              {recent.status === "error" && <span className="muted">Unavailable</span>}
            </dd>
          </div>
          <div className="ledger-header__cell">
            <dt>Active keys</dt>
            <dd>
              {keys.status === "loading" && <Skeleton label="Loading keys" />}
              {keys.status === "ready" && <span className="amount amount--small" data-testid="active-keys">{active}</span>}
              {keys.status === "error" && <span className="muted">{canSeeKeys ? "Unavailable" : "Not available for your role"}</span>}
            </dd>
          </div>
        </dl>
        {balance.status === "ready" && (
          <p className="small muted">Balance as of <time dateTime={balance.data.asOf}>{new Date(balance.data.asOf).toLocaleTimeString()}</time>. <button type="button" className="link-button" onClick={reloadBalance}>Refresh</button></p>
        )}
        {balance.status === "error" && <LoadError what="balance" failure={balance.failure} onRetry={reloadBalance} />}
        {keys.status === "error" && canSeeKeys && <LoadError what="keys" failure={keys.failure} onRetry={reloadKeys} />}
      </section>

      <section aria-labelledby="recent-head" className="section--ruled" aria-busy={recent.status === "loading"}>
        <h2 id="recent-head" className="section-title">Recent requests</h2>
        {recent.status === "loading" && <Skeleton label="Loading recent requests" />}
        {recent.status === "error" && <LoadError what="recent requests" failure={recent.failure} onRetry={reloadRecent} />}
        {recent.status === "ready" && recent.data.items.length === 0 && (
          <div className="empty" data-testid="recent-empty"><h3>No requests yet</h3><p className="muted">Send one with the example below and it appears here with its cost.</p></div>
        )}
        {recent.status === "ready" && recent.data.items.length > 0 && (
          <>
            <div className="table-wrap" role="region" aria-label="Recent requests table" tabIndex={0}>
              <table className="data-table" data-testid="recent-table">
                <caption className="sr-only">The latest requests</caption>
                <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" className="num">Tokens in / out</th><th scope="col" className="num">Charge (USD)</th></tr></thead>
                <tbody>
                  {recent.data.items.map((r) => (
                    <tr key={r.id}>
                      <th scope="row"><Link to={`/app/usage/${encodeURIComponent(r.requestId)}`} state={{ record: r }}><time dateTime={r.createdAt}>{formatUtc(r.createdAt)}</time></Link></th>
                      <td><code>{r.model}</code></td>
                      <td><Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge></td>
                      <td className="num">{formatCount((BigInt(r.inputTokens) + BigInt(r.cachedInputTokens)).toString())} / {formatCount(r.outputTokens)}</td>
                      <td className="num">{formatUsdDisplay(r.chargeMicrousd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted"><Link to="/app/usage">View all usage</Link></p>
          </>
        )}
      </section>

      <section aria-labelledby="first-head" className="section--ruled first-request">
        <h2 id="first-head" className="section-title">{funded && active ? "Connect a tool" : "First request"}</h2>
        <ol className="steps steps--wide">
          <li>
            <div>
              <p><strong>Add credit</strong> {balance.status === "ready" && <Badge tone={funded ? "success" : "pending"}>{funded ? "Done" : "To do"}</Badge>}</p>
              <p className="muted">{funded ? "Credit is available." : <>Requests need available credit. Deposit on the <Link to="/app/credits">Credits</Link> page. A new account starts at zero.</>}</p>
            </div>
          </li>
          <li>
            <div>
              <p><strong>Create an API key</strong> {active !== null && <Badge tone={active > 0 ? "success" : "pending"}>{active > 0 ? "Done" : "To do"}</Badge>}</p>
              <p className="muted">{active ? "You have an active key." : <>Create one on the <Link to="/app/keys">API keys</Link> page. The secret is shown once.</>}</p>
            </div>
          </li>
          <li>
            <div>
              <p><strong>Send a first request</strong></p>
              <p className="muted">Replace <code>{API_KEY_PLACEHOLDER}</code> with your key. This is a template; no real key is shown here.</p>
            </div>
          </li>
        </ol>
        <CodeBlock code={firstRequestCurl(window.location.origin, modelId)} label="cURL, Chat Completions" what="first request command" />
        {modelId === MODEL_PLACEHOLDER && <p className="small muted">Replace <code>{MODEL_PLACEHOLDER}</code> with a model ID from the catalog.</p>}
        <p className="small muted">The gateway only forwards requests once credit exists and a provider is configured; a failed request here does not mean sign-in is broken.</p>
      </section>
    </div>
  );
}
