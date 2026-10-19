/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKey, getBalance, listKeys, requestWalletChallenge, unlinkIdentity } from "../../apps/web/src/lib/api";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function stubFetch(res: Response | Error) {
  const f = vi.fn(async (...args: [string, RequestInit]) => { void args; if (res instanceof Error) throw res; return res; });
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

const KEY = { id: "key_1", name: "k", projectId: null, prefix: "sk_abcde", scopes: ["gateway:invoke"], modelAllowlist: [], spendCapMicrousd: null, expiresAt: null, createdAt: "2026-10-18T12:00:00Z", lastUsedAt: null, revokedAt: null };

describe("api client", () => {
  it("sends cookies, JSON and the Idempotency-Key header on key creation", async () => {
    const f = stubFetch(json(201, { key: KEY, secretStatus: "PROVIDED", secret: "sk_secret_value" }));
    const r = await createKey({ name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, "idem-12345678");
    expect(r).toMatchObject({ ok: true, data: { secretStatus: "PROVIDED", secret: "sk_secret_value" } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/keys");
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-12345678");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("parses NON_RECOVERABLE with a null secret", async () => {
    stubFetch(json(201, { key: KEY, secretStatus: "NON_RECOVERABLE", secret: null }));
    const r = await createKey({ name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, "idem-12345678");
    expect(r).toMatchObject({ ok: true, data: { secretStatus: "NON_RECOVERABLE", secret: null } });
  });

  it("rejects a PROVIDED response with no secret as invalid rather than trusting it", async () => {
    stubFetch(json(201, { key: KEY, secretStatus: "PROVIDED", secret: null }));
    expect(await createKey({ name: "k", scopes: ["gateway:invoke"], modelAllowlist: [] }, "idem-12345678")).toEqual({ ok: false, error: { kind: "invalid" } });
  });

  it("surfaces error envelope code, request id, field errors and Retry-After", async () => {
    stubFetch(json(422, { error: { code: "VALIDATION_FAILED", message: "bad", requestId: "req_9", fieldErrors: [{ field: "chainId", message: "no" }] } }, { "retry-after": "5" }));
    const r = await requestWalletChallenge({ protocol: "evm", address: "0xabc", chainId: "5" });
    expect(r).toEqual({ ok: false, error: { kind: "http", status: 422, code: "VALIDATION_FAILED", requestId: "req_9", fieldErrors: [{ field: "chainId", message: "no" }], retryAfterSeconds: 5 } });
  });

  it("a challenge response must be 201 with the contract shape", async () => {
    stubFetch(json(200, { challengeId: "c", message: "m", expiresAt: "2026-10-18T12:05:00Z" }));
    expect((await requestWalletChallenge({ protocol: "evm", address: "0xabc", chainId: "1" })).ok).toBe(false);
  });

  it("network errors are a distinct failure kind", async () => {
    stubFetch(new TypeError("fetch failed"));
    expect(await getBalance()).toEqual({ ok: false, error: { kind: "network" } });
  });

  it("validates list and balance bodies against the contract", async () => {
    stubFetch(json(200, { items: [KEY], nextCursor: null }));
    expect(await listKeys()).toMatchObject({ ok: true, data: { items: [{ id: "key_1" }] } });
    stubFetch(json(200, { availableMicrousd: "1", heldMicrousd: "0", postedMicrousd: "1", asOf: "2026-10-18T12:00:00Z" }));
    expect(await getBalance()).toMatchObject({ ok: true, data: { availableMicrousd: "1" } });
    stubFetch(json(200, { availableMicrousd: 1 }));
    expect(await getBalance()).toEqual({ ok: false, error: { kind: "invalid" } });
  });

  it("DELETE succeeds only on 204 and encodes the id", async () => {
    const f = stubFetch(new Response(null, { status: 204 }));
    expect(await unlinkIdentity("id/with space")).toEqual({ ok: true, data: null });
    expect(f.mock.calls[0]![0]).toBe("/api/identities/id%2Fwith%20space");
    stubFetch(json(409, { error: { code: "LAST_AUTH_METHOD", message: "last", requestId: "r1" } }));
    expect(await unlinkIdentity("x")).toMatchObject({ ok: false, error: { status: 409, code: "LAST_AUTH_METHOD" } });
  });
});

describe("task 16/19/20/21 client calls follow the contract", () => {
  it("password sign-in posts the credentials and surfaces Retry-After on 429", async () => {
    const f = stubFetch(json(429, { error: { code: "RATE_LIMITED", message: "slow", requestId: "r1" } }, { "retry-after": "42" }));
    const { passwordSignIn } = await import("../../apps/web/src/lib/api-auth");
    const r = await passwordSignIn({ username: "a", password: "b" });
    expect(r).toMatchObject({ ok: false, error: { kind: "http", status: 429, retryAfterSeconds: 42 } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/auth/password/sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ username: "a", password: "b" });
  });
  it("step-up sends the body and treats 204 as success", async () => {
    const f = stubFetch(new Response(null, { status: 204 }));
    const { stepUp } = await import("../../apps/web/src/lib/api-auth");
    expect(await stepUp({ password: "pw" })).toEqual({ ok: true, data: null });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/session/step-up");
    expect(JSON.parse(String(init.body))).toEqual({ password: "pw" });
  });
  it("policy update sends expectedVersion and reports a 409 as VERSION_CONFLICT", async () => {
    const f = stubFetch(json(409, { error: { code: "VERSION_CONFLICT", message: "stale", requestId: "r2" } }));
    const { updatePolicy } = await import("../../apps/web/src/lib/api-product");
    const { DEFAULT_OPTIMIZATION_CONFIG } = await import("@llmcrypto/contracts");
    const r = await updatePolicy({ expectedVersion: 3, config: DEFAULT_OPTIMIZATION_CONFIG });
    expect(r).toMatchObject({ ok: false, error: { status: 409, code: "VERSION_CONFLICT" } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/optimization/policy");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).expectedVersion).toBe(3);
  });
  it("memory create always carries literal storageConsent and encodes ids", async () => {
    const f = stubFetch(json(201, { id: "m1", projectId: "p/1", text: "t", version: 1, inject: false, expiresAt: null, createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z" }));
    const { createMemory } = await import("../../apps/web/src/lib/api-product");
    expect(await createMemory("p/1", { text: "t", storageConsent: true })).toMatchObject({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/projects/p%2F1/memories");
    expect(JSON.parse(String(init.body)).storageConsent).toBe(true);
  });
  it("pairing confirm sends the chosen events; an empty choice is sent as an empty list", async () => {
    const f = stubFetch(json(422, { error: { code: "VALIDATION_FAILED", message: "no", requestId: "r3", fieldErrors: [{ field: "pairing", message: "not yet" }] } }));
    const { confirmPairing } = await import("../../apps/web/src/lib/api-product");
    const r = await confirmPairing("pair_1", []);
    expect(r).toMatchObject({ ok: false, error: { status: 422, fieldErrors: [{ field: "pairing" }] } });
    expect(f.mock.calls[0]![0]).toBe("/api/connectivity/pairings/pair_1/confirm");
    expect(JSON.parse(String(f.mock.calls[0]![1].body))).toEqual({ events: [] });
  });
  it("a response that does not match the schema is invalid, not trusted", async () => {
    stubFetch(json(200, { version: "nope" }));
    const { getPolicy } = await import("../../apps/web/src/lib/api-product");
    expect(await getPolicy()).toEqual({ ok: false, error: { kind: "invalid" } });
  });
});
