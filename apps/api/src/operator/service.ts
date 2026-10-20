/**
 * Operator grants and the per-session elevation.
 *
 * Operator is NOT a membership role and is never derived from a wallet or a customer role. A grant is a row in `operators`,
 * written only by configuration (OPERATOR_USER_IDS, synced at startup) or the operator CLI; no HTTP route can create, edit or
 * delete one. Using any /api/operator route needs (1) the grant and (2) an elevation bound to the current session, which is
 * issued only when the session authenticated very recently (OPERATOR_STEP_UP_WINDOW_SECONDS) and lapses on its own
 * (OPERATOR_ELEVATION_SECONDS). A new session starts without an elevation.
 */
import type { MiddlewareHandler } from "hono";
import { audit } from "../audit";
import { requireSession } from "../auth/session";
import type { AppConfig } from "../config";
import type { Db, Queryable } from "../db";
import { ApiError, type AppEnv } from "../http";

export async function isOperator(q: Queryable, userId: string): Promise<boolean> {
  const rows = await q.query("select 1 as x from operators where user_id=$1 and revoked_at is null", [userId]);
  return rows.length > 0;
}

export async function grantOperator(db: Db, i: { userId: string; grantedBy: "config" | "cli"; note?: string; at: Date }): Promise<void> {
  await db.tx(async (q) => {
    const [u] = await q.query("select 1 as x from users where id=$1", [i.userId]);
    if (!u) throw new Error(`unknown user ${i.userId}`);
    await q.query(
      `insert into operators (user_id, granted_by, note, granted_at) values ($1,$2,$3,$4)
       on conflict (user_id) do update set granted_by=excluded.granted_by, note=excluded.note, granted_at=excluded.granted_at, revoked_at=null`,
      [i.userId, i.grantedBy, i.note ?? null, i.at],
    );
    await audit(q, { accountId: null, actorUserId: null, action: "operator.granted", targetType: "user", targetId: i.userId, at: i.at, metadata: { grantedBy: i.grantedBy } });
  });
}

export async function revokeOperator(db: Db, userId: string, at: Date): Promise<boolean> {
  return db.tx(async (q) => {
    const rows = await q.query("update operators set revoked_at=$2 where user_id=$1 and revoked_at is null returning user_id", [userId, at]);
    if (!rows.length) return false;
    await q.query("delete from operator_elevations where user_id=$1", [userId]);
    await audit(q, { accountId: null, actorUserId: null, action: "operator.revoked", targetType: "user", targetId: userId, at });
    return true;
  });
}

/** Makes the configured list the authority for config-granted operators: grants new ids, revokes config grants no longer listed. */
export async function syncConfiguredOperators(db: Db, config: AppConfig): Promise<{ granted: string[]; revoked: string[]; unknown: string[] }> {
  const at = config.now();
  const out = { granted: [] as string[], revoked: [] as string[], unknown: [] as string[] };
  const listed = new Set(config.operator.configuredUserIds);
  for (const userId of listed) {
    const [u] = await db.query("select 1 as x from users where id=$1", [userId]);
    if (!u) {
      out.unknown.push(userId);
      continue;
    }
    if (!(await isOperator(db, userId))) {
      await grantOperator(db, { userId, grantedBy: "config", at });
      out.granted.push(userId);
    }
  }
  const stale = await db.query<{ user_id: string }>("select user_id from operators where granted_by='config' and revoked_at is null");
  for (const s of stale) if (!listed.has(s.user_id) && (await revokeOperator(db, s.user_id, at))) out.revoked.push(s.user_id);
  return out;
}

/** Session + operator grant + live elevation. Order of failure: 401 (no session), 403 (not an operator), 403 STEP_UP_REQUIRED. */
export const requireOperator = (db: Db, config: AppConfig, opts: { elevated: boolean } = { elevated: true }): readonly [MiddlewareHandler<AppEnv>, MiddlewareHandler<AppEnv>] => [
  requireSession(db, config),
  async (c, next) => {
    const auth = c.get("auth");
    if (!(await isOperator(db, auth.userId))) throw new ApiError("FORBIDDEN", "Operator access required");
    if (opts.elevated) {
      const [e] = await db.query("select 1 as x from operator_elevations where session_id=$1 and user_id=$2 and expires_at > $3", [auth.sessionId, auth.userId, config.now()]);
      if (!e) throw new ApiError("STEP_UP_REQUIRED", "Operator step-up required for this session");
    }
    await next();
  },
] as const;
