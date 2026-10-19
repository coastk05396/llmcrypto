import { useId } from "react";
import type { OptimizationConfig, OptimizationControl } from "@llmcrypto/contracts";
import { Link } from "react-router";
import { ControlCard, EvidenceSection, HistoryPanel, PolicyStatus, ReportSection, SavePanel, usePolicyEditor } from "../components/PolicyKit";
import { LoadError } from "../components/Feedback";


function NumberField({ label, value, onChange, min, max, error, help }: { label: string; value: number; onChange(v: number): void; min: number; max: number; error: string | undefined; help?: string }) {
  const uid = useId();
  return (
    <div className="field">
      <label htmlFor={uid}>{label}</label>
      <input id={uid} type="number" inputMode="numeric" min={min} max={max} value={Number.isFinite(value) ? value : ""} aria-invalid={error ? true : undefined}
        aria-describedby={`${uid}-d`} onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} />
      <p id={`${uid}-d`} className={error ? "field__error" : "small muted"}>{error ?? help ?? ""}</p>
    </div>
  );
}

/** Tuning (task 19, UI): accounting and monitoring controls. Request-altering ones live on Context steering. */
export function Tuning() {
  const ed = usePolicyEditor();
  const { draft, setDraft } = ed;
  const find = (feature: OptimizationControl["feature"]) => (ed.controls.status === "ready" ? ed.controls.data.items.find((c) => c.feature === feature) : undefined);
  const err = (field: string) => ed.issues.find((i) => i.field === field)?.message;
  const set = (fn: (c: OptimizationConfig) => OptimizationConfig) => draft && setDraft(fn(draft));
  const lg = draft?.loopGuard;

  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">Tuning</h1>
      <p className="muted lead">Optional controls that observe or limit your own traffic. Everything is off until you turn it on, and none of them claims a saving it has not measured. Controls that add text to prompts are on <Link to="/app/context">Context steering</Link>.</p>

      <PolicyStatus policy={ed.policy} onRetry={ed.reloadAll} />
      {ed.controls.status === "error" && <LoadError what="the control descriptions" failure={ed.controls.failure} onRetry={ed.reloadAll} />}

      {draft && ed.controls.status !== "loading" && (
        <>
          <ControlCard control={find("cache_accounting")} title="Cache accounting" enabled={draft.cacheAccounting.enabled} onToggle={(on) => set((c) => ({ ...c, cacheAccounting: { enabled: on } }))} />
          <ControlCard control={find("route_comparison")} title="Route comparison" enabled={draft.routeComparison.enabled} onToggle={(on) => set((c) => ({ ...c, routeComparison: { enabled: on } }))} />
          <ControlCard control={find("batching") ?? { id: "batching", feature: "batching", title: "Batching", description: "Queue requests to run later at lower priority.", privacyImpact: "None.", tradeoff: "Adds latency.", availability: "unavailable", unavailableReason: "Batching is unavailable: no provider batch API exists." }} title="Batching" enabled={false} onToggle={() => undefined} />
          <ControlCard control={find("loop_guard")} title="LoopGuard" enabled={draft.loopGuard.enabled} onToggle={(on) => set((c) => ({ ...c, loopGuard: { ...c.loopGuard, enabled: on } }))}>
            {lg && (
              <div className="form-stack">
                <fieldset className="field fieldset">
                  <legend>Mode</legend>
                  <label className="check"><input type="radio" name="lg-mode" checked={lg.mode === "advisory"} onChange={() => set((c) => ({ ...c, loopGuard: { ...c.loopGuard, mode: "advisory", enforcementConsent: false } }))} /><span>Advisory: flag repeats in evidence and a response header. The request still runs and is charged.</span></label>
                  <label className="check"><input type="radio" name="lg-mode" checked={lg.mode === "enforce"} onChange={() => set((c) => ({ ...c, loopGuard: { ...c.loopGuard, mode: "enforce" } }))} /><span>Enforce: refuse the repeat that reaches the threshold (HTTP 429) before it is sent or charged.</span></label>
                </fieldset>
                <div className="inline-fields">
                  <NumberField label="Threshold (identical requests)" value={lg.threshold} min={2} max={1000} error={err("threshold")} help="2 to 1000. The request that reaches this count is the one blocked or flagged." onChange={(v) => set((c) => ({ ...c, loopGuard: { ...c.loopGuard, threshold: v } }))} />
                  <NumberField label="Window (seconds)" value={lg.windowSeconds} min={60} max={86400} error={err("windowSeconds")} help="60 to 86400." onChange={(v) => set((c) => ({ ...c, loopGuard: { ...c.loopGuard, windowSeconds: v } }))} />
                </div>
                {lg.mode === "enforce" && (
                  <div className="consent" data-testid="loopguard-consent">
                    <label className="check">
                      <input type="checkbox" checked={lg.enforcementConsent} aria-invalid={err("enforcementConsent") ? true : undefined} onChange={(e) => set((c) => ({ ...c, loopGuard: { ...c.loopGuard, enforcementConsent: e.target.checked } }))} />
                      <span>I consent to blocking. Legitimate retries of the same request may be refused once the threshold is reached.</span>
                    </label>
                    {err("enforcementConsent") && <p className="field__error">{err("enforcementConsent")}</p>}
                    <p className="small muted">Concurrent identical requests can slip past the count by the number in flight. Enforcing needs a recent sign-in.</p>
                  </div>
                )}
              </div>
            )}
          </ControlCard>
          <section aria-labelledby="save-head" className="section--ruled">
            <h2 id="save-head" className="section-title">Save</h2>
            <SavePanel ed={ed} />
          </section>
        </>
      )}
      {ed.policy.status === "ready" && <HistoryPanel ed={ed} />}
      <ReportSection parts={["cache", "route", "loop"]} />
      <EvidenceSection features={["cache_accounting", "route_comparison", "loop_guard"]} intro="One row per request and control that was on, saying whether it applied, was skipped, flagged or blocked." />
    </div>
  );
}
