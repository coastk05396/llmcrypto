import type { Deposit, DepositReviewReason, DepositStatus } from "@llmcrypto/contracts";
import type { ApiFailure } from "./api";
import type { BadgeTone } from "./tone";

/** What each deposit state means to the customer. Wording states only what the contract guarantees; no policy is invented. */
export interface StatusView {
  label: string;
  tone: BadgeTone;
  what: string;
  next: string;
}

export function statusView(d: Pick<Deposit, "status" | "confirmations" | "requiredConfirmations" | "asset" | "network">): StatusView {
  switch (d.status) {
    case "CREATED":
      return { label: "Awaiting payment", tone: "pending", what: "No transfer has been seen yet.", next: `Send ${d.asset} on ${d.network} to the address below before it expires.` };
    case "DETECTED":
      return { label: "Payment detected", tone: "pending", what: "A transfer was seen and is waiting for its first confirmations.", next: "Wait. Credit appears after the required confirmations." };
    case "CONFIRMING":
      return { label: "Confirming", tone: "pending", what: `Confirmations ${d.confirmations} of ${d.requiredConfirmations}.`, next: "Wait. Credit appears after the required confirmations." };
    case "CREDITED":
      return { label: "Credited", tone: "success", what: "The transfer was confirmed and credited once.", next: "No action needed. The credit is in your balance and ledger." };
    case "EXPIRED":
      return { label: "Expired", tone: "neutral", what: "This intent expired before a payment was credited.", next: "Create a new deposit to get a fresh address. Do not send to this address." };
    case "REVIEW_REQUIRED":
      return { label: "Under review", tone: "warning", what: "The transfer does not match this intent, so it was not credited automatically.", next: "Keep the reference ID below. Do not send again to try to fix it." };
    case "REVERSED":
      return { label: "Reversed", tone: "danger", what: "A credited transfer was reversed by the chain and the credit was removed.", next: "Check the ledger for the reversal entry. Keep the reference ID." };
  }
}

export const REVIEW_REASON_TEXT: Record<DepositReviewReason, string> = {
  UNDERPAID: "The amount received was lower than the amount expected.",
  OVERPAID: "The amount received was higher than the amount expected.",
  WRONG_NETWORK: "Funds were sent on a different network than this intent.",
  WRONG_CHAIN: "Funds were sent on a different chain than this intent.",
  WRONG_ASSET: "A different asset than this intent was sent.",
  WRONG_DESTINATION: "The transfer went to a different address than this intent.",
  LATE_PAYMENT: "The transfer arrived after this intent expired.",
  DUPLICATE_PAYMENT: "A second transfer arrived for an intent that was already paid.",
  ZERO_CREDIT: "The transfer would credit nothing.",
  REAPPEARED_AFTER_REVERSAL: "A transfer that was reversed by the chain appeared again; it is not credited again automatically.",
};

const OPEN: ReadonlySet<DepositStatus> = new Set(["CREATED", "DETECTED", "CONFIRMING"]);
/** States that can still change; the list refreshes while any deposit is open. */
export const isOpen = (s: DepositStatus): boolean => OPEN.has(s);

/** Confirmation progress for the progressbar, or null when it does not apply. */
export function confirmationProgress(d: Pick<Deposit, "status" | "confirmations" | "requiredConfirmations">): { now: number; max: number } | null {
  if (d.status !== "DETECTED" && d.status !== "CONFIRMING") return null;
  return { now: Math.min(d.confirmations, d.requiredConfirmations), max: d.requiredConfirmations };
}

export interface DepositFailureView {
  message: string;
  fields: { field: string; message: string }[];
  /** True when the intent may not exist yet and retrying the identical request is safe (same Idempotency-Key). */
  retrySafe: boolean;
}

/** User-facing text for a failed POST /api/deposits. Network and 5xx failures keep the idempotency key (retrySafe). */
export function describeDepositFailure(f: ApiFailure): DepositFailureView {
  if (f.kind === "network") return { message: "The API could not be reached. Nothing was confirmed; retrying sends the same request safely.", fields: [], retrySafe: true };
  if (f.kind === "invalid") return { message: "The API answered with something unexpected. Check the deposit list before retrying.", fields: [], retrySafe: true };
  switch (f.code) {
    case "VALIDATION_FAILED": return { message: "Some values were not accepted.", fields: f.fieldErrors, retrySafe: false };
    case "FORBIDDEN": return { message: "Your role cannot create deposits. Ask an owner or billing manager.", fields: [], retrySafe: false };
    case "IN_PROGRESS": return { message: "A deposit is already being created. Check the list or try again in a moment.", fields: [], retrySafe: true };
    case "IDEMPOTENCY_CONFLICT": return { message: "This attempt conflicts with an earlier one. Close and reopen the form to start a new one.", fields: [], retrySafe: false };
    case "RATE_LIMITED": return { message: f.retryAfterSeconds ? `Too many requests. Retry in ${f.retryAfterSeconds} seconds.` : "Too many requests. Retry shortly.", fields: [], retrySafe: true };
    case "UNAVAILABLE": return { message: "Deposits are not available right now: no payment network is configured.", fields: [], retrySafe: false };
    default: return { message: f.status >= 500 ? "The service had a problem creating the deposit. Check the list before retrying." : "The deposit could not be created.", fields: [], retrySafe: f.status >= 500 };
  }
}
