/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_OPTIMIZATION_CONFIG, OptimizationEvidenceList, OptimizationPolicy, OptimizationReport, PreviewOptimizationResponse } from "@llmcrypto/contracts";
import { accountBalance, chargeFor, inputTokenUpperBound, reservationUpperBound, verifyLedger, type RateSnapshot } from "@llmcrypto/domain";
import { SAMPLE_CATALOG } from "../../apps/api/src/catalog/seed";
import { BASE_TIME, advance, call, dumpDatabase, login, seedMember, type LoggedIn } from "./helpers";
import { createKey, fund, funded, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness({ providerTimeoutMs: 2000 });
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

const model = (id: string) => SAMPLE_CATALOG.find((m) => m.id === id)!;
const ratesOf = (id: string): RateSnapshot => {
  const m = model(id);
  return { priceVersion: "x", model: id, inputMicrousdPerMtok: BigInt(m.inputMicrousdPerMtok), cachedInputMicrousdPerMtok: m.cachedInputMicrousdPerMtok ? BigInt(m.cachedInputMicrousdPerMtok) : null, outputMicrousdPerMtok: BigInt(m.outputMicrousdPerMtok) };
};

const cfg = (over: Record<string, unknown> = {}): any => ({ ...structuredClone(DEFAULT_OPTIMIZATION_CONFIG), ...over });
const GUIDE = "Answer briefly and cite nothing.";
const putPolicy = (s: Pick<LoggedIn, "cookie">, expectedVersion: number, config: unknown, extra: Record<string, unknown> = {}) =>
  call<any>(h.gwApp, "PUT", "/api/optimization/policy", { cookie: s.cookie, body: { expectedVersion, config, ...extra } });
const getPolicy = (s: Pick<LoggedIn, "cookie">) => call<any>(h.gwApp, "GET", "/api/optimization/policy", { cookie: s.cookie });
const evidence = (s: Pick<LoggedIn, "cookie">, q = "") => call<any>(h.gwApp, "GET", `/api/optimization/evidence${q}`, { cookie: s.cookie });

const chat = (secret: string, content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  Promise.resolve(h.gwApp.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify({ model: "sample-fast-1", max_tokens: 100, messages: [{ role: "user", content }], ...extra }),
    ...(signal ? { signal } : {}),
  }));
const reqId = (r: Response): string => r.headers.get("x-request-id")!;
const lastProviderMessages = () => h.fake.requests.at(-1)!.messages;
const reqRow = async (id: string) => (await h.db.query<any>("select state, outcome, policy_version, reserved_microusd::text reserved from requests where id=$1", [id]))[0];
const spend = async (id: string) => (await h.db.query<any>("select count(*)::int n from ledger_transactions where source_id=$1 and kind='spend'", [id]))[0].n as number;
const evRows = (id: string) => h.db.query<any>("select feature, status, reason, detail, policy_version from optimization_evidence where request_id=$1 order by feature", [id]);

describe("policy: defaults, versions, reversibility", () => {
  it("starts at version 0 with every control off; batching is declared unavailable", async () => {
    const s = await login(h.gwApp);
    const p = await getPolicy(s);
    expect(p.status).toBe(200);
    expect(OptimizationPolicy.parse(p.json)).toMatchObject({ version: 0, createdAt: null, config: DEFAULT_OPTIMIZATION_CONFIG });
    for (const f of ["cacheAccounting", "conciseGuidance", "projectContext", "routeComparison", "batching", "loopGuard"]) expect(p.json.config[f].enabled).toBe(false);
    expect(p.json.config.loopGuard.mode).toBe("advisory");
    const controls = (await call<any>(h.gwApp, "GET", "/api/optimization/controls", { cookie: s.cookie })).json.items;
    expect(controls.find((c: any) => c.id === "batching")).toMatchObject({ availability: "unavailable" });
    expect(controls.find((c: any) => c.id === "batching").unavailableReason).toMatch(/batch API/);
    for (const c of controls.filter((c: any) => c.availability === "available")) expect(c.tradeoff.length).toBeGreaterThan(10);
  });

  it("every change appends a version; stale expectedVersion is 409; an unchanged config adds nothing; revert re-applies history", async () => {
    const s = await login(h.gwApp);
    const v1 = await putPolicy(s, 0, cfg({ cacheAccounting: { enabled: true } }), { note: "accounting" });
    expect(v1.status).toBe(200);
    expect(v1.json).toMatchObject({ version: 1, note: "accounting", revertedFrom: null, createdByUserId: s.userId });
    const same = await putPolicy(s, 1, cfg({ cacheAccounting: { enabled: true } }));
    expect(same.status).toBe(200);
    expect(same.json.version).toBe(1);
    const stale = await putPolicy(s, 0, cfg({ routeComparison: { enabled: true } }));
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("VERSION_CONFLICT");
    const v2 = await putPolicy(s, 1, cfg({ cacheAccounting: { enabled: true }, routeComparison: { enabled: true } }));
    expect(v2.json.version).toBe(2);

    const rev = await call<any>(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: s.cookie, body: { toVersion: 1, expectedVersion: 2 } });
    expect(rev.status).toBe(200);
    expect(rev.json).toMatchObject({ version: 3, revertedFrom: 1, config: v1.json.config });
    const off = await call<any>(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: s.cookie, body: { toVersion: 0, expectedVersion: 3 } });
    expect(off.json).toMatchObject({ version: 4, revertedFrom: 0, config: DEFAULT_OPTIMIZATION_CONFIG });
    expect((await call<any>(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: s.cookie, body: { toVersion: 9, expectedVersion: 4 } })).status).toBe(404);
    expect((await call<any>(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: s.cookie, body: { toVersion: 1, expectedVersion: 0 } })).json.error.code).toBe("VERSION_CONFLICT");

    const versions = await call<any>(h.gwApp, "GET", "/api/optimization/policy/versions?limit=2", { cookie: s.cookie });
    expect(versions.json.items.map((v: any) => v.version)).toEqual([4, 3]);
    const rest = await call<any>(h.gwApp, "GET", `/api/optimization/policy/versions?limit=10&cursor=${versions.json.nextCursor}`, { cookie: s.cookie });
    expect(rest.json.items.map((v: any) => v.version)).toEqual([2, 1, 0]);
    const rows = await h.db.query<any>("select version from optimization_policies where account_id=$1 order by version", [s.accountId]);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    await expect(h.db.query("update optimization_policies set note='x' where account_id=$1", [s.accountId])).rejects.toThrow(/append-only/);
  });

  it("concurrent updates from the same version: exactly one wins", async () => {
    const s = await login(h.gwApp);
    const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => putPolicy(s, 0, cfg({ loopGuard: { ...DEFAULT_OPTIMIZATION_CONFIG.loopGuard, enabled: true, threshold: 2 + n } }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await getPolicy(s)).json.version).toBe(1);
  });

  it("semantic validation: batching refused, guidance needs text, enforcement needs consent, consent without enforcement is refused", async () => {
    const s = await login(h.gwApp);
    const bat = await putPolicy(s, 0, cfg({ batching: { enabled: true } }));
    expect(bat.status).toBe(422);
    expect(bat.json.error.fieldErrors[0].field).toBe("config.batching.enabled");
    const g = await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: "   " } }));
    expect(g.json.error.fieldErrors[0].field).toBe("config.conciseGuidance.text");
    const lg = { ...DEFAULT_OPTIMIZATION_CONFIG.loopGuard, enabled: true, mode: "enforce", threshold: 3 };
    expect((await putPolicy(s, 0, cfg({ loopGuard: lg }))).json.error.fieldErrors[0].field).toBe("config.loopGuard.enforcementConsent");
    expect((await putPolicy(s, 0, cfg({ loopGuard: { ...lg, mode: "advisory", enforcementConsent: true } }))).status).toBe(422);
    expect((await putPolicy(s, 0, cfg({ loopGuard: { ...lg, threshold: 1, enforcementConsent: true } }))).status).toBe(422); // schema bound
    expect((await putPolicy(s, 0, { cacheAccounting: { enabled: true } })).status).toBe(422); // full document required
    expect((await getPolicy(s)).json.version).toBe(0);
  });

  it("enabling prompt-altering or enforcing controls needs a recent sign-in; turning them off does not", async () => {
    const s = await login(h.gwApp);
    expect((await putPolicy(s, 0, cfg({ cacheAccounting: { enabled: true } }))).status).toBe(200);
    advance(h, 16 * 60);
    const g = await putPolicy(s, 1, cfg({ cacheAccounting: { enabled: true }, conciseGuidance: { enabled: true, text: GUIDE } }));
    expect(g.status).toBe(403);
    expect(g.json.error.code).toBe("STEP_UP_REQUIRED");
    expect((await putPolicy(s, 1, cfg({ routeComparison: { enabled: true } }))).status).toBe(200); // informational: no step-up
  });

  it("roles and account isolation: only owner/admin change it; billing may read; another account sees its own defaults", async () => {
    const owner = await login(h.gwApp);
    const billing = await seedMember(h, owner.accountId, "billing");
    const member = await seedMember(h, owner.accountId, "member");
    const admin = await seedMember(h, owner.accountId, "admin");
    expect((await putPolicy(billing, 0, cfg({ cacheAccounting: { enabled: true } }))).status).toBe(403);
    expect((await putPolicy(member, 0, cfg({ cacheAccounting: { enabled: true } }))).status).toBe(403);
    expect((await putPolicy(admin, 0, cfg({ cacheAccounting: { enabled: true } }))).status).toBe(200);
    expect((await getPolicy(billing)).json.version).toBe(1);
    const other = await login(h.gwApp);
    expect((await getPolicy(other)).json.version).toBe(0);
    expect((await call<any>(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: other.cookie, body: { toVersion: 1, expectedVersion: 0 } })).status).toBe(404);
    expect((await call<any>(h.gwApp, "GET", "/api/optimization/policy")).status).toBe(401);
    expect((await call<any>(h.gwApp, "PUT", "/api/optimization/policy", { body: {}, origin: null })).status).toBe(403); // CSRF origin check
    const aud = await h.db.query<any>("select action, metadata from audit_events where account_id=$1 and action like 'optimization.%'", [owner.accountId]);
    expect(aud).toHaveLength(1);
    expect(aud[0].metadata).toEqual({ changed: "cacheAccounting", version: 1, loopGuardEnforced: false }); // names of changed controls, never their values
  });
});

describe("gateway: policy off is a no-op; policy version is recorded per request", () => {
  it("version 0: provider gets the caller's messages untouched, no evidence, policy_version 0", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "plain request");
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(lastProviderMessages()).toEqual([{ role: "user", text: "plain request" }]);
    expect(await evRows(reqId(r))).toHaveLength(0);
    expect(await reqRow(reqId(r))).toMatchObject({ policy_version: 0, state: "SETTLED" });
    expect(r.headers.get("x-optimization-policy")).toBeNull();
  });

  it("records the governing version on each request, including after a revert", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ cacheAccounting: { enabled: true } }));
    const a = await chat(key.secret, "a");
    await putPolicy(s, 1, cfg({ cacheAccounting: { enabled: true }, routeComparison: { enabled: true } }));
    const b = await chat(key.secret, "b");
    await call(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: s.cookie, body: { toVersion: 0, expectedVersion: 2 } });
    const c = await chat(key.secret, "c");
    await h.gateway.idle();
    expect([a, b, c].map((r) => r.headers.get("x-optimization-policy"))).toEqual(["1", "2", "3"]);
    expect((await reqRow(reqId(a))).policy_version).toBe(1);
    expect((await reqRow(reqId(b))).policy_version).toBe(2);
    expect((await reqRow(reqId(c))).policy_version).toBe(3);
    expect((await evRows(reqId(b))).map((e) => e.feature)).toEqual(["cache_accounting", "route_comparison"]);
    expect(await evRows(reqId(c))).toHaveLength(0); // reverted to all-off: nothing enabled, nothing recorded
  });
});

describe("concise guidance: altered request, preview, evidence, opt-out", () => {
  it("prepends the account's own text, bounds and reserves the longer prompt, records bytes (not text), and charges once", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: GUIDE } }));
    const marker = "PROMPT-MARKER-77";
    const r = await chat(key.secret, `${marker} hello`, { max_tokens: 50 });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(lastProviderMessages()).toEqual([{ role: "system", text: GUIDE }, { role: "user", text: `${marker} hello` }]);
    const id = reqId(r);
    const bound = inputTokenUpperBound([GUIDE, `${marker} hello`]);
    expect((await reqRow(id)).reserved).toBe(reservationUpperBound(bound, 50n, ratesOf("sample-fast-1")).toString());
    expect(await spend(id)).toBe(1);
    const [ev] = await evRows(id);
    expect(ev).toMatchObject({ feature: "concise_guidance", status: "applied", policy_version: 1 });
    expect(ev.detail).toEqual({ addedUtf8Bytes: GUIDE.length });
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(marker);
    const rows = await evidence(s, `?requestId=${id}`);
    expect(OptimizationEvidenceList.parse(rows.json).items).toHaveLength(1);
    expect(JSON.stringify(rows.json)).not.toContain(GUIDE);
  });

  it("X-Optimize: off skips request-altering controls and says so", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: GUIDE }, cacheAccounting: { enabled: true } }));
    const r = await chat(key.secret, "no thanks", {}, { "X-Optimize": "off" });
    await h.gateway.idle();
    expect(lastProviderMessages()).toEqual([{ role: "user", text: "no thanks" }]);
    const ev = await evRows(reqId(r));
    expect(ev.find((e) => e.feature === "concise_guidance")).toMatchObject({ status: "skipped", reason: "request_opt_out" });
    expect(ev.find((e) => e.feature === "cache_accounting")).toMatchObject({ status: "applied" });
  });

  it("preview shows the altered request without sending, storing or charging anything", async () => {
    const { s } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: GUIDE } }));
    const calls = h.fake.calls.length;
    const balance = await accountBalance(h.db, s.accountId);
    const evBefore = (await h.db.query<any>("select count(*)::int n from optimization_evidence"))[0].n;
    const reqBefore = (await h.db.query<any>("select count(*)::int n from requests"))[0].n;
    const p = await call<any>(h.gwApp, "POST", "/api/optimization/preview", { cookie: s.cookie, body: { model: "sample-fast-1", messages: [{ role: "user", content: "preview me" }] } });
    expect(p.status).toBe(200);
    const body = PreviewOptimizationResponse.parse(p.json);
    expect(body.policyVersion).toBe(1);
    expect(body.messages).toEqual([{ role: "system", content: GUIDE, origin: "guidance" }, { role: "user", content: "preview me", origin: "request" }]);
    expect(body.changes).toEqual([{ feature: "concise_guidance", status: "applied", reason: null, detail: { addedUtf8Bytes: GUIDE.length } }]);
    expect(Number(body.alteredUtf8Bytes) - Number(body.originalUtf8Bytes)).toBe(GUIDE.length);
    expect(h.fake.calls.length).toBe(calls);
    expect(await accountBalance(h.db, s.accountId)).toEqual(balance);
    expect((await h.db.query<any>("select count(*)::int n from optimization_evidence"))[0].n).toBe(evBefore);
    expect((await h.db.query<any>("select count(*)::int n from requests"))[0].n).toBe(reqBefore);
    // validation and authorization
    expect((await call<any>(h.gwApp, "POST", "/api/optimization/preview", { cookie: s.cookie, body: { model: "nope", messages: [{ role: "user", content: "x" }] } })).status).toBe(422);
    expect((await call<any>(h.gwApp, "POST", "/api/optimization/preview", { cookie: s.cookie, body: { model: "sample-fast-1", projectId: "prj_missing", messages: [{ role: "user", content: "x" }] } })).status).toBe(404);
    const billing = await seedMember(h, s.accountId, "billing");
    expect((await call<any>(h.gwApp, "POST", "/api/optimization/preview", { cookie: billing.cookie, body: { model: "sample-fast-1", messages: [{ role: "user", content: "x" }] } })).status).toBe(403);
  });
});

describe("cache accounting and route comparison: derived only from recorded usage", () => {
  it("the report compares the same recorded tokens with and without the cached discount, exactly", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const empty = await call<any>(h.gwApp, "GET", "/api/optimization/report", { cookie: s.cookie });
    expect(OptimizationReport.parse(empty.json).cacheAccounting).toMatchObject({ status: "insufficient_data", requests: "0" });
    await putPolicy(s, 0, cfg({ cacheAccounting: { enabled: true } }));
    const outcomes = [];
    for (const cached of [0, 20, 60]) {
      const r = await chat(key.secret, `cache probe ${"x".repeat(300)} [[fake:cached=${cached}]] [[fake:output=10]]`);
      expect(r.status).toBe(200);
      outcomes.push(reqId(r));
    }
    await h.gateway.idle();
    let baseline = 0n, actual = 0n, input = 0n, cachedT = 0n;
    const fast = ratesOf("sample-fast-1");
    for (const id of outcomes) {
      const [u] = await h.db.query<any>("select input_tokens::text i, cached_input_tokens::text c, output_tokens::text o, charge_microusd::text ch from usage_records where request_id=$1", [id]);
      baseline += chargeFor({ inputTokens: BigInt(u.i) + BigInt(u.c), cachedInputTokens: 0n, outputTokens: BigInt(u.o) }, fast);
      actual += BigInt(u.ch);
      input += BigInt(u.i);
      cachedT += BigInt(u.c);
    }
    const report = OptimizationReport.parse((await call<any>(h.gwApp, "GET", "/api/optimization/report", { cookie: s.cookie })).json);
    expect(report.cacheAccounting).toEqual({
      status: "ok", requests: "3", inputTokens: input.toString(), cachedInputTokens: cachedT.toString(), outputTokens: "30",
      baselineMicrousd: baseline.toString(), actualMicrousd: actual.toString(), differenceMicrousd: (baseline - actual).toString(),
    });
    expect(cachedT).toBe(80n);
    expect(baseline).toBeGreaterThan(actual);
    // the same figures come from per-request evidence
    const ev = (await evidence(s, "?feature=cache_accounting")).json.items;
    expect(ev).toHaveLength(3);
    expect(ev.map((e: any) => e.detail.cachedInputTokens).sort()).toEqual(["0", "20", "60"]);
    // injected-prompt controls never produce a savings figure
    expect(report.conciseGuidance.status).toBe("insufficient_data");
    expect(report.projectContext.status).toBe("insufficient_data");
    // a window with no policy-governed requests says so rather than reporting zeros as results
    const future = await call<any>(h.gwApp, "GET", `/api/optimization/report?from=${encodeURIComponent("2027-01-01T00:00:00Z")}`, { cookie: s.cookie });
    expect(future.json.cacheAccounting.status).toBe("insufficient_data");
  });

  it("requests whose usage is missing are 'insufficient data', never counted as zero", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ cacheAccounting: { enabled: true }, routeComparison: { enabled: true } }));
    const r = await chat(key.secret, "[[fake:no_usage]] where did the usage go");
    await h.gateway.idle();
    const ev = (await evidence(s, `?requestId=${reqId(r)}`)).json.items;
    expect(ev.find((e: any) => e.feature === "cache_accounting").detail.usage).toBe("insufficient_data");
    expect(ev.find((e: any) => e.feature === "route_comparison").routeComparison).toBeNull();
    const report = (await call<any>(h.gwApp, "GET", "/api/optimization/report", { cookie: s.cookie })).json;
    expect(report.cacheAccounting.status).toBe("insufficient_data");
    expect(report.cacheAccounting.reason).toMatch(/provider-reported usage/);
  });

  it("route comparison is an estimate at current rates for same-protocol models; the route never changes", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ routeComparison: { enabled: true } }));
    const r = await chat(key.secret, "compare me [[fake:output=25]]");
    const j: any = await r.json();
    expect(j.model).toBe("sample-fast-1");
    await h.gateway.idle();
    expect(h.fake.requests.at(-1)!.model).toBe("sample-fast-1");
    const id = reqId(r);
    const [u] = await h.db.query<any>("select input_tokens::text i, cached_input_tokens::text c, output_tokens::text o, charge_microusd::text ch from usage_records where request_id=$1", [id]);
    const usage = { inputTokens: BigInt(u.i), cachedInputTokens: BigInt(u.c), outputTokens: BigInt(u.o) };
    const ev = (await evidence(s, `?requestId=${id}`)).json.items[0];
    expect(ev).toMatchObject({ feature: "route_comparison", status: "applied", reason: "informational_only", detail: { routeChanged: false, usage: "recorded" } });
    expect(ev.routeComparison.basis).toBe("recorded_usage_at_current_rates");
    expect(ev.routeComparison.actualChargeMicrousd).toBe(u.ch);
    const alts = Object.fromEntries(ev.routeComparison.alternatives.map((a: any) => [a.model, a.estimatedChargeMicrousd]));
    const chatModels = SAMPLE_CATALOG.filter((m) => m.protocols.includes("openai_chat") && m.id !== "sample-fast-1").map((m) => m.id);
    expect(Object.keys(alts).sort()).toEqual([...chatModels].sort());
    for (const m of chatModels) expect(alts[m]).toBe(chargeFor(usage, ratesOf(m)).toString());
    expect(Object.keys(alts)).not.toContain("sample-fast-1");
  });
});

describe("LoopGuard: advisory by default; enforcement needs threshold and explicit consent", () => {
  const lg = (over: Record<string, unknown>) => cfg({ loopGuard: { ...DEFAULT_OPTIMIZATION_CONFIG.loopGuard, enabled: true, ...over } });

  it("advisory: repeats are flagged in a header and in evidence but still run and are charged", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, lg({ threshold: 3 }));
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await chat(key.secret, "same prompt again", {}, { "X-Run-Id": "run-1" }));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(rs.map((r) => r.headers.get("x-loopguard"))).toEqual([null, null, "advisory; count=3; threshold=3", "advisory; count=4; threshold=3"]);
    const other = await chat(key.secret, "a different prompt", {}, { "X-Run-Id": "run-1" });
    const otherRun = await chat(key.secret, "same prompt again", {}, { "X-Run-Id": "run-2" });
    expect(other.headers.get("x-loopguard")).toBeNull();
    expect(otherRun.headers.get("x-loopguard")).toBeNull();
    await h.gateway.idle();
    for (const r of rs) expect(await spend(reqId(r))).toBe(1);
    const ev = (await evidence(s, "?feature=loop_guard&status=advisory")).json.items;
    expect(ev).toHaveLength(2);
    expect(ev[0].detail).toMatchObject({ threshold: 3, windowSeconds: 600, mode: "advisory" });
    const rows = await h.db.query<any>("select fingerprint, scope_key from optimization_evidence where feature='loop_guard' and request_id=$1", [reqId(rs[0]!)]);
    expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].scope_key).toBe("run-1");
    expect(JSON.stringify(rows)).not.toContain("same prompt again");
    const report = (await call<any>(h.gwApp, "GET", "/api/optimization/report", { cookie: s.cookie })).json;
    expect(report.loopGuard).toMatchObject({ advisoryRequests: "2", blockedRequests: "0" });
  });

  it("the window bounds the count: repeats outside it do not accumulate", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, lg({ threshold: 2, windowSeconds: 60 }));
    await chat(key.secret, "windowed");
    advance(h, 61);
    const r = await chat(key.secret, "windowed");
    expect(r.headers.get("x-loopguard")).toBeNull();
    const r2 = await chat(key.secret, "windowed");
    expect(r2.headers.get("x-loopguard")).toBe("advisory; count=2; threshold=2");
    await h.gateway.idle();
  });

  it("enforcement: the request at the threshold is stopped before any reservation, provider call or charge", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    expect((await putPolicy(s, 0, lg({ mode: "enforce", threshold: 2 }))).status).toBe(422); // no consent
    expect((await putPolicy(s, 0, lg({ mode: "enforce", threshold: 2, enforcementConsent: true }))).status).toBe(200);
    const first = await chat(key.secret, "stuck in a loop", {}, { "X-Run-Id": "r1" });
    expect(first.status).toBe(200);
    await h.gateway.idle();
    const balance = await accountBalance(h.db, s.accountId);
    const calls = h.fake.calls.length;
    const reqs = (await h.db.query<any>("select count(*)::int n from requests"))[0].n;
    const blocked = await chat(key.secret, "stuck in a loop", {}, { "X-Run-Id": "r1" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("600");
    const body: any = await blocked.json();
    expect(body.error.code).toBe("loop_guard_blocked");
    expect(h.fake.calls.length).toBe(calls);
    expect(await accountBalance(h.db, s.accountId)).toEqual(balance);
    expect((await h.db.query<any>("select count(*)::int n from requests"))[0].n).toBe(reqs);
    const ev = (await evidence(s, "?status=blocked")).json.items;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ feature: "loop_guard", reason: "threshold_reached_enforced", requestId: reqId(blocked) });
    // still blocked while repeats keep arriving; a different prompt is fine; after the window it is allowed again
    expect((await chat(key.secret, "stuck in a loop", {}, { "X-Run-Id": "r1" })).status).toBe(429);
    expect((await chat(key.secret, "something new", {}, { "X-Run-Id": "r1" })).status).toBe(200);
    advance(h, 601);
    expect((await chat(key.secret, "stuck in a loop", {}, { "X-Run-Id": "r1" })).status).toBe(200);
    await h.gateway.idle();
    // disabling enforcement (revert to advisory/off) restores normal behaviour at once
    await call(h.gwApp, "POST", "/api/optimization/policy/revert", { cookie: s.cookie, body: { toVersion: 0, expectedVersion: 1 } });
    expect((await chat(key.secret, "stuck in a loop", {}, { "X-Run-Id": "r1" })).status).toBe(200);
    await h.gateway.idle();
    expect((await verifyLedger(h.db)).totalSum).toBe(0n);
  });

  it("repeats are isolated per account and per key when no run id is sent", async () => {
    const a = await funded(h, 5_000_000n);
    const b = await funded(h, 5_000_000n);
    await putPolicy(a.s, 0, lg({ threshold: 2 }));
    await putPolicy(b.s, 0, lg({ threshold: 2 }));
    await chat(a.key.secret, "shared text");
    expect((await chat(b.key.secret, "shared text")).headers.get("x-loopguard")).toBeNull();
    const a2 = await createKey(h, a.s);
    expect((await chat(a2.secret, "shared text")).headers.get("x-loopguard")).toBeNull(); // other key, other scope
    expect((await chat(a.key.secret, "shared text")).headers.get("x-loopguard")).toMatch(/advisory/);
    await h.gateway.idle();
  });
});

describe("regression: reservation, budget, cancellation and concurrency still hold with a policy active", () => {
  it("a key spend cap sized for the plain request refuses the longer, guided request: 402, no provider call, no evidence", async () => {
    const s = await login(h.gwApp);
    await fund(h, s.accountId, 5_000_000n);
    const probe = await createKey(h, s);
    const plain = await chat(probe.secret, "cap probe", { max_tokens: 40 });
    await h.gateway.idle();
    const reserved = (await reqRow(reqId(plain))).reserved;
    const capped = await createKey(h, s, { spendCapMicrousd: reserved });
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: "x".repeat(500) } }));
    const calls = h.fake.calls.length;
    const refused = await chat(capped.secret, "cap probe", { max_tokens: 40 });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as any).error.code).toBe("key_spend_cap_exceeded");
    expect(h.fake.calls.length).toBe(calls);
    expect(await evRows(reqId(refused))).toHaveLength(0);
    expect(await reqRow(reqId(refused))).toMatchObject({ state: "FAILED", outcome: "rejected" });
    const ok = await chat(capped.secret, "cap probe", { max_tokens: 40 }, { "X-Optimize": "off" });
    expect(ok.status).toBe(200);
    await h.gateway.idle();
  });

  it("client disconnect mid-stream under a policy: upstream cancelled, usage charged once, hold released, evidence kept once", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: GUIDE }, cacheAccounting: { enabled: true } }));
    const r = await chat(key.secret, "go [[fake:slow]] [[fake:output=50]]", { stream: true, max_tokens: 100 });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await h.gateway.idle();
    const id = reqId(r);
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "cancelled", policy_version: 1 });
    expect(await spend(id)).toBe(1);
    expect(await accountBalance(h.db, s.accountId)).toMatchObject({ held: 0n });
    expect((await evRows(id)).map((e) => e.feature)).toEqual(["cache_accounting", "concise_guidance"]);
    const [u] = await h.db.query<any>("select output_tokens::text o from usage_records where request_id=$1", [id]);
    expect(Number(u.o)).toBeLessThan(50);
  });

  it("provider rejection releases the hold and leaves no spend; the reserve-time evidence stays truthful (applied, request FAILED)", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: GUIDE } }));
    const r = await chat(key.secret, "[[fake:reject]] nope");
    expect(r.status).toBe(502);
    await h.gateway.idle();
    expect(await spend(reqId(r))).toBe(0);
    expect(await accountBalance(h.db, s.accountId)).toMatchObject({ held: 0n });
    expect(await reqRow(reqId(r))).toMatchObject({ state: "FAILED", outcome: "rejected", policy_version: 1 });
    expect((await evRows(reqId(r))).map((e) => e.status)).toEqual(["applied"]); // it was sent to the provider with the guidance, which refused
  });

  it("A5 with guidance: concurrent near-balance requests still cannot overspend, and each sent request has exactly one evidence row", async () => {
    const msg = "race [[fake:slow]] [[fake:output=4]]";
    const hold = reservationUpperBound(inputTokenUpperBound([GUIDE, msg]), 100n, ratesOf("sample-fast-1"));
    const { s, key } = await funded(h, hold * 2n + hold / 2n);
    await putPolicy(s, 0, cfg({ conciseGuidance: { enabled: true, text: GUIDE } }));
    const calls = h.fake.calls.length;
    const rs = await Promise.all(Array.from({ length: 8 }, () => chat(key.secret, msg, { max_tokens: 100 })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 402)).toHaveLength(6);
    await Promise.all(rs.map((r) => r.text()));
    await h.gateway.idle();
    expect(h.fake.calls.length - calls).toBe(2);
    const bal = await accountBalance(h.db, s.accountId);
    expect(bal.held).toBe(0n);
    expect((await h.db.query<any>("select count(*)::int n from optimization_evidence where account_id=$1", [s.accountId]))[0].n).toBe(2);
    expect((await verifyLedger(h.db)).totalSum).toBe(0n);
  });

  it("evidence is append-only and account-scoped", async () => {
    const a = await funded(h, 5_000_000n);
    const b = await funded(h, 5_000_000n);
    await putPolicy(a.s, 0, cfg({ cacheAccounting: { enabled: true } }));
    const r = await chat(a.key.secret, "mine");
    await h.gateway.idle();
    await expect(h.db.query("delete from optimization_evidence where request_id=$1", [reqId(r)])).rejects.toThrow(/append-only/);
    expect((await evidence(b.s, `?requestId=${reqId(r)}`)).json.items).toHaveLength(0);
    expect((await evidence(a.s, `?requestId=${reqId(r)}`)).json.items).toHaveLength(1);
    const page1 = await evidence(a.s, "?limit=1");
    expect(page1.json.items).toHaveLength(1);
    expect((await evidence(a.s, "?limit=1&cursor=garbage")).status).toBe(400);
    expect((await evidence(a.s, "?feature=nope")).status).toBe(422);
  });
});
