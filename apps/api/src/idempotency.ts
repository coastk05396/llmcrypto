import { decideIdempotency, type IdempotencyDecision } from "@llmcrypto/contracts";
import type { Db, Queryable } from "./db";
import { randomToken } from "./crypto";

export interface IdemRow {
  state: "in_flight" | "completed";
  payload_hash: string;
  created_at: Date;
  status_code: number | null;
  result: unknown;
  replay_ciphertext: string | null;
  replay_session_id: string | null;
  replay_expires_at: Date | null;
}
export interface IdemScope {
  accountId: string;
  operation: string;
  key: string;
  /** Set by beginIdempotent when this caller won the claim. Only the holder of the current token may complete or abort the row. */
  claim?: string;
}
export type BeginOutcome =
  | { action: "execute" }
  | { action: "replay"; row: IdemRow }
  | { action: "reject"; code: "IDEMPOTENCY_CONFLICT" | "IN_PROGRESS" };

const SELECT = `select state, payload_hash, created_at, status_code, result, replay_ciphertext, replay_session_id, replay_expires_at
                from idempotency_keys where account_id=$1 and operation=$2 and key=$3`;

/**
 * Claims (account, operation, key). The in_flight row is committed immediately so concurrent duplicates see it.
 * The business write and `complete` share one transaction, so a crash leaves only a stale in_flight row,
 * which is re-claimable after staleSeconds (nothing it protected was committed).
 */
export async function beginIdempotent(db: Db, s: IdemScope, payloadHash: string, now: Date, staleSeconds: number): Promise<BeginOutcome> {
  const token = randomToken(16);
  const claimed = await db.query(
    `insert into idempotency_keys (account_id, operation, key, payload_hash, state, created_at, claim_token)
     values ($1,$2,$3,$4,'in_flight',$5,$6) on conflict do nothing returning key`,
    [s.accountId, s.operation, s.key, payloadHash, now, token],
  );
  if (claimed.length) {
    s.claim = token;
    return { action: "execute" };
  }

  const [row] = await db.query<IdemRow>(SELECT, [s.accountId, s.operation, s.key]);
  if (!row) return beginIdempotent(db, s, payloadHash, now, staleSeconds); // deleted between statements
  if (row.state === "in_flight" && row.payload_hash === payloadHash && now.getTime() - row.created_at.getTime() > staleSeconds * 1000) {
    const reclaimed = await db.query(
      `update idempotency_keys set created_at=$5, claim_token=$6 where account_id=$1 and operation=$2 and key=$3 and state='in_flight' and created_at=$4 returning key`,
      [s.accountId, s.operation, s.key, row.created_at, now, token],
    );
    if (reclaimed.length) {
      // The previous claimant's token no longer matches, so if it is merely slow (not dead) its completion fails and its
      // transaction, business writes included, rolls back: at most one execution can ever commit.
      s.claim = token;
      return { action: "execute" };
    }
  }
  const decision: IdempotencyDecision = decideIdempotency(
    row.state === "in_flight"
      ? { state: "in_flight", payloadHash: row.payload_hash }
      : { state: "completed", payloadHash: row.payload_hash, result: row.result },
    payloadHash,
  );
  if (decision.action === "execute") return { action: "execute" };
  if (decision.action === "replay") return { action: "replay", row };
  return { action: "reject", code: decision.code };
}

export interface CompleteInput {
  statusCode: number;
  result: unknown;
  at: Date;
  replay?: { ciphertext: string; sessionId: string; expiresAt: Date };
}

export async function completeIdempotent(q: Queryable, s: IdemScope, c: CompleteInput): Promise<void> {
  const rows = await q.query(
    `update idempotency_keys set state='completed', completed_at=$4, status_code=$5, result=$6::jsonb,
       replay_ciphertext=$7, replay_session_id=$8, replay_expires_at=$9
     where account_id=$1 and operation=$2 and key=$3 and state='in_flight' and ($10::text is null or claim_token = $10) returning key`,
    [s.accountId, s.operation, s.key, c.at, c.statusCode, JSON.stringify(c.result), c.replay?.ciphertext ?? null, c.replay?.sessionId ?? null, c.replay?.expiresAt ?? null, s.claim ?? null],
  );
  // Zero rows means this execution lost its claim (reclaimed as stale, or already completed). Throwing rolls the caller's transaction back.
  if (rows.length === 0) throw new Error("idempotency claim lost; the operation was not committed");
}

/** Releases an in_flight claim after a failed attempt so the client may retry with the same key. */
export async function abortIdempotent(db: Db, s: IdemScope): Promise<void> {
  await db.query("delete from idempotency_keys where account_id=$1 and operation=$2 and key=$3 and state='in_flight' and ($4::text is null or claim_token = $4)", [s.accountId, s.operation, s.key, s.claim ?? null]);
}

/** Drops sealed secrets whose replay window has ended (also done lazily on access). Safe to run from the worker. */
export async function scrubExpiredReplaySecrets(db: Db, now: Date): Promise<number> {
  const r = await db.query(
    "update idempotency_keys set replay_ciphertext=null where replay_ciphertext is not null and replay_expires_at <= $1 returning key",
    [now],
  );
  return r.length;
}
