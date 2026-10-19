/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthMethods, ErrorEnvelope, PasswordSignupResponse, RecoveryCodes, SessionView, TelegramCode, TelegramIdentity,
} from "@llmcrypto/contracts";
import { createApp } from "../../apps/api/src/app";
import { FakeTelegramBot } from "../../apps/api/src/auth/telegram";
import { loadConfig } from "../../apps/api/src/config";
import { createGateway } from "../../apps/api/src/gateway/dispatch";
import { FakeProvider } from "../../apps/api/src/gateway/fake-provider";
import { BASE_TIME, advance, call, cookieOf, dumpDatabase, login, makeHarness, type Harness, type LoggedIn } from "./helpers";
import { createKey, fund, idemKey } from "./metering-helpers";

const PW = "correct horse battery staple";
const PW2 = "another long passphrase 42";

let h: Harness;
let app: ReturnType<typeof createApp>;
let bot: FakeTelegramBot;
let ip = "10.0.0.1";
let tgSeq = 1000;
let nameSeq = 0;
const newTg = (): string => String(++tgSeq);
const uname = (): string => `user${++nameSeq}.test`;
const gwPost = (secret: string, extra: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...extra },
    body: JSON.stringify({ model: "sample-fast-1", messages: [{ role: "user", content: "hello" }], max_tokens: 20 }),
  }));

beforeAll(async () => {
  const base = loadConfig({}).auth;
  h = await makeHarness({ auth: { ...base, argon2: { memoryKiB: 64, timeCost: 1 } } }, { GATEWAY_PROVIDER: "fake" });
  bot = new FakeTelegramBot();
  const gateway = createGateway({ db: h.db, config: h.config, provider: new FakeProvider() });
  app = createApp({ db: h.db, config: h.config, gateway, telegramBot: bot, clientKey: () => ip });
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
});

async function signup(username = uname(), password = PW) {
  const r = await call<any>(app, "POST", "/api/auth/password/signup", { body: { username, password } });
  return { r, username, password };
}
const signupOk = async (username?: string, password?: string) => {
  const s = await signup(username, password);
  expect(s.r.status).toBe(201);
  const body = PasswordSignupResponse.parse(s.r.json);
  return { ...s, body, cookie: cookieOf(s.r) };
};
const pwLogin = (username: string, password: string) => call<any>(app, "POST", "/api/auth/password/sessions", { body: { username, password } });

/** Plays the human: request a code, send it to the bot, return the code record. */
async function tgCode(purpose: "login" | "link" | "step_up", telegramUserId: string, cookie?: string, send = true) {
  const r = await call<any>(app, "POST", "/api/auth/telegram/codes", { body: { purpose }, cookie });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const code = TelegramCode.parse(r.json);
  if (send) bot.userSends(telegramUserId, `/start ${code.code}`);
  return code;
}
async function tgLogin(telegramUserId = newTg()) {
  const code = await tgCode("login", telegramUserId);
  const r = await call<any>(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { r, telegramUserId, cookie: cookieOf(r), view: SessionView.parse(r.json), code };
}
const errCode = (r: { json: unknown }): string => ErrorEnvelope.parse(r.json).error.code;

describe("password sign-in", () => {
  it("signs up with argon2id, returns a password session and one-time recovery codes, stores no plaintext", async () => {
    const { body, username, cookie, r } = await signupOk();
    expect(body.session.sessionKind).toBe("password");
    expect(body.session.restricted).toBe(false);
    expect(body.session.membership.role).toBe("owner");
    expect(body.recovery.recoveryCodes).toHaveLength(8);
    expect(r.setCookie.find((c) => c.startsWith("session="))).toMatch(/HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/i);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const me = await call<any>(app, "GET", "/api/session", { cookie });
    expect(SessionView.parse(me.json).sessionKind).toBe("password");

    const [row] = await h.db.query<{ password_hash: string; username: string }>("select password_hash, username from password_credentials where username=$1", [username]);
    expect(row?.password_hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=1\$/);
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(PW);
    for (const code of body.recovery.recoveryCodes) expect(dump).not.toContain(code.replace("-", ""));
  });

  it("signs in; username is case-insensitive; rejects username reuse, weak and username-containing passwords", async () => {
    const { username } = await signupOk(`Mixed.Case${++nameSeq}`);
    const ok = await pwLogin(username.toUpperCase(), PW);
    expect(ok.status).toBe(200);
    expect(SessionView.parse(ok.json).sessionKind).toBe("password");
    const dup = await signup(username.toLowerCase());
    expect(dup.r.status).toBe(409);
    expect(errCode(dup.r)).toBe("IDENTITY_CONFLICT");
    expect((await signup(uname(), "short")).r.status).toBe(422);
    const name = uname();
    expect((await signup(name, `xx${name}xx-long-enough`)).r.status).toBe(422);
  });

  it("answers every failure identically: unknown user, wrong password, and wrong password for a real user", async () => {
    const { username } = await signupOk();
    const a = await pwLogin("nobody.here", "whatever password");
    const b = await pwLogin(username, "wrong password entirely");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const strip = (r: any) => ({ ...r.json.error, requestId: "x" });
    expect(strip(a)).toEqual(strip(b));
    expect(a.setCookie).toEqual([]);
  });

  it("per account + IP: the 6th failure is 429 with Retry-After, even with the right password; it lifts after the window", async () => {
    const { username } = await signupOk();
    for (let i = 0; i < 5; i++) expect((await pwLogin(username, `wrong guess number ${i}`)).status).toBe(401);
    const locked = await pwLogin(username, PW);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(errCode(locked)).toBe("RATE_LIMITED");
    // the lockout is persisted and ignores the in-memory limiter
    advance(h, 16 * 60);
    expect((await pwLogin(username, PW)).status).toBe(200);
  });

  it("per account across IPs: failures from OTHER clients cannot lock the owner out (the account-wide bucket is deliberately high)", async () => {
    const { username } = await signupOk();
    expect(h.config.auth.attempts.account.limit).toBeGreaterThanOrEqual(100);
    for (let i = 0; i < 10; i++) {
      ip = `192.0.2.${i + 1}`; // each attempt from a new client: no single pair or IP bucket fills
      expect((await pwLogin(username, `distributed guess ${i}`)).status).toBe(401);
    }
    ip = "192.0.2.200"; // the owner, from their own address, is not locked out by ten strangers
    expect((await pwLogin(username, PW)).status).toBe(200);
  });

  it("per IP across accounts (spraying) is stopped", async () => {
    ip = "198.51.100.7";
    for (let i = 0; i < 30; i++) expect((await pwLogin(`spray.target${i}`, "spray password attempt")).status).toBe(401);
    const { username } = await (async () => {
      ip = "198.51.100.8";
      return signupOk();
    })();
    ip = "198.51.100.7";
    expect((await pwLogin(username, PW)).status).toBe(429);
    ip = "198.51.100.9";
    expect((await pwLogin(username, PW)).status).toBe(200);
  });

  it("a success clears the account+IP bucket", async () => {
    const { username } = await signupOk();
    for (let i = 0; i < 4; i++) await pwLogin(username, `typo ${i} typo typo`);
    expect((await pwLogin(username, PW)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await pwLogin(username, `typo again ${i} typo`)).status).toBe(401);
  });
});

describe("recovery codes", () => {
  it("a code works once (replay fails), sets a new password, revokes all sessions, and is insensitive to case/separators", async () => {
    const { username, body, cookie } = await signupOk();
    const code = body.recovery.recoveryCodes[0]!;
    const sloppy = code.toLowerCase().replace("-", " ");
    const r = await call<any>(app, "POST", "/api/auth/password/recovery", { body: { username, recoveryCode: sloppy, newPassword: PW2 } });
    expect(r.status).toBe(204);
    expect((await call(app, "GET", "/api/session", { cookie })).status).toBe(401); // old session revoked
    expect((await pwLogin(username, PW)).status).toBe(401);
    expect((await pwLogin(username, PW2)).status).toBe(200);
    const replay = await call<any>(app, "POST", "/api/auth/password/recovery", { body: { username, recoveryCode: code, newPassword: "yet another passphrase 9" } });
    expect(replay.status).toBe(401);
    expect((await pwLogin(username, PW2)).status).toBe(200); // replay changed nothing
    // other codes still work
    const other = await call(app, "POST", "/api/auth/password/recovery", { body: { username, recoveryCode: body.recovery.recoveryCodes[1], newPassword: "yet another passphrase 9" } });
    expect(other.status).toBe(204);
  });

  it("an expired code, another user's code, and wrong codes fail with the same generic answer", async () => {
    const a = await signupOk();
    const b = await signupOk();
    const wrong = await call<any>(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: "AAAAA-BBBBB", newPassword: PW2 } });
    const foreign = await call<any>(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: b.body.recovery.recoveryCodes[0], newPassword: PW2 } });
    expect(wrong.status).toBe(401);
    expect(foreign.status).toBe(401);
    expect(wrong.json.error.message).toBe(foreign.json.error.message);
    advance(h, 91 * 86_400);
    const expired = await call<any>(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: a.body.recovery.recoveryCodes[0], newPassword: PW2 } });
    expect(expired.status).toBe(401);
    expect((await pwLogin(a.username, PW)).status).toBe(200);
  });

  it("recovery attempts are limited per account + IP", async () => {
    const a = await signupOk();
    for (let i = 0; i < 5; i++) expect((await call(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: `GUESS-${i}${i}${i}${i}${i}`, newPassword: PW2 } })).status).toBe(401);
    const locked = await call(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: a.body.recovery.recoveryCodes[0], newPassword: PW2 } });
    expect(locked.status).toBe(429);
  });

  it("regenerating invalidates the old set and needs a recent sign-in", async () => {
    const a = await signupOk();
    advance(h, 20 * 60);
    expect((await call<any>(app, "POST", "/api/auth/recovery-codes", { cookie: a.cookie })).json.error.code).toBe("STEP_UP_REQUIRED");
    const step = await call(app, "POST", "/api/session/step-up", { cookie: a.cookie, body: { password: PW } });
    expect(step.status).toBe(204);
    const fresh = RecoveryCodes.parse((await call<any>(app, "POST", "/api/auth/recovery-codes", { cookie: a.cookie })).json);
    expect(fresh.recoveryCodes).toHaveLength(8);
    const old = await call(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: a.body.recovery.recoveryCodes[0], newPassword: PW2 } });
    expect(old.status).toBe(401);
    const ok = await call(app, "POST", "/api/auth/password/recovery", { body: { username: a.username, recoveryCode: fresh.recoveryCodes[0], newPassword: PW2 } });
    expect(ok.status).toBe(204);
  });
});

describe("linking only from an existing session; methods; last-method rule", () => {
  it("links a password to a wallet account (recovery codes once), refuses without a session or a second password", async () => {
    const w = await login(app);
    const anon = await call(app, "POST", "/api/auth/password", { body: { username: uname(), password: PW } });
    expect(anon.status).toBe(401);
    const name = uname();
    const linked = await call<any>(app, "POST", "/api/auth/password", { cookie: w.cookie, body: { username: name, password: PW } });
    expect(linked.status).toBe(201);
    expect(RecoveryCodes.parse(linked.json).recoveryCodes).toHaveLength(8);
    expect((await call<any>(app, "POST", "/api/auth/password", { cookie: w.cookie, body: { username: uname(), password: PW } })).json.error.code).toBe("IDENTITY_CONFLICT");
    // signing in with the password reaches the SAME account
    const viaPw = SessionView.parse((await pwLogin(name, PW)).json);
    expect(viaPw.account.id).toBe(w.accountId);
    const methods = AuthMethods.parse((await call(app, "GET", "/api/auth/methods", { cookie: w.cookie })).json);
    expect(methods.password).toMatchObject({ username: name, unusedRecoveryCodes: 8 });
    expect(methods.wallets).toHaveLength(1);
  });

  it("another user's username cannot be taken by linking; linking needs a recent sign-in", async () => {
    const a = await signupOk();
    const w = await login(app);
    expect((await call<any>(app, "POST", "/api/auth/password", { cookie: w.cookie, body: { username: a.username, password: PW } })).json.error.code).toBe("IDENTITY_CONFLICT");
    advance(h, 20 * 60);
    expect((await call<any>(app, "POST", "/api/auth/password", { cookie: w.cookie, body: { username: uname(), password: PW } })).json.error.code).toBe("STEP_UP_REQUIRED");
  });

  it("counts every method type for the last-method rule, and removing a method revokes its sessions", async () => {
    const pw = await signupOk();
    // sole method: cannot remove the password
    const blocked = await call<any>(app, "DELETE", "/api/auth/password", { cookie: pw.cookie });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("LAST_AUTH_METHOD");
    // add Telegram from the password session
    const tg = newTg();
    const code = await tgCode("link", tg, pw.cookie);
    const linked = await call<any>(app, "POST", "/api/auth/telegram/identities", { cookie: pw.cookie, body: { codeId: code.codeId } });
    expect(linked.status).toBe(201);
    const ident = TelegramIdentity.parse(linked.json);
    // a Telegram session, then unlink Telegram from the password session: the Telegram session dies, the password one lives
    const viaTg = await tgLogin(tg);
    expect(viaTg.view.account.id).toBe(pw.body.session.account.id);
    expect((await call(app, "DELETE", `/api/auth/telegram/identities/${ident.id}`, { cookie: pw.cookie })).status).toBe(204);
    expect((await call(app, "GET", "/api/session", { cookie: viaTg.cookie })).status).toBe(401);
    expect((await call(app, "GET", "/api/session", { cookie: pw.cookie })).status).toBe(200);
    // Telegram is gone again, so the password is the last method once more
    expect((await call<any>(app, "DELETE", "/api/auth/password", { cookie: pw.cookie })).json.error.code).toBe("LAST_AUTH_METHOD");
  });

  it("removing the password revokes password sessions and deletes its recovery codes", async () => {
    const w = await login(app);
    const name = uname();
    const l = RecoveryCodes.parse((await call<any>(app, "POST", "/api/auth/password", { cookie: w.cookie, body: { username: name, password: PW } })).json);
    const viaPw = await pwLogin(name, PW);
    expect(viaPw.status).toBe(200);
    expect((await call(app, "DELETE", "/api/auth/password", { cookie: w.cookie })).status).toBe(204);
    expect((await call(app, "GET", "/api/session", { cookie: cookieOf(viaPw) })).status).toBe(401);
    expect((await pwLogin(name, PW)).status).toBe(401);
    const rec = await call(app, "POST", "/api/auth/password/recovery", { body: { username: name, recoveryCode: l.recoveryCodes[0], newPassword: PW2 } });
    expect(rec.status).toBe(401);
    expect((await h.db.query("select 1 from recovery_codes where user_id=$1", [w.userId])).length).toBe(0);
  });
});

describe("Telegram one-time code", () => {
  it("signs in through the bot port, creating an account for an unknown Telegram id and reusing it afterwards", async () => {
    const first = await tgLogin();
    expect(first.view.sessionKind).toBe("telegram");
    expect(first.view.membership.role).toBe("owner");
    const again = await tgLogin(first.telegramUserId);
    expect(again.view.account.id).toBe(first.view.account.id);
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(first.code.code.replace("-", ""));
  });

  it("a code is single use: replay is rejected, and it must have been sent to the bot", async () => {
    const code = await tgCode("login", newTg());
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } })).status).toBe(200);
    const replay = await call<any>(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } });
    expect(replay.status).toBe(401);
    expect(errCode(replay)).toBe("CHALLENGE_INVALID");
    const unsent = await tgCode("login", newTg(), undefined, false);
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: unsent.codeId } })).status).toBe(401);
    // once the user does send it, the same code still works
    bot.userSends(newTg(), unsent.code);
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: unsent.codeId } })).status).toBe(200);
  });

  it("expires, and a guessed code text never claims someone else's code", async () => {
    const code = await tgCode("login", newTg());
    advance(h, 11 * 60);
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } })).status).toBe(401);

    const live = await tgCode("login", newTg(), undefined, false);
    bot.userSends(newTg(), "AAAA-AAAA");
    bot.userSends(newTg(), "hello bot");
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: live.codeId } })).status).toBe(401);
  });

  it("the first sender claims a code; a later sender of the same code cannot take it over", async () => {
    const owner = newTg();
    const code = await tgCode("login", owner);
    bot.userSends(newTg(), code.code); // an attacker who saw the code, too late
    const s = await call<any>(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } });
    expect(s.status).toBe(200);
    const who = await h.db.query<{ telegram_user_id: string }>("select telegram_user_id from telegram_identities where user_id=$1", [s.json.user.id]);
    expect(who[0]?.telegram_user_id).toBe(owner);
  });

  it("burns a code after too many unconfirmed tries", async () => {
    const code = await tgCode("login", newTg(), undefined, false);
    for (let i = 0; i < 30; i++) expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } })).status).toBe(401);
    bot.userSends(newTg(), code.code);
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: code.codeId } })).status).toBe(401);
  });

  it("purposes do not mix: a login code cannot link, a link code cannot log in, and a link code is bound to its session", async () => {
    const w = await login(app);
    const other = await login(app);
    const loginCode = await tgCode("login", newTg());
    expect((await call<any>(app, "POST", "/api/auth/telegram/identities", { cookie: w.cookie, body: { codeId: loginCode.codeId } })).status).toBe(401);
    const linkCode = await tgCode("link", newTg(), w.cookie);
    expect((await call(app, "POST", "/api/auth/telegram/sessions", { body: { codeId: linkCode.codeId } })).status).toBe(401);
    const code2 = await tgCode("link", newTg(), w.cookie);
    expect((await call(app, "POST", "/api/auth/telegram/identities", { cookie: other.cookie, body: { codeId: code2.codeId } })).status).toBe(401);
    expect((await call(app, "POST", "/api/auth/telegram/identities", { cookie: w.cookie, body: { codeId: code2.codeId } })).status).toBe(201);
    // link/step_up codes need a session at all
    expect((await call(app, "POST", "/api/auth/telegram/codes", { body: { purpose: "link" } })).status).toBe(401);
  });

  it("never merges accounts: linking a Telegram id owned elsewhere is 409", async () => {
    const owner = await tgLogin();
    const w = await login(app);
    const code = await tgCode("link", owner.telegramUserId, w.cookie);
    const r = await call<any>(app, "POST", "/api/auth/telegram/identities", { cookie: w.cookie, body: { codeId: code.codeId } });
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("IDENTITY_CONFLICT");
  });

  it("answers 503 when no bot is configured (real bot BLOCKED: no token)", async () => {
    const noBot = createApp({ db: h.db, config: h.config, clientKey: () => ip });
    const r = await call<any>(noBot, "POST", "/api/auth/telegram/codes", { body: { purpose: "login" } });
    expect(r.status).toBe(503);
    expect(errCode(r)).toBe("UNAVAILABLE");
  });
});

describe("step-up for non-wallet methods", () => {
  it("password session: privileged key creation is blocked when stale, allowed after a password step-up", async () => {
    const a = await signupOk();
    const create = () => call<any>(app, "POST", "/api/keys", { cookie: a.cookie, body: { name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, headers: { "Idempotency-Key": idemKey() } });
    expect((await create()).status).toBe(201);
    advance(h, 20 * 60);
    expect((await create()).json.error.code).toBe("STEP_UP_REQUIRED");
    const bad = await call<any>(app, "POST", "/api/session/step-up", { cookie: a.cookie, body: { password: "wrong wrong wrong" } });
    expect(bad.status).toBe(403);
    expect((await create()).json.error.code).toBe("STEP_UP_REQUIRED");
    expect((await call(app, "POST", "/api/session/step-up", { cookie: a.cookie, body: { password: PW } })).status).toBe(204);
    expect((await create()).status).toBe(201);
  });

  it("Telegram session steps up with a fresh step_up code from one of the user's own Telegram accounts", async () => {
    const t = await tgLogin();
    advance(h, 20 * 60);
    const blocked = await call<any>(app, "POST", "/api/keys", { cookie: t.cookie, body: { name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, headers: { "Idempotency-Key": idemKey() } });
    expect(blocked.json.error.code).toBe("STEP_UP_REQUIRED");
    // a code claimed by a stranger's Telegram account does not count
    const stranger = await tgCode("step_up", newTg(), t.cookie);
    expect((await call(app, "POST", "/api/session/step-up", { cookie: t.cookie, body: { codeId: stranger.codeId } })).status).toBe(403);
    const mine = await tgCode("step_up", t.telegramUserId, t.cookie);
    expect((await call(app, "POST", "/api/session/step-up", { cookie: t.cookie, body: { codeId: mine.codeId } })).status).toBe(204);
    // single use (same 403 as any failed step-up, so the console does not mistake it for a dead session)
    expect((await call(app, "POST", "/api/session/step-up", { cookie: t.cookie, body: { codeId: mine.codeId } })).status).toBe(403);
    const ok = await call<any>(app, "POST", "/api/keys", { cookie: t.cookie, body: { name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, headers: { "Idempotency-Key": idemKey() } });
    expect(ok.status).toBe(201);
  });

  it("step-up guesses are limited per user + IP", async () => {
    const a = await signupOk();
    for (let i = 0; i < 5; i++) expect((await call(app, "POST", "/api/session/step-up", { cookie: a.cookie, body: { password: `guess number ${i} x` } })).status).toBe(403);
    expect((await call(app, "POST", "/api/session/step-up", { cookie: a.cookie, body: { password: PW } })).status).toBe(429);
  });
});

describe("session renewal", () => {
  it("rotates the cookie token, slides expiry, stops at the absolute ceiling, and never refreshes step-up", async () => {
    const a = await signupOk();
    const before = SessionView.parse((await call(app, "GET", "/api/session", { cookie: a.cookie })).json);
    advance(h, 3600);
    const r = await call<any>(app, "POST", "/api/session/renew", { cookie: a.cookie });
    expect(r.status).toBe(200);
    const after = SessionView.parse(r.json);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
    const newCookie = cookieOf(r);
    expect(newCookie).not.toBe(a.cookie);
    expect((await call(app, "GET", "/api/session", { cookie: a.cookie })).status).toBe(401); // old token dead
    expect((await call(app, "GET", "/api/session", { cookie: newCookie })).status).toBe(200);
    advance(h, 20 * 60);
    const stale = await call<any>(app, "POST", "/api/keys", { cookie: newCookie, body: { name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, headers: { "Idempotency-Key": idemKey() } });
    expect(stale.json.error.code).toBe("STEP_UP_REQUIRED");

    // keep renewing until the 7-day ceiling from creation stops it; expiry never passes the ceiling
    const ceiling = BASE_TIME.getTime() + 7 * 86_400_000;
    let cookie = newCookie;
    let renewals = 0;
    for (; renewals < 12; renewals++) {
      advance(h, 20 * 3600);
      const rr = await call<any>(app, "POST", "/api/session/renew", { cookie });
      if (rr.status === 401) break;
      expect(rr.status).toBe(200);
      expect(Date.parse(SessionView.parse(rr.json).expiresAt)).toBeLessThanOrEqual(ceiling);
      cookie = cookieOf(rr);
    }
    expect(renewals).toBeGreaterThanOrEqual(5);
    expect(renewals).toBeLessThan(12);
    expect(h.clock.now.getTime()).toBeGreaterThan(ceiling - 24 * 3600_000);
  });

  it("an expired or revoked session cannot be renewed", async () => {
    const a = await signupOk();
    advance(h, 25 * 3600);
    expect((await call(app, "POST", "/api/session/renew", { cookie: a.cookie })).status).toBe(401);
    expect((await call(app, "POST", "/api/session/renew", {})).status).toBe(401);
  });
});

describe("API-key console session: restricted", () => {
  let owner: LoggedIn;
  let keyA: { id: string; secret: string };
  let keyB: { id: string; secret: string };
  let noUsage: { id: string; secret: string };

  beforeAll(async () => {
    ip = "203.0.113.5";
    owner = await login(app);
    await fund(h, owner.accountId, 50_000_000n);
    keyA = await createKey(h, { ...owner } as LoggedIn, { scopes: ["gateway:invoke", "usage:read"] });
    keyB = await createKey(h, owner, { scopes: ["gateway:invoke", "usage:read"] });
    noUsage = await createKey(h, owner, { scopes: ["gateway:invoke"] });
    expect((await gwPost(keyA.secret, { "X-Run-Id": "run-a" })).status).toBe(200);
    expect((await gwPost(keyA.secret)).status).toBe(200);
    expect((await gwPost(keyB.secret, { "X-Run-Id": "run-b" })).status).toBe(200);
  });
  // the gateway settles asynchronously for streams only; non-streaming settles before responding

  const open = (apiKey: string) => call<any>(app, "POST", "/api/auth/key-sessions", { body: { apiKey } });

  it("opens a short restricted session for a key with usage:read and records the kind", async () => {
    const r = await open(keyA.secret);
    expect(r.status).toBe(200);
    const view = SessionView.parse(r.json);
    expect(view.sessionKind).toBe("api_key");
    expect(view.restricted).toBe(true);
    expect(Date.parse(view.expiresAt) - h.clock.now.getTime()).toBe(3600_000);
    const row = await h.db.query<{ kind: string; method_ref: string }>("select kind, method_ref from sessions where id in (select id from sessions where method_ref=$1)", [keyA.id]);
    expect(row[0]).toMatchObject({ kind: "api_key", method_ref: keyA.id });
  });

  it("rejects unknown keys generically and keys without usage:read", async () => {
    const bad = await open("sk_notarealkey000000000000000000000000");
    expect(bad.status).toBe(401);
    expect(errCode(bad)).toBe("UNAUTHENTICATED");
    const forbidden = await open(noUsage.secret);
    expect(forbidden.status).toBe(403);
    expect(forbidden.setCookie).toEqual([]);
  });

  it("sees only its own key's usage and runs, never the account's other keys", async () => {
    const r = await open(keyA.secret);
    const cookie = cookieOf(r);
    const usage = await call<any>(app, "GET", "/api/usage", { cookie });
    expect(usage.status).toBe(200);
    expect(usage.json.items).toHaveLength(2);
    expect(new Set(usage.json.items.map((i: any) => i.keyId))).toEqual(new Set([keyA.id]));
    // asking for the other key's rows through a filter still returns nothing
    const other = await call<any>(app, "GET", `/api/usage?keyId=${keyB.id}`, { cookie });
    expect(other.json.items).toEqual([]);
    const runs = await call<any>(app, "GET", "/api/usage/agent-runs", { cookie });
    expect(runs.status).toBe(200);
    expect(runs.json.items.map((i: any) => i.runId).sort()).toEqual([null, "run-a"]);
    // the owner's full session sees all three
    expect((await call<any>(app, "GET", "/api/usage", { cookie: owner.cookie })).json.items).toHaveLength(3);
  });

  it("is denied everything outside the key's data scope by the central check", async () => {
    const cookie = cookieOf(await open(keyA.secret));
    const denied: [string, string, unknown?][] = [
      ["GET", "/api/keys"],
      ["POST", "/api/keys", { name: "x", scopes: ["gateway:invoke", "usage:read"], modelAllowlist: [] }],
      ["DELETE", `/api/keys/${keyB.id}`],
      ["GET", "/api/identities"],
      ["POST", "/api/identities", { challengeId: "chl_x", signature: "0x00" }],
      ["DELETE", "/api/identities/idn_x"],
      ["GET", "/api/auth/methods"],
      ["POST", "/api/auth/password", { username: "evil.user", password: PW }],
      ["DELETE", "/api/auth/password"],
      ["POST", "/api/auth/recovery-codes"],
      ["POST", "/api/auth/telegram/codes", { purpose: "link" }],
      ["POST", "/api/auth/telegram/identities", { codeId: "tgc_x" }],
      ["DELETE", "/api/auth/telegram/identities/tgi_x"],
      ["POST", "/api/session/step-up", { password: PW }],
      ["POST", "/api/auth/wallet/challenges", { protocol: "evm", address: "0x0000000000000000000000000000000000000001", chainId: "1", purpose: "link" }],
      ["GET", "/api/accounts/current/balance"],
      ["GET", "/api/ledger"],
      ["GET", "/api/deposits"],
      ["POST", "/api/deposits", { network: "x" }],
      ["POST", "/api/exports", { kind: "usage", filters: {}, format: "csv" }],
      ["GET", "/api/jobs/job_x"],
      ["GET", "/api/jobs/job_x/download"],
    ];
    for (const [method, path, body] of denied) {
      const r = await call<any>(app, method, path, { cookie, ...(body !== undefined ? { body } : {}), headers: { "Idempotency-Key": idemKey() } });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(errCode(r), `${method} ${path}`).toMatch(/FORBIDDEN|STEP_UP_REQUIRED/);
    }
    // allowed
    expect((await call(app, "GET", "/api/session", { cookie })).status).toBe(200);
  });

  it("cannot be used to mint a privileged key even though the creator is the owner", async () => {
    const cookie = cookieOf(await open(keyA.secret));
    const before = (await h.db.query("select 1 from api_keys where account_id=$1", [owner.accountId])).length;
    const r = await call(app, "POST", "/api/keys", { cookie, body: { name: "escalate", scopes: ["gateway:invoke"], modelAllowlist: [] }, headers: { "Idempotency-Key": idemKey() } });
    expect(r.status).toBe(403);
    expect((await h.db.query("select 1 from api_keys where account_id=$1", [owner.accountId])).length).toBe(before);
  });

  it("ends when the key is revoked or expires, and is renewable only up to its own ceiling", async () => {
    const k = await createKey(h, owner, { scopes: ["usage:read"] });
    const r = await open(k.secret);
    const cookie = cookieOf(r);
    expect((await call(app, "GET", "/api/usage", { cookie })).status).toBe(200);
    // renew keeps it restricted and short
    const renewed = await call<any>(app, "POST", "/api/session/renew", { cookie });
    expect(renewed.status).toBe(200);
    expect(SessionView.parse(renewed.json).restricted).toBe(true);
    const cookie2 = cookieOf(renewed);
    expect((await call(app, "DELETE", `/api/keys/${k.id}`, { cookie: owner.cookie })).status).toBe(204);
    expect((await call(app, "GET", "/api/usage", { cookie: cookie2 })).status).toBe(401);
    expect((await open(k.secret)).status).toBe(401);

    const k2 = await createKey(h, owner, { scopes: ["usage:read"] });
    let c2 = cookieOf(await open(k2.secret));
    const ceiling = h.clock.now.getTime() + 8 * 3600_000;
    let n = 0;
    for (; n < 20; n++) {
      advance(h, 50 * 60);
      const rr = await call<any>(app, "POST", "/api/session/renew", { cookie: c2 });
      if (rr.status === 401) break;
      expect(Date.parse(SessionView.parse(rr.json).expiresAt)).toBeLessThanOrEqual(ceiling);
      c2 = cookieOf(rr);
    }
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThan(20);
    expect(h.clock.now.getTime()).toBeGreaterThan(ceiling - 3600_000);
  });

  it("key sign-in attempts are limited per IP", async () => {
    ip = "203.0.113.99";
    for (let i = 0; i < 5; i++) expect((await open(`sk_guess${i}000000000000000000000000000`)).status).toBe(401);
    expect((await open(`sk_guess${5}000000000000000000000000000`)).status).toBe(429);
  });

  it("logout revokes the restricted session", async () => {
    const cookie = cookieOf(await open(keyA.secret));
    expect((await call(app, "DELETE", "/api/session", { cookie })).status).toBe(204);
    expect((await call(app, "GET", "/api/session", { cookie })).status).toBe(401);
  });
});
