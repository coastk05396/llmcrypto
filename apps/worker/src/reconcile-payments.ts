/**
 * Payment reconciliation, independent of the observer's own bookkeeping. It re-derives facts from the chain
 * (via the ChainClient) and from the ledger, and records `payment_alerts` rows for anything that disagrees:
 *
 *  1. MISSED_EVENT          a transfer to a watched address exists on chain but was never observed (it is ingested now).
 *  2. EVENT_NOT_CANONICAL   a recorded transfer is no longer on the canonical chain (reorg); ingested as a removal, which
 *                           reverses a credit with a compensating ledger transaction and opens an account review.
 *  3. LEDGER_MISMATCH       a CREDITED/REVERSED intent whose ledger postings do not equal its recorded credit.
 *  4. ORPHAN_LEDGER_CREDIT  a deposit ledger transaction no intent points to (or a reversal without a REVERSED intent).
 *  5. LEDGER_UNBALANCED     the whole ledger (or any transaction) does not sum to zero.
 *  6. CHAIN_CLIENT_ERROR    the chain source failed; nothing was changed for the affected scope.
 *
 * Alerts are idempotent (dedupe_key), so running the job repeatedly does not spam. Alerts are records only: wiring them
 * to a pager is part of release preparation (task 26).
 */
import { eventKey, expireIntents, ingestTransfer, recordAlert, verifyLedger, type ObservedTransfer, type SqlDb } from "@llmcrypto/domain";
import type { ChainClient } from "./chain-client";
import { checkAdjustedEvents, listWatchedIntents, removalObservation } from "./chain-observer";

export interface ReconcileOptions {
  db: SqlDb;
  client: ChainClient;
  now: () => Date;
  newId: (prefix: string) => string;
  /** Only intents/events newer than this are re-verified against the chain. */
  lookbackSeconds?: number;
  /** Same meaning as in the observer: extra networks scanned for every watched address. */
  scanNetworks?: readonly string[];
}

export interface PaymentReconcileReport {
  expired: string[];
  missedEvents: string[];
  nonCanonical: string[];
  ledgerMismatches: string[];
  /** dedupe keys of NEWLY recorded alerts. */
  alerts: string[];
  errors: { scope: string; message: string }[];
}

export async function reconcilePayments(o: ReconcileOptions): Promise<PaymentReconcileReport> {
  const at = o.now();
  const lookback = o.lookbackSeconds ?? 7 * 86_400;
  const ctx = { now: at, newId: o.newId };
  const report: PaymentReconcileReport = { expired: [], missedEvents: [], nonCanonical: [], ledgerMismatches: [], alerts: [], errors: [] };
  const alert = async (a: Omit<Parameters<typeof recordAlert>[1], "newId" | "at">): Promise<void> => {
    if (await recordAlert(o.db, { ...a, newId: o.newId, at })) report.alerts.push(a.dedupeKey);
  };
  const clientError = async (scope: string, network: string, e: unknown): Promise<void> => {
    const message = e instanceof Error ? e.message : "unknown";
    report.errors.push({ scope, message });
    await alert({ dedupeKey: `client:${network}:${at.toISOString().slice(0, 13)}`, kind: "CHAIN_CLIENT_ERROR", severity: "warning", details: { network, scope, message } });
  };

  report.expired = await expireIntents(o.db, at);

  // 1. Missed events: anything the chain lists for a watched address that we have no row for.
  for (const intent of await listWatchedIntents(o.db, at, lookback)) {
    try {
      const listed: ObservedTransfer[] = [];
      for (const network of new Set([intent.network, ...(o.scanNetworks ?? [])])) listed.push(...(await o.client.getTransfersTo(network, intent.address)));
      for (const t of listed) {
        const key = eventKey(t.network, t.txHash, t.eventIndex, t.assetContract);
        const known = await o.db.query("select 1 as x from chain_events where event_key=$1", [key]);
        if (known.length) continue;
        await ingestTransfer(o.db, t, ctx);
        report.missedEvents.push(key);
        await alert({ dedupeKey: `missed:${key}`, kind: "MISSED_EVENT", severity: "warning", depositId: intent.id, details: { eventKey: key } });
      }
    } catch (e) {
      await clientError(`missed:${intent.id}`, intent.network, e);
    }
  }

  // 2. Recorded transfers that are no longer canonical.
  const tracked = await o.db.query<{ event_key: string; network: string; tx_hash: string; event_index: number; asset_contract: string; deposit_id: string; status: string; account_id: string }>(
    `select e.event_key, e.network, e.tx_hash, e.event_index, e.asset_contract, i.id as deposit_id, i.status, i.account_id
     from chain_events e join deposit_intents i on i.id = e.deposit_id and i.matched_event_key = e.event_key
     where e.removed = false and i.status in ('DETECTED','CONFIRMING','CREDITED','REVIEW_REQUIRED') and e.last_seen_at >= $1
     order by e.first_seen_at, e.id`,
    [new Date(at.getTime() - lookback * 1000)],
  );
  for (const e of tracked) {
    try {
      const found = await o.client.getTransfer(e.network, { txHash: e.tx_hash, eventIndex: e.event_index, assetContract: e.asset_contract });
      if (found !== null) continue;
      const removal = await removalObservation(o.db, e.event_key, (await o.client.getHead(e.network)).blockNumber);
      if (!removal) continue;
      await ingestTransfer(o.db, removal, ctx);
      report.nonCanonical.push(e.event_key);
      await alert({
        dedupeKey: `noncanonical:${e.event_key}`, kind: "EVENT_NOT_CANONICAL", severity: e.status === "CREDITED" ? "critical" : "warning",
        accountId: e.account_id, depositId: e.deposit_id, details: { eventKey: e.event_key, statusBefore: e.status },
      });
    } catch (err) {
      await clientError(`canonical:${e.event_key}`, e.network, err);
    }
  }

  // 2b. Events behind an approved operator credit that are no longer canonical (compensated by the ingest).
  await checkAdjustedEvents(o, (r) => void (r.outcome === "applied" && report.nonCanonical.push(r.eventId)), (scope, e) => void report.errors.push({ scope, message: e instanceof Error ? e.message : "unknown" }));

  // 3. Credited/reversed intents vs. their ledger postings.
  const mismatched = await o.db.query<{ id: string; account_id: string; credited: string | null; posted: string }>(
    `select i.id, i.account_id, i.credited_microusd::text as credited,
            (select coalesce(sum(le.amount),0) from ledger_entries le where le.transaction_id = i.ledger_transaction_id and le.ledger_account='customer_funds')::text as posted
     from deposit_intents i
     where i.status in ('CREDITED','REVERSED')
       and i.credited_microusd is distinct from (select coalesce(sum(le.amount),0) from ledger_entries le where le.transaction_id = i.ledger_transaction_id and le.ledger_account='customer_funds')`,
  );
  for (const m of mismatched) {
    report.ledgerMismatches.push(m.id);
    await alert({ dedupeKey: `ledger-mismatch:${m.id}`, kind: "LEDGER_MISMATCH", severity: "critical", accountId: m.account_id, depositId: m.id, details: { credited: m.credited, posted: m.posted } });
  }
  const reversalOff = await o.db.query<{ id: string; account_id: string }>(
    `select i.id, i.account_id from deposit_intents i
     where i.status = 'REVERSED'
       and (select coalesce(sum(le.amount),0) from ledger_entries le where le.transaction_id = i.reversal_transaction_id and le.ledger_account='customer_funds') <> -i.credited_microusd`,
  );
  for (const m of reversalOff) {
    report.ledgerMismatches.push(m.id);
    await alert({ dedupeKey: `reversal-mismatch:${m.id}`, kind: "LEDGER_MISMATCH", severity: "critical", accountId: m.account_id, depositId: m.id, details: { part: "reversal" } });
  }

  // 4. Ledger deposit/reversal transactions nothing points to.
  const orphans = await o.db.query<{ id: string; account_id: string; kind: string; source_id: string }>(
    `select t.id, t.account_id, t.kind, t.source_id from ledger_transactions t
     where t.source_type = 'deposit' and t.kind in ('deposit','reversal')
       and not exists (select 1 from deposit_intents i where i.id = t.source_id and (i.ledger_transaction_id = t.id or i.reversal_transaction_id = t.id))`,
  );
  for (const t of orphans) {
    report.ledgerMismatches.push(t.source_id);
    await alert({ dedupeKey: `orphan-ledger:${t.id}`, kind: "ORPHAN_LEDGER_CREDIT", severity: "critical", accountId: t.account_id, details: { transactionId: t.id, kind: t.kind, sourceId: t.source_id } });
  }

  // 5. Global ledger integrity.
  const integrity = await verifyLedger(o.db);
  if (integrity.totalSum !== 0n || integrity.unbalancedTransactions.length) {
    await alert({ dedupeKey: `ledger-unbalanced:${at.toISOString().slice(0, 10)}`, kind: "LEDGER_UNBALANCED", severity: "critical", details: { totalSum: integrity.totalSum.toString(), transactions: integrity.unbalancedTransactions.slice(0, 20) } });
  }
  return report;
}
