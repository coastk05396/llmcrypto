/**
 * Read-only reconciliation queries for operators: stuck reservations and ledger/usage/deposit disagreements. Pure SQL over
 * the existing tables; it changes nothing. The payment worker (apps/worker reconcile-payments) records alerts for the same
 * classes of problem; these views recompute them on demand from the ledger so an operator never has to trust a cached flag.
 */
import type { SqlExecutor } from "./sql";

export type StuckReason = "not_dispatched" | "dispatched_stale" | "usage_pending_past_deadline";
export interface StuckReservationRow {
  reservationId: string;
  requestId: string;
  accountId: string;
  amountMicrousd: string;
  requestState: string;
  reason: StuckReason;
  ageSeconds: number;
  createdAt: Date;
}

/** Active holds that should have moved on: never dispatched, dispatched long ago, or pending past the reconcile deadline. */
export async function findStuckReservations(q: SqlExecutor, now: Date, olderThanSeconds: number, limit: number): Promise<StuckReservationRow[]> {
  const rows = await q.query<{ rid: string; request_id: string; account_id: string; amount: string; state: string; reason: StuckReason; age: string; created_at: Date }>(
    `select * from (
       select r.id as rid, r.request_id, r.account_id, r.amount::text as amount, q.state,
              case when q.state = 'USAGE_PENDING' and q.usage_deadline <= $1 then 'usage_pending_past_deadline'
                   when q.state in ('VALIDATED','RESERVED') then 'not_dispatched'
                   when q.state = 'DISPATCHED' then 'dispatched_stale' end as reason,
              floor(extract(epoch from ($1::timestamptz - r.created_at)))::text as age, r.created_at
       from reservations r join requests q on q.id = r.request_id
       where r.status = 'active' and r.created_at <= $1::timestamptz - make_interval(secs => $2::float8)
     ) s where reason is not null order by created_at, rid limit $3`,
    [now, olderThanSeconds, limit],
  );
  return rows.map((r) => ({ reservationId: r.rid, requestId: r.request_id, accountId: r.account_id, amountMicrousd: r.amount, requestState: r.state, reason: r.reason, ageSeconds: Number(r.age), createdAt: r.created_at }));
}

export type MismatchKind =
  | "unbalanced_transaction"
  | "ledger_not_zero"
  | "reservation_charge_mismatch"
  | "usage_charge_mismatch"
  | "deposit_credit_mismatch"
  | "orphan_deposit_credit"
  | "negative_balance";
export interface LedgerMismatchRow {
  kind: MismatchKind;
  accountId: string | null;
  refId: string;
  expectedMicrousd: string | null;
  actualMicrousd: string | null;
  detail: string;
}

/** Every disagreement between ledger postings and the records that claim them. Empty = consistent. */
export async function findLedgerMismatches(q: SqlExecutor, limit: number): Promise<LedgerMismatchRow[]> {
  const out: LedgerMismatchRow[] = [];
  const push = (r: LedgerMismatchRow): void => void out.push(r);

  for (const r of await q.query<{ transaction_id: string; account_id: string; s: string }>(
    "select e.transaction_id, t.account_id, sum(e.amount)::text as s from ledger_entries e join ledger_transactions t on t.id = e.transaction_id group by e.transaction_id, t.account_id having sum(e.amount) <> 0 limit $1",
    [limit],
  )) push({ kind: "unbalanced_transaction", accountId: r.account_id, refId: r.transaction_id, expectedMicrousd: "0", actualMicrousd: r.s, detail: "ledger transaction does not sum to zero" });

  const [tot] = await q.query<{ s: string }>("select coalesce(sum(amount),0)::text as s from ledger_entries");
  if (tot && tot.s !== "0") push({ kind: "ledger_not_zero", accountId: null, refId: "ledger", expectedMicrousd: "0", actualMicrousd: tot.s, detail: "sum of all ledger entries is not zero" });

  for (const r of await q.query<{ id: string; account_id: string; charge: string; posted: string }>(
    `select r.id, r.account_id, coalesce(r.charge_microusd,0)::text as charge,
            (select coalesce(-sum(e.amount),0) from ledger_entries e where e.transaction_id = r.ledger_transaction_id and e.ledger_account='customer_funds')::text as posted
     from reservations r where r.status = 'settled'
       and coalesce(r.charge_microusd,0) <> (select coalesce(-sum(e.amount),0) from ledger_entries e where e.transaction_id = r.ledger_transaction_id and e.ledger_account='customer_funds')
     limit $1`,
    [limit],
  )) push({ kind: "reservation_charge_mismatch", accountId: r.account_id, refId: r.id, expectedMicrousd: r.charge, actualMicrousd: r.posted, detail: "settled reservation charge differs from its ledger spend" });

  for (const r of await q.query<{ id: string; account_id: string; usage: string; charge: string }>(
    `select u.id, q.account_id, u.charge_microusd::text as usage, coalesce(rs.charge_microusd,0)::text as charge
     from usage_records u join requests q on q.id = u.request_id left join reservations rs on rs.request_id = u.request_id
     where u.settled_at is not null and u.usage_source = 'provider' and u.charge_microusd <> coalesce(rs.charge_microusd,0) limit $1`,
    [limit],
  )) push({ kind: "usage_charge_mismatch", accountId: r.account_id, refId: r.id, expectedMicrousd: r.usage, actualMicrousd: r.charge, detail: "usage record charge differs from the reservation charge" });

  for (const r of await q.query<{ id: string; account_id: string; credited: string | null; posted: string }>(
    `select i.id, i.account_id, i.credited_microusd::text as credited,
            (select coalesce(sum(le.amount),0) from ledger_entries le where le.transaction_id = i.ledger_transaction_id and le.ledger_account='customer_funds')::text as posted
     from deposit_intents i where i.status in ('CREDITED','REVERSED')
       and i.credited_microusd is distinct from (select coalesce(sum(le.amount),0) from ledger_entries le where le.transaction_id = i.ledger_transaction_id and le.ledger_account='customer_funds')
     limit $1`,
    [limit],
  )) push({ kind: "deposit_credit_mismatch", accountId: r.account_id, refId: r.id, expectedMicrousd: r.credited, actualMicrousd: r.posted, detail: "deposit credit differs from its ledger postings" });

  for (const r of await q.query<{ id: string; account_id: string; kind: string }>(
    `select t.id, t.account_id, t.kind from ledger_transactions t
     where t.source_type = 'deposit' and t.kind in ('deposit','reversal')
       and not exists (select 1 from deposit_intents i where i.id = t.source_id and (i.ledger_transaction_id = t.id or i.reversal_transaction_id = t.id)) limit $1`,
    [limit],
  )) push({ kind: "orphan_deposit_credit", accountId: r.account_id, refId: r.id, expectedMicrousd: null, actualMicrousd: null, detail: `ledger ${r.kind} that no deposit intent points to` });

  for (const r of await q.query<{ account_id: string; s: string }>(
    "select account_id, sum(amount)::text as s from ledger_entries where ledger_account = 'customer_funds' group by account_id having sum(amount) < 0 limit $1",
    [limit],
  )) push({ kind: "negative_balance", accountId: r.account_id, refId: r.account_id, expectedMicrousd: "0", actualMicrousd: r.s, detail: "customer posted balance is negative" });

  return out.slice(0, limit);
}
