/** Password, Telegram, API-key sessions, recovery codes, step-up, renewal and the method listing. */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  AuthMethods, KeySessionRequest, PasswordRecoveryRequest, PasswordSessionRequest, PasswordSetupRequest, StepUpRequest,
  TelegramCodeRequest, TelegramVerifyRequest, type PasswordSignupResponse,
} from "@llmcrypto/contracts";
import { audit } from "../audit";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { ApiError, parseBody, rateLimit, type AppEnv, type Ctx, type RateLimiter } from "../http";
import { takeAttempt } from "./attempts";
import { openKeySession } from "./key-session";
import { listIdentities, removeMethod } from "./linking";
import {
  BAD_LOGIN, linkPassword, normalizeUsername, recoverPassword, regenerateRecoveryCodes, signupPassword, verifyOwnPassword, verifyPasswordLogin,
} from "./password";
import {
  authorizeSession, createSession, renewSession, requireRecentSignIn, requireSession, resolveSession, SESSION_COOKIE, sessionView,
  setSessionCookie, startSession,
} from "./session";
import {
  issueTelegramCode, linkTelegram, listTelegramIdentities, loginWithTelegram, ownsTelegramId, requireBot, verifyTelegramCode, type TelegramBot,
} from "./telegram";

export interface MethodDeps {
  db: Db;
  config: AppConfig;
  clientKey: (c: Ctx) => string;
  limiters: { challenge: RateLimiter; session: RateLimiter };
  telegramBot: TelegramBot | null;
}

export function methodRoutes({ db, config, clientKey, limiters, telegramBot }: MethodDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const full = requireSession(db, config); // default-deny for API-key sessions
  const keyScoped = requireSession(db, config, "key_scope");
  const bySession = rateLimit(limiters.session, clientKey, "session");

  // ---------------------------------------------------------------- password

  app.post("/auth/password/signup", rateLimit(limiters.session, clientKey, "pw-signup"), async (c) => {
    const req = await parseBody(c, PasswordSetupRequest);
    const created = await signupPassword(db, config, req, c.get("requestId"));
    const session = await db.tx((q) => createSession(q, config, created.userId, created.accountId, { kind: "password", methodRef: created.credentialId, authVersion: created.authVersion }));
    const body: PasswordSignupResponse = { session: await startSession(db, c, config, session), recovery: created.recovery };
    return c.json(body, 201);
  });

  app.post("/auth/password/sessions", bySession, async (c) => {
    const req = await parseBody(c, PasswordSessionRequest);
    const ticket = await takeAttempt(db, config, "password", { account: normalizeUsername(req.username), ip: clientKey(c) });
    const login = await verifyPasswordLogin(db, config, req.username, req.password);
    if (!login) throw BAD_LOGIN();
    await ticket.succeeded();
    const now = config.now();
    const session = await db.tx(async (q) => {
      const s = await createSession(q, config, login.userId, login.accountId, { kind: "password", methodRef: login.credentialId, authVersion: login.authVersion });
      await audit(q, { accountId: login.accountId, actorUserId: login.userId, action: "session.created", targetType: "session", targetId: s.id, requestId: c.get("requestId"), at: now, metadata: { kind: "password" } });
      return s;
    });
    return c.json(await startSession(db, c, config, session), 200);
  });

  app.post("/auth/password/recovery", bySession, async (c) => {
    const req = await parseBody(c, PasswordRecoveryRequest);
    const ticket = await takeAttempt(db, config, "recovery", { account: normalizeUsername(req.username), ip: clientKey(c) });
    if (!(await recoverPassword(db, config, req, c.get("requestId")))) throw new ApiError("UNAUTHENTICATED", "Invalid username or recovery code");
    await ticket.succeeded();
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  app.post("/auth/password", full, bySession, async (c) => {
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    const req = await parseBody(c, PasswordSetupRequest);
    c.header("Cache-Control", "no-store");
    return c.json(await linkPassword(db, config, auth, req, c.get("requestId")), 201);
  });

  app.delete("/auth/password", full, async (c) => {
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    const [cred] = await db.query<{ id: string }>("select id from password_credentials where user_id=$1", [auth.userId]);
    if (!cred) throw new ApiError("NOT_FOUND", "No password is set for this user");
    await removeMethod(db, auth, config.now(), c.get("requestId"), {
      exists: async () => true,
      remove: async (q) => {
        await q.query("delete from recovery_codes where user_id=$1", [auth.userId]);
        await q.query("delete from password_credentials where id=$1", [cred.id]);
      },
      methodRef: cred.id,
      action: "password.unlinked",
      targetType: "credential",
      notFound: "No password is set for this user",
    });
    return c.body(null, 204);
  });

  app.post("/auth/recovery-codes", full, bySession, async (c) => {
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    c.header("Cache-Control", "no-store");
    return c.json(await regenerateRecoveryCodes(db, config, auth, c.get("requestId")), 201);
  });

  // ---------------------------------------------------------------- Telegram

  app.post("/auth/telegram/codes", rateLimit(limiters.challenge, clientKey, "tg-code"), async (c) => {
    requireBot(telegramBot);
    const req = await parseBody(c, TelegramCodeRequest);
    let bind: { userId: string; sessionId: string } | null = null;
    if (req.purpose !== "login") {
      const auth = await resolveSession(db, config, getCookie(c, SESSION_COOKIE));
      if (!auth) throw new ApiError("UNAUTHENTICATED", "Sign in required");
      authorizeSession(auth, "full");
      if (req.purpose === "link") requireRecentSignIn(auth, config);
      bind = { userId: auth.userId, sessionId: auth.sessionId };
    }
    c.header("Cache-Control", "no-store");
    return c.json(await issueTelegramCode(db, config, req.purpose, bind), 201);
  });

  app.post("/auth/telegram/sessions", bySession, async (c) => {
    const bot = requireBot(telegramBot);
    const req = await parseBody(c, TelegramVerifyRequest);
    const v = await verifyTelegramCode(db, config, bot, req.codeId, "login", null);
    const now = config.now();
    const login = await loginWithTelegram(db, v.telegramUserId, now, c.get("requestId"));
    const session = await db.tx(async (q) => {
      const s = await createSession(q, config, login.userId, login.accountId, { kind: "telegram", methodRef: login.identityId, authVersion: login.authVersion });
      await audit(q, { accountId: login.accountId, actorUserId: login.userId, action: "session.created", targetType: "session", targetId: s.id, requestId: c.get("requestId"), at: now, metadata: { kind: "telegram", newAccount: login.created } });
      return s;
    });
    return c.json(await startSession(db, c, config, session), 200);
  });

  app.post("/auth/telegram/identities", full, bySession, async (c) => {
    const bot = requireBot(telegramBot);
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    const req = await parseBody(c, TelegramVerifyRequest);
    const v = await verifyTelegramCode(db, config, bot, req.codeId, "link", { userId: auth.userId, sessionId: auth.sessionId });
    return c.json(await linkTelegram(db, auth, v.telegramUserId, config.now(), c.get("requestId")), 201);
  });

  app.delete("/auth/telegram/identities/:id", full, async (c) => {
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    const id = c.req.param("id");
    const now = config.now();
    await removeMethod(db, auth, now, c.get("requestId"), {
      exists: async (q) => (await q.query("select 1 as x from telegram_identities where id=$1 and user_id=$2 and unlinked_at is null", [id, auth.userId])).length > 0,
      remove: (q) => q.query("update telegram_identities set unlinked_at=$2 where id=$1", [id, now]).then(() => undefined),
      methodRef: id,
      action: "telegram.unlinked",
      targetType: "identity",
      notFound: "Identity not found",
    });
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- API-key console session

  app.post("/auth/key-sessions", bySession, async (c) => {
    const req = await parseBody(c, KeySessionRequest);
    const ticket = await takeAttempt(db, config, "key_session", { account: req.apiKey.slice(0, 8), ip: clientKey(c) });
    const s = await openKeySession(db, config, req.apiKey, c.get("requestId"));
    if (!s) throw new ApiError("UNAUTHENTICATED", "Invalid API key");
    await ticket.succeeded();
    return c.json(await startSession(db, c, config, s), 200);
  });

  // ---------------------------------------------------------------- session lifecycle

  app.post("/session/renew", keyScoped, async (c) => {
    const renewed = await renewSession(db, config, c.get("auth"));
    setSessionCookie(c, config, renewed.token, renewed.expiresAt);
    c.header("Cache-Control", "no-store");
    const auth = await resolveSession(db, config, renewed.token);
    if (!auth) throw new ApiError("INTERNAL", "Session could not be renewed");
    return c.json(await sessionView(db, auth));
  });

  /** Re-proves a non-wallet method so privileged mutations (key creation, linking, unlinking) pass requireRecentSignIn again. */
  app.post("/session/step-up", full, bySession, async (c) => {
    const auth = c.get("auth");
    const req = await parseBody(c, StepUpRequest);
    const fail = (): ApiError => new ApiError("FORBIDDEN", "Step-up verification failed");
    const ticket = await takeAttempt(db, config, "step_up", { account: auth.userId, ip: clientKey(c) });
    if ("password" in req) {
      if (!(await verifyOwnPassword(db, config, auth.userId, req.password))) throw fail();
    } else {
      const bot = requireBot(telegramBot);
      const v = await verifyTelegramCode(db, config, bot, req.codeId, "step_up", { userId: auth.userId, sessionId: auth.sessionId }).catch((e: unknown) => {
        throw e instanceof ApiError && e.code === "CHALLENGE_INVALID" ? fail() : e;
      });
      if (!(await ownsTelegramId(db, auth.userId, v.telegramUserId))) throw fail();
    }
    await ticket.succeeded();
    const now = config.now();
    await db.query("update sessions set authenticated_at=$2 where id=$1 and revoked_at is null", [auth.sessionId, now]);
    await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "session.step_up", targetType: "session", targetId: auth.sessionId, requestId: c.get("requestId"), at: now, metadata: { method: "password" in req ? "password" : "telegram" } });
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  app.get("/auth/methods", full, async (c) => {
    const auth = c.get("auth");
    const [pwd] = await db.query<{ id: string; username: string; unused: string }>(
      `select c.id, c.username, (select count(*) from recovery_codes r where r.user_id = c.user_id and r.used_at is null and r.expires_at > $2)::text as unused
       from password_credentials c where c.user_id=$1`,
      [auth.userId, config.now()],
    );
    c.header("Cache-Control", "no-store");
    return c.json(AuthMethods.parse({
      wallets: await listIdentities(db, auth.userId),
      telegram: await listTelegramIdentities(db, auth.userId),
      password: pwd ? { id: pwd.id, username: pwd.username, unusedRecoveryCodes: Number(pwd.unused) } : null,
    }));
  });

  return app;
}
