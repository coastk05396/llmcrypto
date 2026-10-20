/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageDetail } from "@llmcrypto/contracts";
import { call, login, seedMember } from "./helpers";
import { createKey, fund, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness();
});
afterAll(async () => {
  await h.db.close();
});

const chat = (secret: string, stream: boolean) =>
  h.gwApp.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "sample-fast-1", max_tokens: 20, stream, messages: [{ role: "user", content: "hello" }] }),
  });

describe("GET /api/usage/{id}", () => {
  it("returns the frozen rate snapshot, protocol, streaming, finish reason and latency, equal to the ledger; scoped by account and role", async () => {
    const s = await login(h.gwApp);
    await fund(h, s.accountId, 5_000_000n);
    const key = await createKey(h, s);
    for (const stream of [false, true]) {
      const res = await chat(key.secret, stream);
      expect(res.status).toBe(200);
      await res.text();
      await h.gateway.idle();
    }
    const list = (await call<any>(h.gwApp, "GET", "/api/usage", { cookie: s.cookie })).json.items as any[];
    expect(list).toHaveLength(2);
    for (const item of list) {
      const r = await call<any>(h.gwApp, "GET", `/api/usage/${item.requestId}`, { cookie: s.cookie });
      expect(r.status).toBe(200);
      const d = UsageDetail.parse(r.json);
      expect(d).toMatchObject({ requestId: item.requestId, protocol: "openai_chat", outcome: "succeeded", chargeMicrousd: item.chargeMicrousd, priceVersion: item.priceVersion });
      expect(d.rateSnapshot).toEqual({ inputMicrousdPerMtok: "250000", cachedInputMicrousdPerMtok: "25000", outputMicrousdPerMtok: "1250000" });
      expect(d.finishReason).toBeTruthy();
      expect(d.latencyMs).toBeGreaterThanOrEqual(0);
      expect(d.ledgerEntries.map((e) => e.amountMicrousd)).toEqual([`-${d.chargeMicrousd}`]);
      expect(d.ledgerTransactionId).toBe(d.ledgerEntries[0]!.transactionId);
      // lookups by usage record id work too
      expect((await call(h.gwApp, "GET", `/api/usage/${item.id}`, { cookie: s.cookie })).status).toBe(200);
    }
    expect(list.map((i) => i.requestId)).toHaveLength(2);
    const streams = await h.db.query<any>("select stream from requests where account_id=$1 order by created_at", [s.accountId]);
    expect(streams.map((x) => x.stream).sort()).toEqual([false, true]);
    const one = list[0].requestId;
    const other = await login(h.gwApp);
    expect((await call(h.gwApp, "GET", `/api/usage/${one}`, { cookie: other.cookie })).status).toBe(404);
    expect((await call(h.gwApp, "GET", `/api/usage/${one}`, { cookie: (await seedMember(h, s.accountId, "member")).cookie })).status).toBe(404);
    expect((await call(h.gwApp, "GET", `/api/usage/${one}`, { cookie: (await seedMember(h, s.accountId, "billing")).cookie })).status).toBe(200);
    expect((await call(h.gwApp, "GET", "/api/usage/req_nope", { cookie: s.cookie })).status).toBe(404);
    expect((await call(h.gwApp, "GET", `/api/usage/${one}`, {})).status).toBe(401);
  });
});
