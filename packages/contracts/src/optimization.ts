import { z } from "zod";
import { AtomicAmount, Id, Microusd, PageQuery, SignedMicrousd, Timestamp, listEnvelope } from "./common";

/** Request-altering or request-observing controls. Every one is opt-in, per account, and versioned. */
export const OptimizationFeature = z.enum(["cache_accounting", "concise_guidance", "project_context", "route_comparison", "loop_guard"]);
export const EvidenceStatus = z.enum(["applied", "skipped", "advisory", "blocked"]);

export const OptimizationConfig = z.strictObject({
  /** Accounting only: reports the provider-reported cached tokens already recorded in usage. Changes no request. */
  cacheAccounting: z.strictObject({ enabled: z.boolean() }),
  /** Prepends the account's own short guidance text as a system message. Adds input tokens; no saving is claimed. */
  conciseGuidance: z.strictObject({ enabled: z.boolean(), text: z.string().max(500) }),
  /** Prepends the project's explicitly saved, inject-flagged notes (scoped to the request's project). */
  projectContext: z.strictObject({ enabled: z.boolean(), maxNotes: z.number().int().min(1).max(20), maxChars: z.number().int().min(100).max(4000) }),
  /** Informational: estimates what recorded usage would have cost on other catalog models. Never changes the route. */
  routeComparison: z.strictObject({ enabled: z.boolean() }),
  /** No provider batch API exists: enabling is refused (422) until one is built. */
  batching: z.strictObject({ enabled: z.boolean() }),
  /** Advisory by default. mode "enforce" blocks at the threshold and needs enforcementConsent=true. */
  loopGuard: z.strictObject({
    enabled: z.boolean(),
    mode: z.enum(["advisory", "enforce"]),
    threshold: z.number().int().min(2).max(1000),
    windowSeconds: z.number().int().min(60).max(86_400),
    enforcementConsent: z.boolean(),
  }),
});

export const OptimizationPolicy = z.object({
  /** 0 = the implicit default (everything off); no row exists for it. */
  version: z.number().int().nonnegative(),
  config: OptimizationConfig,
  createdAt: Timestamp.nullable(),
  createdByUserId: Id.nullable(),
  revertedFrom: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
});

export const UpdateOptimizationPolicyRequest = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  config: OptimizationConfig,
  note: z.string().max(200).optional(),
});
export const RevertOptimizationPolicyRequest = z.strictObject({
  toVersion: z.number().int().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
});
export const OptimizationPolicyVersionList = listEnvelope(OptimizationPolicy);
export const PolicyVersionQuery = PageQuery;

export const OptimizationControl = z.object({
  id: z.string().min(1),
  feature: z.enum(["cache_accounting", "concise_guidance", "project_context", "route_comparison", "batching", "loop_guard"]),
  title: z.string(),
  description: z.string(),
  /** What leaves the account's data boundary or is added to the prompt when enabled. */
  privacyImpact: z.string(),
  /** Cost / latency / behaviour tradeoff, stated plainly. */
  tradeoff: z.string(),
  availability: z.enum(["available", "unavailable"]),
  unavailableReason: z.string().nullable(),
});
export const OptimizationControlList = z.object({ items: z.array(OptimizationControl) });

const PreviewMessage = z.strictObject({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(100_000) });
export const PreviewOptimizationRequest = z.strictObject({
  model: z.string().min(1),
  projectId: Id.optional(),
  messages: z.array(PreviewMessage).min(1).max(100),
});

const DetailValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const OptimizationChange = z.object({
  feature: OptimizationFeature,
  status: EvidenceStatus,
  reason: z.string().nullable(),
  detail: z.record(z.string(), DetailValue),
});
export const PreviewOptimizationResponse = z.object({
  policyVersion: z.number().int().nonnegative(),
  changes: z.array(OptimizationChange),
  /** The messages the provider would receive, with where each came from. Nothing is stored or sent. */
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string(), origin: z.enum(["request", "guidance", "project_memory"]) })),
  originalUtf8Bytes: AtomicAmount,
  alteredUtf8Bytes: AtomicAmount,
});

export const OptimizationEvidence = z.object({
  id: Id,
  requestId: z.string().min(1),
  policyVersion: z.number().int().nonnegative(),
  feature: OptimizationFeature,
  status: EvidenceStatus,
  reason: z.string().nullable(),
  detail: z.record(z.string(), DetailValue),
  /** route_comparison only: usage-based estimates at current catalog rates. Informational; never a routing change. */
  routeComparison: z
    .object({
      basis: z.literal("recorded_usage_at_current_rates"),
      actualChargeMicrousd: Microusd,
      alternatives: z.array(z.object({ model: z.string(), estimatedChargeMicrousd: Microusd })),
    })
    .nullable(),
  createdAt: Timestamp,
});
export const EvidenceQuery = PageQuery.extend({
  requestId: z.string().min(1).max(128).optional(),
  feature: OptimizationFeature.optional(),
  status: EvidenceStatus.optional(),
});
export const OptimizationEvidenceList = listEnvelope(OptimizationEvidence);

const InsufficientData = z.object({ status: z.literal("insufficient_data"), reason: z.string(), requests: AtomicAmount });
export const OptimizationReport = z.object({
  period: z.object({ from: Timestamp.nullable(), to: Timestamp.nullable() }),
  /** Same recorded tokens priced with and without the provider-reported cache discount, at each request's own rate snapshot. */
  cacheAccounting: z.discriminatedUnion("status", [
    InsufficientData,
    z.object({
      status: z.literal("ok"),
      requests: AtomicAmount,
      inputTokens: AtomicAmount,
      cachedInputTokens: AtomicAmount,
      outputTokens: AtomicAmount,
      baselineMicrousd: Microusd,
      actualMicrousd: Microusd,
      differenceMicrousd: SignedMicrousd,
    }),
  ]),
  /** Injection changes the prompt, so no counterfactual cost exists: counts only, never a savings figure. */
  conciseGuidance: z.object({ status: z.literal("insufficient_data"), reason: z.string(), appliedRequests: AtomicAmount, addedUtf8Bytes: AtomicAmount }),
  projectContext: z.object({ status: z.literal("insufficient_data"), reason: z.string(), appliedRequests: AtomicAmount, addedUtf8Bytes: AtomicAmount }),
  routeComparison: z.object({ status: z.literal("informational"), evaluatedRequests: AtomicAmount }),
  loopGuard: z.object({ advisoryRequests: AtomicAmount, blockedRequests: AtomicAmount, note: z.string() }),
});
export const OptimizationReportQuery = z.object({ from: Timestamp.optional(), to: Timestamp.optional() });

export type OptimizationFeature = z.infer<typeof OptimizationFeature>;
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;
export type OptimizationConfig = z.infer<typeof OptimizationConfig>;
export type OptimizationPolicy = z.infer<typeof OptimizationPolicy>;
export type UpdateOptimizationPolicyRequest = z.infer<typeof UpdateOptimizationPolicyRequest>;
export type RevertOptimizationPolicyRequest = z.infer<typeof RevertOptimizationPolicyRequest>;
export type OptimizationControl = z.infer<typeof OptimizationControl>;
export type PreviewOptimizationRequest = z.infer<typeof PreviewOptimizationRequest>;
export type PreviewOptimizationResponse = z.infer<typeof PreviewOptimizationResponse>;
export type OptimizationChange = z.infer<typeof OptimizationChange>;
export type OptimizationEvidence = z.infer<typeof OptimizationEvidence>;
export type OptimizationReport = z.infer<typeof OptimizationReport>;

export const DEFAULT_OPTIMIZATION_CONFIG: OptimizationConfig = {
  cacheAccounting: { enabled: false },
  conciseGuidance: { enabled: false, text: "" },
  projectContext: { enabled: false, maxNotes: 5, maxChars: 2000 },
  routeComparison: { enabled: false },
  batching: { enabled: false },
  loopGuard: { enabled: false, mode: "advisory", threshold: 5, windowSeconds: 600, enforcementConsent: false },
};
