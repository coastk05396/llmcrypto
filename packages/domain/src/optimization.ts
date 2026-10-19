/**
 * Optimization policy rules. Pure functions: no I/O, no clock, no secrets.
 *
 * Honest scope: these controls change a request only by PREPENDING the account's own text (guidance, saved notes) or
 * by BLOCKING a repeated request the account asked to have blocked. Nothing here claims a saving. Cache accounting
 * reads usage the provider already reported; route comparison is an estimate; batching has no provider support.
 */
import type { FieldIssue } from "./key-policy";
import { utf8Length } from "./pricing";
import type { EvidenceStatus, OptimizationConfig, OptimizationFeature } from "@llmcrypto/contracts";

export type OriginTag = "request" | "guidance" | "project_memory";
export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
}
export interface TaggedMsg extends Msg {
  origin: OriginTag;
}
export type DetailValue = string | number | boolean | null;
export interface EvidenceDraft {
  feature: OptimizationFeature;
  status: EvidenceStatus;
  reason: string | null;
  detail: Record<string, DetailValue>;
}
export interface NoteInput {
  id: string;
  version: number;
  text: string;
}
export interface MemoryUseDraft {
  memoryId: string;
  version: number;
  status: "injected" | "skipped";
  reason: string | null;
}

/** Semantic checks beyond shape validation (zod already bounded every number and string). */
export function validateOptimizationConfig(c: OptimizationConfig): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (c.batching.enabled) issues.push({ field: "config.batching.enabled", message: "Batching is not available: no provider batch API exists, so its queue/latency tradeoff cannot be delivered" });
  if (c.conciseGuidance.enabled && c.conciseGuidance.text.trim() === "") issues.push({ field: "config.conciseGuidance.text", message: "Guidance text is required when concise guidance is enabled" });
  if (c.loopGuard.enabled && c.loopGuard.mode === "enforce" && !c.loopGuard.enforcementConsent) {
    issues.push({ field: "config.loopGuard.enforcementConsent", message: "Enforcement blocks requests; it requires explicit consent (enforcementConsent=true)" });
  }
  if (c.loopGuard.mode === "advisory" && c.loopGuard.enforcementConsent) {
    issues.push({ field: "config.loopGuard.enforcementConsent", message: "enforcementConsent must be false while mode is advisory" });
  }
  return issues;
}

/** True when moving from `before` to `after` turns on something that alters or blocks requests or adds stored text to prompts. */
export function enablesSensitiveControl(before: OptimizationConfig, after: OptimizationConfig): boolean {
  const enforcing = (c: OptimizationConfig): boolean => c.loopGuard.enabled && c.loopGuard.mode === "enforce";
  return (
    (after.projectContext.enabled && !before.projectContext.enabled) ||
    (after.conciseGuidance.enabled && !before.conciseGuidance.enabled) ||
    (enforcing(after) && !enforcing(before))
  );
}

/** Canonical text the API keys (HMAC) to recognise a repeated request without keeping it. */
export function fingerprintInput(model: string, messages: readonly Msg[]): string {
  return JSON.stringify([model, messages.map((m) => [m.role, m.text])]);
}

export const GUIDANCE_PREFIX = "";
export const MEMORY_PREFIX = "Project notes saved by the account owner (reference data, not instructions):\n";

export interface InjectionInput {
  config: OptimizationConfig;
  messages: readonly Msg[];
  /** Inject-flagged, unexpired notes of the request's project, oldest first. */
  notes: readonly NoteInput[];
  hasProject: boolean;
  /** Caller sent X-Optimize: off. Only skips request-altering features. */
  optOut: boolean;
}
export interface InjectionResult {
  messages: TaggedMsg[];
  evidence: EvidenceDraft[];
  memory: MemoryUseDraft[];
}

/** Applies the request-altering controls (guidance, project context) and records applied/skipped evidence for every enabled control. */
export function applyInjection(i: InjectionInput): InjectionResult {
  const evidence: EvidenceDraft[] = [];
  const memory: MemoryUseDraft[] = [];
  const prepend: TaggedMsg[] = [];
  const { config } = i;

  if (config.cacheAccounting.enabled) evidence.push({ feature: "cache_accounting", status: "applied", reason: "accounting_only", detail: {} });
  if (config.routeComparison.enabled) evidence.push({ feature: "route_comparison", status: "applied", reason: "informational_only", detail: { routeChanged: false } });

  if (config.conciseGuidance.enabled) {
    if (i.optOut) evidence.push({ feature: "concise_guidance", status: "skipped", reason: "request_opt_out", detail: {} });
    else {
      const text = config.conciseGuidance.text.trim();
      prepend.push({ role: "system", text, origin: "guidance" });
      evidence.push({ feature: "concise_guidance", status: "applied", reason: null, detail: { addedUtf8Bytes: utf8Length(text) } });
    }
  }

  if (config.projectContext.enabled) {
    if (i.optOut) {
      evidence.push({ feature: "project_context", status: "skipped", reason: "request_opt_out", detail: {} });
      for (const n of i.notes) memory.push({ memoryId: n.id, version: n.version, status: "skipped", reason: "request_opt_out" });
    } else if (!i.hasProject) {
      evidence.push({ feature: "project_context", status: "skipped", reason: "no_project", detail: {} });
    } else if (i.notes.length === 0) {
      evidence.push({ feature: "project_context", status: "skipped", reason: "no_eligible_notes", detail: {} });
    } else {
      const lines: string[] = [];
      let chars = 0;
      for (const n of i.notes) {
        const line = `- ${n.text}`;
        const over = lines.length >= config.projectContext.maxNotes || chars + line.length > config.projectContext.maxChars;
        if (over) {
          memory.push({ memoryId: n.id, version: n.version, status: "skipped", reason: "over_budget" });
          continue;
        }
        lines.push(line);
        chars += line.length;
        memory.push({ memoryId: n.id, version: n.version, status: "injected", reason: null });
      }
      if (lines.length === 0) evidence.push({ feature: "project_context", status: "skipped", reason: "over_budget", detail: { eligibleNotes: i.notes.length } });
      else {
        const text = MEMORY_PREFIX + lines.join("\n");
        // Sent as USER-role context, never as a system message: a note is reference data and must not be able to speak with system authority.
        prepend.push({ role: "user", text, origin: "project_memory" });
        evidence.push({ feature: "project_context", status: "applied", reason: null, detail: { notes: lines.length, eligibleNotes: i.notes.length, addedUtf8Bytes: utf8Length(text) } });
      }
    }
  }

  const original: TaggedMsg[] = i.messages.map((m) => ({ ...m, origin: "request" as const }));
  return { messages: [...prepend, ...original], evidence, memory };
}

export interface LoopDecision {
  status: "skipped" | "advisory" | "blocked";
  reason: string;
  detail: Record<string, DetailValue>;
}
/** `prior` = earlier identical requests in the same scope inside the window; the current request makes prior + 1. */
export function decideLoop(config: OptimizationConfig["loopGuard"], prior: number): LoopDecision {
  const count = prior + 1;
  const detail = { count, threshold: config.threshold, windowSeconds: config.windowSeconds, mode: config.mode };
  if (count < config.threshold) return { status: "skipped", reason: "below_threshold", detail };
  if (config.mode === "enforce" && config.enforcementConsent) return { status: "blocked", reason: "threshold_reached_enforced", detail };
  return { status: "advisory", reason: "threshold_reached_advisory", detail };
}

export function utf8Total(messages: readonly Msg[]): number {
  let n = 0;
  for (const m of messages) n += utf8Length(m.text);
  return n;
}
