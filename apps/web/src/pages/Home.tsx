import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { CatalogModel } from "@llmcrypto/contracts";
import { formatUsd, tokenCharge } from "@llmcrypto/domain";
import { Badge } from "../components/StatusBadge";
import { CodeBlock } from "../components/CodeBlock";
import { CopyButton } from "../components/CopyButton";
import { Tabs } from "../components/Tabs";
import { useCatalog } from "../components/CatalogProvider";
import {
  PROTOCOL_LABELS,
  SORT_LABELS,
  filterCatalog,
  formatContext,
  formatRate,
  providersOf,
  resultCountText,
  sortCatalog,
  type SortKey,
} from "../lib/catalog";
import { GUIDE_STATUS_LABEL, quickstartSnippets } from "../lib/snippets";

/** Example request priced with the same bigint rule the gateway ledger will use. Labelled as example data. */
function Specimen() {
  const rate = { input: 3_000_000n, output: 15_000_000n };
  const inTok = 12_400n;
  const outTok = 800n;
  const cin = tokenCharge(inTok, rate.input);
  const cout = tokenCharge(outTok, rate.output);
  return (
    <figure className="specimen">
      <figcaption>
        <span className="eyebrow">Ledger specimen</span>
        <Badge tone="info">Example data</Badge>
      </figcaption>
      <table>
        <caption className="sr-only">Example request cost breakdown</caption>
        <thead>
          <tr><th scope="col">Line</th><th scope="col" className="num">Tokens</th><th scope="col" className="num">Rate per 1M</th><th scope="col" className="num">Cost (USD)</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Input</th><td className="num">{inTok.toLocaleString("en-US")}</td><td className="num">$3.00</td><td className="num">{formatUsd(cin)}</td></tr>
          <tr><th scope="row">Output</th><td className="num">{outTok.toLocaleString("en-US")}</td><td className="num">$15.00</td><td className="num">{formatUsd(cout)}</td></tr>
        </tbody>
        <tfoot>
          <tr><th scope="row" colSpan={3}>Total charged</th><td className="num total">{formatUsd(cin + cout)}</td></tr>
        </tfoot>
      </table>
      <p className="muted small">Invented rates for illustration. Each category is rounded up once to a whole micro-USD.</p>
    </figure>
  );
}

function ModelRow({ m }: { m: CatalogModel }) {
  return (
    <tr>
      <th scope="row">
        <span className="model-name">{m.displayName}</span>
        <span className="model-meta small muted">Updated {m.updatedAt.slice(0, 10)}, source: {m.source}</span>
        <span className="model-id"><code id={`mid-${m.id}`}>{m.id}</code><CopyButton text={m.id} what={`model ID ${m.id}`} label="Copy ID" selectTarget={() => document.getElementById(`mid-${m.id}`)} /></span>
      </th>
      <td data-label="Provider">{m.provider}</td>
      <td className="num" data-label="Input / 1M">{formatRate(m.inputMicrousdPerMtok)}</td>
      <td className="num" data-label="Output / 1M">{formatRate(m.outputMicrousdPerMtok)}</td>
      <td className="num" data-label="Context"><span title={`${m.contextWindowTokens} tokens`}>{formatContext(m.contextWindowTokens)}</span></td>
      <td data-label="Formats">{m.protocols.map((p) => PROTOCOL_LABELS[p]).join(", ")}</td>
    </tr>
  );
}

function Catalog() {
  const { state, reload } = useCatalog();
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const items = state.status === "ready" ? state.data.items : [];
  const providers = useMemo(() => providersOf(items), [items]);
  const shown = useMemo(() => sortCatalog(filterCatalog(items, { provider, search }), sort), [items, provider, search, sort]);
  const filtering = provider !== "" || search.trim() !== "";

  return (
    <section id="catalog" tabIndex={-1} className="section" aria-labelledby="catalog-h">
      <div className="container">
        <h2 id="catalog-h" className="section-title">Model catalog</h2>

        {state.status === "ready" && state.source === "sample" && (
          <div className="banner banner--warning" role="status">
            <span className="banner__title">Sample data</span>
            <span>{state.reason} These models and prices are bundled examples dated {state.asOf}, not live prices.</span>
            <button type="button" className="btn btn--secondary btn--small" onClick={reload}>Retry</button>
          </div>
        )}
        {state.status === "ready" && state.source === "api" && (
          <p className="muted small">Pricing version <code>{state.data.pricingVersion}</code>, newest entry updated {state.asOf}. Prices are USD per one million tokens. Each row shows its own update date and source label.</p>
        )}

        <div className="toolbar" role="search" aria-label="Filter models">
          <div className="field">
            <label htmlFor="model-search">Search models</label>
            <input id="model-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, ID or provider" autoComplete="off" disabled={state.status === "loading"} />
          </div>
          <div className="field">
            <label htmlFor="provider-filter">Provider</label>
            <select id="provider-filter" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={state.status === "loading"}>
              <option value="">All providers</option>
              {providers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sort-by">Sort by</label>
            <select id="sort-by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} disabled={state.status === "loading"}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
            </select>
          </div>
        </div>
        <p className="result-count" role="status" aria-live="polite" data-testid="result-count">
          {state.status === "loading" ? "Loading models" : resultCountText(shown.length, items.length)}
        </p>

        {state.status === "loading" ? (
          <div className="skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
        ) : items.length === 0 ? (
          <p className="empty">No models are available yet.</p>
        ) : shown.length === 0 ? (
          <div className="empty" data-testid="catalog-empty">
            <p>No models match{search.trim() ? ` "${search.trim()}"` : " these filters"}.</p>
            <button type="button" className="btn btn--secondary btn--small" onClick={() => { setSearch(""); setProvider(""); document.getElementById("model-search")?.focus(); }}>Clear filters</button>
          </div>
        ) : (
          <div className="table-wrap" role="region" aria-label="Model catalog table" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">Models with input and output price per million tokens, context window and supported API formats</caption>
              <thead>
                <tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col" className="num">Input / 1M</th><th scope="col" className="num">Output / 1M</th><th scope="col" className="num">Context</th><th scope="col">Formats</th></tr>
              </thead>
              <tbody>{shown.map((m) => <ModelRow key={m.id} m={m} />)}</tbody>
            </table>
          </div>
        )}
        {filtering && shown.length > 0 && <p className="muted small">Filters are active.</p>}
        <p className="muted small">Availability and capability flags are not part of the catalog contract yet, so they are not shown. Listing a model here does not prove it can run. Rows whose source label is a sample or seed are not live provider prices.</p>
      </div>
    </section>
  );
}

function Quickstart() {
  const origin = window.location.origin;
  const snippets = quickstartSnippets(origin);
  return (
    <section id="quickstart" tabIndex={-1} className="section section--ruled" aria-labelledby="quickstart-h">
      <div className="container">
        <h2 id="quickstart-h" className="section-title">Quickstart</h2>
        <div className="split">
          <ol className="steps">
            <li><div><strong>Create an API key</strong> in the console after you sign in.</div></li>
            <li><div><strong>Pick a model ID</strong> from the catalog above and copy it.</div></li>
            <li><div><strong>Replace both placeholders</strong>, <code>YOUR_API_KEY</code> and <code>YOUR_MODEL_ID</code>, then send a request to <code>{origin}/v1</code>.</div></li>
          </ol>
          <div>
            <p><Badge tone="neutral">{GUIDE_STATUS_LABEL["docs-only"]}</Badge> <span className="muted small">None of these samples has been run against the gateway yet.</span></p>
            <Tabs
              label="Quickstart language"
              tabs={snippets.map((s) => ({
                id: s.id,
                label: s.label,
                panel: (
                  <>
                    <p className="muted small">{s.note}</p>
                    <CodeBlock code={s.code} label={`${s.label} example`} what={`${s.label} example`} />
                  </>
                ),
              }))}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

const FAQ: { q: string; a: string }[] = [
  { q: "Is the gateway live?", a: "No. This is a pre-release site. The public catalog, setup guides and the local usage comparison work; sign-in, funding and API requests are still under development." },
  { q: "How will billing work?", a: "Prepaid. Before a request runs, the gateway reserves its maximum possible cost from your available balance. After it finishes, the actual cost is charged and any unused hold is released. Available and held balance are shown separately." },
  { q: "Which API formats are planned?", a: "Anthropic Messages, OpenAI Chat Completions and OpenAI Responses shapes, plus model discovery at /v1/models. Gemini generateContent is included only once it has passed adapter tests. Image generation is not offered." },
  { q: "Are prompts stored?", a: "The design stores minimal request metadata by default, not prompt bodies. Capturing prompts would be an explicit opt-in with a retention limit. This describes the intended design, not a deployed system." },
  { q: "How are API keys handled?", a: "Keys are designed to be shown once at creation and stored only as digests. Examples on this site always use the placeholder YOUR_API_KEY. Never paste a real key into a page, issue or chat." },
  { q: "Does the usage comparison upload my file?", a: "No. The file is read and processed in a Web Worker in your browser, with a 25 MB limit. Nothing is sent over the network. The result is an estimate against a dated price snapshot, not a promise of savings." },
];

function Faq() {
  return (
    <section id="faq" tabIndex={-1} className="section section--ruled" aria-labelledby="faq-h">
      <div className="container">
        <h2 id="faq-h" className="section-title">Questions</h2>
        <div className="faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Home() {
  return (
    <>
      <section className="hero">
        <div className="container hero__grid">
          <div>
            <p className="eyebrow">Prepaid LLM gateway - pre-release</p>
            <h1>One account, one key, many models, paid in advance</h1>
            <p className="lead">Compare model prices, follow setup guides, and check your own usage export without leaving your browser. Accounts and the API itself are still being built.</p>
            <div className="actions">
              <Link to="/app" className="btn btn--primary">Sign in</Link>
              <a href="#catalog" className="btn btn--secondary" onClick={(e) => { e.preventDefault(); document.getElementById("catalog")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); document.getElementById("catalog")?.focus({ preventScroll: true }); }}>Browse models</a>
            </div>
          </div>
          <Specimen />
        </div>
      </section>

      <section id="overview" tabIndex={-1} className="section section--ruled" aria-labelledby="overview-h">
        <div className="container">
          <h2 id="overview-h" className="section-title">What the gateway is built to do</h2>
          <p className="muted"><Badge tone="warning">Under development</Badge> These are design goals from the product specification, not claims about a running service.</p>
          <ul className="benefits">
            <li><h3>Prepaid, with holds</h3><p>Requests reserve a maximum cost first, so concurrent requests cannot spend the same funds. Held and available balance stay separate.</p></li>
            <li><h3>Scoped keys</h3><p>Keys carry a name, scope, optional spend cap and model allow-list. A secret is shown once and can be revoked.</p></li>
            <li><h3>Exact accounting</h3><p>Money is whole micro-USD integers. Each charge records the price version it used, so a later price change does not rewrite past charges.</p></li>
            <li><h3>Local diagnostics</h3><p>Compare an export of your own usage against a dated price snapshot. The file never leaves your device.</p></li>
          </ul>
        </div>
      </section>

      <Catalog />
      <Quickstart />

      <section id="billing" tabIndex={-1} className="section section--ruled" aria-labelledby="billing-h">
        <div className="container">
          <h2 id="billing-h" className="section-title">Billing</h2>
          <ol className="steps steps--wide">
            <li><div><strong>Deposit.</strong> You will create a deposit intent for a supported asset and network.</div></li>
            <li><div><strong>Credit appears after confirmations.</strong> Only finalized, matched on-chain transfers are credited, once each.</div></li>
            <li><div><strong>Usage draws from available balance.</strong> A hold covers each in-flight request and is released or settled when it ends.</div></li>
          </ol>
          <p>Supported networks are announced when payments open. Nothing can be deposited in this build.</p>
        </div>
      </section>

      <Faq />
    </>
  );
}
