import { Deposit, type CreateDepositRequest, type DepositReviewReason } from "@llmcrypto/contracts";
import { normalizeAddress, type DepositStatus, type PaymentRoute } from "@llmcrypto/domain";
import type { Queryable } from "../db";

export interface IntentRow {
  id: string; account_id: string; network: string; asset: string; chain_id: string; asset_contract: string; decimals: number;
  required_confirmations: number; address: string; amount_atomic: string; expires_at: Date; status: DepositStatus; confirmations: number;
  credited_microusd: string | null; ledger_transaction_id: string | null; review_reason: string | null; created_at: Date;
}

export const INTENT_COLUMNS = `id, account_id, network, asset, chain_id, asset_contract, decimals, required_confirmations, address, amount_atomic::text as amount_atomic,
  expires_at, status, confirmations, credited_microusd::text as credited_microusd, ledger_transaction_id, review_reason, created_at`;

export function toDeposit(r: IntentRow): Deposit {
  return Deposit.parse({
    id: r.id, asset: r.asset, decimals: r.decimals, requiredConfirmations: r.required_confirmations, createdAt: r.created_at.toISOString(),
    address: r.address, assetContract: r.asset_contract === "" ? null : r.asset_contract, network: r.network, amountAtomic: r.amount_atomic,
    expiresAt: r.expires_at.toISOString(), status: r.status, confirmations: r.confirmations, creditedMicrousd: r.credited_microusd,
    ledgerTransactionId: r.ledger_transaction_id, reviewReason: (r.review_reason as DepositReviewReason | null) ?? null,
  });
}

export async function getIntent(q: Queryable, accountId: string, id: string): Promise<IntentRow | undefined> {
  const [row] = await q.query<IntentRow>(`select ${INTENT_COLUMNS} from deposit_intents where id=$1 and account_id=$2`, [id, accountId]);
  return row;
}

export function findRoute(routes: readonly PaymentRoute[], req: Pick<CreateDepositRequest, "network" | "asset">): PaymentRoute | undefined {
  return routes.find((r) => r.network === req.network && r.asset === req.asset);
}

export function amountIssues(route: PaymentRoute, amount: bigint): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  if (amount < route.minAmountAtomic) issues.push({ field: "amountAtomic", message: `below the minimum deposit of ${route.minAmountAtomic} atomic units` });
  if (route.maxAmountAtomic !== null && amount > route.maxAmountAtomic) issues.push({ field: "amountAtomic", message: `above the maximum deposit of ${route.maxAmountAtomic} atomic units` });
  return issues;
}

export interface NewIntent {
  id: string; accountId: string; userId: string; route: PaymentRoute; address: string; amountAtomic: bigint; at: Date;
}

/** Inserts the intent with policy snapshots from the route. Caller holds the account lock and the DB transaction. */
export async function insertIntent(q: Queryable, n: NewIntent): Promise<void> {
  const expiresAt = new Date(n.at.getTime() + n.route.expirySeconds * 1000);
  const acceptUntil = new Date(expiresAt.getTime() + n.route.graceSeconds * 1000);
  await q.query(
    `insert into deposit_intents (id, account_id, created_by_user_id, network, asset, chain_id, asset_contract, decimals, required_confirmations, address, address_key,
       amount_atomic, microusd_per_token, overpayment_policy, expires_at, accept_until, status, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CREATED',$17,$17)`,
    [n.id, n.accountId, n.userId, n.route.network, n.route.asset, n.route.chainId, n.route.assetContract, n.route.decimals, n.route.confirmations, n.address,
      normalizeAddress(n.address), n.amountAtomic.toString(), n.route.microusdPerToken.toString(), n.route.overpayment, expiresAt, acceptUntil, n.at],
  );
}
