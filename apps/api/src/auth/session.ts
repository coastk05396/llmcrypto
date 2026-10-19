import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type { MembershipRole, SessionKind, SessionView } from "@llmcrypto/contracts";
import { isRecentSignIn } from "@llmcrypto/domain";
import { audit } from "../audit";
import type { AppConfig } from "../config";
import { hmacHex, randomId, randomToken } from "../crypto";
import type { Db, Queryable } from "../db";
import { ApiError, type AppEnv, type Ctx } from "../http";

export const SESSION_COOKIE = "session";

export interface AuthContext {
  sessionKind: SessionKind;
  /** Identity / credential / API key id the session was established with. */
  methodRef: string | null;
  createdAt: Date;
  sessionId: string;
  userId: string;
  accountId: string;
  membershipId: string;
  role: MembershipRole;
  authenticatedAt: Date;
  expiresAt: Date;
}

export const requireSecret = (v: string | undefined, name: string): string => {
  void name; // the setting's name is for readers of the call site; it is never put in a response
  if (!v) throw new ApiError("UNAVAILABLE", "Service not configured"); // never name the setting: `name` is for the code reader only
  return v;
};

export interface NewSessionOptions {
  kind?: SessionKind;
  methodRef?: string | null;
  /** User credential generation observed when the proof was verified. */
  authVersion?: number;
}

/** Lifetime for a session of this kind. API-key sessions are deliberately shorter. */
export const sessionTtlSeconds = (config: AppConfig, kind: SessionKind): number =>
  kind === "api_key" ? config.auth.keySessionTtlSeconds : config.sessionTtlSeconds;

export async function createSession(
  q: Queryable,
  config: AppConfig,
  userId: string,
  accountId: string,
  opts: NewSessionOptions = {},
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const secret = requireSecret(config.sessionSecret, "SESSION_SECRET");
  const token = randomToken(32);
  const now = config.now();
  const kind = opts.kind ?? "wallet";
  // Same lock as method removal and recovery: validation and insertion must be one transaction.
  const [user] = await q.query<{ auth_version: number }>("select auth_version from users where id=$1 for update", [userId]);
  if (!user || (opts.authVersion !== undefined && user.auth_version !== opts.authVersion)) {
    throw new ApiError("UNAUTHENTICATED", "Sign in again");
  }
  if (opts.methodRef && kind !== "api_key") {
    const table = kind === "password" ? "password_credentials" : kind === "telegram" ? "telegram_identities" : "linked_identities";
    const active = kind === "password" ? "" : " and unlinked_at is null";
    const [method] = await q.query(`select id from ${table} where id=$1 and user_id=$2${active}`, [opts.methodRef, userId]);
    if (!method) throw new ApiError("UNAUTHENTICATED", "Sign in again");
  }
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds(config, kind) * 1000);
  const id = randomId("ses");
  await q.query(
    `insert into sessions (id, token_hash, user_id, account_id, authenticated_at, created_at, expires_at, kind, method_ref) values ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
    [id, hmacHex(secret, token), userId, accountId, now, expiresAt, kind, opts.methodRef ?? null],
  );
  return { token, id, expiresAt };
}

/** Sets the cookie, then resolves it into the SessionView every sign-in endpoint returns. */
export async function startSession(db: Db, c: Ctx, config: AppConfig, session: { token: string; expiresAt: Date }): Promise<SessionView> {
  setSessionCookie(c, config, session.token, session.expiresAt);
  c.header("Cache-Control", "no-store");
  const auth = await resolveSession(db, config, session.token);
  if (!auth) throw new ApiError("INTERNAL", "Session could not be established");
  return sessionView(db, auth);
}

export function setSessionCookie(c: Ctx, config: AppConfig, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Strict",
    path: "/",
    expires: expiresAt,
  });
}
export const clearSessionCookie = (c: Ctx, config: AppConfig): void => {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: config.cookieSecure });
};

interface SessionJoin {
  session_id: string;
  user_id: string;
  account_id: string;
  authenticated_at: Date;
  created_at: Date;
  expires_at: Date;
  kind: SessionKind;
  method_ref: string | null;
  membership_id: string;
  role: MembershipRole;
}

/** Resolves the cookie to a live session + current membership role, or null. */
export async function resolveSession(db: Db, config: AppConfig, token: string | undefined): Promise<AuthContext | null> {
  if (!token || !config.sessionSecret) return null;
  const [r] = await db.query<SessionJoin>(
    `select s.id as session_id, s.user_id, s.account_id, s.authenticated_at, s.created_at, s.expires_at, s.kind, s.method_ref,
            m.id as membership_id, m.role
     from sessions s join memberships m on m.user_id = s.user_id and m.account_id = s.account_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2
       and (s.kind <> 'api_key' or exists (
         select 1 from api_keys k where k.id = s.method_ref and k.account_id = s.account_id and k.revoked_at is null
           and (k.expires_at is null or k.expires_at > $2) and k.scopes @> '["usage:read"]'::jsonb))`,
    [hmacHex(config.sessionSecret, token), config.now()],
  );
  if (!r) return null;
  return {
    sessionId: r.session_id, userId: r.user_id, accountId: r.account_id, membershipId: r.membership_id,
    role: r.role, authenticatedAt: r.authenticated_at, expiresAt: r.expires_at,
    sessionKind: r.kind, methodRef: r.method_ref, createdAt: r.created_at,
  };
}

/**
 * Every protected route goes through here. The default ("full") refuses restricted (API-key) sessions, so a route
 * that forgets to think about them fails closed; routes that are safe for a key's own data scope opt in with
 * "key_scope" and must then narrow their data to `auth.methodRef` themselves.
 */
export const requireSession = (db: Db, config: AppConfig, access: SessionAccess = "full"): MiddlewareHandler<AppEnv> => async (c, next) => {
  requireSecret(config.sessionSecret, "SESSION_SECRET");
  const auth = await resolveSession(db, config, getCookie(c, SESSION_COOKIE));
  if (!auth) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  authorizeSession(auth, access);
  c.set("auth", auth);
  await next();
};

/** Central authorization decision for session kinds. Restricted = established from an API key. */
export type SessionAccess = "full" | "key_scope";
export const isRestricted = (auth: Pick<AuthContext, "sessionKind">): boolean => auth.sessionKind === "api_key";
export function authorizeSession(auth: AuthContext, access: SessionAccess): void {
  if (access === "full" && isRestricted(auth)) throw new ApiError("FORBIDDEN", "Not available to API-key sessions");
}

export function requireRecentSignIn(auth: AuthContext, config: AppConfig): void {
  if (!isRecentSignIn(auth.authenticatedAt, config.now())) throw new ApiError("STEP_UP_REQUIRED", "Recent sign-in required");
}

/** Revokes every live session established with a method (identity, credential or key id). Returns how many. */
export async function revokeSessionsByMethod(q: Queryable, methodRef: string, now: Date): Promise<number> {
  const r = await q.query("update sessions set revoked_at=$2 where method_ref=$1 and revoked_at is null returning id", [methodRef, now]);
  return r.length;
}
export async function revokeAllUserSessions(q: Queryable, userId: string, now: Date): Promise<number> {
  const r = await q.query("update sessions set revoked_at=$2 where user_id=$1 and revoked_at is null returning id", [userId, now]);
  return r.length;
}

/**
 * Renewal rotates the cookie token (the old one stops working) and slides expiry forward, never past the absolute
 * ceiling measured from creation. It does not refresh authenticated_at, so renewing cannot satisfy a step-up.
 */
export async function renewSession(db: Db, config: AppConfig, auth: AuthContext): Promise<{ token: string; expiresAt: Date }> {
  const secret = requireSecret(config.sessionSecret, "SESSION_SECRET");
  const now = config.now();
  const ceiling = auth.createdAt.getTime() + (isRestricted(auth) ? config.auth.keySessionMaxSeconds : config.auth.sessionMaxSeconds) * 1000;
  const expiresAt = new Date(Math.min(now.getTime() + sessionTtlSeconds(config, auth.sessionKind) * 1000, ceiling));
  if (expiresAt.getTime() <= now.getTime()) throw new ApiError("UNAUTHENTICATED", "Session reached its maximum lifetime; sign in again");
  const token = randomToken(32);
  const r = await db.query("update sessions set token_hash=$2, expires_at=$3 where id=$1 and revoked_at is null and expires_at > $4 returning id", [auth.sessionId, hmacHex(secret, token), expiresAt, now]);
  if (!r.length) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "session.renewed", targetType: "session", targetId: auth.sessionId, at: now });
  return { token, expiresAt };
}

export async function revokeSession(db: Db, sessionId: string, now: Date): Promise<void> {
  await db.query("update sessions set revoked_at = $2 where id = $1 and revoked_at is null", [sessionId, now]);
}

export async function sessionView(db: Db, auth: AuthContext): Promise<SessionView> {
  const [r] = await db.query<{ ucreated: Date; name: string | null }>(
    "select u.created_at as ucreated, a.name from users u, accounts a where u.id = $1 and a.id = $2",
    [auth.userId, auth.accountId],
  );
  if (!r) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  return {
    user: { id: auth.userId, createdAt: r.ucreated.toISOString() },
    account: { id: auth.accountId, name: r.name },
    membership: { id: auth.membershipId, accountId: auth.accountId, userId: auth.userId, role: auth.role },
    expiresAt: auth.expiresAt.toISOString(),
    sessionKind: auth.sessionKind,
    restricted: isRestricted(auth),
  };
}
