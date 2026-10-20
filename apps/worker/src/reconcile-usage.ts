/**
 * USAGE_PENDING reconciliation job.
 *
 * For every request left in USAGE_PENDING (usage was missing after possible provider acceptance):
 *   1. ask the usage source for verified usage; if found, settle it (charged once, idempotent);
 *   2. otherwise, once the deadline has passed, release the customer hold, absorb the unresolved provider cost
 *      and settle at zero (outcome usage_unresolved). The customer is never charged for it later.
 * It also sweeps requests stuck in DISPATCHED (a gateway crash between dispatch and finalization) into
 * USAGE_PENDING so their holds cannot live forever.
 *
 * The deadline length is the configurable, UNCONFIRMED commercial policy `usagePendingSeconds`
 * (default 24 h, set by the gateway when the request becomes pending).
 */
import {
  failWithoutCharge, listUsagePending, markUsagePending, resolveUnrecoverable, settleRequest,
  type SqlDb, type TokenUsage,
} from "@llmcrypto/domain";

/** Where verified late usage comes from (a provider usage API). null = not known (yet). */
export interface UsageSource {
  lookupUsage(providerRequestId: string): Promise<TokenUsage | null>;
}
/** Source for deployments with no usage API: nothing is ever found, so only the deadline policy applies. */
export const NO_USAGE_SOURCE: UsageSource = { lookupUsage: async () => null };

export interface ReconcileOptions {
  db: SqlDb;
  source: UsageSource;
  now: () => Date;
  newId: (prefix: string) => string;
  batchSize?: number;
  /** DISPATCHED requests older than this are treated as orphaned. */
  staleDispatchSeconds?: number;
  /** RESERVED/VALIDATED requests (a hold that was never dispatched: the gateway died or failed between reserve and dispatch) older than this are released. Default 900. */
  staleReservedSeconds?: number;
  /** Deadline given to swept orphans. */
  usagePendingSeconds?: number;
}

export interface ReconcileReport {
  settled: string[];
  absorbed: string[];
  stillPending: string[];
  sweptStale: string[];
  /** Never-dispatched holds released without charge. */
  releasedReserved: string[];
  errors: { requestId: string; message: string }[];
}

export async function reconcileUsage(o: ReconcileOptions): Promise<ReconcileReport> {
  const report: ReconcileReport = { settled: [], absorbed: [], stillPending: [], sweptStale: [], releasedReserved: [], errors: [] };
  const at = o.now();

  const stale = await o.db.query<{ id: string }>(
    "select id from requests where state='DISPATCHED' and dispatched_at < $1 order by dispatched_at limit $2",
    [new Date(at.getTime() - (o.staleDispatchSeconds ?? 900) * 1000), o.batchSize ?? 100],
  );
  for (const s of stale) {
    const deadline = new Date(at.getTime() + (o.usagePendingSeconds ?? 86_400) * 1000);
    if (await markUsagePending(o.db, s.id, { code: "STALE_DISPATCH", deadline, at })) report.sweptStale.push(s.id);
  }

  // A hold that never reached the provider can be released with certainty: nothing was accepted, so nothing can be owed.
  const unsent = await o.db.query<{ id: string }>(
    `select r.id from requests r join reservations rs on rs.request_id = r.id
      where r.state in ('RESERVED','VALIDATED') and rs.status = 'active' and r.updated_at < $1 order by r.updated_at limit $2`,
    [new Date(at.getTime() - (o.staleReservedSeconds ?? 900) * 1000), o.batchSize ?? 100],
  );
  for (const s of unsent) {
    try {
      // onlyUndispatched: if a late markDispatched won the race the request is DISPATCHED and this does nothing (the provider call may be in flight).
      if (await failWithoutCharge(o.db, s.id, { code: "NEVER_DISPATCHED", at, onlyUndispatched: true })) report.releasedReserved.push(s.id);
    } catch (e) {
      report.errors.push({ requestId: s.id, message: e instanceof Error ? e.message : "unknown" });
    }
  }

  for (const p of await listUsagePending(o.db, o.batchSize ?? 100)) {
    try {
      const usage = p.providerRequestId ? await o.source.lookupUsage(p.providerRequestId) : null;
      if (usage) {
        const r = await settleRequest(o.db, { requestId: p.id, usage, outcome: "succeeded", at, newId: o.newId });
        if (r.status === "settled") report.settled.push(p.id);
      } else if (at.getTime() >= p.deadline.getTime()) {
        if (await resolveUnrecoverable(o.db, p.id, at)) report.absorbed.push(p.id);
      } else {
        report.stillPending.push(p.id);
      }
    } catch (e) {
      report.errors.push({ requestId: p.id, message: e instanceof Error ? e.message : "unknown" });
    }
  }
  return report;
}
