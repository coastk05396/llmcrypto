import { useMemo, useState } from "react";
import { Link } from "react-router";
import "./home.css";
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
        <p className="home-kicker">05 / EXPLORE THE MODELS</p>
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
        <p className="home-kicker">06 / BUILT FOR THE WAY YOU WORK</p>
        <h2 id="quickstart-h" className="section-title">Keep your stack.<br />Open new doors.</h2>
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
        <p className="home-kicker">08 / THE DETAILS</p>
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

function TracePreview() {
  const rows = [
    ["09:42", "northstar / prod", "Sonnet", "$0.024"],
    ["09:41", "studio / sandbox", "Gemini Flash", "$0.003"],
    ["09:39", "northstar / prod", "GPT", "$0.018"],
    ["09:34", "docs / staging", "Haiku", "$0.001"],
  ];
  return <div className="home-panel home-trace"><div className="home-panel-bar"><span>usage / recent requests</span><span>EXAMPLE DATA</span></div><div className="home-panel-body"><h3 className="home-panel-heading">A trace you can actually read.</h3><div className="home-trace-scroll" role="region" aria-label="Example request history" tabIndex={0}><table><caption className="sr-only">Illustrative request history with invented costs</caption><thead><tr>{["TIME", "KEY / PROJECT", "MODEL", "COST"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row[0]}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody></table></div><p className="home-code-caption">ILLUSTRATIVE VIEW · VALUES SHOWN FOR DESIGN CONTEXT</p></div></div>;
}

function RequestPath() {
  return (
    <ol className="home-path" aria-label="Planned request path">
      <li><span>01</span><strong>Create a project key</strong><p>Give the support assistant its own access and budget.</p></li>
      <li><span>02</span><strong>Send a request</strong><p>Use the key to reach the model you selected.</p></li>
      <li><span>03</span><strong>Inspect the trace</strong><p>See the model, project and cost for each answer.</p></li>
    </ol>
  );
}

export function Home() {
  return (
    <div className="home-landing">
      <section className="home-hero">
        <div className="container home-two-col">
          <div className="home-hero-copy">
            <p className="home-kicker">01 / A BETTER CONTROL PLANE FOR AI</p>
            <h1>Build with AI.<br />Keep the reins.</h1>
            <p className="home-intro">One gateway for model access, project keys, usage and cost. Give your team room to try different models while keeping every request—and its spend—accountable.</p>
            <div className="actions">
              <a href="#overview" className="btn btn--primary">Explore the platform ↗</a>
              <a href="#overview" className="home-text-link">See how it works →</a>
            </div>
            <p className="home-release">Pre-release · Accounts, funding and live API access are under development.</p>
          </div>
          <div className="home-panel home-workspace">
            <div className="home-panel-bar"><span>workspace / overview</span><span>DESIGN PREVIEW</span></div>
            <div className="home-panel-body">
              <p className="home-kicker">PROJECT / NORTHSTAR</p>
              <h2>A clear view of every request.</h2>
              <div className="home-mini-flow">
                <p className="home-panel-label">PLANNED REQUEST PATH</p>
                <div><span><strong>APP</strong><small>your tool</small></span><b aria-hidden="true">→</b><span><strong>GATEWAY</strong><small>key + policy</small></span><b aria-hidden="true">→</b><span><strong>MODEL</strong><small>best fit</small></span></div>
              </div>
              <p className="home-panel-label">What you can see</p>
              <div className="home-signals"><div><span>01</span><strong>ACCESS</strong><small>Keys per project</small></div><div><span>02</span><strong>CHOICE</strong><small>Models in one place</small></div><div><span>03</span><strong>SPEND</strong><small>Usage made legible</small></div></div>
            </div>
          </div>
        </div>
        <div className="container"><div id="principles" tabIndex={-1} className="home-principles"><span>ONE API ACROSS MODELS</span><span>A KEY FOR EVERY PROJECT</span><span>COST BY REQUEST</span></div></div>
      </section>

      <section id="overview" tabIndex={-1} className="section" aria-labelledby="overview-h">
        <div className="container home-two-col">
          <div>
            <p className="home-kicker">02 / THE PLATFORM</p>
            <h2 id="overview-h" className="section-title">Freedom to explore.<br />Guardrails that make sense.</h2>
            <p className="home-intro">Experiment across models while keeping the essentials close: who can access them, what ran, and where the budget went.</p>
            <ul className="home-feature-list">
              <li><span>01</span><div><h3>Give every project its own key</h3><p>Keep access intentional instead of sharing one secret everywhere.</p></div></li>
              <li><span>02</span><div><h3>Find the right model for the moment</h3><p>Choose capability and cost to match the work in front of you.</p></div></li>
              <li><span>03</span><div><h3>Understand the bill as it happens</h3><p>A request trail makes spending easier to investigate and explain.</p></div></li>
            </ul>
          </div>
          <div className="home-panel">
            <div className="home-panel-bar"><span>policies / project-northstar</span><span>PLANNED</span></div>
            <div className="home-panel-body">
              <h3 className="home-panel-heading">Know the boundaries. Move faster within them.</h3>
              <dl className="home-policy"><div><dt>PROJECT KEY</dt><dd>northstar-production <span>EXAMPLE</span></dd></div><div><dt>MONTHLY LIMIT</dt><dd>$250.00 <span>PLANNED</span></dd></div><div><dt>MODEL ACCESS</dt><dd>Selected by your team <span>PLANNED</span></dd></div></dl>
              <p className="home-note">↗ Change a key or limit without changing your workflow.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section home-workflow" aria-labelledby="path-h">
        <div className="container">
          <p className="home-kicker">03 / A REAL WORKFLOW</p>
          <h2 id="path-h" className="section-title">From first key to clear answers.</h2>
          <p className="home-intro">For example: launch a support assistant with its own key, route its requests to a model, then inspect the cost of every answer.</p>
          <div className="home-panel home-path-panel"><p className="home-panel-label">SUPPORT ASSISTANT / EXAMPLE WORKFLOW</p><RequestPath /></div>
          <p className="home-caption">One path from setup to insight—with the request trail ready when you need it.</p>
        </div>
      </section>

      <section className="section" aria-labelledby="details-h">
        <div className="container home-two-col">
          <div><p className="home-kicker">04 / SEE THE WHOLE STORY</p><h2 id="details-h" className="section-title">The useful details,<br />not another dashboard.</h2><p className="home-intro">Turn opaque AI calls into a readable trail. Understand which model ran, which key called it and what it cost—without digging through logs.</p><p className="home-quote">“Good infrastructure makes the invisible visible.”</p></div>
          <TracePreview />
        </div>
      </section>

      <section id="developer" tabIndex={-1} className="section home-developer" aria-labelledby="developer-h">
        <div className="container home-two-col">
          <div><p className="home-kicker">05 / BUILT FOR THE WAY YOU WORK</p><h2 id="developer-h" className="section-title">Keep your stack.<br />Open new doors.</h2><p className="home-intro">Start where you are—an SDK, an agent, or a simple HTTP call. Make model access feel like part of your workflow, not another platform to learn.</p><div className="actions"><a href="#quickstart" className="btn btn--primary">Start building ↗</a><Link to="/docs" className="home-text-link">Explore the approach →</Link></div><p className="home-developer-note">LESS FRICTION / MORE SIGNAL / YOUR DIRECTION</p></div>
          <div className="home-panel"><div className="home-panel-bar"><span>quickstart / example.ts</span><span>TYPESCRIPT</span></div><div className="home-panel-body"><p className="home-kicker">ONE INTERFACE. YOUR CHOICE OF MODEL.</p><CodeBlock code={'const response = await fetch("/v1/chat/completions", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer YOUR_API_KEY",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({\n    model: "YOUR_MODEL_ID",\n    messages: [{ role: "user", content: "Hello" }],\n  }),\n});'} label="TypeScript request example" what="TypeScript request example" /><p className="home-code-caption">ILLUSTRATIVE CONFIGURATION · NOT A LIVE ENDPOINT</p></div></div>
        </div>
      </section>
      <Catalog />
      <Quickstart />

      <section id="billing" tabIndex={-1} className="section section--ruled" aria-labelledby="billing-h">
        <div className="container">
          <p className="home-kicker">07 / A CLEARER BALANCE</p>
          <h2 id="billing-h" className="section-title">Pay ahead. Know where you stand.</h2>
          <ol className="steps steps--wide">
            <li><div><strong>Deposit.</strong> You will create a deposit intent for a supported asset and network.</div></li>
            <li><div><strong>Credit appears after confirmations.</strong> Only finalized, matched on-chain transfers are credited, once each.</div></li>
            <li><div><strong>Usage draws from available balance.</strong> A hold covers each in-flight request and is released or settled when it ends.</div></li>
          </ol>
          <p>Supported networks are announced when payments open. Nothing can be deposited in this build.</p>
          <Specimen />
        </div>
      </section>
      <Faq />
    </div>
  );
}
