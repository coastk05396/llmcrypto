import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DESIGN_EXPORT_LABEL, DesignExport } from "@llmcrypto/contracts";
import { Modal } from "../components/Modal";
import { downloadJson, Failure, FeatureGate, LoadRegion, PageRegion, ProjectPicker, useAttemptKey, useToolAction } from "../components/ToolKit";
import { call, getBalance } from "../lib/api";
import { fetchDesignMarkdown } from "../lib/api-tools";
import { createDesign, deleteDesign, getDesign, listDesigns, reviseDesign } from "../lib/api-tools";
import { formatUsdDisplay } from "../lib/keys";
import { formatSignedUsd } from "../lib/format";
import { useLoad } from "../lib/use-load";
import { usePaged } from "../lib/use-paged";

function DesignDetail({ id, onDeleted, onChanged }: { id: string; onDeleted(): void; onChanged(): void }) {
  const fetcher = useCallback((s: AbortSignal) => getDesign(id, s), [id]);
  const [design, reload] = useLoad(fetcher);
  const [instruction, setInstruction] = useState(""); const [consent, setConsent] = useState(false);
  const [confirm, setConfirm] = useState(false); const cancel = useRef<HTMLButtonElement>(null);
  const action = useToolAction(); const attempt = useAttemptKey(); const uid = useId();
  const [textView, setTextView] = useState<{ revision: number; text: string } | null>(null);
  const running = design.status === "ready" && design.data.revisions.some((r) => r.status === "queued" || r.status === "generating");
  useEffect(() => { if (!running) return; const t = window.setInterval(reload, 2000); return () => window.clearInterval(t); }, [running, reload]);
  return <section className="section--ruled"><LoadRegion state={design} what="design" reload={reload}>{design.status === "ready" && <>
    <h2 className="section-title">{design.data.title}</h2><p className="muted">{DESIGN_EXPORT_LABEL}</p><p>Total charged: ${formatSignedUsd(design.data.totalChargedMicrousd, false)}</p><details><summary>Original brief</summary><pre className="pre-block">{design.data.brief}</pre></details>
    <button className="btn btn--secondary" onClick={() => { reload(); onChanged(); }}>Refresh design</button>
    {design.data.revisions.map((r) => <article className="section--ruled" key={r.number} aria-label={`Revision ${r.number}`}>
      <h3>Revision {r.number} · {r.status}</h3><p>Model: <code>{r.model}</code>. Cost: {r.cost.state}; quoted maximum ${formatSignedUsd(r.cost.maxMicrousd, false)}; charged {r.cost.chargedMicrousd === null ? "unknown" : `$${formatSignedUsd(r.cost.chargedMicrousd, false)}`}.</p>
      {r.status === "queued" && <p role="status">Waiting for a generation worker.</p>}{r.status === "generating" && <p role="status">Generation in progress.</p>}
      {r.failure && <p className="banner banner--danger" role="alert">{r.failure.code}: {r.failure.message}</p>}{r.cost.state === "pending" && <p className="banner banner--warning">Usage is pending reconciliation. The hold remains open.</p>}
      {r.instruction && <pre className="pre-block">{r.instruction}</pre>}
      {r.document && <div data-testid="design-document"><h4>{r.document.title}</h4><p>{r.document.summary}</p>{r.document.sections.map((s, i) => <section key={i}><h5>{s.heading}</h5><p className="pre-block">{s.body}</p></section>)}<h5>Components</h5><ul>{r.document.components.map((c, i) => <li key={i}>{c.name}: {c.purpose}</li>)}</ul><h5>Risks</h5><ul>{r.document.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></div>}
      {r.status === "succeeded" && <button className="btn btn--secondary" disabled={action.busy} onClick={() => void action.run(() => fetchDesignMarkdown(id, r.number), (text) => setTextView({ revision: r.number, text }))}>View revision {r.number} export as text</button>}
      {textView?.revision === r.number && <div data-testid="export-text"><p className="small muted">Plain text, exactly as exported. Nothing in it is rendered as HTML or run.</p><pre className="pre-block">{textView.text}</pre></div>}
      {r.status === "succeeded" && <button className="btn btn--secondary" disabled={action.busy} onClick={() => void action.run(() => call("GET", `/api/designs/${encodeURIComponent(id)}/export?format=json&revision=${r.number}`, DesignExport), (data) => downloadJson(data, `design-${id}-r${r.number}.json`))}>Export revision {r.number} JSON</button>}
    </article>)}
    <Failure failure={action.failure} />
    <form className="form-stack section--ruled" onSubmit={(e) => { e.preventDefault(); if (!consent || running || instruction.trim().length < 3) return; const body = { instruction: instruction.trim(), baseRevision: design.data.latestRevision }; void action.run(() => reviseDesign(id, body, attempt.for(JSON.stringify(body))), () => { attempt.clear(); setInstruction(""); setConsent(false); reload(); onChanged(); }); }}>
      <div className="field"><label htmlFor={uid}>Revision instruction</label><textarea id={uid} value={instruction} minLength={3} maxLength={4000} required onChange={(e) => setInstruction(e.target.value)} /></div><label className="check"><input type="checkbox" checked={consent} required onChange={(e) => setConsent(e.target.checked)} /><span>I authorize another paid generation using this instruction and the existing brief and proposal.</span></label><button className="btn btn--primary" disabled={running || action.busy}>Request paid revision</button>
    </form>
    <div className="actions"><button className="btn btn--danger" disabled={action.busy} onClick={() => setConfirm(true)}>Delete design</button></div>
  </>}</LoadRegion><Modal open={confirm} title="Delete this design?" initialFocus={cancel} onRequestClose={() => { if (!action.busy) setConfirm(false); }}><p>Delete the brief, instructions and generated documents permanently? Financial records remain.</p><Failure failure={action.failure} /><div className="actions"><button ref={cancel} className="btn btn--secondary" disabled={action.busy} onClick={() => setConfirm(false)}>Cancel</button><button className="btn btn--danger" disabled={action.busy} onClick={() => void action.run(() => deleteDesign(id), onDeleted)}>Confirm delete design</button></div></Modal></section>;
}
function DesignProject({ project }: { project: string }) {
  const fetcher = useCallback((c: string | null, s: AbortSignal) => listDesigns(project, c, s), [project]);
  const designs = usePaged(fetcher); const action = useToolAction(); const attempt = useAttemptKey();
  const [balance] = useLoad(getBalance);
  const [selected, setSelected] = useState<string | null>(null); const [title, setTitle] = useState(""); const [brief, setBrief] = useState(""); const [consent, setConsent] = useState(false); const [quote, setQuote] = useState<string | null>(null); const uid = useId();
  return <>
    <section className="section--ruled"><h2 className="section-title">New proposal</h2><p className="muted">Generation uses the configured chat model and prepaid credit. The API has no separate pre-submit quote: submitting queues the generation and returns the maximum cost it may charge (refused with insufficient funds if that exceeds your available credit). Briefs and revision instructions go to the model provider and are stored until deletion. Keep secrets out.</p>
      <p data-testid="design-credit">{balance.status === "ready" ? `Available credit: ${formatUsdDisplay(balance.data.availableMicrousd)} USD.` : balance.status === "error" ? "Available credit could not be loaded." : "Loading available credit."}</p>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (!consent) return; const body = { title: title.trim(), brief: brief.trim() }; void action.run(() => createDesign(project, body, attempt.for(JSON.stringify(body))), (data) => { attempt.clear(); setQuote(data.maxCostMicrousd); setSelected(data.designId); setTitle(""); setBrief(""); setConsent(false); designs.reload(); }); }}>
        <div className="field"><label htmlFor={`${uid}-title`}>Title</label><input id={`${uid}-title`} required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field"><label htmlFor={`${uid}-brief`}>Design brief</label><textarea id={`${uid}-brief`} required minLength={10} maxLength={8000} value={brief} onChange={(e) => setBrief(e.target.value)} /></div>
        <label className="check"><input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I consent to storing this brief, sending it to the model provider and charging my prepaid balance for this generation.</span></label><Failure failure={action.failure} /><button className="btn btn--primary" disabled={action.busy}>Create paid proposal</button>
      </form>{quote !== null && <p role="status">Generation accepted. Quoted maximum: ${formatSignedUsd(quote, false)}. Acceptance does not mean generation succeeded.</p>}
    </section>
    <section className="section--ruled"><h2 className="section-title">Designs</h2><button className="btn btn--secondary" onClick={designs.reload}>Refresh designs</button><PageRegion state={designs.state} what="designs" reload={designs.reload} more={designs.loadMore}><ul className="key-list">{designs.state.status === "ready" && designs.state.items.map((d) => <li className="key-row" key={d.id}><button className="btn btn--secondary" aria-pressed={selected === d.id} onClick={() => setSelected(d.id)}>{d.title}</button><p>Revision {d.latestRevision} · {d.latestStatus} · ${formatSignedUsd(d.totalChargedMicrousd, false)} charged</p></li>)}</ul></PageRegion></section>
    {selected && <DesignDetail key={selected} id={selected} onChanged={designs.reload} onDeleted={() => { setSelected(null); setQuote(null); designs.reload(); }} />}
  </>;
}
export function Design() {
  return <div className="page-body console-page"><p className="eyebrow">Beta</p><h1 className="page-title">Design</h1><p className="lead muted">Create and revise a text proposal for human review. Output is never executed or deployed.</p><FeatureGate feature="designBeta"><ProjectPicker>{(project) => <DesignProject key={project} project={project} />}</ProjectPicker></FeatureGate></div>;
}
