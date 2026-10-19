/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogResponse, CreateKeyResponse, ErrorEnvelope, KeyList } from "@llmcrypto/contracts";
import { hmacHex, canonicalJson, sha256Hex } from "../../apps/api/src/crypto";
import { beginIdempotent, scrubExpiredReplaySecrets } from "../../apps/api/src/idempotency";
import { BASE_TIME, advance, call, dumpDatabase, login, makeHarness, seedMember, type Harness } from "./helpers";

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

let n = 0;
const idem = () => `idem-key-${Date.now()}-${++n}`;
const body = (over: Record<string, unknown> = {}) => ({ name: "ci", scopes: ["gateway:invoke"], modelAllowlist: ["sample-fast-1"], ...over });
const create = (s: { cookie: string }, b: unknown = body(), key: string | null = idem(), extra: Record<string, string> = {}) =>
  call(h.app, "POST", "/api/keys", { cookie: s.cookie, body: b, headers: { ...(key ? { "Idempotency-Key": key } : {}), ...extra } });

describe("catalog, models and public reads", () => {
  it("serves a labelled sample catalog with updatedAt and filters", async () => {
    const r = await call(h.app, "GET", "/api/catalog");
    expect(r.status).toBe(200);
    const cat = CatalogResponse.parse(r.json);
    expect(cat.items.length).toBeGreaterThanOrEqual(5);
    expect(cat.items.every((i) => i.source === "sample-seed" && i.displayName.includes("(fake)") && i.updatedAt)).toBe(true);
    expect(cat.pricingVersion).toContain("sample");
    const f = CatalogResponse.parse((await call(h.app, "GET", "/api/catalog?provider=sample-provider-a")).json);
    expect(f.items.map((i) => i.provider)).toEqual(["sample-provider-a", "sample-provider-a"]);
    expect(CatalogResponse.parse((await call(h.app, "GET", "/api/catalog?search=REASONER")).json).items).toHaveLength(1);
    expect((await call(h.app, "GET", "/api/catalog?search=")).status).toBe(422);
  });

  it("serves OpenAI-style GET /v1/models publicly", async () => {
    const r = await call(h.app, "GET", "/v1/models");
    expect(r.status).toBe(200);
    expect(r.json.object).toBe("list");
    expect(r.json.data[0]).toEqual(expect.objectContaining({ object: "model", id: expect.any(String), created: expect.any(Number), owned_by: expect.any(String) }));
  });
});

describe("key creation", () => {
  it("mints a key: contract-valid, secret shown once, only a keyed digest stored", async () => {
    const s = await login(h.app);
    const r = await create(s, body({ spendCapMicrousd: "5000000", expiresAt: "2027-01-01T00:00:00Z" }));
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const parsed = CreateKeyResponse.parse(r.json);
    if (parsed.secretStatus !== "PROVIDED") throw new Error("expected secret");
    expect(parsed.secret).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(parsed.key.prefix).toBe(parsed.secret.slice(0, 8));
    expect(parsed.key).toMatchObject({ spendCapMicrousd: "5000000", expiresAt: "2027-01-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null, projectId: null });

    const [row] = await h.db.query<{ key_hash: string }>("select key_hash from api_keys where id=$1", [parsed.key.id]);
    expect(row!.key_hash).toBe(hmacHex(h.secrets.API_KEY_HASH_PEPPER, parsed.secret));
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(parsed.secret);
    expect(dump).not.toContain(parsed.secret.slice(3)); // not even the random body
    // the sealed replay blob does not contain the secret either
    const [idemRow] = await h.db.query<{ replay_ciphertext: string }>("select replay_ciphertext from idempotency_keys where account_id=$1", [s.accountId]);
    expect(idemRow!.replay_ciphertext).toMatch(/^v1\./);

    const list = KeyList.parse((await call(h.app, "GET", "/api/keys", { cookie: s.cookie })).json);
    expect(list.items.map((k) => k.id)).toEqual([parsed.key.id]);
    expect(JSON.stringify(list)).not.toContain(parsed.secret);
    expect(JSON.stringify(list)).not.toContain("key_hash");
  });

  it("requires authentication, an allowed Origin, and the Idempotency-Key header", async () => {
    const s = await login(h.app);
    expect((await call(h.app, "POST", "/api/keys", { body: body(), headers: { "Idempotency-Key": idem() } })).status).toBe(401);
    expect((await call(h.app, "POST", "/api/keys", { cookie: s.cookie, body: body(), origin: null, headers: { "Idempotency-Key": idem() } })).status).toBe(403);
    const missing = await create(s, body(), null);
    expect(missing.status).toBe(400);
    expect(ErrorEnvelope.parse(missing.json).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await create(s, body(), "short")).status).toBe(400);
    expect((await create(s, body(), "has space in key")).status).toBe(400);
    expect((await h.db.query("select 1 from api_keys where account_id=$1", [s.accountId])).length).toBe(0);
  });

  it("validates scopes, models, project, spend cap and expiry (422 with field errors)", async () => {
    const s = await login(h.app);
    const other = await login(h.app);
    await h.db.query("insert into projects (id, account_id, name, created_at) values ('prj_other',$1,'x',$2)", [other.accountId, BASE_TIME]);
    await h.db.query("insert into projects (id, account_id, name, created_at) values ('prj_mine',$1,'x',$2)", [s.accountId, BASE_TIME]);
    const cases: [Record<string, unknown>, string][] = [
      [{ scopes: [] }, "scopes"],
      [{ scopes: ["admin:everything"] }, "scopes.0"],
      [{ modelAllowlist: ["gpt-real"] }, "modelAllowlist[0]"],
      [{ spendCapMicrousd: "0" }, "spendCapMicrousd"],
      [{ spendCapMicrousd: "1.5" }, "spendCapMicrousd"],
      [{ expiresAt: "2026-10-18T11:00:00Z" }, "expiresAt"],
      [{ projectId: "prj_other" }, "projectId"],
      [{ projectId: "prj_missing" }, "projectId"],
      [{ name: "" }, "name"],
    ];
    for (const [over, field] of cases) {
      const r = await create(s, body(over));
      expect(r.status, JSON.stringify(over)).toBe(422);
      expect(ErrorEnvelope.parse(r.json).error.fieldErrors?.map((f) => f.field)).toContain(field);
    }
    expect((await create(s, body({ projectId: "prj_mine" }))).status).toBe(201);
    // failed validation must not poison the idempotency key
    const key = idem();
    expect((await create(s, body({ spendCapMicrousd: "0" }), key)).status).toBe(422);
    expect((await create(s, body({ spendCapMicrousd: "10" }), key)).status).toBe(201);
  });

  it("requires a recent sign-in (step-up)", async () => {
    const s = await login(h.app);
    advance(h, 901);
    const r = await create(s);
    expect(r.status).toBe(403);
    expect(ErrorEnvelope.parse(r.json).error.code).toBe("STEP_UP_REQUIRED");
  });

  it("fails closed when the replay-encryption secret or pepper is missing: no key minted", async () => {
    for (const missing of ["keyReplaySecret", "apiKeyPepper"] as const) {
      const hh = await makeHarness({ [missing]: undefined });
      const s = await login(hh.app);
      const r = await call(hh.app, "POST", "/api/keys", { cookie: s.cookie, body: body(), headers: { "Idempotency-Key": idem() } });
      expect(r.status, missing).toBe(503);
      expect(ErrorEnvelope.parse(r.json).error.code).toBe("UNAVAILABLE");
      expect(await hh.db.query("select 1 from api_keys")).toHaveLength(0);
      expect(await hh.db.query("select 1 from idempotency_keys")).toHaveLength(0);
      await hh.db.close();
    }
  });
});

describe("idempotency", () => {
  it("replays the same secret to the same session inside the window, without minting a second key", async () => {
    const s = await login(h.app);
    const key = idem();
    const first: any = (await create(s, body(), key)).json;
    advance(h, 120);
    const again = await create(s, body(), key);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(again.json.secretStatus).toBe("PROVIDED");
    expect(again.json.secret).toBe(first.secret);
    expect(again.json.key.id).toBe(first.key.id);
    expect(await h.db.query("select 1 from api_keys where account_id=$1", [s.accountId])).toHaveLength(1);
  });

  it("returns NON_RECOVERABLE after the window and never mints a second key", async () => {
    const s = await login(h.app);
    const key = idem();
    const first: any = (await create(s, body(), key)).json;
    advance(h, 301);
    const late = await create(s, body(), key);
    const parsed = CreateKeyResponse.parse(late.json);
    expect(parsed.secretStatus).toBe("NON_RECOVERABLE");
    expect(parsed.secret).toBeNull();
    expect(parsed.key.id).toBe(first.key.id);
    expect(JSON.stringify(late.json)).not.toContain(first.secret);
    expect(await h.db.query("select 1 from api_keys where account_id=$1", [s.accountId])).toHaveLength(1);
    // expired ciphertext is scrubbed once observed
    const [r] = await h.db.query<{ replay_ciphertext: string | null }>("select replay_ciphertext from idempotency_keys where account_id=$1 and key=$2", [s.accountId, key]);
    expect(r!.replay_ciphertext).toBeNull();
  });

  it("scrubs sealed secrets in bulk after the window", async () => {
    const s = await login(h.app);
    await create(s);
    advance(h, 301);
    expect(await scrubExpiredReplaySecrets(h.db, h.clock.now)).toBeGreaterThanOrEqual(1);
    expect(await scrubExpiredReplaySecrets(h.db, h.clock.now)).toBe(0);
  });

  it("does not reveal the secret to a different session of the same account", async () => {
    const owner = await login(h.app);
    const admin = await seedMember(h, owner.accountId, "admin");
    const key = idem();
    const first: any = (await create(owner, body(), key)).json;
    // idempotency scope is the account, so the admin session sees the same record but never the secret
    const other = await create(admin, body(), key);
    expect(other.status).toBe(201);
    expect(other.json.secretStatus).toBe("NON_RECOVERABLE");
    expect(JSON.stringify(other.json)).not.toContain(first.secret);
    // the original session can still replay inside the window
    expect((await create(owner, body(), key)).json.secretStatus).toBe("PROVIDED");
  });

  it("rejects a changed payload under the same key (409 IDEMPOTENCY_CONFLICT)", async () => {
    const s = await login(h.app);
    const key = idem();
    expect((await create(s, body(), key)).status).toBe(201);
    const r = await create(s, body({ name: "different" }), key);
    expect(r.status).toBe(409);
    expect(ErrorEnvelope.parse(r.json).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await h.db.query("select 1 from api_keys where account_id=$1", [s.accountId])).toHaveLength(1);
  });

  it("treats key order and defaulted fields as the same payload", async () => {
    const s = await login(h.app);
    const key = idem();
    await create(s, { name: "ci", scopes: ["gateway:invoke"], modelAllowlist: [] }, key);
    const r = await create(s, { modelAllowlist: [], scopes: ["gateway:invoke"], name: "ci" }, key);
    expect(r.status).toBe(201);
    expect(r.headers.get("idempotent-replay")).toBe("true");
  });

  it("returns 409 IN_PROGRESS while an identical request is in flight, and re-executes a stale one", async () => {
    const s = await login(h.app);
    const key = idem();
    const b = body();
    const hash = sha256Hex(canonicalJson(b));
    const scope = { accountId: s.accountId, operation: "createKey", key };
    expect((await beginIdempotent(h.db, scope, hash, h.clock.now, 120)).action).toBe("execute");
    const busy = await create(s, b, key);
    expect(busy.status).toBe(409);
    expect(ErrorEnvelope.parse(busy.json).error.code).toBe("IN_PROGRESS");
    const changed = await create(s, body({ name: "x" }), key);
    expect(ErrorEnvelope.parse(changed.json).error.code).toBe("IDEMPOTENCY_CONFLICT");
    advance(h, 121); // crashed attempt: nothing committed, safe to take over
    const retry = await create(s, b, key);
    expect(retry.status).toBe(201);
    expect(await h.db.query("select 1 from api_keys where account_id=$1", [s.accountId])).toHaveLength(1);
  });

  it("concurrent identical requests produce exactly one key", async () => {
    const s = await login(h.app);
    const key = idem();
    const rs = await Promise.all(Array.from({ length: 5 }, () => create(s, body(), key)));
    expect(rs.map((r) => r.status).every((st) => st === 201 || st === 409)).toBe(true);
    expect(rs.some((r) => r.status === 201)).toBe(true);
    expect(await h.db.query("select 1 from api_keys where account_id=$1", [s.accountId])).toHaveLength(1);
  });

  it("scopes keys by account: the same Idempotency-Key in another account is independent", async () => {
    const a = await login(h.app);
    const b = await login(h.app);
    const key = idem();
    const ra: any = (await create(a, body(), key)).json;
    const rb: any = (await create(b, body(), key)).json;
    expect(ra.key.id).not.toBe(rb.key.id);
    expect(rb.secretStatus).toBe("PROVIDED");
  });
});

describe("authorization and isolation", () => {
  it("only owner and admin manage keys; billing and member get 403 everywhere", async () => {
    const owner = await login(h.app);
    const created: any = (await create(owner)).json;
    for (const role of ["billing", "member"] as const) {
      const m = await seedMember(h, owner.accountId, role);
      expect((await create(m)).status, role).toBe(403);
      expect((await call(h.app, "GET", "/api/keys", { cookie: m.cookie })).status, role).toBe(403);
      expect((await call(h.app, "DELETE", `/api/keys/${created.key.id}`, { cookie: m.cookie })).status, role).toBe(403);
    }
    const admin = await seedMember(h, owner.accountId, "admin");
    expect((await create(admin)).status).toBe(201);
    expect((await call(h.app, "GET", "/api/keys", { cookie: admin.cookie })).status).toBe(200);
    expect((await call(h.app, "DELETE", `/api/keys/${created.key.id}`, { cookie: admin.cookie })).status).toBe(204);
  });

  it("cross-account access is 404 and leaks nothing", async () => {
    const a = await login(h.app);
    const b = await login(h.app);
    const ka: any = (await create(a)).json;
    expect((await call(h.app, "DELETE", `/api/keys/${ka.key.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await call(h.app, "DELETE", "/api/keys/key_unknown", { cookie: b.cookie })).status).toBe(404);
    expect(KeyList.parse((await call(h.app, "GET", "/api/keys", { cookie: b.cookie })).json).items).toEqual([]);
    const [row] = await h.db.query("select revoked_at from api_keys where id=$1", [ka.key.id]);
    expect((row as any).revoked_at).toBeNull();
  });

  it("paginates with stable cursors and bounds the limit", async () => {
    const s = await login(h.app);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      advance(h, 1);
      ids.push(((await create(s, body({ name: `k${i}` }))).json as any).key.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await call(h.app, "GET", `/api/keys?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { cookie: s.cookie });
      const page = KeyList.parse(r.json);
      seen.push(...page.items.map((k) => k.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
    expect((await call(h.app, "GET", "/api/keys?limit=201", { cookie: s.cookie })).status).toBe(422);
    expect((await call(h.app, "GET", "/api/keys?cursor=%%%", { cookie: s.cookie })).status).toBeGreaterThanOrEqual(400);
    expect((await call(h.app, "GET", "/api/keys?cursor=bm9wZQ", { cookie: s.cookie })).status).toBe(400);
  });
});

describe("revocation, expiry and last use", () => {
  const models = (secret: string) => call(h.app, "GET", "/v1/models", { headers: { Authorization: `Bearer ${secret}` } });

  it("a live key authenticates, records last use and narrows models; revoking rejects it", async () => {
    const s = await login(h.app);
    const created: any = (await create(s, body({ modelAllowlist: ["sample-fast-1"] }))).json;
    const ok = await models(created.secret);
    expect(ok.status).toBe(200);
    expect(ok.json.data.map((m: any) => m.id)).toEqual(["sample-fast-1"]);
    const used = await h.db.query<{ last_used_at: Date }>("select last_used_at from api_keys where id=$1", [created.key.id]);
    expect(used[0]?.last_used_at.toISOString()).toBe(BASE_TIME.toISOString());
    const listed = KeyList.parse((await call(h.app, "GET", "/api/keys", { cookie: s.cookie })).json);
    expect(listed.items[0]!.lastUsedAt).toBe(BASE_TIME.toISOString());

    advance(h, 5);
    expect((await call(h.app, "DELETE", `/api/keys/${created.key.id}`, { cookie: s.cookie })).status).toBe(204);
    const dead = await models(created.secret);
    expect(dead.status).toBe(401);
    expect(dead.json.error).toEqual(expect.objectContaining({ type: "authentication_error", code: "invalid_api_key" }));
    // idempotent revoke
    expect((await call(h.app, "DELETE", `/api/keys/${created.key.id}`, { cookie: s.cookie })).status).toBe(204);
    const listed2 = KeyList.parse((await call(h.app, "GET", "/api/keys", { cookie: s.cookie })).json);
    expect(listed2.items[0]!.revokedAt).not.toBeNull();
  });

  it("rejects unknown, malformed, expired and wrong-scope keys", async () => {
    const s = await login(h.app);
    expect((await models("sk_" + "A".repeat(43))).status).toBe(401);
    expect((await call(h.app, "GET", "/v1/models", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    const exp: any = (await create(s, body({ expiresAt: "2026-10-18T12:10:00Z" }))).json;
    expect((await models(exp.secret)).status).toBe(200);
    advance(h, 601);
    expect((await models(exp.secret)).status).toBe(401);
    advance(h, -601);
    const usage: any = (await create(s, body({ scopes: ["usage:read"] }))).json;
    expect((await models(usage.secret)).status).toBe(403);
  });

  it("a revoked key's secret is no longer replayable inside the window", async () => {
    const s = await login(h.app);
    const key = idem();
    const created: any = (await create(s, body(), key)).json;
    await call(h.app, "DELETE", `/api/keys/${created.key.id}`, { cookie: s.cookie });
    const replay = await create(s, body(), key);
    expect(replay.json.secretStatus).toBe("NON_RECOVERABLE");
    expect(replay.json.key.revokedAt).not.toBeNull();
  });

  it("audits creation, replay and revocation without secrets", async () => {
    const s = await login(h.app);
    const key = idem();
    const created: any = (await create(s, body(), key)).json;
    await create(s, body(), key);
    await call(h.app, "DELETE", `/api/keys/${created.key.id}`, { cookie: s.cookie });
    const ev = await h.db.query<{ action: string }>("select action from audit_events where account_id=$1 and target_id=$2 order by created_at, id", [s.accountId, created.key.id]);
    expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(["key.created", "key.secret_replayed", "key.revoked"]));
    const all = JSON.stringify(await h.db.query("select * from audit_events"));
    expect(all).not.toContain(created.secret);
  });
});
