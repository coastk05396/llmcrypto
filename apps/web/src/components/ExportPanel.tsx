import { useEffect, useRef, useState } from "react";
import type { ExportFormat, Job, UsageFilters } from "@llmcrypto/contracts";
import { createExport, describeFailure, getJob } from "../lib/api";
import { formatCount, formatSignedUsd, formatUtc } from "../lib/format";
import { AttemptKeys } from "../lib/keys";
import { useSession } from "../lib/session";
import { Badge } from "./StatusBadge";

const POLL_MS = 1500;
const MAX_POLLS = 120;

type State =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "job"; job: Job; polls: number }
  | { phase: "error"; message: string };

/** Requests an export of the usage rows matching `filters`, polls the job, and offers the same-origin download link. */
export function ExportPanel({ filters }: { filters: UsageFilters }) {
  const { handleFailure } = useSession();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [state, setState] = useState<State>({ phase: "idle" });
  const attempts = useRef(new AttemptKeys());
  const jobId = state.phase === "job" ? state.job.jobId : null;
  const status = state.phase === "job" ? state.job.status : null;
  const polls = state.phase === "job" ? state.polls : 0;

  useEffect(() => {
    if (!jobId || (status !== "queued" && status !== "running")) return;
    if (polls >= MAX_POLLS) {
      setState({ phase: "error", message: "The export is taking longer than expected. Check back later; the job continues on the server." });
      return;
    }
    const t = window.setTimeout(() => {
      void getJob(jobId).then((r) => {
        if (r.ok) setState({ phase: "job", job: r.data, polls: polls + 1 });
        else if (!handleFailure(r.error)) setState({ phase: "error", message: `Could not read the export job. ${describeFailure(r.error)}` });
      });
    }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [jobId, status, polls, handleFailure]);

  async function start() {
    const body = { kind: "usage" as const, filters, format };
    setState({ phase: "starting" });
    const r = await createExport(body, attempts.current.keyFor(body));
    if (r.ok) {
      attempts.current.reset();
      setState({ phase: "job", job: { jobId: r.data.jobId, status: r.data.status }, polls: 0 });
      return;
    }
    if (handleFailure(r.error)) return;
    const gone = r.error.kind === "http" && (r.error.status === 404 || r.error.status === 501);
    setState({ phase: "error", message: gone ? "Exports are not available on this server yet." : `The export could not be started. ${describeFailure(r.error)}` });
  }

  const busy = state.phase === "starting" || status === "queued" || status === "running";
  const job = state.phase === "job" ? state.job : null;
  return (
    <section aria-labelledby="export-head" className="export-panel">
      <h2 id="export-head" className="section-title">Export</h2>
      <p className="muted small">Exports the requests that match the filters above, as a file you download. CSV cells that start with a formula character are neutralised.</p>
      <div className="export-panel__row">
        <div className="field field--inline">
          <label htmlFor="export-format">Format</label>
          <select id="export-format" value={format} onChange={(e) => { setFormat(e.target.value as ExportFormat); setState({ phase: "idle" }); }} disabled={busy}>
            <option value="csv">CSV</option>
            <option value="jsonl">JSON Lines</option>
          </select>
        </div>
        <button type="button" className="btn btn--secondary" aria-disabled={busy} onClick={() => { if (!busy) void start(); }}>{busy ? "Preparing export" : "Request export"}</button>
      </div>
      <div role="status" aria-live="polite" data-testid="export-status">
        {job && (job.status === "queued" || job.status === "running") && <Badge tone="pending">{job.status === "queued" ? "Export queued" : "Export running"}</Badge>}
        {job && job.status === "succeeded" && (
          <div className="export-panel__done">
            <Badge tone="success">Export ready</Badge>
            {job.summary && <p>{formatCount(job.summary.rowCount)} rows, total {formatSignedUsd(job.summary.totalMicrousd, false)} USD.{job.expiresAt ? <> Link expires <time dateTime={job.expiresAt}>{formatUtc(job.expiresAt)}</time>.</> : null}</p>}
            {job.downloadUrl && <a className="btn btn--primary" href={job.downloadUrl} download data-testid="export-download">Download {format === "csv" ? "CSV" : "JSON Lines"}</a>}
          </div>
        )}
        {job && job.status === "failed" && <p className="banner banner--danger" role="alert"><span className="banner__title">Export failed</span><span>{job.error?.message ?? "The export job failed."} Request it again.</span></p>}
        {job && job.status === "expired" && <p className="banner banner--warning"><span className="banner__title">Export expired</span><span>The download link is no longer valid. Request the export again.</span></p>}
      </div>
      {state.phase === "error" && <p className="banner banner--danger" role="alert"><span className="banner__title">Export unavailable</span><span>{state.message}</span></p>}
    </section>
  );
}
