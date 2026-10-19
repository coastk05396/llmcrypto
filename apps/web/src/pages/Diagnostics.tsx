import { useCallback, useEffect, useRef, useState } from "react";
import { IMPORT_LIMITS, formatUsd, reportToCsv, reportToJson, type ExcludedRow, type PriceSnapshot, type UsageReport, type UsageRow } from "@llmcrypto/domain";
import { Badge } from "../components/StatusBadge";
import { useCatalog } from "../components/CatalogProvider";
import { SAMPLE_CATALOG, SAMPLE_CATALOG_DATE } from "../lib/sample-catalog";
import { SAMPLE_USAGE_CSV } from "../lib/sample-usage";
import type { AnalyzeRequest, AnalyzeResponse } from "../workers/protocol";

type State =
  | { status: "idle" }
  | { status: "working"; name: string }
  | { status: "error"; message: string }
  | { status: "done"; report: UsageReport; preview: UsageRow[]; excluded: ExcludedRow[]; name: string };

const MAX_MB = IMPORT_LIMITS.maxInputBytes / 1024 / 1024;
const n = (v: bigint | number) => v.toLocaleString("en-US");
const usd = (v: bigint) => formatUsd(v);

const REASON_TEXT: Record<string, string> = {
  missing_model: "No model value",
  missing_input_tokens: "No input token count",
  missing_output_tokens: "No output token count",
  invalid_number: "Token count is not a non-negative whole number",
  invalid_row: "Row is not a JSON object or valid line",
};
const SKIP_TEXT: Record<string, string> = {
  directory: "folder",
  unsafe_path: "unsafe path, ignored",
  unsupported_type: "not a CSV, JSON or JSONL file",
  encrypted: "encrypted, cannot be read",
  unsupported_method: "unsupported compression",
  hidden_metadata: "system metadata file",
};

function download(name: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Results({ s, onDownload }: { s: Extract<State, { status: "done" }>; onDownload: (kind: "json" | "csv") => void }) {
  const { report, preview, excluded } = s;
  const c = report.comparison;
  return (
    <section className="report" aria-labelledby="report-h">
      <div className="report__head">
        <h2 id="report-h" tabIndex={-1}>Report: {s.name}</h2>
        {report.sample && <Badge tone="warning">Sample report - not your data</Badge>}
      </div>
      {report.sample && <p className="banner banner--warning"><span className="banner__title">Sample</span><span>This report uses an invented usage file and invented prices so you can see the layout. Import your own file above to analyze real data.</span></p>}

      <div className="actions no-print">
        <button type="button" className="btn btn--primary btn--small" onClick={() => onDownload("json")}>Download report (JSON)</button>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => onDownload("csv")}>Download model table (CSV)</button>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => window.print()}>Print</button>
      </div>

      <h3>Summary</h3>
      <dl className="facts facts--grid">
        <div><dt>Files read</dt><dd>{report.files.map((f) => `${f.name} (${n(f.rows)} rows)`).join(", ")}</dd></div>
        <div><dt>Usable rows</dt><dd>{n(report.rowsRead)}</dd></div>
        <div><dt>Matched to a catalog model</dt><dd>{n(report.rowsMatched)}</dd></div>
        <div><dt>Unmatched model</dt><dd>{n(report.rowsUnmatched)}</dd></div>
        <div><dt>Excluded rows</dt><dd>{n(report.excludedTotal)}</dd></div>
      </dl>

      <h3>Price snapshot</h3>
      <p>Version <code>{report.snapshot.pricingVersion}</code>, source: {report.snapshot.source}, as of {report.snapshot.asOf}, {report.snapshot.modelCount} models. {report.snapshot.isSample && <Badge tone="warning">Sample prices</Badge>}</p>

      <h3>Comparison</h3>
      {c.status === "complete" ? (
        <dl className="facts facts--grid">
          <div><dt>Recorded cost in your file</dt><dd className="num">{usd(c.recordedMicrousd)} USD</dd></div>
          <div><dt>Same tokens at snapshot rates</dt><dd className="num">{usd(c.estimatedMicrousd)} USD</dd></div>
          <div><dt>Difference</dt><dd className="num">{c.direction === "equal" ? "None" : `${usd(c.differenceMicrousd)} USD, snapshot estimate is ${c.direction === "estimate_lower" ? "lower" : "higher"}`}</dd></div>
        </dl>
      ) : (
        <p className="banner banner--info"><span className="banner__title">Insufficient data</span><span>{c.reason === "no_matched_rows" ? "No rows matched a catalog model, so nothing could be priced." : `Only ${n(c.rowsWithRecordedCost)} of ${n(c.matchedRows)} matched rows have a recorded cost, so no comparison is shown. The estimates below still use the snapshot.`}</span></p>
      )}
      <p className="muted small">This is an estimate from the stated snapshot, not a quote and not a promise of savings.</p>

      <h3>Matched models</h3>
      {report.matched.length === 0 ? <p className="empty">No models matched.</p> : (
        <div className="table-wrap" role="region" aria-label="Matched models table" tabIndex={0}>
          <table className="data-table">
            <caption className="sr-only">Estimated cost per matched model</caption>
            <thead><tr><th scope="col">Model</th><th scope="col" className="num">Requests</th><th scope="col" className="num">Input tokens</th><th scope="col" className="num">Output tokens</th><th scope="col" className="num">Cached tokens</th><th scope="col" className="num">Estimated (USD)</th><th scope="col" className="num">Recorded (USD)</th></tr></thead>
            <tbody>
              {report.matched.map((m) => (
                <tr key={m.catalogId}>
                  <th scope="row"><code>{m.model}</code></th>
                  <td className="num">{n(m.requests)}</td><td className="num">{n(m.inputTokens)}</td><td className="num">{n(m.outputTokens)}</td><td className="num">{n(m.cachedInputTokens)}</td>
                  <td className="num">{usd(m.estimatedMicrousd)}</td>
                  <td className="num">{m.recordedMicrousd === null ? "Not in file" : usd(m.recordedMicrousd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Unmatched models</h3>
      {report.unmatched.length === 0 ? <p className="muted">Every model in the file matched the snapshot.</p> : (
        <>
          <p className="muted">These model IDs are not in the price snapshot, or the snapshot rate for them is unreadable. They are not priced and not included in any total.</p>
          <div className="table-wrap" role="region" aria-label="Unmatched models table" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">Models with no price in the snapshot</caption>
              <thead><tr><th scope="col">Model in file</th><th scope="col">Reason</th><th scope="col" className="num">Requests</th><th scope="col" className="num">Input tokens</th><th scope="col" className="num">Output tokens</th></tr></thead>
              <tbody>{report.unmatched.map((u) => <tr key={u.model}><th scope="row"><code>{u.model}</code></th><td>{u.reason === "invalid_rate" ? "Snapshot rate unreadable" : "Not in snapshot"}</td><td className="num">{n(u.requests)}</td><td className="num">{n(u.inputTokens)}</td><td className="num">{n(u.outputTokens)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}

      <h3>Excluded items</h3>
      {report.excludedTotal === 0 && report.skippedEntries.length === 0 ? <p className="muted">Nothing was excluded.</p> : (
        <>
          {report.excludedTotal > 0 && (
            <>
              <p>{n(report.excludedTotal)} rows were excluded: {Object.entries(report.excludedByReason).map(([k, v]) => `${REASON_TEXT[k] ?? k} (${n(v)})`).join("; ")}.</p>
              <div className="table-wrap" role="region" aria-label="Excluded rows table" tabIndex={0}>
                <table className="data-table">
                  <caption className="sr-only">First excluded rows</caption>
                  <thead><tr><th scope="col">File</th><th scope="col" className="num">Row</th><th scope="col">Reason</th></tr></thead>
                  <tbody>{excluded.slice(0, 20).map((x, i) => <tr key={i}><th scope="row"><code>{x.file}</code></th><td className="num">{x.row}</td><td>{x.detail}</td></tr>)}</tbody>
                </table>
              </div>
              {excluded.length > 20 && <p className="muted small">Showing the first 20 excluded rows.</p>}
            </>
          )}
          {report.skippedEntries.length > 0 && <p>Skipped archive entries: {report.skippedEntries.map((e) => `${e.name} (${SKIP_TEXT[e.reason] ?? e.reason})`).join("; ")}.</p>}
        </>
      )}
      {report.unknownColumns.length > 0 && <p><strong>Unrecognized fields</strong> (ignored): {report.unknownColumns.map((c) => <code key={c}>{c} </code>)}</p>}
      {report.unreadableCostValues > 0 && <p className="muted">{n(report.unreadableCostValues)} cost values could not be read and were treated as missing.</p>}

      <h3>Preview of recognized rows</h3>
      <div className="table-wrap" role="region" aria-label="Preview table" tabIndex={0}>
        <table className="data-table">
          <caption className="sr-only">First recognized rows after normalization</caption>
          <thead><tr><th scope="col">Row</th><th scope="col">Model</th><th scope="col" className="num">Input</th><th scope="col" className="num">Output</th><th scope="col" className="num">Cached</th><th scope="col" className="num">Cost in file (USD)</th></tr></thead>
          <tbody>{preview.map((r) => <tr key={`${r.file}:${r.row}`}><th scope="row" className="num">{r.row}</th><td><code>{r.model}</code></td><td className="num">{n(r.inputTokens)}</td><td className="num">{n(r.outputTokens)}</td><td className="num">{n(r.cachedInputTokens)}</td><td className="num">{r.recordedCostMicrousd === null ? "-" : usd(r.recordedCostMicrousd)}</td></tr>)}</tbody>
        </table>
      </div>

      <h3>Method and caveats</h3>
      <ul>{report.notes.map((t) => <li key={t}>{t}</li>)}</ul>
    </section>
  );
}

export function Diagnostics() {
  const { state: catalog } = useCatalog();
  const [state, setState] = useState<State>({ status: "idle" });
  const worker = useRef<Worker | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => {
    if (state.status === "done") document.getElementById("report-h")?.focus();
  }, [state.status]);

  const run = useCallback((name: string, file: File | null, sampleCsv: string | null, snapshot: PriceSnapshot) => {
    worker.current?.terminate();
    const w = new Worker(new URL("../workers/diagnostics.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setState({ status: "working", name });
    w.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
      const m = e.data;
      setState(m.type === "result" ? { status: "done", report: m.report, preview: m.preview, excluded: m.excluded, name } : { status: "error", message: m.message });
      w.terminate();
    };
    w.onerror = () => {
      setState({ status: "error", message: "The file could not be processed." });
      w.terminate();
    };
    const req: AnalyzeRequest = { type: "analyze", file, sampleCsv, snapshot, generatedAt: new Date().toISOString() };
    w.postMessage(req);
  }, []);

  const snapshotFromCatalog = (): PriceSnapshot | null => {
    if (catalog.status !== "ready") return null;
    return {
      pricingVersion: catalog.data.pricingVersion,
      source: catalog.source === "api" ? "Gateway catalog API (entry dates vary)" : "Bundled sample data (API unreachable)",
      asOf: catalog.asOf,
      isSample: catalog.source === "sample",
      models: catalog.data.items,
    };
  };

  function onFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const snap = snapshotFromCatalog();
    if (!snap) return setState({ status: "error", message: "Prices are still loading. Try again in a moment." });
    if (f.size > IMPORT_LIMITS.maxInputBytes) return setState({ status: "error", message: `The file is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_MB} MB.` });
    run(f.name, f, null, snap);
  }

  function runSample() {
    run("Sample usage export", null, SAMPLE_USAGE_CSV, {
      pricingVersion: SAMPLE_CATALOG.pricingVersion,
      source: "Bundled sample data",
      asOf: SAMPLE_CATALOG_DATE,
      isSample: true,
      models: SAMPLE_CATALOG.items,
    });
  }

  function onDownload(kind: "json" | "csv") {
    if (state.status !== "done") return;
    const tag = state.report.sample ? "sample-" : "";
    if (kind === "json") download(`${tag}usage-report.json`, "application/json", reportToJson(state.report));
    else download(`${tag}usage-models.csv`, "text/csv;charset=utf-8", reportToCsv(state.report));
  }

  const busy = state.status === "working";
  return (
    <div className="container page-body">
      <p className="eyebrow no-print">Usage comparison</p>
      <h1 className="page-title">Check your usage export locally</h1>
      <p className="lead">Import a ZIP, CSV, JSON or JSONL export of your own usage. It is read and priced inside your browser against a dated price snapshot.</p>

      <div className="banner banner--success no-print" role="note">
        <span className="banner__title">Stays on this device</span>
        <span>The file is processed in a Web Worker. This page makes no upload request with it, and there is no upload option.</span>
      </div>

      <section className="import no-print" aria-labelledby="import-h">
        <h2 id="import-h">Import</h2>
        <div className="field">
          <label htmlFor="usage-file">Usage export file</label>
          <input ref={fileInput} id="usage-file" type="file" accept=".zip,.csv,.json,.jsonl,.ndjson" aria-describedby="usage-limits" disabled={busy} onChange={(e) => { onFile(e.target.files); e.target.value = ""; }} />
        </div>
        <ul id="usage-limits" className="small muted">
          <li>Up to {MAX_MB} MB per file. ZIP archives: at most {IMPORT_LIMITS.maxZipEntries} entries, {IMPORT_LIMITS.maxEntryBytes / 1024 / 1024} MB per file and {IMPORT_LIMITS.maxTotalBytes / 1024 / 1024} MB in total after decompression; encrypted, nested and unsafe-path entries are ignored.</li>
          <li>Up to {n(IMPORT_LIMITS.maxRows)} rows. Each row needs a model plus input and output token counts (<code>input_tokens</code>/<code>prompt_tokens</code>, <code>output_tokens</code>/<code>completion_tokens</code>). Optional: <code>cached_tokens</code>, <code>cost_usd</code>, <code>timestamp</code>. Nested <code>usage</code> objects are read.</li>
          <li>Models match catalog IDs exactly, ignoring case. Cached tokens are treated as separate from input tokens.</li>
        </ul>
        <div className="actions">
          <button type="button" className="btn btn--secondary btn--small" onClick={runSample} disabled={busy}>Show sample report</button>
        </div>
        <p className="muted small">Prices for your file come from: {catalog.status === "loading" ? "loading..." : catalog.source === "api" ? `gateway catalog ${catalog.data.pricingVersion}` : `bundled sample data dated ${catalog.asOf} (the catalog API is unreachable, so results will be labelled as using sample prices)`}.</p>
      </section>

      <div role="status" aria-live="polite" className="status-line">
        {state.status === "working" && <p><Badge tone="pending">Analyzing {state.name}</Badge></p>}
      </div>
      {state.status === "error" && (
        <div className="banner banner--danger" role="alert"><span className="banner__title">Could not import</span><span>{state.message}</span></div>
      )}
      {state.status === "done" && <Results s={state} onDownload={onDownload} />}
    </div>
  );
}
