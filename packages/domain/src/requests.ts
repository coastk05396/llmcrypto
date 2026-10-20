/**
 * Gateway request lifecycle persisted with its reservation, usage record and ledger posting.
 *
 *   VALIDATED -> RESERVED -> DISPATCHED -> SUCCEEDED | FAILED | CANCELLED | USAGE_PENDING -> SETTLED
 *
 * - Refused reservation or pre-dispatch failure: hold released immediately, state FAILED/CANCELLED, no charge.
 * - Known usage after dispatch (success, mid-stream failure or disconnect): charged once, then SETTLED
 *   (`outcome` records succeeded | failed | cancelled).
 * - Missing usage after dispatch (timeout, error without usage, no usage reported): USAGE_PENDING with the hold
 *   kept until `usage_deadline`; reconciliation either settles verified usage or, past the deadline, releases
 *   the hold, absorbs the unresolved provider cost and settles at zero (outcome usage_unresolved). It is never
 *   charged afterwards.
 * Only metadata is stored; never prompt or completion text. All transitions are conditional updates, so the
 * gateway and the reconcile worker cannot both finish the same request.
 */
import { chargeFor, effectiveCachedRate, type RateSnapshot, type TokenUsage } from "./pricing";
import { releaseReservation, reserveFunds, settleReservation, type ReserveRefusal } from "./reservations";
import type { SqlDb, SqlExecutor } from "./sql";

export type RequestStateName = "VALIDATED" | "RESERVED" | "DISPATCHED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "USAGE_PENDING" | "SETTLED";
export type RequestOutcome = "succeeded" | "failed" | "cancelled" | "usage_unresolved" | "rejected";
export type IdFactory = (prefix: string) => string;

export interface NewRequest {
  id: string;
  accountId: string;
  keyId: string | null;
  projectId: string | null;
  runId: string | null;
  parentId: string | null;
  correlationId: string | null;
  protocol: "openai_chat" | "openai_responses" | "anthropic_messages";
  model: string;
  stream: boolean;
  rates: RateSnapshot;
  reservedMicrousd: bigint;
  at: Date;
  newId: IdFactory;
  /** Optimization policy version in force (0 = defaults). Recorded on the request row. */
  policyVersion?: number;
  /** Runs inside the same transaction once the hold succeeded (evidence rows). A refused reservation never runs it. */
  afterReserve?: (q: SqlExecutor) => Promise<void>;
}

/** Conditional state change; `extra.set` may reference $4 (at) and $5.. (extra.params). Returns false when the request was not in `from`. */
async function transition(q: SqlExecutor, id: string, from: RequestStateName, to: RequestStateName, at: Date, note: string | null, extra?: { set: string; params: unknown[] }): Promise<boolean> {
  const rows = await q.query<{ id: string }>(`update requests set state=$3, updated_at=$4${extra?.set ?? ""} where id=$1 and state=$2 returning id`, [id, from, to, at, ...(extra?.params ?? [])]);
  if (rows.length === 0) return false;
  await q.query("insert into request_transitions (request_id, from_state, to_state, at, note) values ($1,$2,$3,$4,$5)", [id, from, to, at, note]);
  return true;
}

export type BeginResult = { ok: true; usageRecordId: string } | { ok: false; reason: ReserveRefusal };

/** Creates the request (VALIDATED), snapshots the rates, and reserves; one transaction. */
export async function beginRequest(db: SqlDb, n: NewRequest): Promise<BeginResult> {
  return db.tx(async (q) => {
    // Lock order is ALWAYS account row first. Inserting the request first takes a KEY SHARE lock on the account (foreign key), and
    // two concurrent reservations would then each wait for the other's share lock to clear before FOR UPDATE: a deadlock that
    // only a real PostgreSQL (not PGlite) exposes.
    await q.query("select id from accounts where id=$1 for update", [n.accountId]);
    await q.query(
      `insert into requests (id, account_id, key_id, project_id, run_id, parent_id, correlation_id, protocol, model, stream, state, price_version_id, reserved_microusd, created_at, updated_at, policy_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'VALIDATED',$11,$12,$13,$13,$14)`,
      [n.id, n.accountId, n.keyId, n.projectId, n.runId, n.parentId, n.correlationId, n.protocol, n.model, n.stream, n.rates.priceVersion, n.reservedMicrousd.toString(), n.at, n.policyVersion ?? null],
    );
    await q.query("insert into request_transitions (request_id, from_state, to_state, at) values ($1,null,'VALIDATED',$2)", [n.id, n.at]);
    const usageRecordId = n.newId("use");
    await q.query(
      `insert into usage_records (id, request_id, price_version_id, input_rate_microusd, cached_input_rate_microusd, output_rate_microusd, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [usageRecordId, n.id, n.rates.priceVersion, n.rates.inputMicrousdPerMtok.toString(), effectiveCachedRate(n.rates).toString(), n.rates.outputMicrousdPerMtok.toString(), n.at],
    );
    const res = await reserveFunds(q, {
      id: n.newId("rsv"), accountId: n.accountId, requestId: n.id, keyId: n.keyId, projectId: n.projectId,
      amount: n.reservedMicrousd, priceVersion: n.rates.priceVersion, at: n.at,
    });
    if (!res.ok) {
      // Nothing was held: record the refusal (no charge, no reservation row).
      await transition(q, n.id, "VALIDATED", "FAILED", n.at, res.reason, { set: ", outcome='rejected', failure_code=$5, finished_at=$4", params: [res.reason] });
      return res;
    }
    await transition(q, n.id, "VALIDATED", "RESERVED", n.at, null);
    if (n.afterReserve) await n.afterReserve(q);
    return { ok: true, usageRecordId };
  });
}

export async function markDispatched(db: SqlDb, id: string, providerRequestId: string, at: Date): Promise<void> {
  await db.tx(async (q) => {
    const ok = await transition(q, id, "RESERVED", "DISPATCHED", at, null, { set: ", dispatched_at=$4, provider_request_id=$5", params: [providerRequestId] });
    if (!ok) throw new Error(`request ${id} is not RESERVED`);
  });
}

/** Preserve the observed response end separately from reconciliation/settlement time. */
export async function recordRequestFinish(q: SqlExecutor, id: string, reason: string | null, at: Date): Promise<void> {
  await q.query("update requests set response_finished_at=$2, finish_reason=$3 where id=$1 and response_finished_at is null", [id, at, reason]);
}

/**
 * Failure with no charge: moves the request to FAILED/CANCELLED and releases its hold. Idempotent.
 *
 * Order matters: the request row is locked and its state checked FIRST, the conditional state transition happens next, and the hold is
 * released only if that transition won. A concurrent markDispatched is serialised by the same row lock: either it committed first (the
 * request is DISPATCHED, so `onlyUndispatched` callers leave the hold alone: the provider call may be in flight) or this runs first
 * (the request is FAILED and markDispatched refuses, so no provider call is made). Returns whether the request was failed here.
 *
 * `onlyUndispatched`: act on RESERVED/VALIDATED only. The stale-hold sweeps use it; a DISPATCHED request is never released by them.
 */
export async function failWithoutCharge(db: SqlDb, id: string, o: { code: string; cancelled?: boolean; at: Date; onlyUndispatched?: boolean }): Promise<boolean> {
  return db.tx(async (q) => {
    const [r] = await q.query<{ state: RequestStateName }>("select state from requests where id=$1 for update", [id]);
    if (!r) return false;
    const allowed: RequestStateName[] = o.onlyUndispatched ? ["RESERVED", "VALIDATED"] : ["RESERVED", "VALIDATED", "DISPATCHED"];
    if (!allowed.includes(r.state)) return false;
    const to: RequestStateName = o.cancelled ? "CANCELLED" : "FAILED";
    const extra = { set: ", outcome=$5, failure_code=$6, finished_at=$4", params: [o.cancelled ? "cancelled" : "rejected", o.code] };
    if (!(await transition(q, id, r.state, to, o.at, o.code, extra))) return false;
    await releaseReservation(q, id, o.at);
    return true;
  });
}

/** Usage unknown after possible acceptance: keep the hold until the reconciliation deadline. */
export async function markUsagePending(db: SqlDb, id: string, o: { code: string; deadline: Date; at: Date }): Promise<boolean> {
  return db.tx((q) => transition(q, id, "DISPATCHED", "USAGE_PENDING", o.at, o.code, { set: ", failure_code=$5, usage_deadline=$6", params: [o.code, o.deadline] }));
}

export interface SettleRequestInput {
  requestId: string;
  usage: TokenUsage;
  outcome: "succeeded" | "failed" | "cancelled";
  failureCode?: string | undefined;
  at: Date;
  newId: IdFactory;
}
export type SettleRequestResult =
  | { status: "settled"; chargeMicrousd: bigint; absorbedMicrousd: bigint; ledgerTransactionId: string | null; alreadySettled: boolean }
  | { status: "not_settleable"; reason: string };

interface UsageRow {
  state: RequestStateName;
  failure_code: string | null;
  price_version_id: string;
  in_rate: string;
  cached_rate: string;
  out_rate: string;
}

/**
 * The outcome a request that went USAGE_PENDING keeps when its usage is verified later: what ended it originally, not
 * "succeeded". Only a request whose usage was merely missing after a clean response (USAGE_MISSING) was a success.
 */
export function outcomeForPendingCode(code: string | null): "succeeded" | "failed" | "cancelled" {
  if (code === "CLIENT_DISCONNECT") return "cancelled";
  if (code === null || code === "USAGE_MISSING") return "succeeded";
  return "failed";
}

/**
 * Records verified usage, posts the charge once and moves the request to SETTLED. Idempotent and safe under real
 * concurrency: the request row is locked FOR UPDATE first, so a second settler waits and then sees SETTLED; a reservation that is
 * already settled returns early without touching the request; every state change is a conditional transition, so no
 * transition row is duplicated or regressed and a recorded outcome is never overwritten.
 */
export async function settleRequest(db: SqlDb, i: SettleRequestInput): Promise<SettleRequestResult> {
  return db.tx(async (q) => {
    const [row] = await q.query<UsageRow>(
      `select r.state, r.failure_code, u.price_version_id, u.input_rate_microusd::text as in_rate, u.cached_input_rate_microusd::text as cached_rate, u.output_rate_microusd::text as out_rate
       from requests r join usage_records u on u.request_id = r.id where r.id=$1 for update of r`,
      [i.requestId],
    );
    if (!row) throw new Error(`unknown request ${i.requestId}`);
    const snapshot: RateSnapshot = {
      priceVersion: row.price_version_id, model: "", inputMicrousdPerMtok: BigInt(row.in_rate),
      cachedInputMicrousdPerMtok: BigInt(row.cached_rate), outputMicrousdPerMtok: BigInt(row.out_rate),
    };
    const computed = chargeFor(i.usage, snapshot);
    const prior = async (): Promise<SettleRequestResult> => {
      const [r] = await q.query<{ status: string; charge: string | null; tx: string | null; absorbed: string | null }>(
        `select rs.status, rs.charge_microusd::text as charge, rs.ledger_transaction_id as tx, u.absorbed_microusd::text as absorbed
         from reservations rs join usage_records u on u.request_id = rs.request_id where rs.request_id=$1`,
        [i.requestId],
      );
      return r?.status === "settled"
        ? { status: "settled", chargeMicrousd: BigInt(r.charge ?? "0"), absorbedMicrousd: BigInt(r.absorbed ?? "0"), ledgerTransactionId: r.tx, alreadySettled: true }
        : { status: "not_settleable", reason: "already finished without charge" };
    };
    if (row.state === "SETTLED") return prior();
    if (row.state !== "DISPATCHED" && row.state !== "USAGE_PENDING") return { status: "not_settleable", reason: `request is ${row.state}` };
    // Late-verified usage keeps the original ending (failed/cancelled), not a blanket "succeeded".
    const outcome = row.state === "USAGE_PENDING" ? outcomeForPendingCode(row.failure_code) : i.outcome;
    const res = await settleReservation(q, { requestId: i.requestId, computedCharge: computed, reason: `gateway request ${outcome}`, at: i.at, newId: i.newId });
    if (res.status === "released") return { status: "not_settleable", reason: "hold already released" };
    if (res.alreadySettled) return prior(); // someone else posted the charge; never write a second set of transitions
    await q.query(
      `update usage_records set input_tokens=$2, cached_input_tokens=$3, output_tokens=$4, usage_source='provider', computed_charge_microusd=$5,
         charge_microusd=$6, absorbed_microusd=$7, ledger_transaction_id=$8, settled_at=$9 where request_id=$1 and settled_at is null`,
      [i.requestId, i.usage.inputTokens.toString(), i.usage.cachedInputTokens.toString(), i.usage.outputTokens.toString(), computed.toString(),
        res.chargeMicrousd.toString(), res.absorbedMicrousd.toString(), res.ledgerTransactionId, i.at],
    );
    let from: RequestStateName = row.state;
    if (row.state === "DISPATCHED") {
      const mid: RequestStateName = outcome === "succeeded" ? "SUCCEEDED" : outcome === "failed" ? "FAILED" : "CANCELLED";
      if (!(await transition(q, i.requestId, "DISPATCHED", mid, i.at, null))) throw new Error(`request ${i.requestId} left DISPATCHED while locked`);
      from = mid;
    }
    const done = await transition(q, i.requestId, from, "SETTLED", i.at, outcome, {
      set: ", outcome=$5, failure_code=coalesce($6, failure_code), finished_at=$4", params: [outcome, i.failureCode ?? null],
    });
    if (!done) throw new Error(`request ${i.requestId} could not move ${from} -> SETTLED`);
    return { ...res, status: "settled" };
  });
}

/**
 * Past the reconciliation deadline with no verified usage: release the customer hold, absorb the unresolved
 * provider cost and settle at zero. The customer is never charged for it later. The request is locked and its state
 * checked BEFORE the hold is touched, so a request that is not USAGE_PENDING keeps its hold untouched.
 */
export async function resolveUnrecoverable(db: SqlDb, requestId: string, at: Date): Promise<boolean> {
  return db.tx(async (q) => {
    const [r] = await q.query<{ state: RequestStateName }>("select state from requests where id=$1 for update", [requestId]);
    if (!r || r.state !== "USAGE_PENDING") return false;
    const rel = await releaseReservation(q, requestId, at);
    if (rel === "settled") return false;
    const moved = await transition(q, requestId, "USAGE_PENDING", "SETTLED", at, "usage_unresolved", { set: ", outcome='usage_unresolved', finished_at=$4", params: [] });
    if (!moved) return false;
    await q.query("update usage_records set settled_at=$2 where request_id=$1 and settled_at is null", [requestId, at]);
    return true;
  });
}

export interface PendingRequest {
  id: string;
  providerRequestId: string | null;
  deadline: Date;
}
export async function listUsagePending(q: SqlExecutor, limit: number): Promise<PendingRequest[]> {
  const rows = await q.query<{ id: string; provider_request_id: string | null; usage_deadline: Date }>(
    "select id, provider_request_id, usage_deadline from requests where state='USAGE_PENDING' order by usage_deadline, id limit $1",
    [limit],
  );
  return rows.map((r) => ({ id: r.id, providerRequestId: r.provider_request_id, deadline: r.usage_deadline }));
}
