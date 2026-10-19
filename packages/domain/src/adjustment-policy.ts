/**
 * Dual-control rules for operator adjustments (pure). The API and the database both enforce "the proposer never decides";
 * these functions are the single statement of the rest of the policy.
 */
import type { Adjustment } from "@llmcrypto/contracts";
import type { Posting } from "./ledger";

export type AdjustmentAction = Adjustment["action"];

export interface AdjustmentBounds {
  /** Largest single adjustment, micro-USD. UNCONFIRMED commercial policy; configurable. */
  maxMicrousd: bigint;
  /** A proposal can be decided for this long. */
  ttlSeconds: number;
}
export const DEFAULT_ADJUSTMENT_BOUNDS: AdjustmentBounds = { maxMicrousd: 1_000_000_000n, ttlSeconds: 72 * 3600 };

export interface ProposalCheck {
  action: AdjustmentAction;
  amountMicrousd: bigint | null;
  reviewId: string | null;
  /** Whether the proposer is a member of the target account (conflict of interest). */
  proposerIsMember: boolean;
}

/** Field-level problems with a proposal; empty = acceptable. */
export function validateProposal(p: ProposalCheck, b: AdjustmentBounds): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  if (p.action === "reject_review") {
    if (p.amountMicrousd !== null && p.amountMicrousd !== 0n) issues.push({ field: "amountMicrousd", message: "must be omitted or 0 for reject_review" });
    if (!p.reviewId) issues.push({ field: "reviewId", message: "is required for reject_review" });
  } else {
    if (p.amountMicrousd === null || p.amountMicrousd <= 0n) issues.push({ field: "amountMicrousd", message: "must be greater than zero" });
    else if (p.amountMicrousd > b.maxMicrousd) issues.push({ field: "amountMicrousd", message: `must not exceed ${b.maxMicrousd.toString()} micro-USD` });
    if (p.action === "debit" && p.reviewId) issues.push({ field: "reviewId", message: "a debit cannot resolve a payment review" });
  }
  if (p.proposerIsMember) issues.push({ field: "accountId", message: "operators cannot adjust an account they belong to" });
  return issues;
}

export type DecisionRefusal = "SELF_APPROVAL" | "ALREADY_DECIDED" | "EXPIRED" | "NOT_OPERATOR";

export function canDecide(i: { proposerUserId: string; deciderUserId: string; decided: boolean; expiresAt: Date; now: Date; deciderIsOperator: boolean }): { ok: true } | { ok: false; reason: DecisionRefusal } {
  if (!i.deciderIsOperator) return { ok: false, reason: "NOT_OPERATOR" };
  if (i.proposerUserId === i.deciderUserId) return { ok: false, reason: "SELF_APPROVAL" };
  if (i.decided) return { ok: false, reason: "ALREADY_DECIDED" };
  if (i.expiresAt.getTime() <= i.now.getTime()) return { ok: false, reason: "EXPIRED" };
  return { ok: true };
}

export type AdjustmentStatus = Adjustment["status"];
export const adjustmentStatus = (d: { decision: "approved" | "rejected" } | null, expiresAt: Date, now: Date): AdjustmentStatus =>
  d ? d.decision : expiresAt.getTime() <= now.getTime() ? "expired" : "pending";

/** A debit takes `amount` back out of customer funds; the counter-entry returns to the funding source (not revenue). */
export function debitPostings(accountId: string, amount: bigint): Posting[] {
  if (amount <= 0n) throw new RangeError("Debit must be positive");
  return [
    { ledgerAccount: "customer_funds", accountId, amount: -amount },
    { ledgerAccount: "funding_source", accountId: null, amount },
  ];
}
