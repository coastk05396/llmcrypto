import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorEnvelope, SessionView, WalletChallenge } from "@llmcrypto/contracts";
import { migrate, openPglite } from "../../apps/api/src/db";
import { buildEvmMessage, verifyEvmSignature } from "../../apps/api/src/auth/evm";
import { BASE_TIME, ORIGIN, advance, call, challenge, cookieOf, dumpDatabase, login, makeHarness, newEvmWallet, sign, type Harness } from "./helpers";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

describe("EVM sign-in", () => {
  it("creates an account for a new wallet and returns a contract-valid session with a hardened cookie", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    expect(ch.status).toBe(201);
    expect(WalletChallenge.parse(ch.json).expiresAt).toBe("2026-10-18T12:05:00.000Z");
    expect(ch.json.message).toContain("app.example.test wants you to sign in with your Ethereum account");
    expect(ch.json.message).toContain(`URI: ${ORIGIN}`);
    expect(ch.json.message).toContain("Chain ID: 1");
    const res = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature: await sign(w, ch.json.message) } });
    expect(res.status).toBe(200);
    const view = SessionView.parse(res.json);
    expect(view.membership.role).toBe("owner");
    const sc = res.setCookie.find((c) => c.startsWith("session="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\//);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const me = await call(h.app, "GET", "/api/session", { cookie: cookieOf(res) });
    expect(me.status).toBe(200);
    expect(SessionView.parse(me.json).user.id).toBe(view.user.id);
  });

  it("signing in again with the same wallet reuses the account", async () => {
    const w = newEvmWallet();
    const a = await login(h.app, w);
    const b = await login(h.app, w);
    expect(b.accountId).toBe(a.accountId);
    expect(b.userId).toBe(a.userId);
    const rows = await h.db.query<{ n: string }>("select count(*)::text n from accounts where id=$1", [a.accountId]);
    expect(rows[0]?.n).toBe("1");
  });

  it("rejects replay of a consumed challenge", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const body = { challengeId: ch.json.challengeId, signature: await sign(w, ch.json.message) };
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body })).status).toBe(200);
    const replay = await call(h.app, "POST", "/api/auth/wallet/sessions", { body });
    expect(replay.status).toBe(401);
    expect(ErrorEnvelope.parse(replay.json).error.code).toBe("CHALLENGE_INVALID");
  });

  it("lets exactly one of many concurrent attempts consume a challenge", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const body = { challengeId: ch.json.challengeId, signature: await sign(w, ch.json.message) };
    const results = await Promise.all(Array.from({ length: 6 }, () => call(h.app, "POST", "/api/auth/wallet/sessions", { body })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    const rows = await h.db.query<{ n: string }>("select count(*)::text n from linked_identities where address=$1", [w.address]);
    expect(rows[0]?.n).toBe("1");
  });

  it("rejects a signature from a different key and burns the challenge", async () => {
    const w = newEvmWallet();
    const attacker = newEvmWallet();
    const ch = await challenge(h.app, w);
    const bad = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature: await sign(attacker, ch.json.message) } });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("CHALLENGE_INVALID");
    const retry = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature: await sign(w, ch.json.message) } });
    expect(retry.status).toBe(401);
  });

  it("rejects a valid signature over a different message and malformed signatures", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const other = await w.account.signMessage({ message: ch.json.message + " " });
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature: other } })).status).toBe(401);
    const ch2 = await challenge(h.app, w);
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch2.json.challengeId, signature: "0x1234" } })).status).toBe(401);
  });

  it("rejects an expired challenge (5-minute lifetime)", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const signature = await sign(w, ch.json.message);
    advance(h, 301);
    const res = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature } });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("CHALLENGE_INVALID");
  });

  it("still accepts just inside the lifetime", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const signature = await sign(w, ch.json.message);
    advance(h, 299);
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature } })).status).toBe(200);
  });

  it("rejects a disallowed chain and bad addresses at challenge time", async () => {
    const w = newEvmWallet("10");
    const res = await challenge(h.app, w);
    expect(res.status).toBe(422);
    expect(res.json.error.fieldErrors[0].field).toBe("chainId");
    const bad = await call(h.app, "POST", "/api/auth/wallet/challenges", { body: { protocol: "evm", address: "0x123", chainId: "1" } });
    expect(bad.status).toBe(422);
    const badChecksum = await call(h.app, "POST", "/api/auth/wallet/challenges", { body: { protocol: "evm", address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B".replace("A", "a"), chainId: "1" } });
    expect(badChecksum.status).toBe(422);
    expect((await call(h.app, "POST", "/api/auth/wallet/challenges", { body: { protocol: "btc", address: "x", chainId: "1" } })).status).toBe(422);
  });

  it("rejects a challenge verified under a different configured domain, URI or chain list", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const signature = await sign(w, ch.json.message);
    const otherDomain = h.appWith({ authDomain: "evil.example.test" });
    expect((await call(otherDomain, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature } })).status).toBe(401);

    const ch2 = await challenge(h.app, w);
    const sig2 = await sign(w, ch2.json.message);
    const otherChains = h.appWith({ evmChainIds: ["8453"] });
    expect((await call(otherChains, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch2.json.challengeId, signature: sig2 } })).status).toBe(401);
  });

  it("verifier rejects wrong domain, URI, nonce, address, chain, and expiry directly", async () => {
    const w = newEvmWallet();
    const now = new Date(BASE_TIME);
    const expires = new Date(now.getTime() + 300_000);
    const mk = (over: Partial<Parameters<typeof buildEvmMessage>[0]> = {}) =>
      buildEvmMessage({ address: w.address, chainId: "1", domain: "app.example.test", uri: ORIGIN, nonce: "abcdef0123456789", issuedAt: now, expiresAt: expires, purpose: "login", ...over });
    const expect_ = { domain: "app.example.test", uri: ORIGIN, nonce: "abcdef0123456789", address: w.address, chainId: "1", allowedChainIds: ["1"], now };
    const run = async (message: string, x = expect_) => verifyEvmSignature(message, await w.account.signMessage({ message }), x);

    expect(await run(mk())).toEqual({ ok: true });
    expect(await run(mk({ domain: "evil.test" }))).toEqual({ ok: false, reason: "domain mismatch" });
    expect(await run(mk({ uri: "https://evil.test" }))).toEqual({ ok: false, reason: "uri mismatch" });
    expect(await run(mk({ nonce: "ffffffffffffffff" }))).toEqual({ ok: false, reason: "nonce mismatch" });
    expect(await run(mk({ chainId: "8453" }))).toEqual({ ok: false, reason: "chain not allowed" });
    expect(await run(mk(), { ...expect_, address: newEvmWallet().address })).toEqual({ ok: false, reason: "address mismatch" });
    expect(await run(mk(), { ...expect_, now: new Date(expires.getTime() + 1) })).toEqual({ ok: false, reason: "expired" });
    expect(await run(mk({ issuedAt: new Date(now.getTime() + 3_600_000) }))).toEqual({ ok: false, reason: "issued in the future" });
  });

  it("login challenges cannot create a session via the link route and vice versa", async () => {
    const w = newEvmWallet();
    const me = await login(h.app);
    const lc = await challenge(h.app, w, { cookie: me.cookie, purpose: "link" });
    expect(lc.status).toBe(201);
    const wrong = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: lc.json.challengeId, signature: await sign(w, lc.json.message) } });
    expect(wrong.status).toBe(401);
  });
});

describe("sessions", () => {
  it("logout revokes the session server-side", async () => {
    const s = await login(h.app);
    const out = await call(h.app, "DELETE", "/api/session", { cookie: s.cookie });
    expect(out.status).toBe(204);
    expect(out.setCookie.join(";")).toMatch(/session=;|Max-Age=0/i);
    const again = await call(h.app, "GET", "/api/session", { cookie: s.cookie });
    expect(again.status).toBe(401);
    expect(ErrorEnvelope.parse(again.json).error.code).toBe("UNAUTHENTICATED");
  });

  it("expires after the session lifetime", async () => {
    const s = await login(h.app);
    advance(h, 86_400 + 1);
    expect((await call(h.app, "GET", "/api/session", { cookie: s.cookie })).status).toBe(401);
  });

  it("rejects missing, garbage and forged cookies", async () => {
    expect((await call(h.app, "GET", "/api/session")).status).toBe(401);
    expect((await call(h.app, "GET", "/api/session", { cookie: "session=nope" })).status).toBe(401);
  });

  it("stores only a digest of the session token", async () => {
    const s = await login(h.app);
    const token = s.cookie.slice("session=".length);
    expect(await dumpDatabase(h.db)).not.toContain(token);
  });

  it("returns zero balances in the contract shape until a ledger exists", async () => {
    const s = await login(h.app);
    const r = await call(h.app, "GET", "/api/accounts/current/balance", { cookie: s.cookie });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ availableMicrousd: "0", heldMicrousd: "0", postedMicrousd: "0", asOf: BASE_TIME.toISOString() });
    expect((await call(h.app, "GET", "/api/accounts/current/balance")).status).toBe(401);
  });
});

describe("CSRF / origin checks, errors and limits", () => {
  it("rejects mutating requests without an allowed Origin, even with a valid session", async () => {
    const s = await login(h.app);
    for (const origin of [null, "https://evil.example.test", "http://app.example.test"]) {
      const r = await call(h.app, "DELETE", "/api/session", { cookie: s.cookie, origin });
      expect(r.status).toBe(403);
      expect(ErrorEnvelope.parse(r.json).error.code).toBe("FORBIDDEN");
    }
    expect((await call(h.app, "GET", "/api/session", { cookie: s.cookie })).status).toBe(200); // still alive
    const pub = await call(h.app, "POST", "/api/auth/wallet/challenges", { origin: "https://evil.example.test", body: { protocol: "evm", address: newEvmWallet().address, chainId: "1" } });
    expect(pub.status).toBe(403);
    const crossSite = await call(h.app, "DELETE", "/api/session", { cookie: s.cookie, headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
  });

  it("returns envelope errors with a request id; malformed JSON is 400, bad fields 422", async () => {
    const bad = await call(h.app, "POST", "/api/auth/wallet/challenges", { rawBody: "{nope" });
    expect(bad.status).toBe(400);
    const env = ErrorEnvelope.parse(bad.json);
    expect(env.error.code).toBe("BAD_REQUEST");
    expect(bad.headers.get("x-request-id")).toBe(env.error.requestId);
    const inval = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: 5 } });
    expect(inval.status).toBe(422);
    expect(ErrorEnvelope.parse(inval.json).error.fieldErrors?.length).toBeGreaterThan(0);
    const nf = await call(h.app, "GET", "/api/nope");
    expect(nf.status).toBe(404);
    expect(ErrorEnvelope.parse(nf.json).error.code).toBe("NOT_FOUND");
  });

  it("rate limits challenge creation with Retry-After (in-memory stub)", async () => {
    const lim = await makeHarness({ rateLimits: { challenge: { limit: 2, windowSeconds: 60 }, session: { limit: 100, windowSeconds: 60 }, keys: { limit: 100, windowSeconds: 60 } } });
    const w = newEvmWallet();
    expect((await challenge(lim.app, w)).status).toBe(201);
    expect((await challenge(lim.app, w)).status).toBe(201);
    const third = await challenge(lim.app, w);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(ErrorEnvelope.parse(third.json).error.code).toBe("RATE_LIMITED");
    advance(lim, 61);
    expect((await challenge(lim.app, w)).status).toBe(201);
    await lim.db.close();
  });

  it("fails closed with 503 when the session secret is missing", async () => {
    const nokey = await makeHarness({ sessionSecret: undefined });
    const r = await challenge(nokey.app, newEvmWallet());
    expect(r.status).toBe(503);
    expect(ErrorEnvelope.parse(r.json).error.code).toBe("UNAVAILABLE");
    await nokey.db.close();
  });
});

describe("migrations and audit log", () => {
  it("applies SQL files in order once, records them, and is idempotent", async () => {
    const db = await openPglite();
    const first = await migrate(db, h.config.migrationsDir);
    expect(first.applied).toEqual(["001_identity.sql", "002_keys.sql", "003_ledger.sql", "004_deposits.sql", "005_auth_methods.sql", "006_jobs_and_responses.sql", "007_optimization.sql", "008_project_memory.sql", "009_connectivity.sql", "010_repository_graph.sql", "011_design_beta.sql", "012_operator.sql", "013_request_finish.sql", "014_auth_issuance.sql", "015_security_hardening.sql"]);
    const second = await migrate(db, h.config.migrationsDir);
    expect(second).toEqual({ applied: [], skipped: ["001_identity.sql", "002_keys.sql", "003_ledger.sql", "004_deposits.sql", "005_auth_methods.sql", "006_jobs_and_responses.sql", "007_optimization.sql", "008_project_memory.sql", "009_connectivity.sql", "010_repository_graph.sql", "011_design_beta.sql", "012_operator.sql", "013_request_finish.sql", "014_auth_issuance.sql", "015_security_hardening.sql"] });
    const rows = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(["001_identity.sql", "002_keys.sql", "003_ledger.sql", "004_deposits.sql", "005_auth_methods.sql", "006_jobs_and_responses.sql", "007_optimization.sql", "008_project_memory.sql", "009_connectivity.sql", "010_repository_graph.sql", "011_design_beta.sql", "012_operator.sql", "013_request_finish.sql", "014_auth_issuance.sql", "015_security_hardening.sql"]);
    await db.close();
  });

  it("refuses a migration file edited after it was applied and rolls back failed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_a.sql"), "create table a (id int);");
    const db = await openPglite();
    await migrate(db, dir);
    writeFileSync(join(dir, "001_a.sql"), "create table a (id int, extra int);");
    await expect(migrate(db, dir)).rejects.toThrow(/changed after being applied/);
    writeFileSync(join(dir, "001_a.sql"), readFileSync(join(dir, "001_a.sql"), "utf8").replace(", extra int", ""));
    writeFileSync(join(dir, "002_bad.sql"), "create table b (id int); select * from does_not_exist;");
    await expect(migrate(db, dir)).rejects.toThrow();
    expect(await db.query("select to_regclass('public.b') as t")).toEqual([{ t: null }]);
    await db.close();
  });

  it("records audit events and makes them append-only", async () => {
    const s = await login(h.app);
    const ev = await h.db.query<{ id: string; action: string }>("select id, action from audit_events where account_id=$1 order by created_at", [s.accountId]);
    expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(["account.created", "identity.linked", "session.created"]));
    await expect(h.db.query("update audit_events set action='x' where id=$1", [ev[0]!.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query("delete from audit_events where id=$1", [ev[0]!.id])).rejects.toThrow(/append-only/);
  });
});
