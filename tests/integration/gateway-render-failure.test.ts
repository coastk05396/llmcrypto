/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Protocols from "../../apps/api/src/gateway/protocols";
import { login } from "./helpers";
import { createKey, fund, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

const flags = vi.hoisted(() => ({ breakRender: false }));
vi.mock("../../apps/api/src/gateway/protocols", async (importOriginal) => {
  const real = await importOriginal<typeof Protocols>();
  return {
    ...real,
    adapterFor: (p: Parameters<typeof real.adapterFor>[0]) => {
      const a = real.adapterFor(p);
      return { ...a, body: (...args: Parameters<typeof a.body>) => { if (flags.breakRender) throw new Error("render boom"); return a.body(...args); } };
    },
  };
});

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness();
});
afterAll(async () => {
  await h.db.close();
});

describe("render failure after a charged non-stream settlement", () => {
  it("is reported as an internal error that says the request completed, never as a provider failure, and is charged exactly once", async () => {
    const s = await login(h.gwApp);
    await fund(h, s.accountId, 5_000_000n);
    const key = await createKey(h, s);
    flags.breakRender = true;
    const r = await h.gwApp.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ model: "sample-fast-1", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }) });
    flags.breakRender = false;
    const body: any = await r.json();
    expect(r.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toMatch(/completed and was charged once/);
    expect(JSON.stringify(body)).not.toContain("boom");
    const [rq] = await h.db.query<any>("select state, outcome, failure_code from requests where account_id=$1", [s.accountId]);
    expect(rq).toMatchObject({ state: "SETTLED", outcome: "succeeded", failure_code: null });
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where kind='spend' and account_id=$1", [s.accountId]))[0].n).toBe(1);
    expect((await h.db.query<any>("select count(*)::int n from request_transitions where request_id=$1 and to_state='SETTLED'", [r.headers.get("x-request-id")]))[0].n).toBe(1);
  });
});

describe("streaming body limits (before any parsing)", () => {
  const big = (n: number): string => JSON.stringify({ model: "sample-fast-1", messages: [{ role: "user", content: "x".repeat(n) }] });
  const chunked = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += 65536) c.enqueue(b.subarray(i, i + 65536)); c.close(); } });

  it("/v1: an oversize body is a 413 in the protocol's own error shape, even when sent chunked without Content-Length", async () => {
    const s = await login(h.gwApp);
    await fund(h, s.accountId, 5_000_000n);
    const key = await createKey(h, s);
    const limit = h.config.gateway.maxRequestBytes;
    const sizes: [string, () => RequestInit][] = [
      ["content-length", () => ({ body: big(limit + 10) })],
      ["chunked", () => ({ body: chunked(big(limit + 10)) as any, duplex: "half" } as any)],
    ];
    for (const [name, init] of sizes) {
      for (const path of ["/v1/chat/completions", "/v1/messages"]) {
        const r = await h.gwApp.request(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` }, ...init() });
        const body: any = await r.json();
        expect([name, path, r.status]).toEqual([name, path, 413]);
        if (path === "/v1/messages") expect(body).toMatchObject({ type: "error", error: { type: "request_too_large" } });
        else expect(body.error.code).toBe("request_too_large");
      }
    }
    expect((await h.db.query<any>("select count(*)::int n from requests where account_id=$1", [s.accountId]))[0].n).toBe(0);
  });

  it("/api: an oversize JSON body is a 413 console envelope; normal bodies and the archive route's own limit are unaffected", async () => {
    const s = await login(h.gwApp);
    const limit = h.config.apiMaxBodyBytes;
    const r = await h.gwApp.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example.test", Cookie: s.cookie }, body: JSON.stringify({ name: "x".repeat(limit + 10) }) });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error.code).toBe("PAYLOAD_TOO_LARGE");
    const chunkedRes = await h.gwApp.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example.test", Cookie: s.cookie }, body: chunked(JSON.stringify({ name: "x".repeat(limit + 10) })) as any, duplex: "half" } as any);
    expect(chunkedRes.status).toBe(413);
    expect((await h.gwApp.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example.test", Cookie: s.cookie }, body: JSON.stringify({ name: "ok" }) })).status).toBe(201);
  });
});
