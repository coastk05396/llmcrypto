/**
 * Chain observer: polls a ChainClient for transfers to the addresses of open deposit intents and feeds each
 * observation through the atomic ingest in @llmcrypto/domain (state machine + ledger). It is a pure reader of
 * chain facts: nothing here trusts a customer-supplied transaction hash.
 *
 * A failing client leaves state untouched (no partial credit); the failure is reported and the next run retries.
 * Duplicate, replayed and out-of-order observations are safe (see ingestTransfer).
 */
import { expireIntents, ingestTransfer, listAdjustedEventKeys, type IngestOutcome, type ObservedTransfer, type SqlDb } from "@llmcrypto/domain";
import type { ChainClient } from "./chain-client";

export interface ObserverOptions {
  db: SqlDb;
  client: ChainClient;
  now: () => Date;
  newId: (prefix: string) => string;
  /**
   * Every intent (expired, credited, in review, reversed) stays watched this long past its acceptance deadline, so a late,
   * extra or re-appearing transfer to its address is queued for review instead of going unnoticed.
   */
  lateWatchSeconds?: number;
  /**
   * Extra networks to scan for each watched address (normally every configured network). EVM addresses exist on every
   * chain, so this is how a transfer sent on the WRONG network is noticed and routed to review instead of being missed.
   */
  scanNetworks?: readonly string[];
}

export interface ObserveReport {
  expired: string[];
  intentsScanned: number;
  ingested: number;
  outcomes: { depositId: string | null; decision: string }[];
  errors: { scope: string; message: string }[];
}

export interface WatchedIntent {
  id: string;
  network: string;
  address: string;
  status: string;
  matched_event_key: string | null;
}

export async function listWatchedIntents(db: SqlDb, now: Date, lateWatchSeconds: number): Promise<WatchedIntent[]> {
  return db.query<WatchedIntent>(
    `select id, network, address, status, matched_event_key from deposit_intents
     where status in ('CREATED','DETECTED','CONFIRMING') or accept_until > $1
     order by created_at, id`,
    [new Date(now.getTime() - lateWatchSeconds * 1000)],
  );
}

/** Builds a "left the canonical chain" observation from the stored event (a vanished tx has no block data to report). */
export async function removalObservation(db: SqlDb, key: string, head: bigint): Promise<ObservedTransfer | null> {
  const [r] = await db.query<{
    network: string; chain_id: string; tx_hash: string; event_index: number; asset_contract: string; from_address: string | null; to_address: string;
    amount_atomic: string; block_number: string; block_hash: string; block_time: Date;
  }>(
    `select network, chain_id, tx_hash, event_index, asset_contract, from_address, to_address, amount_atomic::text as amount_atomic,
            block_number::text as block_number, block_hash, block_time from chain_events where event_key=$1`,
    [key],
  );
  if (!r) return null;
  return {
    network: r.network, chainId: r.chain_id, txHash: r.tx_hash, eventIndex: r.event_index, assetContract: r.asset_contract, from: r.from_address, to: r.to_address,
    amountAtomic: BigInt(r.amount_atomic), blockNumber: BigInt(r.block_number), blockHash: r.block_hash, blockTime: r.block_time, confirmations: 0, removed: true, headBlock: head,
  };
}

/** Re-verifies events that carry an approved operator credit; one that left the canonical chain is ingested as a removal (compensating the credit). */
export async function checkAdjustedEvents(o: Pick<ObserverOptions, "db" | "client" | "now" | "newId">, record: (r: IngestOutcome) => void, onError: (scope: string, e: unknown) => void): Promise<void> {
  for (const key of await listAdjustedEventKeys(o.db)) {
    try {
      const [network, txHash, idx, contract] = key.split("|") as [string, string, string, string];
      if ((await o.client.getTransfer(network, { txHash, eventIndex: Number(idx), assetContract: contract })) !== null) continue;
      const removal = await removalObservation(o.db, key, (await o.client.getHead(network)).blockNumber);
      if (removal) record(await ingestTransfer(o.db, removal, { now: o.now(), newId: o.newId }));
    } catch (e) {
      onError(`adjusted:${key}`, e);
    }
  }
}

export async function observeOnce(o: ObserverOptions): Promise<ObserveReport> {
  const at = o.now();
  const ctx = { now: at, newId: o.newId };
  const report: ObserveReport = { expired: [], intentsScanned: 0, ingested: 0, outcomes: [], errors: [] };
  report.expired = await expireIntents(o.db, at);

  const record = (r: IngestOutcome): void => {
    report.ingested += 1;
    report.outcomes.push({ depositId: r.outcome === "applied" ? r.depositId : null, decision: r.outcome === "applied" ? r.decision : r.outcome });
  };

  for (const intent of await listWatchedIntents(o.db, at, o.lateWatchSeconds ?? 7 * 86_400)) {
    report.intentsScanned += 1;
    try {
      const listed: ObservedTransfer[] = [];
      for (const network of new Set([intent.network, ...(o.scanNetworks ?? [])])) listed.push(...(await o.client.getTransfersTo(network, intent.address)));
      const seenKeys = new Set<string>();
      for (const t of listed) {
        record(await ingestTransfer(o.db, t, ctx));
        seenKeys.add(`${t.txHash.toLowerCase()}|${t.eventIndex}`);
      }
      // The transfer this intent is tied to disappeared from the listing: check it explicitly, it may have been reorged out.
      if (intent.matched_event_key) {
        const [network, txHash, idx, contract] = intent.matched_event_key.split("|") as [string, string, string, string];
        if (!seenKeys.has(`${txHash}|${Number(idx)}`)) {
          const found = await o.client.getTransfer(network, { txHash, eventIndex: Number(idx), assetContract: contract });
          if (found === null) {
            const removal = await removalObservation(o.db, intent.matched_event_key, (await o.client.getHead(network)).blockNumber);
            if (removal) record(await ingestTransfer(o.db, removal, ctx));
          }
        }
      }
    } catch (e) {
      report.errors.push({ scope: `intent:${intent.id}`, message: e instanceof Error ? e.message : "unknown" });
    }
  }
  await checkAdjustedEvents(o, record, (scope, e) => report.errors.push({ scope, message: e instanceof Error ? e.message : "unknown" }));
  return report;
}
