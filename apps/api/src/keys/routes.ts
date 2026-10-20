import { Hono } from "hono";
import { CreateKeyRequest, CreateKeyResponse, IdempotencyKey, KeyListQuery, SECRET_REPLAY_WINDOW_SECONDS, type CreateKeyRequest as CreateKeyReq, type KeyList } from "@llmcrypto/contracts";
import { KEY_SECRET_PREFIX, canManageKeys, keyDisplayPrefix, validateKeyRequest } from "@llmcrypto/domain";
import { audit } from "../audit";
import { catalogModelIds } from "../catalog/routes";
import type { AppConfig } from "../config";
import { canonicalJson, hmacHex, openSecret, randomId, randomToken, sealSecret, sha256Hex } from "../crypto";
import type { Db } from "../db";
import { ApiError, parseBody, parseWith, rateLimit, type AppEnv, type Ctx, type RateLimiter } from "../http";
import { decodeCursor, encodeCursor } from "../cursor";
import { abortIdempotent, beginIdempotent, completeIdempotent, type IdemRow, type IdemScope } from "../idempotency";
import { requireRecentSignIn, requireSecret, requireSession, type AuthContext } from "../auth/session";
import { KEY_COLUMNS, getKey, toApiKey, type KeyRow } from "./service";

export interface KeyDeps {
  db: Db;
  config: AppConfig;
  clientKey: (c: Ctx) => string;
  limiter: RateLimiter;
}

const OPERATION = "createKey";

function requireManager(auth: AuthContext): void {
  if (!canManageKeys(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
}

export function keyRoutes({ db, config, clientKey, limiter }: KeyDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession(db, config), rateLimit(limiter, clientKey, "keys"));

  app.post("/", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    requireRecentSignIn(auth, config);
    const rawKey = c.req.header("Idempotency-Key");
    if (rawKey === undefined || rawKey === "") throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    const parsedKey = IdempotencyKey.safeParse(rawKey);
    if (!parsedKey.success) throw new ApiError("BAD_REQUEST", "Idempotency-Key must be 8-255 printable ASCII characters");
    // Fail closed: without both secrets no key may be minted (the replay blob could not be protected).
    const pepper = requireSecret(config.apiKeyPepper, "API_KEY_HASH_PEPPER");
    const replaySecret = requireSecret(config.keyReplaySecret, "KEY_REPLAY_ENCRYPTION_SECRET");
    const body = await parseBody(c, CreateKeyRequest);

    const scope: IdemScope = { accountId: auth.accountId, operation: OPERATION, key: parsedKey.data };
    const now = config.now();
    const outcome = await beginIdempotent(db, scope, sha256Hex(canonicalJson(body)), now, config.idempotencyStaleSeconds);
    c.header("Cache-Control", "no-store");
    if (outcome.action === "reject") throw new ApiError(outcome.code, outcome.code === "IN_PROGRESS" ? "An identical request is still running" : "Idempotency-Key reused with a different payload");
    if (outcome.action === "replay") return replay(c, db, config, auth, scope, outcome.row, replaySecret);

    try {
      await validateSemantics(db, auth, body, now);
      const secret = KEY_SECRET_PREFIX + randomToken(32);
      const keyId = randomId("key");
      const row = await db.tx(async (q) => {
        await q.query(
          `insert into api_keys (id, account_id, project_id, name, prefix, key_hash, scopes, model_allowlist, spend_cap_microusd, expires_at, created_by_user_id, created_at)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,
          [keyId, auth.accountId, body.projectId ?? null, body.name.trim(), keyDisplayPrefix(secret), hmacHex(pepper, secret),
            JSON.stringify(body.scopes), JSON.stringify(body.modelAllowlist), body.spendCapMicrousd ?? null, body.expiresAt ?? null, auth.userId, now],
        );
        await audit(q, {
          accountId: auth.accountId, actorUserId: auth.userId, action: "key.created", targetType: "api_key", targetId: keyId,
          requestId: c.get("requestId"), at: now,
          metadata: { prefix: keyDisplayPrefix(secret), scopes: body.scopes.join(","), models: body.modelAllowlist.length, hasSpendCap: body.spendCapMicrousd !== undefined },
        });
        await completeIdempotent(q, scope, {
          statusCode: 201, result: { keyId }, at: now,
          replay: {
            ciphertext: sealSecret(replaySecret, secret, aad(scope, auth.sessionId)),
            sessionId: auth.sessionId,
            expiresAt: new Date(now.getTime() + SECRET_REPLAY_WINDOW_SECONDS * 1000),
          },
        });
        return getKey(q, auth.accountId, keyId);
      });
      if (!row) throw new ApiError("INTERNAL", "Key was not persisted");
      return c.json(CreateKeyResponse.parse({ key: toApiKey(row), secretStatus: "PROVIDED", secret }), 201);
    } catch (e) {
      await abortIdempotent(db, scope);
      throw e;
    }
  });

  app.get("/", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const q = parseWith(KeyListQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<KeyRow>(
      `select ${KEY_COLUMNS} from api_keys
       where account_id=$1 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text))
       order by created_at, id limit $4`,
      [auth.accountId, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const body: KeyList = { items: page.map(toApiKey), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.delete("/:id", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const now = config.now();
    await db.tx(async (q) => {
      const key = await getKey(q, auth.accountId, c.req.param("id")); // account-scoped: other accounts' ids are 404
      if (!key) throw new ApiError("NOT_FOUND", "Key not found");
      if (key.revoked_at) return;
      await q.query("update api_keys set revoked_at=$2, revoked_by_user_id=$3 where id=$1 and revoked_at is null", [key.id, now, auth.userId]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "key.revoked", targetType: "api_key", targetId: key.id, requestId: c.get("requestId"), at: now, metadata: { prefix: key.prefix } });
    });
    return c.body(null, 204);
  });

  return app;
}

const aad = (s: IdemScope, sessionId: string): string => `${s.accountId}|${s.operation}|${s.key}|${sessionId}`;

async function validateSemantics(db: Db, auth: AuthContext, body: CreateKeyReq, now: Date): Promise<void> {
  const issues = validateKeyRequest(body, catalogModelIds(), now);
  if (body.projectId !== undefined) {
    const found = await db.query("select 1 as x from projects where id=$1 and account_id=$2", [body.projectId, auth.accountId]);
    if (!found.length) issues.push({ field: "projectId", message: "project not found in this account" });
  }
  if (issues.length) throw new ApiError("VALIDATION_FAILED", "Request validation failed", issues);
}

/** Same key + payload: returns metadata; the secret again only inside the window, for the same session, while the key is live. */
async function replay(c: Ctx, db: Db, config: AppConfig, auth: AuthContext, scope: IdemScope, row: IdemRow, replaySecret: string): Promise<Response> {
  const keyId = (row.result as { keyId?: string } | null)?.keyId;
  const key = keyId ? await getKey(db, auth.accountId, keyId) : undefined;
  if (!key) throw new ApiError("INTERNAL", "Original result unavailable");
  const now = config.now();
  const inWindow = row.replay_ciphertext !== null && row.replay_expires_at !== null && row.replay_expires_at.getTime() > now.getTime();
  if (row.replay_ciphertext !== null && !inWindow) {
    await db.query("update idempotency_keys set replay_ciphertext=null where account_id=$1 and operation=$2 and key=$3", [scope.accountId, scope.operation, scope.key]);
  }
  c.header("Idempotent-Replay", "true");
  if (inWindow && row.replay_ciphertext && row.replay_session_id === auth.sessionId && !key.revoked_at) {
    const secret = openSecret(replaySecret, row.replay_ciphertext, aad(scope, auth.sessionId));
    if (secret) {
      await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "key.secret_replayed", targetType: "api_key", targetId: key.id, requestId: c.get("requestId"), at: now });
      return c.json(CreateKeyResponse.parse({ key: toApiKey(key), secretStatus: "PROVIDED", secret }), 201);
    }
  }
  return c.json(CreateKeyResponse.parse({ key: toApiKey(key), secretStatus: "NON_RECOVERABLE", secret: null }), 201);
}
