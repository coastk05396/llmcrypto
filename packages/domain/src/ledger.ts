/**
 * Balanced double-entry ledger.
 *
 * Every financial event is one transaction whose entries sum to exactly zero. Customer funds are the
 * `customer_funds` ledger account (credit positive); the counter-entry sits on a system account:
 * `funding_source` for credits (dev/test seed now, confirmed deposits later) and `revenue` for spend.
 * Transactions and entries are append-only (database triggers), and the zero-sum rule is enforced at commit
 * by a deferred constraint trigger as well as here. A transaction is identified by (source type, source id,
 * kind), so posting the same event twice is a no-op rather than a double charge.
 */
import type { SqlExecutor } from "./sql";

export type LedgerAccountName = "customer_funds" | "funding_source" | "revenue";
export type LedgerTxKind = "deposit" | "spend" | "adjustment" | "reversal";
export type LedgerSourceType = "request" | "deposit" | "adjustment";

export interface Posting {
  ledgerAccount: LedgerAccountName;
  /** Customer account for customer_funds entries, otherwise null. */
  accountId: string | null;
  /** Signed micro-USD, never zero. */
  amount: bigint;
}

export function assertBalanced(postings: readonly Posting[]): void {
  if (postings.length < 2) throw new Error("A ledger transaction needs at least two postings");
  let sum = 0n;
  for (const p of postings) {
    if (p.amount === 0n) throw new Error("Zero-amount posting");
    if ((p.ledgerAccount === "customer_funds") !== (p.accountId !== null)) throw new Error("accountId is required for (only) customer_funds postings");
    sum += p.amount;
  }
  if (sum !== 0n) throw new Error(`Unbalanced ledger transaction (sum ${sum})`);
}

/** Customer receives `amount` from the funding source. */
export function creditPostings(accountId: string, amount: bigint): Posting[] {
  if (amount <= 0n) throw new RangeError("Credit must be positive");
  return [
    { ledgerAccount: "customer_funds", accountId, amount },
    { ledgerAccount: "funding_source", accountId: null, amount: -amount },
  ];
}

/** Customer spends `amount`; it becomes revenue. */
export function spendPostings(accountId: string, amount: bigint): Posting[] {
  if (amount <= 0n) throw new RangeError("Spend must be positive");
  return [
    { ledgerAccount: "customer_funds", accountId, amount: -amount },
    { ledgerAccount: "revenue", accountId: null, amount },
  ];
}

export interface LedgerTxInput {
  id: string;
  accountId: string;
  kind: LedgerTxKind;
  sourceType: LedgerSourceType;
  sourceId: string;
  /** Immutable price snapshot the charge used (spend only). */
  priceVersion: string | null;
  reason: string;
  at: Date;
  postings: readonly Posting[];
  newEntryId: () => string;
}

export interface PostResult {
  transactionId: string;
  /** false: the event had already been posted; nothing was written. */
  created: boolean;
}

/** Posts a balanced transaction idempotently. Run it inside the caller's DB transaction. */
export async function postTransaction(q: SqlExecutor, t: LedgerTxInput): Promise<PostResult> {
  assertBalanced(t.postings);
  const inserted = await q.query<{ id: string }>(
    `insert into ledger_transactions (id, account_id, kind, source_type, source_id, price_version_id, reason, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (source_type, source_id, kind) do nothing returning id`,
    [t.id, t.accountId, t.kind, t.sourceType, t.sourceId, t.priceVersion, t.reason, t.at],
  );
  if (inserted.length === 0) {
    const [prior] = await q.query<{ id: string }>("select id from ledger_transactions where source_type=$1 and source_id=$2 and kind=$3", [t.sourceType, t.sourceId, t.kind]);
    if (!prior) throw new Error("ledger transaction vanished");
    return { transactionId: prior.id, created: false };
  }
  for (const p of t.postings) {
    await q.query(
      "insert into ledger_entries (id, transaction_id, ledger_account, account_id, amount, created_at) values ($1,$2,$3,$4,$5,$6)",
      [t.newEntryId(), t.id, p.ledgerAccount, p.accountId, p.amount.toString(), t.at],
    );
  }
  return { transactionId: t.id, created: true };
}

/** Posted customer funds (sum of the account's customer_funds entries). */
export async function postedBalance(q: SqlExecutor, accountId: string): Promise<bigint> {
  const [r] = await q.query<{ s: string }>("select coalesce(sum(amount), 0)::text as s from ledger_entries where ledger_account='customer_funds' and account_id=$1", [accountId]);
  return BigInt(r?.s ?? "0");
}

/** Sum of active reservation holds. */
export async function activeHolds(q: SqlExecutor, accountId: string): Promise<bigint> {
  const [r] = await q.query<{ s: string }>("select coalesce(sum(amount), 0)::text as s from reservations where account_id=$1 and status='active'", [accountId]);
  return BigInt(r?.s ?? "0");
}

export interface AccountBalance {
  posted: bigint;
  held: bigint;
  /** posted - held (never reported below zero). */
  available: bigint;
}
export const availableFunds = (posted: bigint, held: bigint): bigint => (posted > held ? posted - held : 0n);

export async function accountBalance(q: SqlExecutor, accountId: string): Promise<AccountBalance> {
  const posted = await postedBalance(q, accountId);
  const held = await activeHolds(q, accountId);
  return { posted, held, available: availableFunds(posted, held) };
}

export interface LedgerIntegrityReport {
  unbalancedTransactions: string[];
  /** Sum of every entry in the ledger; must be 0. */
  totalSum: bigint;
}

/** Audit query: every transaction must sum to zero and so must the whole ledger. */
export async function verifyLedger(q: SqlExecutor): Promise<LedgerIntegrityReport> {
  const bad = await q.query<{ transaction_id: string }>("select transaction_id from ledger_entries group by transaction_id having sum(amount) <> 0");
  const [tot] = await q.query<{ s: string }>("select coalesce(sum(amount), 0)::text as s from ledger_entries");
  return { unbalancedTransactions: bad.map((b) => b.transaction_id), totalSum: BigInt(tot?.s ?? "0") };
}
