import { z } from "zod";
import { AtomicAmount, Id, Microusd, PageQuery, SignedMicrousd, Timestamp, listEnvelope } from "./common";

export const RequestState = z.enum([
  "VALIDATED",
  "RESERVED",
  "DISPATCHED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "USAGE_PENDING",
  "SETTLED",
]);

export const Balance = z.object({
  availableMicrousd: Microusd,
  heldMicrousd: Microusd,
  postedMicrousd: Microusd,
  asOf: Timestamp,
});

const dateFilters = {
  from: Timestamp.optional(),
  to: Timestamp.optional(),
};

export const UsageFilters = z.object({
  ...dateFilters,
  model: z.string().min(1).optional(),
  projectId: Id.optional(),
  keyId: Id.optional(),
  status: RequestState.optional(),
  /** Exact run correlation (the X-Run-Id the caller sent). */
  runId: Id.optional(),
});

export const UsageQuery = UsageFilters.extend(PageQuery.shape);

/** Cached and uncached input categories never overlap: inputTokens excludes cachedInputTokens. */
export const UsageRecord = z.object({
  id: Id,
  requestId: Id,
  correlationId: z.string().nullable(),
  /** Caller-supplied X-Run-Id / X-Parent-Id; null = the caller sent none (shown as unknown, never guessed). */
  runId: Id.nullable(),
  parentId: Id.nullable(),
  createdAt: Timestamp,
  model: z.string().min(1),
  projectId: Id.nullable(),
  keyId: Id.nullable(),
  status: RequestState,
  inputTokens: AtomicAmount,
  cachedInputTokens: AtomicAmount,
  outputTokens: AtomicAmount,
  chargeMicrousd: Microusd,
  priceVersion: Id,
});
export const UsagePage = listEnvelope(UsageRecord);

/** GET /api/usage/agent-runs query: requests grouped by (runId, projectId). */
export const AgentRunQuery = z.object({ ...dateFilters, projectId: Id.optional(), keyId: Id.optional() }).extend(PageQuery.shape);

/**
 * One group of requests. `runId: null` + `correlation: "unknown"` is the bucket of requests that carried no run id
 * (one per project): their grouping is unknown, not guessed. Counts are decimal strings like all other amounts.
 */
export const AgentRun = z.object({
  runId: Id.nullable(),
  correlation: z.enum(["known", "unknown"]),
  projectId: Id.nullable(),
  requestCount: AtomicAmount,
  firstAt: Timestamp,
  lastAt: Timestamp,
  inputTokens: AtomicAmount,
  cachedInputTokens: AtomicAmount,
  outputTokens: AtomicAmount,
  chargeMicrousd: Microusd,
  /** Alert basis: requests that ended FAILED/CANCELLED, are still USAGE_PENDING, or were refused by a balance/cap limit. */
  failedCount: AtomicAmount,
  pendingCount: AtomicAmount,
  limitRejectedCount: AtomicAmount,
});
export const AgentRunPage = listEnvelope(AgentRun);

export const LedgerKind = z.enum(["deposit", "spend", "adjustment", "reversal"]);

export const LedgerQuery = z.object({ ...dateFilters, kind: LedgerKind.optional() }).extend(PageQuery.shape);

export const LedgerEntry = z.object({
  id: Id,
  transactionId: Id,
  createdAt: Timestamp,
  kind: LedgerKind,
  /** Signed from the customer's perspective: credits positive, spend negative. */
  amountMicrousd: SignedMicrousd,
  source: z.object({ type: z.enum(["request", "deposit", "adjustment"]), id: Id }),
  priceVersion: Id.nullable(),
});
export const LedgerPage = listEnvelope(LedgerEntry);

/** Detail uses frozen billing rates, never today's catalog prices. Unknown provider metadata stays null. */
export const UsageDetail = UsageRecord.extend({
  protocol: z.enum(["openai_chat", "openai_responses", "anthropic_messages"]),
  stream: z.boolean(),
  outcome: z.enum(["succeeded", "failed", "cancelled", "usage_unresolved", "rejected"]).nullable(),
  failureCode: z.string().nullable(),
  dispatchedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  finishReason: z.string().nullable(),
  rateSnapshot: z.object({ inputMicrousdPerMtok: Microusd, cachedInputMicrousdPerMtok: Microusd, outputMicrousdPerMtok: Microusd }),
  computedChargeMicrousd: Microusd,
  absorbedMicrousd: Microusd,
  ledgerTransactionId: Id.nullable(),
  ledgerEntries: z.array(LedgerEntry),
});
export type UsageDetail = z.infer<typeof UsageDetail>;

export type RequestState = z.infer<typeof RequestState>;
export type Balance = z.infer<typeof Balance>;
export type UsageFilters = z.infer<typeof UsageFilters>;
export type UsageQuery = z.infer<typeof UsageQuery>;
export type UsageRecord = z.infer<typeof UsageRecord>;
export type UsagePage = z.infer<typeof UsagePage>;
export type AgentRunQuery = z.infer<typeof AgentRunQuery>;
export type AgentRun = z.infer<typeof AgentRun>;
export type AgentRunPage = z.infer<typeof AgentRunPage>;
export type LedgerKind = z.infer<typeof LedgerKind>;
export type LedgerQuery = z.infer<typeof LedgerQuery>;
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export type LedgerPage = z.infer<typeof LedgerPage>;
