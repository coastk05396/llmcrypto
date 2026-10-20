import { z } from "zod";
import { Id, Microusd, PageQuery, SignedMicrousd, Timestamp, listEnvelope } from "./common";

/**
 * Operator workflows (draft-0.5). Operator status is a separate grant (never a membership role, never inferred from a
 * wallet), given out-of-band by configuration or the operator CLI. Every /api/operator route needs the grant AND a
 * per-session elevation (POST /api/operator/session, which itself needs a very recent sign-in).
 */
export const OperatorSession = z.object({
  isOperator: z.boolean(),
  elevated: z.boolean(),
  elevatedUntil: Timestamp.nullable(),
});

const Details = z.record(z.string(), z.unknown());

export const PaymentReview = z.object({
  id: Id,
  kind: z.enum(["deposit", "unmatched_event", "duplicate_event", "reorg_reversal"]),
  reason: z.string(),
  status: z.enum(["open", "resolved"]),
  accountId: Id.nullable(),
  depositId: Id.nullable(),
  chainEventId: Id.nullable(),
  details: Details,
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  resolution: z.string().nullable(),
});
export const PaymentReviewList = listEnvelope(PaymentReview);
export const PaymentReviewQuery = PageQuery.extend({ status: z.enum(["open", "resolved"]).default("open") });

export const PaymentAlert = z.object({
  id: Id,
  kind: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]),
  accountId: Id.nullable(),
  depositId: Id.nullable(),
  details: Details,
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});
export const PaymentAlertList = listEnvelope(PaymentAlert);
export const PaymentAlertQuery = PageQuery.extend({ resolved: z.enum(["true", "false"]).default("false") });
export const ResolveAlertRequest = z.strictObject({ note: z.string().trim().min(3).max(500) });

export const StuckReservation = z.object({
  reservationId: Id,
  requestId: Id,
  accountId: Id,
  amountMicrousd: Microusd,
  requestState: z.string().min(1),
  reason: z.enum(["not_dispatched", "dispatched_stale", "usage_pending_past_deadline"]),
  ageSeconds: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export const StuckReservationList = z.object({ items: z.array(StuckReservation), truncated: z.boolean() });

export const LedgerMismatch = z.object({
  kind: z.enum(["unbalanced_transaction", "ledger_not_zero", "reservation_charge_mismatch", "usage_charge_mismatch", "deposit_credit_mismatch", "orphan_deposit_credit", "negative_balance"]),
  accountId: Id.nullable(),
  refId: z.string().min(1),
  expectedMicrousd: SignedMicrousd.nullable(),
  actualMicrousd: SignedMicrousd.nullable(),
  detail: z.string(),
});
export const LedgerMismatchList = z.object({ items: z.array(LedgerMismatch), truncated: z.boolean() });

export const ReconciliationSummary = z.object({
  generatedAt: Timestamp,
  openReviews: z.number().int().nonnegative(),
  openAlerts: z.number().int().nonnegative(),
  stuckReservations: z.number().int().nonnegative(),
  ledgerMismatches: z.number().int().nonnegative(),
  pendingAdjustments: z.number().int().nonnegative(),
});

export const AdjustmentAction = z.enum(["credit", "debit", "reject_review"]);
/**
 * amountMicrousd is required (and bounded: > 0 and <= the server maximum) for credit/debit and must be omitted or "0"
 * for reject_review, which needs reviewId. A credit with reviewId resolves that review as credited when applied.
 */
export const ProposeAdjustmentRequest = z.strictObject({
  /** Required for credit/debit. For reject_review it defaults to the review's account and must be omitted for an account-less review. */
  accountId: Id.optional(),
  action: AdjustmentAction,
  amountMicrousd: Microusd.optional(),
  reason: z.string().trim().min(10).max(1000),
  reviewId: Id.optional(),
});
export const DecideAdjustmentRequest = z.strictObject({ reason: z.string().trim().min(3).max(1000).optional() });

export const Adjustment = z.object({
  id: Id,
  /** null only for reject_review of an event that matched no account. */
  accountId: Id.nullable(),
  action: AdjustmentAction,
  amountMicrousd: Microusd,
  reason: z.string(),
  reviewId: Id.nullable(),
  proposedBy: Id,
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  decidedBy: Id.nullable(),
  decisionReason: z.string().nullable(),
  ledgerTransactionId: Id.nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});
export const AdjustmentList = listEnvelope(Adjustment);
export const AdjustmentQuery = PageQuery.extend({
  status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
  accountId: Id.optional(),
});

/** Customer-facing audit view (GET /api/audit). Operator actions on the account appear with actor = "operator" and no user id. */
export const AuditEvent = z.object({
  id: Id,
  action: z.string().min(1),
  actor: z.enum(["member", "operator", "system"]),
  actorUserId: Id.nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: Details,
  createdAt: Timestamp,
});
export const AuditEventList = listEnvelope(AuditEvent);
export const AuditQuery = PageQuery.extend({ source: z.enum(["all", "operator"]).default("all") });

/** GET /api/features: which beta areas this deployment has switched on. Off means unavailable, NOT complete. */
export const FeatureFlags = z.object({ repositoryGraph: z.boolean(), designBeta: z.boolean() });

export type OperatorSession = z.infer<typeof OperatorSession>;
export type PaymentReview = z.infer<typeof PaymentReview>;
export type PaymentAlert = z.infer<typeof PaymentAlert>;
export type StuckReservation = z.infer<typeof StuckReservation>;
export type LedgerMismatch = z.infer<typeof LedgerMismatch>;
export type Adjustment = z.infer<typeof Adjustment>;
export type AuditEvent = z.infer<typeof AuditEvent>;
export type FeatureFlags = z.infer<typeof FeatureFlags>;
