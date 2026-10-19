/**
 * Reservations (holds): reserve a documented maximum cost before dispatch, then settle exactly once or release.
 *
 * Reserving checks, under row locks, the account's available funds (posted - active holds) AND the
 * key and project lifetime spend caps (settled charges + active holds + this hold). The account row is locked
 * first, then the key, then the project, always in that order, so concurrent reservations for one account
 * serialize and cannot both spend the same funds. Settlement and release are idempotent and decided under
 * the same account lock. Run these inside the caller's DB transaction.
 *
 * Settlement never charges more than the hold: usage beyond it is recorded as `absorbed` (provider cost the
 * customer is not billed for) so a balance can never go negative through metering.
 */
import { availableFunds, postedBalance, activeHolds, postTransaction, spendPostings } from "./ledger";
import type { SqlExecutor } from "./sql";

export type ReserveRefusal = "INSUFFICIENT_FUNDS" | "KEY_CAP_EXCEEDED" | "PROJECT_CAP_EXCEEDED" | "KEY_UNUSABLE";

export interface CapState {
  /** null = unlimited. */
  cap: bigint | null;
  /** Settled charges plus active holds already counted against the cap. */
  used: bigint;
}

export interface ReservationCheck {
  posted: bigint;
  held: bigint;
  amount: bigint;
  key?: CapState | undefined;
  project?: CapState | undefined;
}

/** Pure decision used by the SQL path (and unit-tested without a database). */
export function decideReservation(c: ReservationCheck): { ok: true } | { ok: false; reason: ReserveRefusal } {
  if (c.amount < 0n) throw new RangeError("Reservation amount must be non-negative");
  if (availableFunds(c.posted, c.held) < c.amount) return { ok: false, reason: "INSUFFICIENT_FUNDS" };
  if (c.key?.cap != null && c.key.used + c.amount > c.key.cap) return { ok: false, reason: "KEY_CAP_EXCEEDED" };
  if (c.project?.cap != null && c.project.used + c.amount > c.project.cap) return { ok: false, reason: "PROJECT_CAP_EXCEEDED" };
  return { ok: true };
}

/** What gets billed and what the provider cost beyond the hold. */
export function clampToHold(computedCharge: bigint, held: bigint): { charge: bigint; absorbed: bigint } {
  if (computedCharge < 0n || held < 0n) throw new RangeError("Amounts must be non-negative");
  const charge = computedCharge < held ? computedCharge : held;
  return { charge, absorbed: computedCharge - charge };
}

export interface ReserveInput {
  id: string;
  accountId: string;
  requestId: string;
  keyId: string | null;
  projectId: string | null;
  amount: bigint;
  priceVersion: string;
  at: Date;
}

const lockAccount = (q: SqlExecutor, accountId: string): Promise<unknown> => q.query("select id from accounts where id=$1 for update", [accountId]);

const USED_SQL = (col: "key_id" | "project_id"): string =>
  `select coalesce(sum(case status when 'settled' then charge_microusd when 'active' then amount else 0 end), 0)::text as s
   from reservations where ${col}=$1`;

export async function reserveFunds(q: SqlExecutor, i: ReserveInput): Promise<{ ok: true } | { ok: false; reason: ReserveRefusal }> {
  await lockAccount(q, i.accountId);
  let key: CapState | undefined;
  if (i.keyId) {
    const [k] = await q.query<{ cap: string | null; revoked: boolean; expired: boolean }>(
      "select spend_cap_microusd::text as cap, revoked_at is not null as revoked, (expires_at is not null and expires_at <= $2) as expired from api_keys where id=$1 and account_id=$3 for update",
      [i.keyId, i.at, i.accountId],
    );
    if (!k || k.revoked || k.expired) return { ok: false, reason: "KEY_UNUSABLE" };
    const [u] = await q.query<{ s: string }>(USED_SQL("key_id"), [i.keyId]);
    key = { cap: k.cap === null ? null : BigInt(k.cap), used: BigInt(u?.s ?? "0") };
  }
  let project: CapState | undefined;
  if (i.projectId) {
    const [p] = await q.query<{ cap: string | null }>("select spend_cap_microusd::text as cap from projects where id=$1 and account_id=$2 for update", [i.projectId, i.accountId]);
    if (p) {
      const [u] = await q.query<{ s: string }>(USED_SQL("project_id"), [i.projectId]);
      project = { cap: p.cap === null ? null : BigInt(p.cap), used: BigInt(u?.s ?? "0") };
    }
  }
  const decision = decideReservation({ posted: await postedBalance(q, i.accountId), held: await activeHolds(q, i.accountId), amount: i.amount, key, project });
  if (!decision.ok) return decision;
  await q.query(
    `insert into reservations (id, account_id, request_id, key_id, project_id, amount, status, price_version_id, created_at)
     values ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
    [i.id, i.accountId, i.requestId, i.keyId, i.projectId, i.amount.toString(), i.priceVersion, i.at],
  );
  return { ok: true };
}

export type SettleResult =
  | { status: "settled"; chargeMicrousd: bigint; absorbedMicrousd: bigint; ledgerTransactionId: string | null; alreadySettled: boolean }
  | { status: "released" };

interface ReservationRow {
  id: string;
  account_id: string;
  status: "active" | "settled" | "released";
  amount: string;
  charge: string | null;
  tx: string | null;
  price_version_id: string;
}
const RES_COLS = "id, account_id, status, amount::text as amount, charge_microusd::text as charge, ledger_transaction_id as tx, price_version_id";

async function lockReservation(q: SqlExecutor, requestId: string): Promise<ReservationRow> {
  const [pre] = await q.query<{ account_id: string }>("select account_id from reservations where request_id=$1", [requestId]);
  if (!pre) throw new Error(`no reservation for request ${requestId}`);
  await lockAccount(q, pre.account_id);
  const [r] = await q.query<ReservationRow>(`select ${RES_COLS} from reservations where request_id=$1 for update`, [requestId]);
  if (!r) throw new Error(`no reservation for request ${requestId}`);
  return r;
}

export interface SettleInput {
  requestId: string;
  /** Exact charge for the verified usage, already rounded up once (pricing.chargeFor). */
  computedCharge: bigint;
  reason: string;
  at: Date;
  newId: (prefix: string) => string;
}

/** Posts the spend and closes the hold. Idempotent: a settled reservation returns its prior result. */
export async function settleReservation(q: SqlExecutor, i: SettleInput): Promise<SettleResult> {
  const r = await lockReservation(q, i.requestId);
  if (r.status === "settled") {
    return { status: "settled", chargeMicrousd: BigInt(r.charge ?? "0"), absorbedMicrousd: 0n, ledgerTransactionId: r.tx, alreadySettled: true };
  }
  if (r.status === "released") return { status: "released" };
  const { charge, absorbed } = clampToHold(i.computedCharge, BigInt(r.amount));
  let txId: string | null = null;
  if (charge > 0n) {
    const posted = await postTransaction(q, {
      id: i.newId("ltx"), accountId: r.account_id, kind: "spend", sourceType: "request", sourceId: i.requestId,
      priceVersion: r.price_version_id, reason: i.reason, at: i.at, postings: spendPostings(r.account_id, charge), newEntryId: () => i.newId("le"),
    });
    txId = posted.transactionId;
  }
  await q.query("update reservations set status='settled', charge_microusd=$2, ledger_transaction_id=$3, closed_at=$4 where id=$1", [r.id, charge.toString(), txId, i.at]);
  return { status: "settled", chargeMicrousd: charge, absorbedMicrousd: absorbed, ledgerTransactionId: txId, alreadySettled: false };
}

/** Releases an active hold. Idempotent; a hold that was already settled stays settled. */
export async function releaseReservation(q: SqlExecutor, requestId: string, at: Date): Promise<"released" | "settled"> {
  const r = await lockReservation(q, requestId);
  if (r.status === "settled") return "settled";
  if (r.status === "active") await q.query("update reservations set status='released', closed_at=$2 where id=$1", [r.id, at]);
  return "released";
}
