import { useId, useState, type FormEvent } from "react";
import type { PreviewOptimizationResponse } from "@llmcrypto/contracts";
import { describeFailure } from "../lib/api";
import { listProjects, previewOptimization } from "../lib/api-product";
import { forbiddenCopy } from "../lib/auth-copy";
import { formatCount } from "../lib/format";
import { FEATURE_LABEL, formatDetail } from "../lib/policy";
import { useSession } from "../lib/session";
import { useLoad } from "../lib/use-load";
import { useCatalog } from "./CatalogProvider";
import { Badge } from "./StatusBadge";

const ORIGIN_LABEL = { request: "Your request", guidance: "Added: concise guidance", project_memory: "Added: project memory" } as const;

/** Shows what the provider would receive under the saved policy. The API sends, stores and charges nothing for a preview. */
export function PreviewPanel({ policyVersion }: { policyVersion: number | null }) {
  const uid = useId();
  const { handleFailure } = useSession();
  const catalog = useCatalog();
  const models = catalog.state.status === "ready" && catalog.state.source === "api" ? catalog.state.data.items.map((m) => m.id) : [];
  const [projects] = useLoad(listProjects);
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PreviewOptimizationResponse | null>(null);
  const effectiveModel = model || models[0] || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!effectiveModel.trim() || !text.trim()) {
      setError("Choose a model and write a message to preview.");
      return;
    }
    setBusy(true);
    setError("");
    const r = await previewOptimization({ model: effectiveModel.trim(), ...(projectId ? { projectId } : {}), messages: [{ role: "user", content: text }] });
    setBusy(false);
    if (r.ok) return setResult(r.data);
    if (handleFailure(r.error)) return;
    setResult(null);
    const fields = r.error.kind === "http" ? r.error.fieldErrors.map((f) => `${f.field}: ${f.message}`).join("; ") : "";
    setError(forbiddenCopy(r.error, "preview") ?? `${describeFailure(r.error)}${fields ? ` ${fields}` : ""}`);
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="section--ruled">
      <h2 id={`${uid}-h`} className="section-title">Preview the altered request</h2>
      <p className="muted">Shows exactly what would be sent to the provider under the saved policy{policyVersion !== null ? ` (version ${policyVersion})` : ""}. A preview sends nothing to a provider, stores nothing and costs nothing. Unsaved edits above are not included.</p>
      <form onSubmit={(e) => void submit(e)} noValidate className="form-stack" aria-busy={busy}>
        <div className="inline-fields">
          <div className="field">
            <label htmlFor={`${uid}-m`}>Model</label>
            {models.length > 0 ? (
              <select id={`${uid}-m`} value={effectiveModel} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
            ) : (
              <input id={`${uid}-m`} type="text" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" />
            )}
          </div>
          <div className="field">
            <label htmlFor={`${uid}-p`}>Project (for project context)</label>
            <select id={`${uid}-p`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {projects.status === "ready" && projects.data.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-t`}>Your message</label>
          <textarea id={`${uid}-t`} value={text} maxLength={100000} onChange={(e) => setText(e.target.value)} />
        </div>
        {error && <p className="banner banner--danger" role="alert"><span className="banner__title">No preview</span><span>{error}</span></p>}
        <div className="actions"><button type="submit" className="btn btn--primary" aria-disabled={busy}>{busy ? "Previewing" : "Preview request"}</button></div>
      </form>
      {result && (
        <div className="form-stack" data-testid="preview-result">
          <p className="banner banner--info"><span className="banner__title">Nothing was sent, stored or charged</span><span>Policy version {result.policyVersion}. Original {formatCount(result.originalUtf8Bytes)} bytes, altered {formatCount(result.alteredUtf8Bytes)} bytes.</span></p>
          <ol className="preview-messages" aria-label="Messages the provider would receive">
            {result.messages.map((m, i) => (
              <li key={i}>
                <p className="small"><strong>{m.role}</strong> <Badge tone={m.origin === "request" ? "neutral" : "info"}>{ORIGIN_LABEL[m.origin]}</Badge></p>
                <pre className="pre-block">{m.content}</pre>
              </li>
            ))}
          </ol>
          <h3>What changed</h3>
          {result.changes.length === 0 ? <p className="muted">Nothing: every request-altering control is off.</p> : (
            <ul>{result.changes.map((c) => <li key={c.feature}>{FEATURE_LABEL[c.feature]}: <strong>{c.status}</strong>{c.reason ? ` (${c.reason})` : ""}{Object.keys(c.detail).length ? `, ${formatDetail(c.detail)}` : ""}</li>)}</ul>
          )}
        </div>
      )}
    </section>
  );
}
