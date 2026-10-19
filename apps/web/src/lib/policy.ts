import type { OptimizationConfig, OptimizationFeature } from "@llmcrypto/contracts";

export interface PolicyIssue {
  field: string;
  message: string;
}

/** Client-side mirror of the checks the API makes (OptimizationConfig bounds and the LoopGuard enforcement rule). The API stays authoritative. */
export function validateConfig(c: OptimizationConfig): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (c.conciseGuidance.enabled && c.conciseGuidance.text.trim().length === 0) issues.push({ field: "guidanceText", message: "Write the guidance text, or turn guidance off." });
  if (c.conciseGuidance.text.length > 500) issues.push({ field: "guidanceText", message: "Guidance is at most 500 characters." });
  const pc = c.projectContext;
  if (!Number.isInteger(pc.maxNotes) || pc.maxNotes < 1 || pc.maxNotes > 20) issues.push({ field: "maxNotes", message: "Notes per request: a whole number from 1 to 20." });
  if (!Number.isInteger(pc.maxChars) || pc.maxChars < 100 || pc.maxChars > 4000) issues.push({ field: "maxChars", message: "Characters per request: a whole number from 100 to 4000." });
  const lg = c.loopGuard;
  if (!Number.isInteger(lg.threshold) || lg.threshold < 2 || lg.threshold > 1000) issues.push({ field: "threshold", message: "Threshold: a whole number from 2 to 1000." });
  if (!Number.isInteger(lg.windowSeconds) || lg.windowSeconds < 60 || lg.windowSeconds > 86_400) issues.push({ field: "windowSeconds", message: "Window: 60 to 86400 seconds." });
  if (lg.enabled && lg.mode === "enforce" && !lg.enforcementConsent) issues.push({ field: "enforcementConsent", message: "Blocking needs your explicit consent. Tick the box, or use advisory mode." });
  return issues;
}

/** The consent flag only means something while enforcing; keep the stored config consistent with the visible mode. */
export function normalizeConfig(c: OptimizationConfig): OptimizationConfig {
  return c.loopGuard.mode === "advisory" && c.loopGuard.enforcementConsent
    ? { ...c, loopGuard: { ...c.loopGuard, enforcementConsent: false } }
    : c;
}

export const sameConfig = (a: OptimizationConfig, b: OptimizationConfig): boolean => JSON.stringify(a) === JSON.stringify(b);

/** True when saving this change makes a request-altering or blocking control active (the API wants a recent sign-in for it). */
export function enablesSensitive(prev: OptimizationConfig, next: OptimizationConfig): boolean {
  return (
    (!prev.conciseGuidance.enabled && next.conciseGuidance.enabled) ||
    (!prev.projectContext.enabled && next.projectContext.enabled) ||
    (next.loopGuard.enabled && next.loopGuard.mode === "enforce" && !(prev.loopGuard.enabled && prev.loopGuard.mode === "enforce"))
  );
}

export const FEATURE_LABEL: Record<OptimizationFeature, string> = {
  cache_accounting: "Cache accounting",
  concise_guidance: "Concise guidance",
  project_context: "Project context",
  route_comparison: "Route comparison",
  loop_guard: "LoopGuard",
};

/** Plain-language summary of a config for the revert confirmation. */
export function summarizeConfig(c: OptimizationConfig): string[] {
  const on: string[] = [];
  if (c.cacheAccounting.enabled) on.push("Cache accounting");
  if (c.conciseGuidance.enabled) on.push(`Concise guidance (${c.conciseGuidance.text.length} characters)`);
  if (c.projectContext.enabled) on.push(`Project context (up to ${c.projectContext.maxNotes} notes, ${c.projectContext.maxChars} characters)`);
  if (c.routeComparison.enabled) on.push("Route comparison");
  if (c.loopGuard.enabled) on.push(`LoopGuard ${c.loopGuard.mode === "enforce" ? "blocking" : "advisory"} at ${c.loopGuard.threshold} in ${c.loopGuard.windowSeconds}s`);
  return on;
}

/** Evidence detail cell: scalar key/value pairs only, no prompt text exists in it. */
export function formatDetail(detail: Record<string, string | number | boolean | null>): string {
  const e = Object.entries(detail);
  return e.length === 0 ? "" : e.map(([k, v]) => `${k}: ${v === null ? "none" : String(v)}`).join(", ");
}
