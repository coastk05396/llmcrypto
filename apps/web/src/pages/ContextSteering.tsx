import { useId } from "react";
import { Link } from "react-router";
import type { OptimizationConfig, OptimizationControl } from "@llmcrypto/contracts";
import { LoadError } from "../components/Feedback";
import { ControlCard, EvidenceSection, HistoryPanel, PolicyStatus, ReportSection, SavePanel, usePolicyEditor } from "../components/PolicyKit";
import { PreviewPanel } from "../components/PreviewPanel";

/** Context steering (task 19, UI): the two controls that add text to prompts. Both are opt-in; no saving is ever claimed. */
export function ContextSteering() {
  const ed = usePolicyEditor();
  const uid = useId();
  const { draft, setDraft } = ed;
  const find = (feature: OptimizationControl["feature"]) => (ed.controls.status === "ready" ? ed.controls.data.items.find((c) => c.feature === feature) : undefined);
  const err = (field: string) => ed.issues.find((i) => i.field === field)?.message;
  const set = (fn: (c: OptimizationConfig) => OptimizationConfig) => draft && setDraft(fn(draft));

  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">Context steering</h1>
      <p className="muted lead">Optional text added to the start of your requests. It is text you wrote, it adds input tokens you pay for, and nothing here is measured to make answers shorter or cheaper. Send header <code>X-Optimize: off</code> on a request to skip these controls for that request.</p>

      <PolicyStatus policy={ed.policy} onRetry={ed.reloadAll} />
      {ed.controls.status === "error" && <LoadError what="the control descriptions" failure={ed.controls.failure} onRetry={ed.reloadAll} />}

      {draft && ed.controls.status !== "loading" && (
        <>
          <ControlCard control={find("concise_guidance")} title="Concise guidance" enabled={draft.conciseGuidance.enabled} onToggle={(on) => set((c) => ({ ...c, conciseGuidance: { ...c.conciseGuidance, enabled: on } }))}>
            <div className="field">
              <label htmlFor={`${uid}-g`}>Guidance text (added as a system message)</label>
              <textarea id={`${uid}-g`} maxLength={500} value={draft.conciseGuidance.text} aria-invalid={err("guidanceText") ? true : undefined} aria-describedby={`${uid}-gc`}
                onChange={(e) => set((c) => ({ ...c, conciseGuidance: { ...c.conciseGuidance, text: e.target.value } }))} />
              <p id={`${uid}-gc`} className={err("guidanceText") ? "field__error" : "small muted"}>{err("guidanceText") ?? `${draft.conciseGuidance.text.length} of 500 characters. Every request you send gets this text added, and you pay for those tokens.`}</p>
            </div>
          </ControlCard>
          <ControlCard control={find("project_context")} title="Project context" enabled={draft.projectContext.enabled} onToggle={(on) => set((c) => ({ ...c, projectContext: { ...c.projectContext, enabled: on } }))}>
            <p className="small muted">Only notes you stored in <Link to="/app/memory">Project memory</Link> with the inject flag on, for the project named on the request, are added. They are sent to the model provider as reference data.</p>
            <div className="inline-fields">
              <div className="field">
                <label htmlFor={`${uid}-n`}>Notes per request</label>
                <input id={`${uid}-n`} type="number" inputMode="numeric" min={1} max={20} value={Number.isFinite(draft.projectContext.maxNotes) ? draft.projectContext.maxNotes : ""} aria-invalid={err("maxNotes") ? true : undefined}
                  onChange={(e) => set((c) => ({ ...c, projectContext: { ...c.projectContext, maxNotes: e.target.value === "" ? Number.NaN : Number(e.target.value) } }))} />
                {err("maxNotes") && <p className="field__error">{err("maxNotes")}</p>}
              </div>
              <div className="field">
                <label htmlFor={`${uid}-c`}>Characters per request</label>
                <input id={`${uid}-c`} type="number" inputMode="numeric" min={100} max={4000} value={Number.isFinite(draft.projectContext.maxChars) ? draft.projectContext.maxChars : ""} aria-invalid={err("maxChars") ? true : undefined}
                  onChange={(e) => set((c) => ({ ...c, projectContext: { ...c.projectContext, maxChars: e.target.value === "" ? Number.NaN : Number(e.target.value) } }))} />
                {err("maxChars") && <p className="field__error">{err("maxChars")}</p>}
              </div>
            </div>
          </ControlCard>
          <section aria-labelledby={`${uid}-save`} className="section--ruled">
            <h2 id={`${uid}-save`} className="section-title">Save</h2>
            <SavePanel ed={ed} />
          </section>
        </>
      )}
      <PreviewPanel policyVersion={ed.version} />
      {ed.policy.status === "ready" && <HistoryPanel ed={ed} />}
      <ReportSection parts={["guidance", "context"]} />
      <EvidenceSection features={["concise_guidance", "project_context"]} intro="Whether guidance or project notes were added to each request, or skipped and why." />
    </div>
  );
}
