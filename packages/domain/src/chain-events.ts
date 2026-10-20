/**
 * Pure deposit matching and state machine. No I/O, no clock, no configuration lookup: everything the decision
 * needs is passed in, so the same rules run in the observer, the reconciler and the unit tests.
 *
 * States: CREATED -> DETECTED -> CONFIRMING -> CREDITED, with EXPIRED, REVIEW_REQUIRED and REVERSED branches
 * (SPEC "Deposit state"). Rules enforced here:
 *  - Credit only a finalized transfer (confirmations >= the intent's snapshot) that matches the intent on
 *    network, chain id, token contract, destination and (by default) exact amount. Anything else that carries
 *    funds becomes REVIEW_REQUIRED and is never auto-credited or auto-spent.
 *  - A client-submitted transaction hash is not an input of any function here: events come from a ChainClient only.
 *  - A transfer that leaves the canonical chain before credit reverts the intent; after credit it yields a
 *    REVERSED decision (the store posts a compensating ledger transaction and opens an account review).
 *    History is never deleted.
 *  - Duplicate or out-of-order deliveries are no-ops or monotonic (see decideDeposit; stale deliveries are also
 *    dropped by chain head height in the store).
 */

export type DepositStatus = "CREATED" | "DETECTED" | "CONFIRMING" | "CREDITED" | "EXPIRED" | "REVIEW_REQUIRED" | "REVERSED";
export type OverpaymentPolicy = "review" | "credit_full";

export type ReviewReason =
  | "UNDERPAID"
  | "OVERPAID"
  | "WRONG_NETWORK"
  | "WRONG_CHAIN"
  | "WRONG_ASSET"
  | "WRONG_DESTINATION"
  | "LATE_PAYMENT"
  | "DUPLICATE_PAYMENT"
  | "ZERO_CREDIT"
  | "REAPPEARED_AFTER_REVERSAL";

/** One approved (network, asset) pair. Every field is configuration; nothing is defaulted to a real chain. */
export interface PaymentRoute {
  network: string;
  asset: string;
  /** Chain id the network is expected to report (string: EVM ids and TRON network names both fit). */
  chainId: string;
  /** Token contract; "" for a native asset. */
  assetContract: string;
  decimals: number;
  /** Confirmations (including the including block) required before credit. */
  confirmations: number;
  /** Intent lifetime shown to the customer. */
  expirySeconds: number;
  /** Extra time after expiry in which a transfer MINED before the deadline is still honoured. */
  graceSeconds: number;
  /** Micro-USD credited per 1 whole token (e.g. 1_000_000n for a 1:1 USD-pegged stablecoin; a business decision). */
  microusdPerToken: bigint;
  overpayment: OverpaymentPolicy;
  minAmountAtomic: bigint;
  maxAmountAtomic: bigint | null;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]+$/;

/** EVM hex addresses compare case-insensitively; other formats (e.g. TRON base58) are case-sensitive. */
export function normalizeAddress(address: string): string {
  const a = address.trim();
  return HEX_ADDRESS.test(a) ? a.toLowerCase() : a;
}
export function normalizeContract(contract: string | null | undefined): string {
  return contract == null || contract === "" ? "" : normalizeAddress(contract);
}
export function normalizeTxHash(hash: string): string {
  const h = hash.trim();
  return HEX_HASH.test(h) ? h.toLowerCase() : h;
}

/** Event identity: (network, transaction hash, event index, asset contract). A tx hash alone is insufficient. */
export function eventKey(network: string, txHash: string, eventIndex: number, assetContract: string | null | undefined): string {
  return [network, normalizeTxHash(txHash), String(eventIndex), normalizeContract(assetContract)].join("|");
}

/** Micro-USD for an atomic token amount, rounded DOWN (the platform never credits more than it received). */
export function microusdForAtomic(amountAtomic: bigint, decimals: number, microusdPerToken: bigint): bigint {
  if (amountAtomic < 0n || microusdPerToken <= 0n || !Number.isInteger(decimals) || decimals < 0) throw new RangeError("invalid conversion input");
  return (amountAtomic * microusdPerToken) / 10n ** BigInt(decimals);
}

export function isTerminalForCredit(status: DepositStatus): boolean {
  return status === "CREDITED" || status === "REVERSED" || status === "REVIEW_REQUIRED";
}

export interface IntentFacts {
  status: DepositStatus;
  network: string;
  chainId: string;
  assetContract: string;
  addressKey: string;
  amountAtomic: bigint;
  decimals: number;
  requiredConfirmations: number;
  microusdPerToken: bigint;
  overpayment: OverpaymentPolicy;
  /** Transfers mined after this instant are late (expires_at + grace). */
  acceptUntil: Date;
  confirmations: number;
  /** event key this intent is tied to, if any. */
  matchedEventKey: string | null;
}

/** A transfer as the matcher sees it (already normalized by the store). */
export interface TransferFacts {
  eventKey: string;
  network: string;
  chainId: string;
  assetContract: string;
  toKey: string;
  amountAtomic: bigint;
  blockTime: Date;
  confirmations: number;
  /** true: the transfer is no longer on the canonical chain (reorg). */
  removed: boolean;
}

export type Decision =
  | { kind: "noop" }
  | { kind: "progress"; status: "DETECTED" | "CONFIRMING"; confirmations: number }
  | { kind: "credit"; creditedMicrousd: bigint; confirmations: number }
  | { kind: "review"; reason: ReviewReason; confirmations: number }
  /** Transfer vanished before credit: intent returns to CREATED/EXPIRED and forgets the event. */
  | { kind: "revert" }
  /** Transfer vanished AFTER credit: compensate in the ledger, flag the account, never delete history. */
  | { kind: "reverse" }
  /** An additional/odd transfer for an intent that is already settled or tied to another transfer: queue it, change nothing. */
  | { kind: "flag_event"; reason: "DUPLICATE_PAYMENT" | "REAPPEARED_AFTER_REVERSAL" };

const OPEN: ReadonlySet<DepositStatus> = new Set(["CREATED", "DETECTED", "CONFIRMING", "EXPIRED"]);

export function decideDeposit(intent: IntentFacts, t: TransferFacts): Decision {
  const same = intent.matchedEventKey === t.eventKey;
  // A removal of a transfer this intent never accepted changes nothing.
  if (t.removed && !same) return { kind: "noop" };

  switch (intent.status) {
    case "CREDITED":
      if (!same) return { kind: "flag_event", reason: "DUPLICATE_PAYMENT" };
      return t.removed ? { kind: "reverse" } : { kind: "noop" };
    case "REVERSED":
      if (t.removed) return { kind: "noop" };
      return { kind: "flag_event", reason: same ? "REAPPEARED_AFTER_REVERSAL" : "DUPLICATE_PAYMENT" };
    case "EXPIRED":
      if (intent.matchedEventKey === null || same) break;
      // Rejected invalid observations leave the intent expired, but do not reserve its address.
      return decideDeposit({ ...intent, status: "REVIEW_REQUIRED" }, t);
    case "REVIEW_REQUIRED": {
      if (same) return { kind: "noop" };
      // An invalid observation does not reserve this public address against a later valid payment.
      const candidate = decideDeposit({ ...intent, status: "CREATED", matchedEventKey: null, confirmations: 0 }, t);
      return candidate.kind === "progress" || candidate.kind === "credit"
        ? candidate : { kind: "flag_event", reason: "DUPLICATE_PAYMENT" };
    }
    default:
      break;
  }
  if (!OPEN.has(intent.status)) return { kind: "noop" };

  if (intent.matchedEventKey !== null && !same) return { kind: "flag_event", reason: "DUPLICATE_PAYMENT" };
  if (t.removed) return { kind: "revert" };

  const confirmations = same ? Math.max(intent.confirmations, t.confirmations) : t.confirmations;
  const review = (reason: ReviewReason): Decision => ({ kind: "review", reason, confirmations });

  if (t.network !== intent.network) return review("WRONG_NETWORK");
  if (t.chainId !== intent.chainId) return review("WRONG_CHAIN");
  if (t.assetContract !== intent.assetContract) return review("WRONG_ASSET");
  if (t.toKey !== intent.addressKey) return review("WRONG_DESTINATION");
  if (t.blockTime.getTime() > intent.acceptUntil.getTime()) return review("LATE_PAYMENT");
  if (t.amountAtomic < intent.amountAtomic) return review("UNDERPAID");
  if (t.amountAtomic > intent.amountAtomic && intent.overpayment !== "credit_full") return review("OVERPAID");

  // Matched in every respect. Only a finalized transfer is credited.
  if (confirmations < intent.requiredConfirmations) {
    return { kind: "progress", status: confirmations === 0 ? "DETECTED" : "CONFIRMING", confirmations };
  }
  const creditedMicrousd = microusdForAtomic(t.amountAtomic, intent.decimals, intent.microusdPerToken);
  if (creditedMicrousd <= 0n) return review("ZERO_CREDIT");
  return { kind: "credit", creditedMicrousd, confirmations };
}
