/**
 * Telegram one-time-code sign-in, linking and step-up.
 *
 * Flow: the server issues a short single-use code (shown once, stored only as a keyed digest). The user sends the code
 * to the Telegram bot. The server drains inbound bot messages through the TelegramBot port, and the first Telegram
 * user to send an unexpired code claims it. The browser then asks the server to verify codeId: that consumes the code
 * exactly once (one conditional UPDATE) and yields the Telegram user id.
 *
 * Only FakeTelegramBot exists. The real Bot API adapter is BLOCKED: no bot token has been provided.
 * Known limitation: a code someone else can read (screen share) could be claimed by their Telegram account first, which
 * would sign the waiting browser into THAT account. Codes are therefore short-lived and shown once; a confirmation
 * step that shows the claiming Telegram handle to the browser is future work.
 */
import { randomInt } from "node:crypto";
import type { TelegramCode, TelegramCodePurpose, TelegramIdentity } from "@llmcrypto/contracts";
import { audit } from "../audit";
import type { AppConfig } from "../config";
import { hmacHex, randomId } from "../crypto";
import type { Db, Queryable } from "../db";
import { ApiError } from "../http";
import { requireSecret, type AuthContext } from "./session";

export interface TelegramMessage {
  /** Telegram numeric user id of the sender, as a decimal string. */
  telegramUserId: string;
  text: string;
}
export interface TelegramBot {
  /** Returns bot messages received since the previous call and acknowledges them (each message is delivered once). */
  fetchMessages(): Promise<TelegramMessage[]>;
}

/** Deterministic in-process stand-in. NOT Telegram: tests call userSends() to play the human. */
export class FakeTelegramBot implements TelegramBot {
  readonly isFake = true;
  private queue: TelegramMessage[] = [];
  userSends(telegramUserId: string, text: string): void {
    this.queue.push({ telegramUserId, text });
  }
  async fetchMessages(): Promise<TelegramMessage[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8; // 40 bits
const TELEGRAM_ID = /^[0-9]{1,20}$/;

export const normalizeCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const digest = (config: AppConfig, code: string): string => hmacHex(requireSecret(config.sessionSecret, "SESSION_SECRET"), `telegram|${normalizeCode(code)}`);
const invalid = (): ApiError => new ApiError("CHALLENGE_INVALID", "Code is expired, already used, or not confirmed in Telegram yet");

export function requireBot(bot: TelegramBot | null): TelegramBot {
  if (!bot) throw new ApiError("UNAVAILABLE", "Telegram sign-in is not configured (no bot token)");
  return bot;
}

export async function issueTelegramCode(
  db: Db,
  config: AppConfig,
  purpose: TelegramCodePurpose,
  bind: { userId: string; sessionId: string } | null,
): Promise<TelegramCode> {
  const now = config.now();
  const expiresAt = new Date(now.getTime() + config.auth.telegramCodeTtlSeconds * 1000);
  const raw = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const id = randomId("tgc");
  await db.query(
    "insert into telegram_codes (id, code_hash, purpose, user_id, session_id, created_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7)",
    [id, digest(config, raw), purpose, bind?.userId ?? null, bind?.sessionId ?? null, now, expiresAt],
  );
  return { codeId: id, code: `${raw.slice(0, 4)}-${raw.slice(4)}`, purpose, expiresAt: expiresAt.toISOString() };
}

/** Pulls pending bot messages and lets the first sender of each live code claim it. Unknown text is ignored. */
async function ingest(db: Db, config: AppConfig, bot: TelegramBot): Promise<void> {
  const now = config.now();
  for (const m of await bot.fetchMessages()) {
    if (!TELEGRAM_ID.test(m.telegramUserId)) continue;
    // Accept the code anywhere in a short message ("/start ABCD-2345", "my code is abcd2345").
    for (const token of m.text.slice(0, 200).split(/\s+/)) {
      const code = normalizeCode(token);
      if (code.length !== CODE_LENGTH) continue;
      await db.query(
        `update telegram_codes set claimed_telegram_user_id=$2, claimed_at=$3
         where code_hash=$1 and claimed_telegram_user_id is null and consumed_at is null and expires_at > $3`,
        [digest(config, code), m.telegramUserId, now],
      );
    }
  }
}

export interface VerifiedCode {
  codeId: string;
  purpose: TelegramCodePurpose;
  telegramUserId: string;
}

/**
 * Consumes the code if (and only if) it is live, of the expected purpose, bound to the expected session, and claimed
 * through the bot. Every failure is the same CHALLENGE_INVALID. A try that finds nothing counts toward the attempt cap,
 * after which the code is burned. Replays find consumed_at set and match nothing.
 */
export async function verifyTelegramCode(
  db: Db,
  config: AppConfig,
  bot: TelegramBot,
  codeId: string,
  purpose: TelegramCodePurpose,
  bind: { userId: string; sessionId: string } | null,
): Promise<VerifiedCode> {
  const now = config.now();
  await ingest(db, config, bot);
  const rows = await db.query<{ id: string; purpose: TelegramCodePurpose; claimed_telegram_user_id: string }>(
    `update telegram_codes set consumed_at=$2
     where id=$1 and purpose=$3 and consumed_at is null and expires_at > $2 and claimed_telegram_user_id is not null
       and attempts < $6 and ($4::text is null or (user_id = $4 and session_id = $5))
     returning id, purpose, claimed_telegram_user_id`,
    [codeId, now, purpose, bind?.userId ?? null, bind?.sessionId ?? null, config.auth.telegramMaxAttempts],
  );
  const row = rows[0];
  if (!row) {
    await db.query(
      `update telegram_codes set attempts = attempts + 1,
         consumed_at = case when attempts + 1 >= $2 then $3 else consumed_at end
       where id=$1 and consumed_at is null`,
      [codeId, config.auth.telegramMaxAttempts, now],
    );
    throw invalid();
  }
  return { codeId: row.id, purpose: row.purpose, telegramUserId: row.claimed_telegram_user_id };
}

// ------------------------------------------------------------------ identities

export interface TelegramLogin {
  authVersion: number;
  userId: string;
  accountId: string;
  identityId: string;
  created: boolean;
}

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

/** Existing active Telegram identity signs into its owner's account; an unknown id creates user + account + owner + identity. */
export async function loginWithTelegram(db: Db, telegramUserId: string, now: Date, requestId: string): Promise<TelegramLogin> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.tx(async (q) => {
        const [found] = await q.query<{ id: string; user_id: string; account_id: string; auth_version: number }>(
          `select i.id, i.user_id, m.account_id, u.auth_version from telegram_identities i join memberships m on m.user_id = i.user_id join users u on u.id=i.user_id
           where i.telegram_user_id=$1 and i.unlinked_at is null order by m.created_at, m.id limit 1`,
          [telegramUserId],
        );
        if (found) return { userId: found.user_id, accountId: found.account_id, identityId: found.id, authVersion: found.auth_version, created: false };
        const userId = randomId("usr");
        const accountId = randomId("acc");
        const identityId = randomId("tgi");
        await q.query("insert into users (id, created_at) values ($1,$2)", [userId, now]);
        await q.query("insert into accounts (id, name, created_at) values ($1,null,$2)", [accountId, now]);
        await q.query("insert into memberships (id, account_id, user_id, role, created_at) values ($1,$2,$3,'owner',$4)", [randomId("mem"), accountId, userId, now]);
        await q.query("insert into telegram_identities (id, user_id, telegram_user_id, created_at) values ($1,$2,$3,$4)", [identityId, userId, telegramUserId, now]);
        await audit(q, { accountId, actorUserId: userId, action: "account.created", targetType: "account", targetId: accountId, requestId, at: now, metadata: { via: "telegram" } });
        await audit(q, { accountId, actorUserId: userId, action: "telegram.linked", targetType: "identity", targetId: identityId, requestId, at: now, metadata: { via: "signup" } });
        return { userId, accountId, identityId, authVersion: 0, created: true };
      });
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue; // concurrent first sign-in of the same Telegram account
      throw e;
    }
  }
}

/** Adds a verified Telegram account to the signed-in user. Never merges: an id owned by anyone is a 409. */
export async function linkTelegram(db: Db, auth: AuthContext, telegramUserId: string, now: Date, requestId: string): Promise<TelegramIdentity> {
  try {
    return await db.tx(async (q) => {
      const [taken] = await q.query("select 1 as x from telegram_identities where telegram_user_id=$1 and unlinked_at is null", [telegramUserId]);
      if (taken) throw new ApiError("IDENTITY_CONFLICT", "This Telegram account is already linked to an account");
      const id = randomId("tgi");
      await q.query("insert into telegram_identities (id, user_id, telegram_user_id, created_at) values ($1,$2,$3,$4)", [id, auth.userId, telegramUserId, now]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "telegram.linked", targetType: "identity", targetId: id, requestId, at: now, metadata: { via: "link" } });
      return { id, telegramUserId, createdAt: now.toISOString() };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError("IDENTITY_CONFLICT", "This Telegram account is already linked to an account");
    throw e;
  }
}

export async function listTelegramIdentities(q: Queryable, userId: string): Promise<TelegramIdentity[]> {
  const rows = await q.query<{ id: string; telegram_user_id: string; created_at: Date }>(
    "select id, telegram_user_id, created_at from telegram_identities where user_id=$1 and unlinked_at is null order by created_at, id",
    [userId],
  );
  return rows.map((r) => ({ id: r.id, telegramUserId: r.telegram_user_id, createdAt: r.created_at.toISOString() }));
}

/** True when this Telegram user id is one of the user's active identities (step-up proof). */
export async function ownsTelegramId(q: Queryable, userId: string, telegramUserId: string): Promise<boolean> {
  const [r] = await q.query("select 1 as x from telegram_identities where user_id=$1 and telegram_user_id=$2 and unlinked_at is null", [userId, telegramUserId]);
  return Boolean(r);
}
