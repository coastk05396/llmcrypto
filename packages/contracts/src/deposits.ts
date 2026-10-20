import { z } from "zod";
import { AtomicAmount, Id, Microusd, PageQuery, Timestamp, listEnvelope } from "./common";

export const DepositStatus = z.enum([
  "CREATED",
  "DETECTED",
  "CONFIRMING",
  "CREDITED",
  "EXPIRED",
  "REVIEW_REQUIRED",
  "REVERSED",
]);

/** Why a deposit needs manual review; funds are never auto-credited in these cases. */
export const DepositReviewReason = z.enum([
  "UNDERPAID",
  "OVERPAID",
  "WRONG_NETWORK",
  "WRONG_CHAIN",
  "WRONG_ASSET",
  "WRONG_DESTINATION",
  "LATE_PAYMENT",
  "DUPLICATE_PAYMENT",
  "ZERO_CREDIT",
  "REAPPEARED_AFTER_REVERSAL",
]);

/** asset and network are config-driven identifiers (no hardcoded set at the contract level). */
export const CreateDepositRequest = z.object({
  asset: z.string().min(1).max(32),
  network: z.string().min(1).max(32),
  amountAtomic: AtomicAmount,
}).strict(); // unknown fields (e.g. a client-supplied tx hash) are rejected, never ignored

export const Deposit = z.object({
  id: Id,
  asset: z.string().min(1),
  /** Token decimals used to convert amountAtomic to a display amount. */
  decimals: z.number().int().nonnegative(),
  requiredConfirmations: z.number().int().positive(),
  createdAt: Timestamp,
  address: z.string().min(1),
  /** Token contract address; null for a native asset. */
  assetContract: z.string().nullable(),
  network: z.string().min(1),
  amountAtomic: AtomicAmount,
  expiresAt: Timestamp,
  status: DepositStatus,
  confirmations: z.number().int().nonnegative(),
  creditedMicrousd: Microusd.nullable(),
  ledgerTransactionId: Id.nullable(),
  /** Set while status is REVIEW_REQUIRED; null otherwise. */
  reviewReason: DepositReviewReason.nullable(),
});

export const DepositList = listEnvelope(Deposit);
export const DepositListQuery = PageQuery;

/** One configured (network, asset) pair; the list is empty when no payment networks are configured. */
export const PaymentNetwork = z.object({
  network: z.string().min(1),
  asset: z.string().min(1),
  chainId: z.string().min(1),
  assetContract: z.string().nullable(),
  decimals: z.number().int().nonnegative(),
  requiredConfirmations: z.number().int().positive(),
  expirySeconds: z.number().int().positive(),
  minAmountAtomic: AtomicAmount,
  maxAmountAtomic: AtomicAmount.nullable(),
});
export const PaymentNetworkList = z.object({ items: z.array(PaymentNetwork) });

export type DepositStatus = z.infer<typeof DepositStatus>;
export type CreateDepositRequest = z.infer<typeof CreateDepositRequest>;
export type Deposit = z.infer<typeof Deposit>;
export type DepositReviewReason = z.infer<typeof DepositReviewReason>;
export type DepositList = z.infer<typeof DepositList>;
export type PaymentNetwork = z.infer<typeof PaymentNetwork>;
export type PaymentNetworkList = z.infer<typeof PaymentNetworkList>;
