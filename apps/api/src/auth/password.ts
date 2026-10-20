/**
 * Username + password (argon2id) with single-use recovery codes.
 *
 * - Hashing: @node-rs/argon2 (pinned), argon2id, per-hash random salt, parameters stored in the PHC string.
 * - Sign-in failures are one generic answer; unknown usernames burn the same hashing time as known ones.
 * - Recovery: no email provider exists, so recovery is by single-use, time-limited codes issued at setup
 *   (see docs/auth-methods.md; email recovery is BLOCKED). Recovery sets a new password and revokes every session.
 * - Accounts are never linked by username: linking happens only from an existing session (linkPassword).
 */
import { randomInt } from "node:crypto";
import { hash, verify, type Algorithm } from "@node-rs/argon2";
import type { RecoveryCodes } from "@llmcrypto/contracts";
import { audit } from "../audit";
import type { AppConfig } from "../config";
import { hmacHex, randomId } from "../crypto";
import type { Db, Queryable } from "../db";
import { ApiError } from "../http";
import { requireSecret, revokeAllUserSessions, type AuthContext } from "./session";

export const normalizeUsername = (u: string): string => u.trim().toLowerCase();

const argonOptions = (config: AppConfig) => ({
  algorithm: 2 as Algorithm, // Algorithm.Argon2id (a const enum, which verbatimModuleSyntax cannot import)
  memoryCost: config.auth.argon2.memoryKiB,
  timeCost: config.auth.argon2.timeCost,
  parallelism: 1,
});
export const hashPassword = (config: AppConfig, password: string): Promise<string> => hash(password.normalize("NFKC"), argonOptions(config));

let dummyHash: Promise<string> | undefined;
/** Verifies against the stored hash, or against a throwaway hash when the user is unknown (equal work either way). */
async function checkPassword(config: AppConfig, stored: string | null, password: string): Promise<boolean> {
  const secretInput = password.normalize("NFKC");
  if (stored === null) {
    dummyHash ??= hash("not-a-real-password", argonOptions(config));
    await verify(await dummyHash, secretInput).catch(() => false);
    return false;
  }
  return verify(stored, secretInput).catch(() => false);
}

// ------------------------------------------------------------------ recovery codes

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I
const randomCode = (n: number): string => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
/** Accepts any case and ignores separators, so "abcde-fghjk" and "ABCDEFGHJK" are the same code. */
export const normalizeRecoveryCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const codeHash = (config: AppConfig, code: string): string => hmacHex(requireSecret(config.sessionSecret, "SESSION_SECRET"), `recovery|${normalizeRecoveryCode(code)}`);

/** Replaces every unused code with a fresh set. Plaintext is returned once and never stored. */
export async function issueRecoveryCodes(q: Queryable, config: AppConfig, userId: string, now: Date): Promise<RecoveryCodes> {
  await q.query("delete from recovery_codes where user_id=$1", [userId]);
  const expiresAt = new Date(now.getTime() + config.auth.recoveryCodeTtlSeconds * 1000);
  const codes: string[] = [];
  for (let i = 0; i < config.auth.recoveryCodeCount; i++) {
    const raw = randomCode(10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    await q.query("insert into recovery_codes (id, user_id, code_hash, created_at, expires_at) values ($1,$2,$3,$4,$5)", [randomId("rec"), userId, codeHash(config, raw), now, expiresAt]);
  }
  return { recoveryCodes: codes, expiresAt: expiresAt.toISOString() };
}

// ------------------------------------------------------------------ setup

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
const taken = (): ApiError => new ApiError("IDENTITY_CONFLICT", "That username is unavailable");

function checkSecretsDistinct(username: string, password: string): void {
  if (password.toLowerCase().includes(username)) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "password", message: "must not contain the username" }]);
}

export interface NewPasswordAccount {
  authVersion: number;
  userId: string;
  accountId: string;
  credentialId: string;
  recovery: RecoveryCodes;
}

/** Sign-up: a new user, account, owner membership and credential in one transaction. */
export async function signupPassword(db: Db, config: AppConfig, input: { username: string; password: string }, requestId: string): Promise<NewPasswordAccount> {
  const username = normalizeUsername(input.username);
  checkSecretsDistinct(username, input.password);
  const passwordHash = await hashPassword(config, input.password);
  const now = config.now();
  try {
    return await db.tx(async (q) => {
      const userId = randomId("usr");
      const accountId = randomId("acc");
      const credentialId = randomId("pwd");
      await q.query("insert into users (id, created_at) values ($1,$2)", [userId, now]);
      await q.query("insert into accounts (id, name, created_at) values ($1,null,$2)", [accountId, now]);
      await q.query("insert into memberships (id, account_id, user_id, role, created_at) values ($1,$2,$3,'owner',$4)", [randomId("mem"), accountId, userId, now]);
      await q.query("insert into password_credentials (id, user_id, username, password_hash, created_at, changed_at) values ($1,$2,$3,$4,$5,$5)", [credentialId, userId, username, passwordHash, now]);
      const recovery = await issueRecoveryCodes(q, config, userId, now);
      await audit(q, { accountId, actorUserId: userId, action: "account.created", targetType: "account", targetId: accountId, requestId, at: now, metadata: { via: "password" } });
      await audit(q, { accountId, actorUserId: userId, action: "password.linked", targetType: "credential", targetId: credentialId, requestId, at: now, metadata: { via: "signup" } });
      return { userId, accountId, credentialId, recovery, authVersion: 0 };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw taken();
    throw e;
  }
}

/** Adds a password to the signed-in user (the only way to attach one to an existing account). */
export async function linkPassword(db: Db, config: AppConfig, auth: AuthContext, input: { username: string; password: string }, requestId: string): Promise<RecoveryCodes> {
  const username = normalizeUsername(input.username);
  checkSecretsDistinct(username, input.password);
  const passwordHash = await hashPassword(config, input.password);
  const now = config.now();
  try {
    return await db.tx(async (q) => {
      const [has] = await q.query("select 1 as x from password_credentials where user_id=$1", [auth.userId]);
      if (has) throw new ApiError("IDENTITY_CONFLICT", "A password is already set for this user");
      const credentialId = randomId("pwd");
      await q.query("insert into password_credentials (id, user_id, username, password_hash, created_at, changed_at) values ($1,$2,$3,$4,$5,$5)", [credentialId, auth.userId, username, passwordHash, now]);
      const recovery = await issueRecoveryCodes(q, config, auth.userId, now);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "password.linked", targetType: "credential", targetId: credentialId, requestId, at: now, metadata: { via: "link" } });
      return recovery;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw taken();
    throw e;
  }
}

// ------------------------------------------------------------------ sign-in / step-up / recovery

export const BAD_LOGIN = (): ApiError => new ApiError("UNAUTHENTICATED", "Invalid username or password");

export interface PasswordLogin {
  authVersion: number;
  userId: string;
  accountId: string;
  credentialId: string;
}

/** Callers must have called takeAttempt first. Returns null for every kind of failure. */
export async function verifyPasswordLogin(db: Db, config: AppConfig, username: string, password: string): Promise<PasswordLogin | null> {
  const [row] = await db.query<{ id: string; user_id: string; password_hash: string; auth_version: number; account_id: string | null }>(
    `select c.id, c.user_id, c.password_hash, u.auth_version,
            (select m.account_id from memberships m where m.user_id = c.user_id order by m.created_at, m.id limit 1) as account_id
     from password_credentials c join users u on u.id=c.user_id where c.username = $1`,
    [normalizeUsername(username)],
  );
  const ok = await checkPassword(config, row?.password_hash ?? null, password);
  if (!ok || !row || !row.account_id) return null;
  return { userId: row.user_id, accountId: row.account_id, credentialId: row.id, authVersion: row.auth_version };
}

/** Re-checks the signed-in user's own password (step-up). */
export async function verifyOwnPassword(db: Db, config: AppConfig, userId: string, password: string): Promise<boolean> {
  const [row] = await db.query<{ password_hash: string }>("select password_hash from password_credentials where user_id=$1", [userId]);
  return checkPassword(config, row?.password_hash ?? null, password);
}

/**
 * Spends one recovery code (a single conditional UPDATE: replay or expiry matches nothing), sets the new password
 * and revokes every session of the user. Callers must have called takeAttempt first. Returns false on any failure.
 */
export async function recoverPassword(db: Db, config: AppConfig, input: { username: string; recoveryCode: string; newPassword: string }, requestId: string): Promise<boolean> {
  const username = normalizeUsername(input.username);
  checkSecretsDistinct(username, input.newPassword);
  const newHash = await hashPassword(config, input.newPassword);
  const now = config.now();
  return db.tx(async (q) => {
    const [user] = await q.query<{ id: string }>(
      "select u.id from users u join password_credentials c on c.user_id=u.id where c.username=$1 for update of u", [username],
    );
    if (!user) return false;
    const spent = await q.query<{ user_id: string }>(
      `update recovery_codes set used_at=$3
       where code_hash=$1 and used_at is null and expires_at > $3 and user_id=$4
         and user_id = (select user_id from password_credentials where username=$2)
       returning user_id`,
      [codeHash(config, input.recoveryCode), username, now, user.id],
    );
    const userId = spent[0]?.user_id;
    if (!userId) return false;
    await q.query("update password_credentials set password_hash=$2, changed_at=$3 where user_id=$1", [userId, newHash, now]);
    await q.query("update users set auth_version=auth_version+1 where id=$1", [userId]);
    const revoked = await revokeAllUserSessions(q, userId, now);
    const [acc] = await q.query<{ account_id: string }>("select account_id from memberships where user_id=$1 order by created_at, id limit 1", [userId]);
    await audit(q, { accountId: acc?.account_id ?? null, actorUserId: userId, action: "password.recovered", targetType: "user", targetId: userId, requestId, at: now, metadata: { sessionsRevoked: revoked } });
    return true;
  });
}

export async function regenerateRecoveryCodes(db: Db, config: AppConfig, auth: AuthContext, requestId: string): Promise<RecoveryCodes> {
  const now = config.now();
  return db.tx(async (q) => {
    const [has] = await q.query("select 1 as x from password_credentials where user_id=$1", [auth.userId]);
    if (!has) throw new ApiError("NOT_FOUND", "No password is set for this user");
    const codes = await issueRecoveryCodes(q, config, auth.userId, now);
    await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "recovery_codes.regenerated", targetType: "user", targetId: auth.userId, requestId, at: now });
    return codes;
  });
}
