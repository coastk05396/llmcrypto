import { CONTRACT_VERSION, ERROR_CODES } from "@llmcrypto/contracts";
import { Badge } from "../components/StatusBadge";
import { CONSOLE_ENDPOINTS, GATEWAY_ENDPOINTS } from "../lib/endpoints";

export function Docs() {
  return (
    <div className="container page-body">
      <p className="eyebrow">API docs</p>
      <h1 className="page-title">Endpoint overview</h1>
      <p className="lead">Console API operations as defined in the shared contract snapshot (<code data-testid="contract-version">{CONTRACT_VERSION}</code>), plus the planned compatible gateway routes.</p>
      <div className="banner banner--warning" role="note">
        <span className="banner__title">Contract draft</span>
        <span>This is an overview of a draft contract, not of a deployed API. Request and response schemas live in <code>packages/contracts/openapi.yaml</code>. Streaming, limits and a changelog will be documented when the gateway exists.</span>
      </div>

      <nav aria-label="On this page" className="toc">
        <ul>
          <li><a href="#conventions">Conventions</a></li>
          <li><a href="#console-api">Console API</a></li>
          <li><a href="#gateway-api">Gateway routes</a></li>
          <li><a href="#errors">Errors</a></li>
        </ul>
      </nav>

      <section id="conventions" tabIndex={-1} className="doc-section" aria-labelledby="conventions-h">
        <h2 id="conventions-h">Conventions</h2>
        <ul>
          <li>Money is an integer decimal string in micro-USD: <code>"1500000"</code> is 1.50 USD. Token and chain amounts are non-negative integer strings. No floating point.</li>
          <li>Timestamps are UTC RFC 3339 strings.</li>
          <li>Lists return <code>{`{ items, nextCursor }`}</code>, ordered by <code>(createdAt, id)</code>; <code>limit</code> defaults to 50 and is capped at 200. The catalog is the exception: it returns the whole bounded list with a <code>pricingVersion</code>.</li>
          <li>Operations marked idempotent require an <code>Idempotency-Key</code> header. Replaying the same key and payload returns the first result; a different payload returns 409.</li>
          <li>Authenticated operations use a Secure, HttpOnly, SameSite session cookie. Mutations are origin-checked.</li>
        </ul>
      </section>

      <section id="console-api" tabIndex={-1} className="doc-section" aria-labelledby="console-h">
        <h2 id="console-h">Console API</h2>
        <div className="table-wrap" role="region" aria-label="Console API table" tabIndex={0}>
          <table className="data-table">
            <caption className="sr-only">Console API operations</caption>
            <thead><tr><th scope="col">Operation</th><th scope="col">Summary</th><th scope="col">Access</th><th scope="col">Idempotency-Key</th></tr></thead>
            <tbody>
              {CONSOLE_ENDPOINTS.map((e) => (
                <tr key={`${e.method} ${e.path}`}>
                  <th scope="row"><code>{e.method} {e.path}</code></th>
                  <td>{e.summary}</td>
                  <td>{e.auth === "public" ? "Public" : "Signed-in session"}</td>
                  <td>{e.idempotent ? "Required" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="gateway-api" tabIndex={-1} className="doc-section" aria-labelledby="gateway-h">
        <h2 id="gateway-h">Gateway routes</h2>
        <p><Badge tone="warning">Not yet available</Badge> These routes keep the upstream-compatible request and response shapes rather than the console envelope. Which models work on which route will be published as a tested matrix.</p>
        <div className="table-wrap" role="region" aria-label="Gateway routes table" tabIndex={0}>
          <table className="data-table">
            <caption className="sr-only">Planned compatible gateway routes</caption>
            <thead><tr><th scope="col">Route</th><th scope="col">Shape</th></tr></thead>
            <tbody>
              {GATEWAY_ENDPOINTS.map((e) => (
                <tr key={e.path}><th scope="row"><code>{e.method} {e.path}</code></th><td>{e.summary}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="errors" tabIndex={-1} className="doc-section" aria-labelledby="errors-h">
        <h2 id="errors-h">Errors</h2>
        <p>Console errors use <code>{`{ "error": { "code", "message", "requestId", "fieldErrors"? } }`}</code>. Rate limits include <code>Retry-After</code>.</p>
        <div className="table-wrap" role="region" aria-label="Error codes table" tabIndex={0}>
          <table className="data-table">
            <caption className="sr-only">Console error codes</caption>
            <thead><tr><th scope="col">Code</th><th scope="col" className="num">HTTP</th><th scope="col">Meaning</th></tr></thead>
            <tbody>
              {Object.entries(ERROR_CODES).map(([code, v]) => (
                <tr key={code}><th scope="row"><code>{code}</code></th><td className="num">{v.status}</td><td>{v.description}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
