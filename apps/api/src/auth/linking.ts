import type { LinkedIdentity } from "@llmcrypto/contracts";
import { audit } from "../audit";
import { randomId } from "../crypto";
import type { Db, Queryable } from "../db";
import { ApiError } from "../http";
import { revokeSessionsByMethod, type AuthContext } from "./session";
import type { ChallengeRow } from "./challenges";

interface IdentityRow {
  id: string;
  protocol: "evm" | "tron";
  address: string;
  chain_policy: string;
  created_at: Date;
}
const toView = (r: IdentityRow): LinkedIdentity => ({
  id: r.id, protocol: r.protocol, address: r.address, chainPolicy: r.chain_policy, createdAt: r.created_at.toISOString(),
});

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

export interface LoginResult {
  authVersion: number;
  userId: string;
  accountId: string;
  /** The wallet identity the session is established with (sessions are revoked when it is unlinked). */
  identityId: string;
  created: boolean;
}

/**
 * Wallet login: an existing active identity (protocol, address, chain policy) signs into its owner's account;
 * an unknown wallet creates user + account + owner membership + identity. Wallets are never matched to or merged
 * into other accounts by address text.
 */
export async function loginWithWallet(db: Db, ch: ChallengeRow, now: Date, requestId: string): Promise<LoginResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.tx(async (q) => {
        const [found] = await q.query<{ id: string; user_id: string; account_id: string; auth_version: number }>(
          `select i.id, i.user_id, m.account_id, u.auth_version from linked_identities i
           join memberships m on m.user_id = i.user_id join users u on u.id=i.user_id
           where i.protocol=$1 and i.address=$2 and i.chain_policy=$3 and i.unlinked_at is null
           order by m.created_at, m.id limit 1`,
          [ch.protocol, ch.address, ch.chain_policy],
        );
        if (found) return { userId: found.user_id, accountId: found.account_id, identityId: found.id, authVersion: found.auth_version, created: false };
        const userId = randomId("usr");
        const accountId = randomId("acc");
        await q.query("insert into users (id, created_at) values ($1,$2)", [userId, now]);
        await q.query("insert into accounts (id, name, created_at) values ($1,null,$2)", [accountId, now]);
        await q.query("insert into memberships (id, account_id, user_id, role, created_at) values ($1,$2,$3,'owner',$4)", [randomId("mem"), accountId, userId, now]);
        const identityId = randomId("idn");
        await q.query(
          "insert into linked_identities (id, user_id, protocol, address, chain_policy, created_at) values ($1,$2,$3,$4,$5,$6)",
          [identityId, userId, ch.protocol, ch.address, ch.chain_policy, now],
        );
        await audit(q, { accountId, actorUserId: userId, action: "account.created", targetType: "account", targetId: accountId, requestId, at: now });
        await audit(q, {
          accountId, actorUserId: userId, action: "identity.linked", targetType: "identity", targetId: identityId, requestId, at: now,
          metadata: { protocol: ch.protocol, chainPolicy: ch.chain_policy, via: "signup" },
        });
        return { userId, accountId, identityId, authVersion: 0, created: true };
      });
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue; // concurrent first sign-in of the same wallet
      throw e;
    }
  }
}

export async function listIdentities(q: Queryable, userId: string): Promise<LinkedIdentity[]> {
  const rows = await q.query<IdentityRow>(
    "select id, protocol, address, chain_policy, created_at from linked_identities where user_id=$1 and unlinked_at is null order by created_at, id",
    [userId],
  );
  return rows.map(toView);
}

/** Adds a verified wallet to the signed-in user. Never merges: an identity owned by anyone is a 409. */
export async function linkIdentity(db: Db, auth: AuthContext, ch: ChallengeRow, now: Date, requestId: string): Promise<LinkedIdentity> {
  try {
    return await db.tx(async (q) => {
      const [taken] = await q.query(
        "select 1 as x from linked_identities where protocol=$1 and address=$2 and chain_policy=$3 and unlinked_at is null",
        [ch.protocol, ch.address, ch.chain_policy],
      );
      if (taken) throw new ApiError("IDENTITY_CONFLICT", "This wallet is already linked to an account");
      const id = randomId("idn");
      await q.query(
        "insert into linked_identities (id, user_id, protocol, address, chain_policy, created_at) values ($1,$2,$3,$4,$5,$6)",
        [id, auth.userId, ch.protocol, ch.address, ch.chain_policy, now],
      );
      await audit(q, {
        accountId: auth.accountId, actorUserId: auth.userId, action: "identity.linked", targetType: "identity", targetId: id, requestId, at: now,
        metadata: { protocol: ch.protocol, chainPolicy: ch.chain_policy, via: "link" },
      });
      return toView({ id, protocol: ch.protocol, address: ch.address, chain_policy: ch.chain_policy, created_at: now });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError("IDENTITY_CONFLICT", "This wallet is already linked to an account");
    throw e;
  }
}

/** Soft-unlinks a wallet. See removeMethod for the last-method rule and session revocation. */
export async function unlinkIdentity(db: Db, auth: AuthContext, identityId: string, now: Date, requestId: string): Promise<void> {
  await removeMethod(db, auth, now, requestId, {
    exists: async (q) => (await q.query("select id from linked_identities where id=$1 and user_id=$2 and unlinked_at is null", [identityId, auth.userId])).length > 0,
    remove: (q) => q.query("update linked_identities set unlinked_at=$2 where id=$1", [identityId, now]).then(() => undefined),
    methodRef: identityId,
    action: "identity.unlinked",
    targetType: "identity",
    notFound: "Identity not found",
  });
}

export interface MethodRemoval {
  exists(q: Queryable): Promise<boolean>;
  remove(q: Queryable): Promise<void>;
  /** Sessions established with this method id are revoked with it. */
  methodRef: string;
  action: string;
  targetType: string;
  notFound: string;
}

/** Number of distinct sign-in methods the user still has (wallets + Telegram accounts + password). */
export async function countAuthMethods(q: Queryable, userId: string): Promise<number> {
  const [r] = await q.query<{ n: string }>(
    `select ((select count(*) from linked_identities where user_id=$1 and unlinked_at is null)
           + (select count(*) from telegram_identities where user_id=$1 and unlinked_at is null)
           + (select count(*) from password_credentials where user_id=$1))::text as n`,
    [userId],
  );
  return Number(r?.n ?? "0");
}

/**
 * Removes one sign-in method. Locks the user row so concurrent removals cannot together remove the last method, and
 * revokes every session that was established with the removed method (including the caller's own, if it used it).
 */
export async function removeMethod(db: Db, auth: AuthContext, now: Date, requestId: string, m: MethodRemoval): Promise<void> {
  await db.tx(async (q) => {
    await q.query("select id from users where id=$1 for update", [auth.userId]);
    if (!(await m.exists(q))) throw new ApiError("NOT_FOUND", m.notFound);
    if ((await countAuthMethods(q, auth.userId)) <= 1) throw new ApiError("LAST_AUTH_METHOD", "Link another sign-in method before removing this one");
    await m.remove(q);
    const revoked = await revokeSessionsByMethod(q, m.methodRef, now);
    await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: m.action, targetType: m.targetType, targetId: m.methodRef, requestId, at: now, metadata: { sessionsRevoked: revoked } });
  });
}
