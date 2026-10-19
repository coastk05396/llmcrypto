/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsagePage } from "@llmcrypto/contracts";
import { accountBalance, chargeFor, inputTokenUpperBound, registerPriceVersion, reservationUpperBound, verifyLedger, type TokenUsage } from "@llmcrypto/domain";
import { SAMPLE_CATALOG } from "../../apps/api/src/catalog/seed";
import { randomId } from "../../apps/api/src/crypto";
import { reconcileUsage } from "../../apps/worker/src/reconcile-usage";
import { BASE_TIME, advance, call, dumpDatabase, login } from "./helpers";
import { createKey, fund, funded, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness({ providerTimeoutMs: 150 });
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

const FAST = SAMPLE_CATALOG.find((m) => m.id === "sample-fast-1")!;
const rates = { priceVersion: "x", model: FAST.id, inputMicrousdPerMtok: BigInt(FAST.inputMicrousdPerMtok), cachedInputMicrousdPerMtok: BigInt(FAST.cachedInputMicrousdPerMtok!), outputMicrousdPerMtok: BigInt(FAST.outputMicrousdPerMtok) };

const post = (path: string, secret: string | null, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> =>
  Promise.resolve(h.gwApp.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  }));
const chat = (secret: string | null, content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  post("/v1/chat/completions", secret, { model: "sample-fast-1", messages: [{ role: "user", content }], ...extra }, headers, signal);
const messages = (secret: string | null, content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post("/v1/messages", secret, { model: "sample-fast-1", max_tokens: 200, messages: [{ role: "user", content }], ...extra }, headers);

async function sse(res: Response): Promise<{ frames: { event?: string; data: string }[]; raw: string }> {
  const raw = await res.text();
  const frames = raw.split("\n\n").filter(Boolean).map((f) => {
    const lines = f.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "";
    return ev ? { event: ev, data } : { data };
  });
  return { frames, raw };
}

const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await h.db.query<any>(sql, params))[0] as T;
const spendRows = (requestId: string) =>
  h.db.query<{ amount: string; pv: string }>(
    "select e.amount::text amount, t.price_version_id pv from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.source_id=$1 and t.kind='spend' and e.ledger_account='customer_funds'", [requestId]);
const reqRow = (id: string) => one<any>("select state, outcome, failure_code, reserved_microusd::text reserved from requests where id=$1", [id]);
const transitions = async (id: string) => (await h.db.query<{ to_state: string }>("select to_state from request_transitions where request_id=$1 order by id", [id])).map((t) => t.to_state);
const reqId = (r: Response): string => r.headers.get("x-request-id")!;
const usageOf = (id: string) => one<any>("select input_tokens::text i, cached_input_tokens::text c, output_tokens::text o, charge_microusd::text ch, price_version_id pv, input_rate_microusd::text ir, output_rate_microusd::text orate, usage_source from usage_records where request_id=$1", [id]);

describe("non-streaming, both protocols", () => {
  it("OpenAI chat: OpenAI-shaped response, one charge equal to ledger and usage record, hold released", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const before = await accountBalance(h.db, s.accountId);
    const r = await chat(key.secret, "hello [[fake:output=40]]", { max_tokens: 100 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ object: "chat.completion", model: "sample-fast-1", choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }] });
    expect(j.choices[0].message.content.split(" ")).toHaveLength(40);
    expect(j.usage.completion_tokens).toBe(40);
    expect(j.usage.total_tokens).toBe(j.usage.prompt_tokens + 40);
    await h.gateway.idle();

    const id = reqId(r);
    const usage: TokenUsage = { inputTokens: BigInt(j.usage.prompt_tokens), cachedInputTokens: 0n, outputTokens: 40n };
    const charge = chargeFor(usage, rates);
    expect(await spendRows(id)).toEqual([{ amount: `-${charge}`, pv: "pv_sample_2026-10-18" }]);
    expect(await usageOf(id)).toMatchObject({ i: String(j.usage.prompt_tokens), c: "0", o: "40", ch: charge.toString(), usage_source: "provider", ir: FAST.inputMicrousdPerMtok });
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "succeeded" });
    expect(await transitions(id)).toEqual(["VALIDATED", "RESERVED", "DISPATCHED", "SUCCEEDED", "SETTLED"]);
    const after = await accountBalance(h.db, s.accountId);
    expect(after).toEqual({ posted: before.posted - charge, held: 0n, available: before.posted - charge });
  });

  it("Anthropic messages: Anthropic-shaped response with non-overlapping cache categories, charged once", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await messages(key.secret, "hi [[fake:cached=3]] [[fake:output=7]]");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text" }], usage: { output_tokens: 7, cache_read_input_tokens: 3 } });
    await h.gateway.idle();
    const id = reqId(r);
    const u = await usageOf(id);
    expect(u).toMatchObject({ c: "3", o: "7", i: String(j.usage.input_tokens) });
    const charge = chargeFor({ inputTokens: BigInt(j.usage.input_tokens), cachedInputTokens: 3n, outputTokens: 7n }, rates);
    expect(await spendRows(id)).toEqual([{ amount: `-${charge}`, pv: expect.any(String) }]);
    // x-api-key is accepted as the Anthropic credential header
    const r2 = await h.gwApp.request("/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key.secret }, body: JSON.stringify({ model: "sample-fast-1", max_tokens: 5, messages: [{ role: "user", content: "x" }] }) });
    expect(r2.status).toBe(200);
  });

  it("applies the documented default output cap when omitted and reserves against it", async () => {
    const { key } = await funded(h, 50_000_000n);
    const r = await chat(key.secret, "go [[fake:output=5000]]");
    const j = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(j.usage.completion_tokens).toBe(h.config.gateway.defaultMaxOutputTokens);
    expect(j.choices[0].finish_reason).toBe("length");
    await h.gateway.idle();
    const bound = inputTokenUpperBound(["go [[fake:output=5000]]"]);
    expect((await reqRow(reqId(r))).reserved).toBe(reservationUpperBound(bound, BigInt(h.config.gateway.defaultMaxOutputTokens), rates).toString());
  });

  it("persists minimal metadata only: correlation/run/parent ids, never prompt text", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const marker = `SECRET-PROMPT-${randomId("m")}`;
    const r = await chat(key.secret, marker, { max_tokens: 20 }, { "X-Correlation-Id": "corr-1", "X-Run-Id": "run-7", "X-Parent-Id": "run-3" });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(await one("select correlation_id, run_id, parent_id, key_id from requests where id=$1", [reqId(r)])).toEqual({ correlation_id: "corr-1", run_id: "run-7", parent_id: "run-3", key_id: key.id });
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(marker);
    expect(dump).not.toContain(key.secret);
    expect(s.accountId).toBeTruthy();
    expect((await chat(key.secret, "x", {}, { "X-Run-Id": "bad id with spaces" })).status).toBe(400);
  });

  it("scopes project headers to the key's account and project", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const other = await login(h.app);
    const mine = randomId("prj");
    const theirs = randomId("prj");
    await h.db.query("insert into projects (id, account_id, name, created_at) values ($1,$2,'a',$3),($4,$5,'b',$3)", [mine, s.accountId, BASE_TIME, theirs, other.accountId]);
    expect((await chat(key.secret, "x", { max_tokens: 5 }, { "X-Project-Id": theirs })).status).toBe(403);
    const ok = await chat(key.secret, "x", { max_tokens: 5 }, { "X-Project-Id": mine });
    expect(ok.status).toBe(200);
    await h.gateway.idle();
    expect((await one("select project_id from requests where id=$1", [reqId(ok)])).project_id).toBe(mine);
    const scoped = await createKey(h, s, { projectId: mine });
    expect((await chat(scoped.secret, "x", { max_tokens: 5 }, { "X-Project-Id": mine })).status).toBe(200);
    const otherProject = randomId("prj");
    await h.db.query("insert into projects (id, account_id, name, created_at) values ($1,$2,'c',$3)", [otherProject, s.accountId, BASE_TIME]);
    expect((await chat(scoped.secret, "x", { max_tokens: 5 }, { "X-Project-Id": otherProject })).status).toBe(403);
  });
});

describe("streaming, both protocols", () => {
  it("OpenAI SSE: role chunk, deltas, finish, usage chunk, [DONE]; charged once and equal to the stream's usage", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "stream me [[fake:output=6]]", { stream: true, stream_options: { include_usage: true }, max_tokens: 50 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const { frames } = await sse(r);
    expect(frames.at(-1)!.data).toBe("[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.data));
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join("")).toBe("tok0 tok1 tok2 tok3 tok4 tok5");
    expect(chunks.find((c) => c.choices[0]?.finish_reason === "stop")).toBeTruthy();
    const usageChunk = chunks.at(-1);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.completion_tokens).toBe(6);
    await h.gateway.idle();
    const id = reqId(r);
    const charge = chargeFor({ inputTokens: BigInt(usageChunk.usage.prompt_tokens), cachedInputTokens: 0n, outputTokens: 6n }, rates);
    expect(await spendRows(id)).toEqual([{ amount: `-${charge}`, pv: expect.any(String) }]);
    expect((await usageOf(id)).ch).toBe(charge.toString());
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "succeeded" });
  });

  it("OpenAI SSE without include_usage omits the usage chunk but still charges", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "q [[fake:output=3]]", { stream: true, max_tokens: 50 });
    const { frames } = await sse(r);
    expect(frames.slice(0, -1).every((f) => !("usage" in JSON.parse(f.data)))).toBe(true);
    await h.gateway.idle();
    expect(await spendRows(reqId(r))).toHaveLength(1);
  });

  it("Anthropic SSE: ordered typed events, cache categories, charged once", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await messages(key.secret, "yo [[fake:output=4]] [[fake:cached=2]]", { stream: true });
    expect(r.status).toBe(200);
    const { frames } = await sse(r);
    const order = frames.map((f) => f.event);
    expect(order[0]).toBe("message_start");
    expect(order[1]).toBe("content_block_start");
    expect(order.filter((e) => e === "content_block_delta")).toHaveLength(4);
    expect(order.slice(-3)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
    const md = JSON.parse(frames.find((f) => f.event === "message_delta")!.data);
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage).toMatchObject({ output_tokens: 4, cache_read_input_tokens: 2 });
    await h.gateway.idle();
    const id = reqId(r);
    const charge = chargeFor({ inputTokens: BigInt(md.usage.input_tokens), cachedInputTokens: 2n, outputTokens: 4n }, rates);
    expect(await spendRows(id)).toEqual([{ amount: `-${charge}`, pv: expect.any(String) }]);
    expect(await usageOf(id)).toMatchObject({ c: "2", o: "4" });
  });

  it("stream and non-stream of the same prompt cost the same and every ledger/usage/balance figure agrees", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const prompt = "same prompt [[fake:output=9]]";
    const a = await chat(key.secret, prompt, { max_tokens: 30 });
    await a.json();
    const b = await chat(key.secret, prompt, { max_tokens: 30, stream: true });
    await b.text();
    await h.gateway.idle();
    const [ra, rb] = [await spendRows(reqId(a)), await spendRows(reqId(b))];
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(ra[0]!.amount).toBe(rb[0]!.amount);
    const sum = (await one<{ t: string }>("select coalesce(sum(charge_microusd),0)::text t from usage_records u join requests r on r.id=u.request_id where r.account_id=$1", [s.accountId])).t;
    const bal = await accountBalance(h.db, s.accountId);
    expect(5_000_000n - bal.posted).toBe(BigInt(sum));
    expect(bal.held).toBe(0n);
  });
});

describe("authentication, authorization and validation", () => {
  it("rejects missing, unknown, revoked and expired keys with 401 in each protocol's error shape", async () => {
    const { s, key } = await funded(h, 5_000_000n, { expiresAt: "2026-10-18T13:00:00Z" });
    expect((await chat(null, "x")).status).toBe(401);
    const unknown = await chat("sk_nope", "x");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: { type: "authentication_error", code: "invalid_api_key" } });
    const anth = await messages("sk_nope", "x");
    expect(anth.status).toBe(401);
    expect(await anth.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });

    expect((await chat(key.secret, "x", { max_tokens: 5 })).status).toBe(200);
    advance(h, 2 * 3600);
    expect((await chat(key.secret, "x")).status).toBe(401); // expired
    h.clock.now = new Date(BASE_TIME);

    const revocable = await createKey(h, s);
    expect((await chat(revocable.secret, "x", { max_tokens: 5 })).status).toBe(200);
    expect((await call(h.app, "DELETE", `/api/keys/${revocable.id}`, { cookie: s.cookie })).status).toBe(204);
    const calls = h.fake.calls.length;
    expect((await chat(revocable.secret, "x")).status).toBe(401);
    expect((await messages(revocable.secret, "x")).status).toBe(401);
    expect(h.fake.calls.length).toBe(calls); // never reached the provider
    await h.gateway.idle();
  });

  it("enforces scope and model allowlist, protocol/model compatibility, unknown models", async () => {
    const { s, key } = await funded(h, 5_000_000n, { modelAllowlist: ["sample-fast-1"] });
    const usageOnly = await createKey(h, s, { scopes: ["usage:read"] });
    expect((await chat(usageOnly.secret, "x")).status).toBe(403);
    const denied = await post("/v1/chat/completions", key.secret, { model: "sample-frontier-1", messages: [{ role: "user", content: "x" }] });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "model_not_allowed", param: "model" } });
    const unknown = await post("/v1/chat/completions", key.secret, { model: "gpt-nope", messages: [{ role: "user", content: "x" }] });
    expect(unknown.status).toBe(404);
    const open = await createKey(h, s);
    const wrongProto = await post("/v1/messages", open.secret, { model: "sample-mini-1", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(wrongProto.status).toBe(400);
    expect(await wrongProto.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    // No silent switch: nothing was dispatched for any of these.
    await h.gateway.idle();
  });

  it("fails clearly on malformed and unsupported requests without reserving or calling the provider", async () => {
    const { key } = await funded(h, 5_000_000n);
    const calls = h.fake.calls.length;
    const bad: [string, unknown, number, string?][] = [
      ["not json", "{nope", 400, "invalid_json"],
      ["array body", "[]", 400],
      ["no messages", { model: "sample-fast-1" }, 400],
      ["empty messages", { model: "sample-fast-1", messages: [] }, 400],
      ["tools", { model: "sample-fast-1", messages: [{ role: "user", content: "x" }], tools: [] }, 400, "unsupported_parameter"],
      ["response_format", { model: "sample-fast-1", messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } }, 400, "unsupported_parameter"],
      ["n=2", { model: "sample-fast-1", messages: [{ role: "user", content: "x" }], n: 2 }, 400, "unsupported_value"],
      ["image part", { model: "sample-fast-1", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "u" } }] }] }, 400],
      ["bad temperature", { model: "sample-fast-1", messages: [{ role: "user", content: "x" }], temperature: 5 }, 400],
      ["stream not boolean", { model: "sample-fast-1", messages: [{ role: "user", content: "x" }], stream: "yes" }, 400],
      ["cap above ceiling", { model: "sample-fast-1", messages: [{ role: "user", content: "x" }], max_tokens: 1_000_000 }, 400, "max_tokens_too_large"],
      ["context overflow", { model: "sample-mini-1", messages: [{ role: "user", content: "x".repeat(70_000) }] }, 400, "context_length_exceeded"],
    ];
    for (const [name, body, status, code] of bad) {
      const r = await post("/v1/chat/completions", key.secret, body);
      expect(r.status, name).toBe(status);
      const j = (await r.json()) as any;
      expect(j.error.message, name).toBeTruthy();
      if (code) expect(j.error.code, name).toBe(code);
    }
    const a = await post("/v1/messages", key.secret, { model: "sample-fast-1", messages: [{ role: "user", content: "x" }] });
    expect(a.status).toBe(400); // max_tokens is required by the Anthropic protocol
    expect(await a.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect((await post("/v1/messages", key.secret, { model: "sample-fast-1", max_tokens: 5, messages: [{ role: "assistant", content: "x" }] })).status).toBe(400);
    expect((await post("/v1/messages", key.secret, { model: "sample-fast-1", max_tokens: 5, messages: [{ role: "user", content: "x" }], tools: [] })).status).toBe(400);
    const huge = await post("/v1/chat/completions", key.secret, `{"model":"sample-fast-1","messages":[{"role":"user","content":"${"x".repeat(h.config.gateway.maxRequestBytes)}"}]}`);
    expect(huge.status).toBe(413);
    expect(h.fake.calls.length).toBe(calls);
    expect(await one("select count(*)::int n from requests where key_id=$1", [key.id])).toEqual({ n: 0 });
  });

  it("answers 503 when no provider is configured", async () => {
    const { createApp } = await import("../../apps/api/src/app");
    const app = createApp({ db: h.db, config: h.config, provider: null });
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer x", "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(503);
  });
});

describe("funds and caps", () => {
  it("insufficient funds: 402 in each protocol's shape, no provider call, recorded as FAILED with no hold", async () => {
    const { s, key } = await funded(h, 10n);
    const calls = h.fake.calls.length;
    const r = await chat(key.secret, "hello", { max_tokens: 100 });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: { type: "insufficient_quota", code: "insufficient_funds" } });
    const a = await messages(key.secret, "hello");
    expect(a.status).toBe(402);
    expect(await a.json()).toMatchObject({ type: "error", error: { type: "billing_error" } });
    expect(h.fake.calls.length).toBe(calls);
    expect(await accountBalance(h.db, s.accountId)).toEqual({ posted: 10n, held: 0n, available: 10n });
    const st = await h.db.query<any>("select state, failure_code, outcome from requests where key_id=$1", [key.id]);
    expect(st).toEqual([{ state: "FAILED", failure_code: "INSUFFICIENT_FUNDS", outcome: "rejected" }, { state: "FAILED", failure_code: "INSUFFICIENT_FUNDS", outcome: "rejected" }]);
    // a stream request is refused the same way before any SSE starts
    const st2 = await chat(key.secret, "hello", { stream: true, max_tokens: 100 });
    expect(st2.status).toBe(402);
    expect(st2.headers.get("content-type")).toContain("application/json");
  });

  it("enforces the key spend cap (lifetime) with a distinct error code", async () => {
    const { key } = await funded(h, 50_000_000n, { spendCapMicrousd: "200" });
    const ok = await chat(key.secret, "a", { max_tokens: 10, "stream": false });
    expect(ok.status).toBe(200);
    await h.gateway.idle();
    let over: Response | null = null;
    for (let i = 0; i < 40 && !over; i++) {
      const r = await chat(key.secret, "a", { max_tokens: 10 });
      if (r.status !== 200) over = r;
      await h.gateway.idle();
    }
    expect(over?.status).toBe(402);
    expect(await over!.json()).toMatchObject({ error: { code: "key_spend_cap_exceeded" } });
    const spent = await one<{ t: string }>("select coalesce(sum(charge_microusd),0)::text t from usage_records u join requests r on r.id=u.request_id where r.key_id=$1", [key.id]);
    expect(BigInt(spent.t)).toBeLessThanOrEqual(200n);
  });

  it("A5: concurrent near-balance gateway requests cannot overspend", async () => {
    const hold = (() => {
      const bound = inputTokenUpperBound(["race [[fake:slow]] [[fake:output=4]]"]);
      return reservationUpperBound(bound, 100n, rates);
    })();
    const { s, key } = await funded(h, hold * 2n + hold / 2n);
    const calls = h.fake.calls.length;
    const rs = await Promise.all(Array.from({ length: 8 }, () => chat(key.secret, "race [[fake:slow]] [[fake:output=4]]", { max_tokens: 100 })));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(codes.filter((c) => c === 402)).toHaveLength(6);
    await Promise.all(rs.map((r) => r.text()));
    await h.gateway.idle();
    expect(h.fake.calls.length - calls).toBe(2);
    const bal = await accountBalance(h.db, s.accountId);
    expect(bal.posted).toBeGreaterThan(0n);
    expect(bal.held).toBe(0n);
    expect(bal.posted).toBeLessThan(hold * 2n + hold / 2n);
    expect(await verifyLedger(h.db)).toEqual({ unbalancedTransactions: [], totalSum: 0n });
  });

  it("per-key concurrency and rate limits return 429 with Retry-After", async () => {
    const g = await makeGatewayHarness({ maxConcurrentPerKey: 1, providerTimeoutMs: 2000 });
    try {
      const s = await login(g.app);
      await fund(g, s.accountId, 5_000_000n);
      const key = await createKey(g, s);
      const slow = g.gwApp.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ model: "sample-fast-1", max_tokens: 20, messages: [{ role: "user", content: "[[fake:slow]] [[fake:output=6]]" }] }) });
      await new Promise((r) => setTimeout(r, 30));
      const blocked = await g.gwApp.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ model: "sample-fast-1", max_tokens: 5, messages: [{ role: "user", content: "x" }] }) });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      await (await slow).text();
      await g.gateway.idle();
    } finally {
      await g.db.close();
    }
  });
});

describe("faults: timeout, missing usage, disconnect, mid-stream error, provider rejection", () => {
  it("pre-dispatch style rejection releases the hold immediately and charges nothing (stream and non-stream)", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const a = await chat(key.secret, "x [[fake:reject]]", { max_tokens: 10 });
    expect(a.status).toBe(502);
    expect(await a.json()).toMatchObject({ error: { code: "upstream_error" } });
    const b = await chat(key.secret, "x [[fake:reject]]", { max_tokens: 10, stream: true });
    expect(b.status).toBe(502);
    expect(b.headers.get("content-type")).toContain("application/json"); // never JSON inside an SSE stream
    await h.gateway.idle();
    expect(await accountBalance(h.db, s.accountId)).toEqual({ posted: 5_000_000n, held: 0n, available: 5_000_000n });
    expect(await reqRow(reqId(a))).toMatchObject({ state: "FAILED", outcome: "rejected", failure_code: "PROVIDER_REJECTED" });
    expect(await spendRows(reqId(a))).toHaveLength(0);
  });

  it("timeout after dispatch: 504, no retry, hold kept as USAGE_PENDING, then reconciled by the worker", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const calls = h.fake.calls.length;
    const r = await chat(key.secret, "slow [[fake:hang]]", { max_tokens: 10 });
    expect(r.status).toBe(504);
    expect(await r.json()).toMatchObject({ error: { code: "upstream_timeout" } });
    await h.gateway.idle();
    expect(h.fake.calls.length - calls).toBe(1); // exactly one provider call: no retry
    const id = reqId(r);
    expect(await reqRow(id)).toMatchObject({ state: "USAGE_PENDING", failure_code: "PROVIDER_TIMEOUT" });
    const held = (await accountBalance(h.db, s.accountId)).held;
    expect(held).toBeGreaterThan(0n);
    expect(await spendRows(id)).toHaveLength(0);

    const recon = () => reconcileUsage({ db: h.db, source: h.fake, now: h.config.now, newId: randomId });
    expect((await recon()).stillPending).toContain(id);
    expect((await accountBalance(h.db, s.accountId)).held).toBe(held);
    advance(h, h.config.gateway.usagePendingSeconds + 1);
    const rep = await recon();
    expect(rep.absorbed).toContain(id);
    expect(await accountBalance(h.db, s.accountId)).toEqual({ posted: 5_000_000n, held: 0n, available: 5_000_000n });
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "usage_unresolved" });
    expect(await transitions(id)).toEqual(["VALIDATED", "RESERVED", "DISPATCHED", "USAGE_PENDING", "SETTLED"]);
    // Never charged later: a second pass and a late settlement attempt are no-ops.
    expect((await recon()).absorbed).not.toContain(id);
    expect(await spendRows(id)).toHaveLength(0);
  });

  it("missing usage: response is returned without invented usage, request is USAGE_PENDING, worker settles verified late usage once", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "m [[fake:late_usage]] [[fake:output=8]]", { max_tokens: 30 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.usage).toBeUndefined();
    await h.gateway.idle();
    const id = reqId(r);
    expect(await reqRow(id)).toMatchObject({ state: "USAGE_PENDING", failure_code: "USAGE_MISSING" });
    const bal = await accountBalance(h.db, s.accountId);
    expect(bal.held).toBeGreaterThan(0n);
    expect(bal.posted).toBe(5_000_000n);
    expect(await one("select usage_source from usage_records where request_id=$1", [id])).toEqual({ usage_source: "none" });

    const recon = () => reconcileUsage({ db: h.db, source: h.fake, now: h.config.now, newId: randomId });
    const first = await recon();
    expect(first.settled).toContain(id);
    expect((await recon()).settled).not.toContain(id);
    const u = await usageOf(id);
    expect(u).toMatchObject({ o: "8", usage_source: "provider" });
    const charge = chargeFor({ inputTokens: BigInt(u.i), cachedInputTokens: 0n, outputTokens: 8n }, rates);
    expect(await spendRows(id)).toEqual([{ amount: `-${charge}`, pv: expect.any(String) }]);
    expect(await accountBalance(h.db, s.accountId)).toEqual({ posted: 5_000_000n - charge, held: 0n, available: 5_000_000n - charge });
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "succeeded" });
  });

  it("missing usage on a stream leaves it USAGE_PENDING and ends the stream cleanly without a usage chunk", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "m [[fake:no_usage]] [[fake:output=3]]", { stream: true, stream_options: { include_usage: true }, max_tokens: 30 });
    const { frames } = await sse(r);
    expect(frames.at(-1)!.data).toBe("[DONE]");
    expect(frames.slice(0, -1).some((f) => JSON.parse(f.data).usage)).toBe(false);
    await h.gateway.idle();
    expect(await reqRow(reqId(r))).toMatchObject({ state: "USAGE_PENDING" });
  });

  it("client disconnect mid-stream: upstream cancelled, partial verified usage is charged once", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "go [[fake:slow]] [[fake:output=50]]", { stream: true, max_tokens: 100 });
    const reader = r.body!.getReader();
    await reader.read(); // role chunk
    await reader.read(); // first delta
    await reader.cancel();
    await h.gateway.idle();
    const id = reqId(r);
    const st = await reqRow(id);
    expect(st).toMatchObject({ state: "SETTLED", outcome: "cancelled" });
    const u = await usageOf(id);
    expect(Number(u.o)).toBeGreaterThanOrEqual(1);
    expect(Number(u.o)).toBeLessThan(50);
    const rows = await spendRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(`-${u.ch}`);
    expect(await accountBalance(h.db, s.accountId)).toMatchObject({ held: 0n });
    expect(await transitions(id)).toEqual(["VALIDATED", "RESERVED", "DISPATCHED", "CANCELLED", "SETTLED"]);
  });

  it("client disconnect during a non-streaming call is settled from the provider's verified usage", async () => {
    const { key } = await funded(h, 5_000_000n);
    const ac = new AbortController();
    const p = chat(key.secret, "go [[fake:slow]] [[fake:output=30]]", { max_tokens: 60 }, {}, ac.signal);
    setTimeout(() => ac.abort(), 60);
    await p.catch(() => undefined);
    await h.gateway.idle();
    const row = await one<any>("select id, state, outcome from requests where key_id=$1 order by created_at desc limit 1", [key.id]);
    expect(row.state).toBe("SETTLED");
    expect(row.outcome).toBe("cancelled");
    expect(await spendRows(row.id)).toHaveLength(1);
  });

  it("mid-stream provider error (OpenAI): protocol error event, stream closes without [DONE], partial usage charged once", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "x [[fake:error_after=3]] [[fake:output=10]]", { stream: true, max_tokens: 50 });
    expect(r.status).toBe(200);
    const { frames, raw } = await sse(r);
    const last = JSON.parse(frames.at(-1)!.data);
    expect(last).toEqual({ error: { message: expect.any(String), type: "server_error", param: null, code: "upstream_error" } });
    expect(raw).not.toContain("[DONE]");
    expect(frames.filter((f) => /"content":" ?tok/.test(f.data))).toHaveLength(3);
    await h.gateway.idle();
    const id = reqId(r);
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "failed", failure_code: "UPSTREAM_ERROR" });
    expect((await usageOf(id)).o).toBe("3");
    expect(await spendRows(id)).toHaveLength(1);
    expect((await accountBalance(h.db, s.accountId)).held).toBe(0n);
  });

  it("mid-stream provider error (Anthropic): `event: error` frame, no further events, no usage -> USAGE_PENDING", async () => {
    const { key } = await funded(h, 5_000_000n);
    const r = await messages(key.secret, "x [[fake:error_after=2]] [[fake:no_usage]] [[fake:output=10]]", { stream: true });
    const { frames } = await sse(r);
    const last = frames.at(-1)!;
    expect(last.event).toBe("error");
    expect(JSON.parse(last.data)).toEqual({ type: "error", error: { type: "api_error", message: expect.any(String) } });
    expect(frames.map((f) => f.event)).not.toContain("message_stop");
    await h.gateway.idle();
    expect(await reqRow(reqId(r))).toMatchObject({ state: "USAGE_PENDING", failure_code: "UPSTREAM_ERROR" });
  });

  it("streaming timeout mid-stream emits an error event and keeps the request pending", async () => {
    const { key } = await funded(h, 5_000_000n);
    const g = await makeGatewayHarness({ providerTimeoutMs: 80 });
    try {
      const s = await login(g.app);
      await fund(g, s.accountId, 5_000_000n);
      const k = await createKey(g, s);
      const r = await g.gwApp.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k.secret}` }, body: JSON.stringify({ model: "sample-fast-1", stream: true, max_tokens: 100, messages: [{ role: "user", content: "[[fake:slow]] [[fake:output=60]]" }] }) });
      const { frames } = await sse(r);
      expect(JSON.parse(frames.at(-1)!.data).error.code).toBe("upstream_timeout");
      await g.gateway.idle();
      // the fake reports usage on abort, so this settles from verified partial usage rather than leaving it pending
      const row = await g.db.query<any>("select state, outcome from requests where account_id=$1", [s.accountId]);
      expect(row[0]).toMatchObject({ state: "SETTLED", outcome: "failed" });
    } finally {
      await g.db.close();
    }
    expect(key.id).toBeTruthy();
  });

  it("provider usage above the hold is clamped to the hold, excess recorded as absorbed", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "o [[fake:overrun]] [[fake:output=2]]", { max_tokens: 10 });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    const id = reqId(r);
    const u = await one<any>("select computed_charge_microusd::text c, charge_microusd::text ch, absorbed_microusd::text ab from usage_records where request_id=$1", [id]);
    const q = await reqRow(id);
    expect(BigInt(u.ch)).toBeLessThanOrEqual(BigInt(q.reserved));
    expect(BigInt(u.c) - BigInt(u.ch)).toBe(BigInt(u.ab));
    expect((await accountBalance(h.db, s.accountId)).posted).toBe(5_000_000n - BigInt(u.ch));
  });
});

describe("A6: price update through the gateway; GET /api/usage", () => {
  it("a later price version applies to new requests only and leaves old charges untouched", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const a = await chat(key.secret, "p [[fake:output=100]]", { max_tokens: 200 });
    await a.json();
    await h.gateway.idle();
    const idA = reqId(a);
    const chargeA = (await spendRows(idA))[0]!;
    await h.db.tx((q) =>
      registerPriceVersion(q, { id: "pv_raise_1", source: "test", effectiveAt: new Date("2026-10-18T12:30:00Z"), rates: [{ model: "sample-fast-1", inputMicrousdPerMtok: 500_000n, cachedInputMicrousdPerMtok: 50_000n, outputMicrousdPerMtok: 2_500_000n }] }, h.config.now()),
    );
    advance(h, 3600);
    const b = await chat(key.secret, "p [[fake:output=100]]", { max_tokens: 200 });
    await b.json();
    await h.gateway.idle();
    const chargeB = (await spendRows(reqId(b)))[0]!;
    expect(chargeB.pv).toBe("pv_raise_1");
    expect(BigInt(chargeB.amount)).toBeLessThan(BigInt(chargeA.amount)); // negative amounts: B is larger in magnitude
    expect(await spendRows(idA)).toEqual([chargeA]);
    expect((await usageOf(idA)).pv).toBe("pv_sample_2026-10-18");
    const [uA, uB] = [await usageOf(idA), await usageOf(reqId(b))];
    expect(uB.orate).toBe("2500000");
    expect(uA.orate).toBe(FAST.outputMicrousdPerMtok);
    expect(s.accountId).toBeTruthy();
  });

  it("lists account usage with filters and a stable cursor; matches the ledger; isolates accounts", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const key2 = await createKey(h, s);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      advance(h, 1);
      const r = await chat(i % 2 ? key2.secret : key.secret, `u${i} [[fake:output=${i + 1}]]`, { max_tokens: 20 }, { "X-Correlation-Id": `c${i}` });
      await r.json();
      ids.push(reqId(r));
      await h.gateway.idle();
    }
    advance(h, 1);
    await (await messages(key.secret, "anth")).json();
    await h.gateway.idle();

    const p1 = await call<any>(h.app, "GET", "/api/usage?limit=2", { cookie: s.cookie });
    expect(p1.status).toBe(200);
    const page1 = UsagePage.parse(p1.json);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const all = [...page1.items];
    let cursor = page1.nextCursor;
    while (cursor) {
      const p = UsagePage.parse((await call(h.app, "GET", `/api/usage?limit=2&cursor=${cursor}`, { cookie: s.cookie })).json);
      all.push(...p.items);
      cursor = p.nextCursor;
    }
    expect(all).toHaveLength(6);
    expect(all.slice(0, 5).map((u) => u.requestId)).toEqual(ids);
    expect(all.slice(0, 5).map((u) => u.correlationId)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(all.every((u) => u.status === "SETTLED" && u.model === "sample-fast-1")).toBe(true);
    // totals reconcile exactly with the ledger
    const usageTotal = all.reduce((n, u) => n + BigInt(u.chargeMicrousd), 0n);
    const ledgerTotal = BigInt((await one<{ t: string }>("select (-sum(e.amount))::text t from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where e.account_id=$1 and t.kind='spend' and e.ledger_account='customer_funds'", [s.accountId])).t);
    expect(usageTotal).toBe(ledgerTotal);
    expect(all.every((u) => BigInt(u.inputTokens) >= 0n && u.priceVersion)).toBe(true);

    const byKey = UsagePage.parse((await call(h.app, "GET", `/api/usage?keyId=${key2.id}`, { cookie: s.cookie })).json);
    expect(byKey.items).toHaveLength(2);
    expect(byKey.items.every((u) => u.keyId === key2.id)).toBe(true);
    expect(UsagePage.parse((await call(h.app, "GET", "/api/usage?model=sample-lite-1", { cookie: s.cookie })).json).items).toEqual([]);
    expect(UsagePage.parse((await call(h.app, "GET", "/api/usage?status=USAGE_PENDING", { cookie: s.cookie })).json).items).toEqual([]);
    const win = UsagePage.parse((await call(h.app, "GET", `/api/usage?from=${all[1]!.createdAt}&to=${all[3]!.createdAt}`, { cookie: s.cookie })).json);
    expect(win.items.map((u) => u.requestId)).toEqual([all[1]!.requestId, all[2]!.requestId]);

    const stranger = await login(h.app);
    expect(UsagePage.parse((await call(h.app, "GET", "/api/usage", { cookie: stranger.cookie })).json).items).toEqual([]);
    expect((await call(h.app, "GET", "/api/usage")).status).toBe(401);
    expect((await call(h.app, "GET", "/api/usage?status=NOPE", { cookie: s.cookie })).status).toBe(422);
  });

  it("the whole ledger still balances to zero after every scenario above", async () => {
    expect(await verifyLedger(h.db)).toEqual({ unbalancedTransactions: [], totalSum: 0n });
    const held = await one<{ n: string }>("select count(*)::text n from reservations where status='active' and request_id in (select id from requests where state in ('SETTLED','FAILED','CANCELLED'))");
    expect(held.n).toBe("0");
  });
});
