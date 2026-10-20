/**
 * SQL side of deposit crediting: ingests one observed transfer (from a ChainClient) atomically.
 *
 * One database transaction per observation: upsert the chain event, lock the matched intent, run the pure
 * decision (chain-events.ts) and apply it, including the balanced ledger posting. Replays are harmless:
 *  - chain_events is unique on (network, tx hash, event index, asset contract);
 *  - observations older than the stored chain head are ignored (out-of-order delivery);
 *  - the ledger anchors a credit to (source=deposit, source id=intent id, kind=deposit), so even a logic bug could
 *    not credit one intent twice.
 */
import { creditPostings, postTransaction, type Posting } from "./ledger";
import { enqueueNotification } from "./notifications";
import type { SqlDb, SqlExecutor } from "./sql";
import {
  decideDeposit, eventKey, normalizeAddress, normalizeContract, normalizeTxHash,
  type Decision, type DepositStatus, type IntentFacts, type ReviewReason, type TransferFacts,
} from "./chain-events";

/** A transfer as reported by a ChainClient, with the observation context. */
export interface ObservedTransfer {
  network: string;
  chainId: string;
  txHash: string;
  eventIndex: number;
  /** "" or null: native asset. */
  assetContract: string | null;
  from: string | null;
  to: string;
  amountAtomic: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
  /** Confirmations at observation time (1 = included in the head block); 0 = pending/unmined. */
  confirmations: number;
  /** true: the transfer is no longer on the canonical chain. */
  removed: boolean;
  /** Chain head height when observed. Orders deliveries: lower than a stored value = stale. */
  headBlock: bigint;
}

export interface IngestContext {
  now: Date;
  newId: (prefix: string) => string;
}

export type IngestOutcome =
  | { outcome: "stale_ignored"; eventId: string }
  | { outcome: "unmatched"; eventId: string }
  | { outcome: "applied"; eventId: string; depositId: string; decision: Decision["kind"]; status: DepositStatus; ledgerTransactionId?: string };

interface IntentRow {
  id: string; account_id: string; status: DepositStatus; network: string; chain_id: string; asset_contract: string; address_key: string;
  amount_atomic: string; decimals: number; required_confirmations: number; microusd_per_token: string; overpayment_policy: "review" | "credit_full";
  accept_until: Date; confirmations: number; matched_event_key: string | null; credited_microusd: string | null;
}
interface EventRow { id: string; last_head_block: string }

const INTENT_COLS = `id, account_id, status, network, chain_id, asset_contract, address_key, amount_atomic::text as amount_atomic, decimals, required_confirmations,
  microusd_per_token::text as microusd_per_token, overpayment_policy, accept_until, confirmations, matched_event_key, credited_microusd::text as credited_microusd`;

function intentFacts(r: IntentRow): IntentFacts {
  return {
    status: r.status, network: r.network, chainId: r.chain_id, assetContract: r.asset_contract, addressKey: r.address_key,
    amountAtomic: BigInt(r.amount_atomic), decimals: r.decimals, requiredConfirmations: r.required_confirmations,
    microusdPerToken: BigInt(r.microusd_per_token), overpayment: r.overpayment_policy, acceptUntil: r.accept_until,
    confirmations: r.confirmations, matchedEventKey: r.matched_event_key,
  };
}

export async function recordAlert(
  q: SqlExecutor,
  a: { newId: (p: string) => string; dedupeKey: string; kind: string; severity: "info" | "warning" | "critical"; accountId?: string | null; depositId?: string | null; details?: Record<string, unknown>; at: Date },
): Promise<boolean> {
  const r = await q.query(
    `insert into payment_alerts (id, dedupe_key, kind, severity, account_id, deposit_id, details, created_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) on conflict (dedupe_key) do nothing returning id`,
    [a.newId("palert"), a.dedupeKey, a.kind, a.severity, a.accountId ?? null, a.depositId ?? null, JSON.stringify(a.details ?? {}), a.at],
  );
  return r.length > 0;
}

async function openReview(
  q: SqlExecutor,
  r: { newId: (p: string) => string; kind: "deposit" | "unmatched_event" | "duplicate_event" | "reorg_reversal"; reason: string; accountId: string | null; depositId: string | null; eventId: string | null; details: Record<string, unknown>; at: Date },
): Promise<void> {
  await q.query(
    `insert into payment_reviews (id, kind, reason, account_id, deposit_id, chain_event_id, details, created_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) on conflict do nothing`,
    [r.newId("prv"), r.kind, r.reason, r.accountId, r.depositId, r.eventId, JSON.stringify(r.details), r.at],
  );
}

async function auditPayment(q: SqlExecutor, newId: (p: string) => string, accountId: string, action: string, depositId: string, at: Date, metadata: Record<string, string | number | boolean | null>): Promise<void> {
  await q.query(
    `insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,null,$3,'deposit_intent',$4,$5::jsonb,$6)`,
    [newId("aud"), accountId, action, depositId, JSON.stringify(metadata), at],
  );
}

/** Customer funds are debited, the funding source is credited back. */
const reversalPostings = (accountId: string, amount: bigint): Posting[] => [
  { ledgerAccount: "customer_funds", accountId, amount: -amount },
  { ledgerAccount: "funding_source", accountId: null, amount },
];

export async function ingestTransfer(db: SqlDb, t: ObservedTransfer, ctx: IngestContext): Promise<IngestOutcome> {
  return db.tx((q) => ingestInTx(q, t, ctx));
}

async function ingestInTx(q: SqlExecutor, t: ObservedTransfer, ctx: IngestContext): Promise<IngestOutcome> {
  const contract = normalizeContract(t.assetContract);
  const key = eventKey(t.network, t.txHash, t.eventIndex, contract);
  const toKey = normalizeAddress(t.to);
  const eventId = ctx.newId("cev");

  const inserted = await q.query(
    `insert into chain_events (id, event_key, network, chain_id, tx_hash, event_index, asset_contract, from_address, to_address, to_address_key, amount_atomic,
       block_number, block_hash, block_time, confirmations, removed, last_head_block, match_result, first_seen_at, last_seen_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'unprocessed',$18,$18) on conflict (event_key) do nothing returning id`,
    [eventId, key, t.network, t.chainId, normalizeTxHash(t.txHash), t.eventIndex, contract, t.from, t.to, toKey, t.amountAtomic.toString(),
      t.blockNumber.toString(), t.blockHash, t.blockTime, t.confirmations, t.removed, t.headBlock.toString(), ctx.now],
  );
  const [row] = await q.query<EventRow>("select id, last_head_block::text as last_head_block from chain_events where event_key=$1 for update", [key]);
  if (!row) throw new Error("chain event vanished");
  if (inserted.length === 0) {
    if (t.headBlock < BigInt(row.last_head_block)) return { outcome: "stale_ignored", eventId: row.id };
    await q.query(
      `update chain_events set block_number=$2, block_hash=$3, block_time=$4, confirmations=$5, removed=$6, last_head_block=$7, last_seen_at=$8 where id=$1`,
      [row.id, t.blockNumber.toString(), t.blockHash, t.blockTime, t.confirmations, t.removed, t.headBlock.toString(), ctx.now],
    );
  }

  // Match by the destination address the server generated for an intent; prefer the intent on the same network.
  const [intent] = await q.query<IntentRow>(
    `select ${INTENT_COLS} from deposit_intents where address_key=$1 order by (network = $2) desc, created_at limit 1 for update`,
    [toKey, t.network],
  );
  if (!intent) {
    await q.query("update chain_events set match_result='unmatched' where id=$1", [row.id]);
    if (!t.removed) {
      await openReview(q, { newId: ctx.newId, kind: "unmatched_event", reason: "UNMATCHED", accountId: null, depositId: null, eventId: row.id, details: { network: t.network, to: t.to, amountAtomic: t.amountAtomic.toString(), assetContract: contract }, at: ctx.now });
    }
    return { outcome: "unmatched", eventId: row.id };
  }

  // Serialize with review approval on the intent before checking its event-backed credits.
  if (t.removed) await compensateAdjustmentCredits(q, row.id, key, ctx);

  const facts: TransferFacts = {
    eventKey: key, network: t.network, chainId: t.chainId, assetContract: contract, toKey, amountAtomic: t.amountAtomic,
    blockTime: t.blockTime, confirmations: t.confirmations, removed: t.removed,
  };
  // A rejected observation must not reopen on redelivery; its review remains durable evidence.
  const [rejected] = await q.query("select 1 as x from payment_reviews where chain_event_id=$1 and status='resolved' and resolution like 'rejected by adjustment %'", [row.id]);
  let decision = rejected ? { kind: "noop" as const } : decideDeposit(intentFacts(intent), facts);
  // Replays of an observation already reviewed must retain that single review, even after a valid
  // replacement takes over the intent. Otherwise one transfer can acquire multiple credit approvals.
  const [reviewed] = await q.query("select 1 as x from payment_reviews where chain_event_id=$1", [row.id]);
  if (reviewed && decision.kind === "flag_event" && decision.reason === "DUPLICATE_PAYMENT") decision = { kind: "noop" };
  const done = (status: DepositStatus, extra: { ledgerTransactionId?: string } = {}): IngestOutcome => ({
    outcome: "applied", eventId: row.id, depositId: intent.id, decision: decision.kind, status, ...extra,
  });
  const link = (result: string) => q.query("update chain_events set deposit_id=$2, match_result=$3 where id=$1", [row.id, intent.id, result]);

  switch (decision.kind) {
    case "noop":
      await link("noop");
      return done(intent.status);
    case "progress":
      await link("progress");
      await q.query("update deposit_intents set status=$2, confirmations=$3, matched_event_key=$4, updated_at=$5 where id=$1", [intent.id, decision.status, decision.confirmations, key, ctx.now]);
      return done(decision.status);
    case "credit": {
      await link("credited");
      const tx = await postTransaction(q, {
        id: ctx.newId("ltx"), accountId: intent.account_id, kind: "deposit", sourceType: "deposit", sourceId: intent.id, priceVersion: null,
        reason: `Confirmed deposit ${intent.id} (${t.network})`, at: ctx.now, postings: creditPostings(intent.account_id, decision.creditedMicrousd), newEntryId: () => ctx.newId("le"),
      });
      await q.query(
        "update deposit_intents set status='CREDITED', confirmations=$2, matched_event_key=$3, credited_microusd=$4, ledger_transaction_id=$5, review_reason=null, updated_at=$6 where id=$1",
        [intent.id, decision.confirmations, key, decision.creditedMicrousd.toString(), tx.transactionId, ctx.now],
      );
      if (tx.created) await auditPayment(q, ctx.newId, intent.account_id, "deposit.credited", intent.id, ctx.now, { creditedMicrousd: decision.creditedMicrousd.toString(), confirmations: decision.confirmations, network: t.network });
      // Alert outbox row in the same transaction as the credit; only when the credit was newly posted and someone subscribes.
      if (tx.created) await enqueueNotification(q, { id: ctx.newId("nev"), accountId: intent.account_id, kind: "deposit_credited", ref: intent.id, dedupeKey: `deposit_credited:${intent.id}`, at: ctx.now });
      return done("CREDITED", { ledgerTransactionId: tx.transactionId });
    }
    case "review": {
      await link(`review:${decision.reason}`);
      await q.query(
        "update deposit_intents set status='REVIEW_REQUIRED', review_reason=$2, confirmations=$3, matched_event_key=$4, updated_at=$5 where id=$1",
        [intent.id, decision.reason, decision.confirmations, key, ctx.now],
      );
      await openReview(q, { newId: ctx.newId, kind: "deposit", reason: decision.reason satisfies ReviewReason, accountId: intent.account_id, depositId: intent.id, eventId: row.id, details: { receivedAtomic: t.amountAtomic.toString(), expectedAtomic: intent.amount_atomic, network: t.network, assetContract: contract }, at: ctx.now });
      await auditPayment(q, ctx.newId, intent.account_id, "deposit.review_required", intent.id, ctx.now, { reason: decision.reason });
      await enqueueNotification(q, { id: ctx.newId("nev"), accountId: intent.account_id, kind: "deposit_needs_review", ref: intent.id, dedupeKey: `deposit_needs_review:${intent.id}:${decision.reason}`, at: ctx.now });
      return done("REVIEW_REQUIRED");
    }
    case "revert": {
      await link("reverted_before_credit");
      const status: DepositStatus = ctx.now.getTime() > intent.accept_until.getTime() ? "EXPIRED" : "CREATED";
      await q.query("update deposit_intents set status=$2, confirmations=0, matched_event_key=null, updated_at=$3 where id=$1", [intent.id, status, ctx.now]);
      await auditPayment(q, ctx.newId, intent.account_id, "deposit.transfer_removed", intent.id, ctx.now, { fromStatus: intent.status });
      return done(status);
    }
    case "reverse": {
      await link("reversed");
      const amount = BigInt(intent.credited_microusd ?? "0");
      const tx = await postTransaction(q, {
        id: ctx.newId("ltx"), accountId: intent.account_id, kind: "reversal", sourceType: "deposit", sourceId: intent.id, priceVersion: null,
        reason: `Compensation: transfer for deposit ${intent.id} left the canonical chain`, at: ctx.now, postings: reversalPostings(intent.account_id, amount), newEntryId: () => ctx.newId("le"),
      });
      await q.query("update deposit_intents set status='REVERSED', reversal_transaction_id=$2, updated_at=$3 where id=$1", [intent.id, tx.transactionId, ctx.now]);
      await openReview(q, { newId: ctx.newId, kind: "reorg_reversal", reason: "CREDITED_TRANSFER_REVERSED", accountId: intent.account_id, depositId: intent.id, eventId: row.id, details: { reversedMicrousd: amount.toString() }, at: ctx.now });
      await recordAlert(q, { newId: ctx.newId, dedupeKey: `reversed:${intent.id}`, kind: "CREDITED_TRANSFER_REVERSED", severity: "critical", accountId: intent.account_id, depositId: intent.id, details: { reversedMicrousd: amount.toString() }, at: ctx.now });
      await auditPayment(q, ctx.newId, intent.account_id, "deposit.reversed", intent.id, ctx.now, { reversedMicrousd: amount.toString() });
      return done("REVERSED", { ledgerTransactionId: tx.transactionId });
    }
    case "flag_event": {
      await link(`flagged:${decision.reason}`);
      await openReview(q, { newId: ctx.newId, kind: "duplicate_event", reason: decision.reason, accountId: intent.account_id, depositId: intent.id, eventId: row.id, details: { amountAtomic: t.amountAtomic.toString(), network: t.network }, at: ctx.now });
      await auditPayment(q, ctx.newId, intent.account_id, "deposit.extra_transfer_flagged", intent.id, ctx.now, { reason: decision.reason });
      return done(intent.status);
    }
  }
}

/** Event keys (not yet removed) that carry an approved operator credit, so observers know which extra events to re-verify. */
export async function listAdjustedEventKeys(q: SqlExecutor): Promise<string[]> {
  const rows = await q.query<{ event_key: string }>(
    `select distinct e.event_key from chain_events e
       join payment_reviews r on r.chain_event_id = e.id
       join operator_adjustments a on a.review_id = r.id and a.action = 'credit'
       join operator_adjustment_decisions d on d.adjustment_id = a.id and d.decision = 'approved'
      where e.removed = false`,
  );
  return rows.map((r) => r.event_key);
}

/**
 * An operator credit approved for a review of a transfer that later left the canonical chain is compensated with a reversal
 * (source = the adjustment, kind reversal; unique, so it posts once). The deposit intent and any primary payment stay untouched.
 */
async function compensateAdjustmentCredits(q: SqlExecutor, eventId: string, key: string, ctx: IngestContext): Promise<void> {
  const credits = await q.query<{ id: string; account_id: string; amount: string }>(
    `select distinct a.id, a.account_id, a.amount_microusd::text as amount
       from payment_reviews r join operator_adjustments a on a.review_id = r.id and a.action = 'credit'
       join operator_adjustment_decisions d on d.adjustment_id = a.id and d.decision = 'approved'
      where r.chain_event_id = $1
        and not exists (select 1 from deposit_intents i where i.ledger_transaction_id = d.ledger_transaction_id)`,
    [eventId],
  );
  for (const c of credits) {
    await q.query("select id from accounts where id=$1 for update", [c.account_id]);
    const amount = BigInt(c.amount);
    const tx = await postTransaction(q, {
      id: ctx.newId("ltx"), accountId: c.account_id, kind: "reversal", sourceType: "adjustment", sourceId: c.id, priceVersion: null,
      reason: `Compensation: transfer behind operator credit ${c.id} left the canonical chain`, at: ctx.now, postings: reversalPostings(c.account_id, amount), newEntryId: () => ctx.newId("le"),
    });
    if (!tx.created) continue;
    await recordAlert(q, { newId: ctx.newId, dedupeKey: `reversed-adjustment:${c.id}`, kind: "CREDITED_TRANSFER_REVERSED", severity: "critical", accountId: c.account_id, details: { adjustmentId: c.id, eventKey: key, reversedMicrousd: amount.toString() }, at: ctx.now });
    await q.query(
      `insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,null,'payment.adjustment_credit_reversed','adjustment',$3,$4::jsonb,$5)`,
      [ctx.newId("aud"), c.account_id, c.id, JSON.stringify({ reversedMicrousd: amount.toString() }), ctx.now],
    );
  }
}

/** CREATED intents whose acceptance deadline passed with no transfer become EXPIRED. Returns the expired ids. */
export async function expireIntents(q: SqlExecutor, now: Date, accountId?: string): Promise<string[]> {
  const rows = await q.query<{ id: string }>(
    `update deposit_intents set status='EXPIRED', updated_at=$1
     where status='CREATED' and matched_event_key is null and accept_until < $1 and ($2::text is null or account_id = $2) returning id`,
    [now, accountId ?? null],
  );
  return rows.map((r) => r.id);
}
