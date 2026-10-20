import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  WalletChallengeRequest, WalletSessionRequest,
} from "@llmcrypto/contracts";
import { audit } from "../audit";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { parseBody, rateLimit, type AppEnv, type RateLimiter, ApiError, type Ctx } from "../http";
import { consumeAndVerify, issueChallenge } from "./challenges";
import { linkIdentity, listIdentities, loginWithWallet, unlinkIdentity } from "./linking";
import { methodRoutes } from "./method-routes";
import type { TelegramBot } from "./telegram";
import {
  authorizeSession, clearSessionCookie, createSession, requireRecentSignIn, requireSecret, requireSession, resolveSession, revokeSession,
  sessionView, startSession, SESSION_COOKIE,
} from "./session";

/** Per-challenge pre-session binding cookie: `wc_<challengeId>` (HttpOnly, SameSite=Strict, Path=/api/auth/wallet/sessions, lives as long as the challenge). */
export const CHALLENGE_COOKIE_PREFIX = "wc_";

export interface AuthDeps {
  db: Db;
  config: AppConfig;
  clientKey: (c: Ctx) => string;
  limiters: { challenge: RateLimiter; session: RateLimiter };
  /** null = Telegram sign-in unavailable (503): no bot token exists yet. */
  telegramBot: TelegramBot | null;
}

export function authRoutes({ db, config, clientKey, limiters, telegramBot }: AuthDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const needSession = requireSession(db, config);
  /** Routes a restricted (API-key) session may use: they only ever return that key's own data. */
  const keyScoped = requireSession(db, config, "key_scope");

  app.post("/auth/wallet/challenges", rateLimit(limiters.challenge, clientKey, "challenge"), async (c) => {
    requireSecret(config.sessionSecret, "SESSION_SECRET");
    const req = await parseBody(c, WalletChallengeRequest);
    let bind: { userId: string; sessionId: string } | null = null;
    if (req.purpose === "link") {
      const auth = await resolveSession(db, config, getCookie(c, SESSION_COOKIE));
      if (!auth) throw new ApiError("UNAUTHENTICATED", "Sign in required");
      authorizeSession(auth, "full");
      requireRecentSignIn(auth, config);
      bind = { userId: auth.userId, sessionId: auth.sessionId };
    }
    c.header("Cache-Control", "no-store");
    const issued = await issueChallenge(db, config, req, bind);
    if (issued.bindingToken) {
      // One cookie per outstanding challenge (so two tabs can both sign in); readable only by the sessions endpoint, gone with the challenge.
      setCookie(c, `${CHALLENGE_COOKIE_PREFIX}${issued.challenge.challengeId}`, issued.bindingToken, {
        httpOnly: true, secure: config.cookieSecure, sameSite: "Strict", path: "/api/auth/wallet/sessions", maxAge: config.challengeTtlSeconds,
      });
    }
    return c.json(issued.challenge, 201);
  });

  app.post("/auth/wallet/sessions", rateLimit(limiters.session, clientKey, "session"), async (c) => {
    requireSecret(config.sessionSecret, "SESSION_SECRET");
    const req = await parseBody(c, WalletSessionRequest);
    const ch = await consumeAndVerify(db, config, req.challengeId, req.signature, "login", null, getCookie(c, `${CHALLENGE_COOKIE_PREFIX}${req.challengeId}`) ?? null);
    const now = config.now();
    const login = await loginWithWallet(db, ch, now, c.get("requestId"));
    const session = await db.tx(async (q) => {
      const s = await createSession(q, config, login.userId, login.accountId, { kind: "wallet", methodRef: login.identityId, authVersion: login.authVersion });
      await audit(q, {
        accountId: login.accountId, actorUserId: login.userId, action: "session.created", targetType: "session", targetId: s.id,
        requestId: c.get("requestId"), at: now, metadata: { protocol: ch.protocol, newAccount: login.created },
      });
      return s;
    });
    return c.json(await startSession(db, c, config, session), 200);
  });

  app.get("/session", keyScoped, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await sessionView(db, c.get("auth")));
  });

  app.delete("/session", keyScoped, async (c) => {
    const auth = c.get("auth");
    const now = config.now();
    await revokeSession(db, auth.sessionId, now);
    await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "session.revoked", targetType: "session", targetId: auth.sessionId, requestId: c.get("requestId"), at: now });
    clearSessionCookie(c, config);
    return c.body(null, 204);
  });

  app.get("/identities", needSession, async (c) => c.json({ items: await listIdentities(db, c.get("auth").userId) }));

  app.post("/identities", needSession, rateLimit(limiters.session, clientKey, "link"), async (c) => {
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    const req = await parseBody(c, WalletSessionRequest);
    const ch = await consumeAndVerify(db, config, req.challengeId, req.signature, "link", { userId: auth.userId, sessionId: auth.sessionId });
    return c.json(await linkIdentity(db, auth, ch, config.now(), c.get("requestId")), 201);
  });

  app.delete("/identities/:id", needSession, async (c) => {
    const auth = c.get("auth");
    requireRecentSignIn(auth, config);
    await unlinkIdentity(db, auth, c.req.param("id"), config.now(), c.get("requestId"));
    return c.body(null, 204);
  });

  app.route("/", methodRoutes({ db, config, clientKey, limiters, telegramBot }));
  return app;
}
