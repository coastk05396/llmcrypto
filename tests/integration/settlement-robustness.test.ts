/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginRequest, getActiveRates, markDispatched, markUsagePending, resolveUnrecoverable, settleRequest, settleReservation, verifyLedger } from "@llmcrypto/domain";
import { randomId } from "../../apps/api/src/crypto";
import { ensureSamplePriceVersion } from "../../apps/api/src/gateway/prices";
import { reconcileUsage } from "../../apps/worker/src/reconcile-usage";
import { advance, login } from "./helpers";
import { createKey, fund, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness({ providerTimeoutMs: 300 });
});
afterAll(async () => {
  await h.db.close();
});

const USAGE = { inputTokens: 100n, cachedInputTokens: 0n, outputTokens: 100n };
const chat = (secret: string, content: string) =>
  h.gwApp.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "sample-fast-1", max_tokens: 20, messages: [{ role: "user", content }] }),
  });

async function funded(micro = 20_000_000n) {
  const s = await login(h.gwApp);
  await fund(h, s.accountId, micro);
  return { s, key: await createKey(h, s) };
}
/** A RESERVED request with an active hold, created through the real domain path. */
async function reserved(accountId: string, amount = 5000n): Promise<string> {
  await ensureSamplePriceVersion(h.db, h.config.now());
  const rates = (await getActiveRates(h.db, "sample-fast-1", h.config.now()))!;
  const id = randomId("req");
  const b = await beginRequest(h.db, { id, accountId, keyId: null, projectId: null, runId: null, parentId: null, correlationId: null, protocol: "openai_chat", model: "sample-fast-1", stream: false, rates, reservedMicrousd: amount, at: h.config.now(), newId: randomId });
  expect(b.ok).toBe(true);
  return id;
}
const transitions = (id: string) => h.db.query<any>("select from_state, to_state, note from request_transitions where request_id=$1 order by id", [id]);
const reqRow = async (id: string) => (await h.db.query<any>("select state, outcome, failure_code from requests where id=$1", [id]))[0];

describe("dispatch failure", () => {
  it("a failed markDispatched releases the hold at once, calls no provider and answers 500 (not a provider error)", async () => {
    const { s, key } = await funded();
    await h.db.exec(`create function zz_block_dispatch() returns trigger language plpgsql as $$ begin raise exception 'injected dispatch failure'; end $$;
      create trigger zz_block_dispatch before update on requests for each row when (new.state = 'DISPATCHED') execute function zz_block_dispatch();`);
    try {
      const r = await chat(key.secret, "hello");
      const body: any = await r.json();
      expect(r.status).toBe(500);
      expect(body.error.code).toBe("internal_error");
      expect(JSON.stringify(body)).not.toContain("injected");
    } finally {
      await h.db.exec("drop trigger zz_block_dispatch on requests; drop function zz_block_dispatch()");
    }
    expect(h.fake.calls).toHaveLength(0);
    const [rq] = await h.db.query<any>("select r.id, r.state, r.outcome, r.failure_code, rs.status from requests r join reservations rs on rs.request_id = r.id where r.account_id=$1", [s.accountId]);
    expect(rq).toMatchObject({ state: "FAILED", outcome: "rejected", failure_code: "DISPATCH_FAILED", status: "released" });
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where kind='spend' and account_id=$1", [s.accountId]))[0].n).toBe(0);
  });
});

describe("stale RESERVED sweep", () => {
  it("releases holds that never reached the provider after the configured age, and only those", async () => {
    const { s } = await funded();
    const old = await reserved(s.accountId);
    advance(h, 1000);
    const fresh = await reserved(s.accountId);
    const rep = await reconcileUsage({ db: h.db, source: h.fake, now: () => h.config.now(), newId: randomId, staleReservedSeconds: 600 });
    expect(rep.releasedReserved).toEqual([old]);
    expect(await reqRow(old)).toMatchObject({ state: "FAILED", outcome: "rejected", failure_code: "NEVER_DISPATCHED" });
    expect((await h.db.query<any>("select status from reservations where request_id=$1", [old]))[0].status).toBe("released");
    expect(await reqRow(fresh)).toMatchObject({ state: "RESERVED" });
    expect((await h.db.query<any>("select status from reservations where request_id=$1", [fresh]))[0].status).toBe("active");
    // Idempotent: a second sweep finds nothing to do for the released one.
    expect((await reconcileUsage({ db: h.db, source: h.fake, now: () => h.config.now(), newId: randomId, staleReservedSeconds: 600 })).releasedReserved).toEqual([]);
  });
});

describe("settleRequest is exactly-once and never regresses", () => {
  it("double and interleaved settles: one spend, one set of transitions, the first outcome wins", async () => {
    const { s } = await funded();
    const id = await reserved(s.accountId, 50_000n);
    await markDispatched(h.db, id, "prov_x", h.config.now());
    const mk = (outcome: "succeeded" | "failed" | "cancelled") => settleRequest(h.db, { requestId: id, usage: USAGE, outcome, failureCode: outcome === "succeeded" ? undefined : "X", at: h.config.now(), newId: randomId });
    const results = await Promise.all([mk("succeeded"), mk("failed"), mk("cancelled"), mk("succeeded")]);
    expect(results.filter((r) => r.status === "settled" && !r.alreadySettled)).toHaveLength(1);
    expect(results.filter((r) => r.status === "settled" && r.alreadySettled)).toHaveLength(3);
    const charges = new Set(results.map((r) => (r.status === "settled" ? r.chargeMicrousd : -1n)));
    expect(charges.size).toBe(1);
    expect(await transitions(id)).toEqual([
      { from_state: null, to_state: "VALIDATED", note: null }, { from_state: "VALIDATED", to_state: "RESERVED", note: null },
      { from_state: "RESERVED", to_state: "DISPATCHED", note: null }, { from_state: "DISPATCHED", to_state: expect.stringMatching(/SUCCEEDED|FAILED|CANCELLED/), note: null },
      { from_state: expect.stringMatching(/SUCCEEDED|FAILED|CANCELLED/), to_state: "SETTLED", note: expect.any(String) },
    ]);
    const row = await reqRow(id);
    expect(row.outcome).toBe(row.state === "SETTLED" ? row.outcome : null);
    const [first] = await h.db.query<any>("select note from request_transitions where request_id=$1 and to_state='SETTLED'", [id]);
    expect(row.outcome).toBe(first.note);
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where source_type='request' and source_id=$1", [id]))[0].n).toBe(1);
    expect(await verifyLedger(h.db)).toMatchObject({ totalSum: 0n });
    // A later settle (any outcome) changes nothing.
    const before = await transitions(id);
    await mk("failed");
    expect(await transitions(id)).toEqual(before);
    expect((await reqRow(id)).outcome).toBe(first.note);
  });

  it("when another settler already posted the reservation, the call returns early and writes no request transitions", async () => {
    const { s } = await funded();
    const id = await reserved(s.accountId, 50_000n);
    await markDispatched(h.db, id, "prov_y", h.config.now());
    const other = await h.db.tx((q) => settleReservation(q, { requestId: id, computedCharge: 123n, reason: "other settler", at: h.config.now(), newId: randomId }));
    expect(other).toMatchObject({ status: "settled", alreadySettled: false });
    const before = await transitions(id);
    const r = await settleRequest(h.db, { requestId: id, usage: USAGE, outcome: "succeeded", at: h.config.now(), newId: randomId });
    expect(r).toMatchObject({ status: "settled", alreadySettled: true, chargeMicrousd: 123n });
    expect(await transitions(id)).toEqual(before);
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where source_type='request' and source_id=$1", [id]))[0].n).toBe(1);
  });
});

describe("resolveUnrecoverable checks state before touching the hold", () => {
  it("only a USAGE_PENDING request is absorbed; any other state keeps its hold", async () => {
    const { s } = await funded();
    const dispatched = await reserved(s.accountId);
    await markDispatched(h.db, dispatched, "prov_d", h.config.now());
    expect(await resolveUnrecoverable(h.db, dispatched, h.config.now())).toBe(false);
    expect((await h.db.query<any>("select status from reservations where request_id=$1", [dispatched]))[0].status).toBe("active");
    expect(await reqRow(dispatched)).toMatchObject({ state: "DISPATCHED" });

    const reservedOnly = await reserved(s.accountId);
    expect(await resolveUnrecoverable(h.db, reservedOnly, h.config.now())).toBe(false);
    expect((await h.db.query<any>("select status from reservations where request_id=$1", [reservedOnly]))[0].status).toBe("active");

    const pending = await reserved(s.accountId);
    await markDispatched(h.db, pending, "prov_p", h.config.now());
    await markUsagePending(h.db, pending, { code: "PROVIDER_TIMEOUT", deadline: h.config.now(), at: h.config.now() });
    expect(await resolveUnrecoverable(h.db, pending, h.config.now())).toBe(true);
    expect(await resolveUnrecoverable(h.db, pending, h.config.now())).toBe(false);
    expect(await reqRow(pending)).toMatchObject({ state: "SETTLED", outcome: "usage_unresolved" });
    expect((await transitions(pending)).filter((t: any) => t.to_state === "SETTLED")).toHaveLength(1);
    expect(await resolveUnrecoverable(h.db, randomId("req"), h.config.now())).toBe(false);
  });
});

describe("late reconciled usage keeps the original ending", () => {
  it.each([
    ["a provider timeout stays failed", "[[fake:hang]]", "failed", "PROVIDER_TIMEOUT"],
    ["a missing-usage success stays succeeded", "[[fake:late_usage]]", "succeeded", "USAGE_MISSING"],
  ])("%s", async (_n, directive, outcome, code) => {
    const { key } = await funded();
    const r = await chat(key.secret, `hello ${directive}`);
    await r.text();
    await h.gateway.idle();
    const requestId = r.headers.get("x-request-id")!;
    expect(await reqRow(requestId)).toMatchObject({ state: "USAGE_PENDING", failure_code: code });
    if (directive.includes("hang")) h.fake.recordLateUsage(`prov_${requestId}`, USAGE);
    const rep = await reconcileUsage({ db: h.db, source: h.fake, now: () => h.config.now(), newId: randomId });
    expect(rep.settled).toContain(requestId);
    expect(await reqRow(requestId)).toMatchObject({ state: "SETTLED", outcome, failure_code: code });
    expect((await transitions(requestId)).map((t: any) => t.to_state)).toEqual(["VALIDATED", "RESERVED", "DISPATCHED", "USAGE_PENDING", "SETTLED"]);
  });

  it("a client disconnect settled later is cancelled", async () => {
    const { s } = await funded();
    const id = await reserved(s.accountId, 50_000n);
    await markDispatched(h.db, id, `prov_${id}`, h.config.now());
    await markUsagePending(h.db, id, { code: "CLIENT_DISCONNECT", deadline: new Date(h.config.now().getTime() + 60_000), at: h.config.now() });
    h.fake.recordLateUsage(`prov_${id}`, USAGE);
    await reconcileUsage({ db: h.db, source: h.fake, now: () => h.config.now(), newId: randomId });
    expect(await reqRow(id)).toMatchObject({ state: "SETTLED", outcome: "cancelled", failure_code: "CLIENT_DISCONNECT" });
  });
});
