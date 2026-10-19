/**
 * Persisted sign-in abuse limits. Every sign-in, recovery, step-up and API-key sign-in attempt is recorded
 * BEFORE the secret is checked and then counted in three buckets:
 *   account    all attempts naming this account (stops a distributed guess)
 *   accountIp  this account from this client (the tight bucket)
 *   ip         this client across all accounts (stops password spraying)
 * Because the attempt is written first, a parallel burst cannot slip past the limit by racing the check.
 * Success erases only the account+IP bucket, so one correct guess never resets the account-wide counter.
 * Subjects are stored as keyed digests (no usernames or addresses). Unknown accounts are counted identically,
 * so lockout behaviour does not reveal whether an account exists.
 */
import type { AppConfig, RateRule } from "../config";
import type { Db, Queryable } from "../db";
import { hmacHex } from "../crypto";
import { ApiError } from "../http";
import { requireSecret } from "./session";

export interface AttemptSubject {
  /** What is being attacked: a normalised username, user id or key prefix. */
  account: string;
  ip: string;
}
export type AttemptScope = "password" | "recovery" | "step_up" | "key_session";

interface Bucket {
  key: string;
  rule: RateRule;
}

function buckets(config: AppConfig, scope: AttemptScope, s: AttemptSubject): Bucket[] {
  const secret = requireSecret(config.sessionSecret, "SESSION_SECRET");
  const h = (kind: string, v: string): string => hmacHex(secret, `${scope}|${kind}|${v}`);
  const a = config.auth.attempts;
  return [
    { key: h("account", s.account), rule: a.account },
    { key: h("pair", `${s.account}|${s.ip}`), rule: a.accountIp },
    { key: h("ip", s.ip), rule: a.ip },
  ];
}

export interface AttemptTicket {
  /** Erases the account+IP bucket after a successful attempt. */
  succeeded(): Promise<void>;
}

/** Records one attempt and throws 429 (with Retry-After) when any bucket is over its limit. */
export async function takeAttempt(db: Db, config: AppConfig, scope: AttemptScope, subject: AttemptSubject): Promise<AttemptTicket> {
  const now = config.now();
  const bs = buckets(config, scope, subject);
  const longest = Math.max(...bs.map((b) => b.rule.windowSeconds));
  const wait = await db.tx(async (q) => {
    await q.query("delete from auth_attempts where at <= $1", [new Date(now.getTime() - longest * 1000)]);
    let worst = 0;
    for (const b of bs) {
      await q.query("insert into auth_attempts (scope, key_hash, at) values ($1,$2,$3)", [scope, b.key, now]);
      worst = Math.max(worst, await overBy(q, scope, b, now));
    }
    return worst;
  });
  if (wait > 0) throw new ApiError("RATE_LIMITED", "Too many attempts; try again later", undefined, { "Retry-After": String(wait) });
  const pair = bs[1];
  return {
    async succeeded() {
      if (pair) await db.query("delete from auth_attempts where scope=$1 and key_hash=$2", [scope, pair.key]);
    },
  };
}

/** Seconds until the bucket drops back to its limit, or 0 when it is within it. */
async function overBy(q: Queryable, scope: string, b: Bucket, now: Date): Promise<number> {
  const since = new Date(now.getTime() - b.rule.windowSeconds * 1000);
  const rows = await q.query<{ at: Date }>("select at from auth_attempts where scope=$1 and key_hash=$2 and at > $3 order by at desc limit $4", [scope, b.key, since, b.rule.limit + 1]);
  if (rows.length <= b.rule.limit) return 0;
  // The oldest of the newest `limit` attempts must age out of the window before another one is allowed.
  const pivot = rows[b.rule.limit - 1];
  return Math.max(1, Math.ceil(((pivot?.at.getTime() ?? now.getTime()) + b.rule.windowSeconds * 1000 - now.getTime()) / 1000));
}
