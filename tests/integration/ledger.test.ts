/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Balance, ErrorEnvelope, LedgerPage } from "@llmcrypto/contracts";
import {
  accountBalance, beginRequest, chargeFor, failWithoutCharge, markDispatched, registerPriceVersion, releaseReservation, settleRequest,
  verifyLedger, type RateSnapshot,
} from "@llmcrypto/domain";
import { randomId } from "../../apps/api/src/crypto";
import { devCreditAccount } from "../../apps/api/src/dev/credit";
import { BASE_TIME, call, login, makeHarness, seedMember, type Harness } from "./helpers";
import { createKey, fund } from "./metering-helpers";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
  await h.db.tx((q) =>
    registerPriceVersion(q, { id: "pv_t1", source: "test", effectiveAt: new Date("2026-01-01T00:00:00Z"), rates: [{ model: "m", inputMicrousdPerMtok: 3_000_000n, cachedInputMicrousdPerMtok: 300_000n, outputMicrousdPerMtok: 15_000_000n }] }, BASE_TIME),
  );
});
afterAll(async () => {
  await h.db.close();
});

const rates = (pv = "pv_t1"): RateSnapshot => ({ priceVersion: pv, model: "m", inputMicrousdPerMtok: 3_000_000n, cachedInputMicrousdPerMtok: 300_000n, outputMicrousdPerMtok: 15_000_000n });

async function begin(accountId: string, amount: bigint, o: { keyId?: string | null; projectId?: string | null; rates?: RateSnapshot } = {}) {
  const id = randomId("req");
  const r = await beginRequest(h.db, {
    id, accountId, keyId: o.keyId ?? null, projectId: o.projectId ?? null, runId: null, parentId: null, correlationId: null,
    protocol: "openai_chat", model: "m", stream: false, rates: o.rates ?? rates(), reservedMicrousd: amount, at: h.config.now(), newId: randomId,
  });
  return { id, r };
}
const usage = (i: bigint, c: bigint, o: bigint) => ({ inputTokens: i, cachedInputTokens: c, outputTokens: o });

describe("schema invariants", () => {
  it("rejects an unbalanced ledger transaction at commit", async () => {
    const s = await login(h.app);
    await expect(
      h.db.tx(async (q) => {
        await q.query("insert into ledger_transactions (id, account_id, kind, source_type, source_id, reason, created_at) values ('ltx_bad',$1,'adjustment','adjustment','bad1','x',$2)", [s.accountId, BASE_TIME]);
        await q.query("insert into ledger_entries (id, transaction_id, ledger_account, account_id, amount, created_at) values ('le_b1','ltx_bad','customer_funds',$1,100,$2)", [s.accountId, BASE_TIME]);
        await q.query("insert into ledger_entries (id, transaction_id, ledger_account, account_id, amount, created_at) values ('le_b2','ltx_bad','funding_source',null,-99,$1)", [BASE_TIME]);
      }),
    ).rejects.toThrow(/unbalanced/);
    expect(await h.db.query("select 1 from ledger_transactions where id='ltx_bad'")).toHaveLength(0);
  });

  it("rejects a transaction without entries, zero amounts, and any update or delete", async () => {
    const s = await login(h.app);
    await expect(
      h.db.query("insert into ledger_transactions (id, account_id, kind, source_type, source_id, reason, created_at) values ('ltx_empty',$1,'adjustment','adjustment','e1','x',$2)", [s.accountId, BASE_TIME]),
    ).rejects.toThrow(/at least two entries/);
    const { transactionId } = await devCreditAccount(h.db, { accountId: s.accountId, amountMicrousd: 5n, at: BASE_TIME });
    await expect(h.db.query("update ledger_entries set amount = amount + 1 where transaction_id=$1", [transactionId])).rejects.toThrow(/append-only/);
    await expect(h.db.query("delete from ledger_entries where transaction_id=$1", [transactionId])).rejects.toThrow(/append-only/);
    await expect(h.db.query("delete from ledger_transactions where id=$1", [transactionId])).rejects.toThrow(/append-only/);
    await expect(h.db.query("update price_rates set output_microusd_per_mtok = 1 where price_version_id='pv_t1'")).rejects.toThrow(/append-only/);
    await expect(h.db.query("update price_versions set source='x' where id='pv_t1'")).rejects.toThrow(/append-only/);
  });

  it("price versions: identical re-registration is a no-op, changed rates under the same id are refused", async () => {
    const same = { id: "pv_t1", source: "test", effectiveAt: new Date("2026-01-01T00:00:00Z"), rates: [{ model: "m", inputMicrousdPerMtok: 3_000_000n, cachedInputMicrousdPerMtok: 300_000n, outputMicrousdPerMtok: 15_000_000n }] };
    expect(await h.db.tx((q) => registerPriceVersion(q, same, BASE_TIME))).toBe("exists");
    await expect(h.db.tx((q) => registerPriceVersion(q, { ...same, rates: [{ ...same.rates[0]!, outputMicrousdPerMtok: 1n }] }, BASE_TIME))).rejects.toThrow(/different rates/);
  });
});

describe("dev credit and balance/ledger endpoints", () => {
  it("serves real balance values: posted, held and available separately", async () => {
    const s = await login(h.app);
    expect((await call(h.app, "GET", "/api/accounts/current/balance")).status).toBe(401);
    let b = Balance.parse((await call(h.app, "GET", "/api/accounts/current/balance", { cookie: s.cookie })).json);
    expect(b).toMatchObject({ postedMicrousd: "0", heldMicrousd: "0", availableMicrousd: "0" });
    await fund(h, s.accountId, 1_000_000n);
    const held = await begin(s.accountId, 400_000n);
    expect(held.r.ok).toBe(true);
    b = Balance.parse((await call(h.app, "GET", "/api/accounts/current/balance", { cookie: s.cookie })).json);
    expect(b).toMatchObject({ postedMicrousd: "1000000", heldMicrousd: "400000", availableMicrousd: "600000" });
    await failWithoutCharge(h.db, held.id, { code: "TEST", at: h.config.now() });
    b = Balance.parse((await call(h.app, "GET", "/api/accounts/current/balance", { cookie: s.cookie })).json);
    expect(b).toMatchObject({ heldMicrousd: "0", availableMicrousd: "1000000" });
  });

  it("dev credit is not an HTTP route and refuses production", async () => {
    const s = await login(h.app);
    for (const path of ["/api/dev/credit", "/api/credit", "/api/accounts/current/credit", "/api/ledger/credit"]) {
      const r = await call(h.app, "POST", path, { cookie: s.cookie, body: { amountMicrousd: "1" } });
      expect([404, 405]).toContain(r.status);
    }
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(devCreditAccount(h.db, { accountId: s.accountId, amountMicrousd: 1n, at: BASE_TIME })).rejects.toThrow(/production/);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
    await expect(devCreditAccount(h.db, { accountId: s.accountId, amountMicrousd: 0n, at: BASE_TIME })).rejects.toThrow();
    await expect(devCreditAccount(h.db, { accountId: "acc_nope", amountMicrousd: 1n, at: BASE_TIME })).rejects.toThrow(/unknown account/);
  });

  it("GET /api/ledger: billing role only, cursor paging, kind filter, account isolation", async () => {
    const s = await login(h.app);
    const other = await login(h.app);
    for (let i = 1; i <= 5; i++) {
      h.clock.now = new Date(BASE_TIME.getTime() + i * 1000);
      await fund(h, s.accountId, BigInt(i) * 1000n);
    }
    await fund(h, other.accountId, 777n);
    const billing = await seedMember(h, s.accountId, "billing");
    const admin = await seedMember(h, s.accountId, "admin");
    const member = await seedMember(h, s.accountId, "member");
    for (const m of [admin, member]) expect((await call(h.app, "GET", "/api/ledger", { cookie: m.cookie })).status).toBe(403);
    expect((await call(h.app, "GET", "/api/ledger")).status).toBe(401);

    const p1 = await call<any>(h.app, "GET", "/api/ledger?limit=2", { cookie: billing.cookie });
    expect(p1.status).toBe(200);
    const page1 = LedgerPage.parse(p1.json);
    expect(page1.items.map((e) => e.amountMicrousd)).toEqual(["1000", "2000"]);
    expect(page1.nextCursor).not.toBeNull();
    const seen = [...page1.items];
    let cursor = page1.nextCursor;
    while (cursor) {
      const p = LedgerPage.parse((await call(h.app, "GET", `/api/ledger?limit=2&cursor=${cursor}`, { cookie: s.cookie })).json);
      seen.push(...p.items);
      cursor = p.nextCursor;
    }
    expect(seen.map((e) => e.amountMicrousd)).toEqual(["1000", "2000", "3000", "4000", "5000"]);
    expect(seen.every((e) => e.kind === "adjustment" && e.source.type === "adjustment" && e.priceVersion === null)).toBe(true);
    expect(LedgerPage.parse((await call(h.app, "GET", "/api/ledger?kind=spend", { cookie: s.cookie })).json).items).toEqual([]);
    expect(LedgerPage.parse((await call(h.app, "GET", `/api/ledger?from=${new Date(BASE_TIME.getTime() + 3000).toISOString()}`, { cookie: s.cookie })).json).items).toHaveLength(3);
    const bad = await call<any>(h.app, "GET", "/api/ledger?cursor=garbage", { cookie: s.cookie });
    expect(bad.status).toBe(400);
    ErrorEnvelope.parse(bad.json);
    expect((await call<any>(h.app, "GET", "/api/ledger?limit=500", { cookie: s.cookie })).status).toBe(422);
    h.clock.now = new Date(BASE_TIME);
  });
});

describe("A5: concurrent near-balance reservations cannot overspend", () => {
  it("exactly floor(balance / hold) of N concurrent reservations succeed", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 1_000_000n);
    const results = await Promise.all(Array.from({ length: 20 }, () => begin(s.accountId, 300_000n)));
    const ok = results.filter((x) => x.r.ok);
    expect(ok).toHaveLength(3);
    expect(results.filter((x) => !x.r.ok && x.r.reason === "INSUFFICIENT_FUNDS")).toHaveLength(17);
    const b = await accountBalance(h.db, s.accountId);
    expect(b).toEqual({ posted: 1_000_000n, held: 900_000n, available: 100_000n });
    const rows = await h.db.query<{ n: string }>("select count(*)::text as n from reservations where account_id=$1 and status='active'", [s.accountId]);
    expect(rows[0]!.n).toBe("3");
    // Refused requests are recorded but hold nothing.
    const refused = await h.db.query<{ state: string; failure_code: string }>("select state, failure_code from requests where account_id=$1 and state='FAILED'", [s.accountId]);
    expect(refused).toHaveLength(17);
    expect(new Set(refused.map((r) => r.failure_code))).toEqual(new Set(["INSUFFICIENT_FUNDS"]));
  });

  it("settling concurrently with new reservations never lets holds + charges exceed posted funds", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 1_000_000n);
    const first = await begin(s.accountId, 900_000n);
    expect(first.r.ok).toBe(true);
    await markDispatched(h.db, first.id, "prov_x", h.config.now());
    const racing = Promise.all([
      settleRequest(h.db, { requestId: first.id, usage: usage(10n, 0n, 10n), outcome: "succeeded", at: h.config.now(), newId: randomId }),
      ...Array.from({ length: 6 }, () => begin(s.accountId, 400_000n)),
    ]);
    await racing;
    const b = await accountBalance(h.db, s.accountId);
    expect(b.posted).toBeGreaterThanOrEqual(0n);
    expect(b.held).toBeLessThanOrEqual(b.posted);
    expect(b.posted + 0n).toBe(1_000_000n - chargeFor(usage(10n, 0n, 10n), rates()));
  });

  it("key and project spend caps are enforced atomically with the balance check", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 10_000_000n);
    const key = await createKey(h, s, { spendCapMicrousd: "500000" });
    const results = await Promise.all(Array.from({ length: 10 }, () => begin(s.accountId, 200_000n, { keyId: key.id })));
    expect(results.filter((x) => x.r.ok)).toHaveLength(2);
    expect(results.filter((x) => !x.r.ok && x.r.reason === "KEY_CAP_EXCEEDED")).toHaveLength(8);

    const projectId = randomId("prj");
    await h.db.query("insert into projects (id, account_id, name, created_at, spend_cap_microusd) values ($1,$2,'p',$3,350000)", [projectId, s.accountId, BASE_TIME]);
    const pr = await Promise.all(Array.from({ length: 6 }, () => begin(s.accountId, 100_000n, { projectId })));
    expect(pr.filter((x) => x.r.ok)).toHaveLength(3);
    expect(pr.filter((x) => !x.r.ok && x.r.reason === "PROJECT_CAP_EXCEEDED")).toHaveLength(3);
  });

  it("a settled charge counts against the key cap; a released hold does not", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 10_000_000n);
    const key = await createKey(h, s, { spendCapMicrousd: "100" });
    const a = await begin(s.accountId, 100n, { keyId: key.id });
    expect(a.r.ok).toBe(true);
    expect((await begin(s.accountId, 1n, { keyId: key.id })).r).toMatchObject({ ok: false, reason: "KEY_CAP_EXCEEDED" });
    await failWithoutCharge(h.db, a.id, { code: "T", at: h.config.now() });
    const b = await begin(s.accountId, 100n, { keyId: key.id });
    expect(b.r.ok).toBe(true);
    await markDispatched(h.db, b.id, "prov_b", h.config.now());
    await settleRequest(h.db, { requestId: b.id, usage: usage(1n, 0n, 6n), outcome: "succeeded", at: h.config.now(), newId: randomId }); // 3 + 90 = 93
    expect((await begin(s.accountId, 8n, { keyId: key.id })).r).toMatchObject({ ok: false, reason: "KEY_CAP_EXCEEDED" });
    expect((await begin(s.accountId, 7n, { keyId: key.id })).r.ok).toBe(true);
  });
});

describe("idempotent settle and release", () => {
  it("settling the same request many times (concurrently) posts one spend", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 1_000_000n);
    const { id } = await begin(s.accountId, 100_000n);
    await markDispatched(h.db, id, "prov_1", h.config.now());
    const u = usage(1000n, 0n, 500n); // 3_000_000_000 + 7_500_000_000 -> 10_500
    const res = await Promise.all(Array.from({ length: 8 }, () => settleRequest(h.db, { requestId: id, usage: u, outcome: "succeeded", at: h.config.now(), newId: randomId })));
    expect(res.every((r) => r.status === "settled" && r.chargeMicrousd === 10_500n)).toBe(true);
    expect(res.filter((r) => r.status === "settled" && !r.alreadySettled)).toHaveLength(1);
    const spends = await h.db.query<{ amount: string }>(
      "select e.amount::text as amount from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.source_id=$1 and t.kind='spend' and e.ledger_account='customer_funds'", [id]);
    expect(spends).toEqual([{ amount: "-10500" }]);
    expect(await accountBalance(h.db, s.accountId)).toEqual({ posted: 989_500n, held: 0n, available: 989_500n });
    const [u1] = await h.db.query<any>("select input_tokens::text i, cached_input_tokens::text c, output_tokens::text o, charge_microusd::text ch, absorbed_microusd::text ab, usage_source, settled_at from usage_records where request_id=$1", [id]);
    expect(u1).toMatchObject({ i: "1000", c: "0", o: "500", ch: "10500", ab: "0", usage_source: "provider" });
    const trans = await h.db.query<{ to_state: string }>("select to_state from request_transitions where request_id=$1 order by id", [id]);
    expect(trans.map((t) => t.to_state)).toEqual(["VALIDATED", "RESERVED", "DISPATCHED", "SUCCEEDED", "SETTLED"]);
    // A later "different" settlement for the same request cannot change the charge.
    const again = await settleRequest(h.db, { requestId: id, usage: usage(1n, 0n, 1n), outcome: "succeeded", at: h.config.now(), newId: randomId });
    expect(again).toMatchObject({ status: "settled", chargeMicrousd: 10_500n, alreadySettled: true });
    expect((await accountBalance(h.db, s.accountId)).posted).toBe(989_500n);
  });

  it("release is idempotent, a released hold cannot be settled, a settled hold cannot be released", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 1_000_000n);
    const a = await begin(s.accountId, 200_000n);
    await markDispatched(h.db, a.id, "prov_a", h.config.now());
    await failWithoutCharge(h.db, a.id, { code: "X", at: h.config.now() });
    await failWithoutCharge(h.db, a.id, { code: "X", at: h.config.now() });
    expect(await h.db.tx((q) => releaseReservation(q, a.id, h.config.now()))).toBe("released");
    expect(await settleRequest(h.db, { requestId: a.id, usage: usage(1n, 0n, 1n), outcome: "succeeded", at: h.config.now(), newId: randomId })).toMatchObject({ status: "not_settleable" });
    expect(await accountBalance(h.db, s.accountId)).toMatchObject({ posted: 1_000_000n, held: 0n });

    const b = await begin(s.accountId, 200_000n);
    await markDispatched(h.db, b.id, "prov_b", h.config.now());
    await settleRequest(h.db, { requestId: b.id, usage: usage(1n, 0n, 1n), outcome: "succeeded", at: h.config.now(), newId: randomId });
    expect(await h.db.tx((q) => releaseReservation(q, b.id, h.config.now()))).toBe("settled");
    await failWithoutCharge(h.db, b.id, { code: "X", at: h.config.now() });
    const [st] = await h.db.query<{ state: string }>("select state from requests where id=$1", [b.id]);
    expect(st!.state).toBe("SETTLED");
    expect((await accountBalance(h.db, s.accountId)).posted).toBe(1_000_000n - 18n); // ceil((1*3e6 + 1*15e6)/1e6) = 18
  });

  it("usage above the hold is clamped to the hold and the excess is recorded as absorbed", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 1_000_000n);
    const { id } = await begin(s.accountId, 50n);
    await markDispatched(h.db, id, "prov_o", h.config.now());
    const r = await settleRequest(h.db, { requestId: id, usage: usage(0n, 0n, 100n), outcome: "succeeded", at: h.config.now(), newId: randomId }); // computed 1500
    expect(r).toMatchObject({ status: "settled", chargeMicrousd: 50n, absorbedMicrousd: 1450n });
    expect((await accountBalance(h.db, s.accountId)).posted).toBe(999_950n);
    const [u] = await h.db.query<any>("select computed_charge_microusd::text c, charge_microusd::text ch, absorbed_microusd::text ab from usage_records where request_id=$1", [id]);
    expect(u).toEqual({ c: "1500", ch: "50", ab: "1450" });
  });
});

describe("A6: price changes never rewrite earlier charges", () => {
  it("a new price version applies to new requests only; old ledger rows and usage snapshots are unchanged", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 10_000_000n);
    const u = usage(1000n, 0n, 500n);
    const old = await begin(s.accountId, 1_000_000n, { rates: rates("pv_t1") });
    await markDispatched(h.db, old.id, "p1", h.config.now());
    await settleRequest(h.db, { requestId: old.id, usage: u, outcome: "succeeded", at: h.config.now(), newId: randomId });

    await h.db.tx((q) =>
      registerPriceVersion(q, { id: "pv_t2", source: "test", effectiveAt: new Date("2026-06-01T00:00:00Z"), rates: [{ model: "m", inputMicrousdPerMtok: 6_000_000n, cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: 30_000_000n }] }, BASE_TIME),
    );
    const before = await h.db.query("select e.id, e.amount::text a, t.price_version_id from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.source_id=$1 order by e.id", [old.id]);

    const reservedBeforeChange = await begin(s.accountId, 1_000_000n, { rates: rates("pv_t1") }); // still holds the pv_t1 snapshot
    const fresh = await begin(s.accountId, 1_000_000n, { rates: { ...rates("pv_t2"), inputMicrousdPerMtok: 6_000_000n, cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: 30_000_000n } });
    for (const r of [reservedBeforeChange, fresh]) {
      await markDispatched(h.db, r.id, "p", h.config.now());
      await settleRequest(h.db, { requestId: r.id, usage: u, outcome: "succeeded", at: h.config.now(), newId: randomId });
    }
    const charge = async (id: string) => (await h.db.query<{ a: string; pv: string }>("select e.amount::text a, t.price_version_id pv from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.source_id=$1 and e.ledger_account='customer_funds'", [id]))[0];
    expect(await charge(old.id)).toEqual({ a: "-10500", pv: "pv_t1" });
    expect(await charge(reservedBeforeChange.id)).toEqual({ a: "-10500", pv: "pv_t1" }); // reserved before the change: keeps its snapshot
    expect(await charge(fresh.id)).toEqual({ a: "-21000", pv: "pv_t2" });
    expect(await h.db.query("select e.id, e.amount::text a, t.price_version_id from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where t.source_id=$1 order by e.id", [old.id])).toEqual(before);

    // The settled usage record is frozen, including its rate snapshot.
    await expect(h.db.query("update usage_records set charge_microusd=1 where request_id=$1", [old.id])).rejects.toThrow(/immutable/);
    await expect(h.db.query("update usage_records set output_rate_microusd=1 where request_id=$1", [old.id])).rejects.toThrow();
    const [snap] = await h.db.query<any>("select price_version_id pv, input_rate_microusd::text i, output_rate_microusd::text o from usage_records where request_id=$1", [old.id]);
    expect(snap).toEqual({ pv: "pv_t1", i: "3000000", o: "15000000" });
  });
});

describe("ledger zero-sum", () => {
  it("every transaction and the whole ledger sum to zero; customer balance equals credits minus spend", async () => {
    const report = await verifyLedger(h.db);
    expect(report).toEqual({ unbalancedTransactions: [], totalSum: 0n });
    const per = await h.db.query<{ account_id: string; posted: string; credits: string; spend: string }>(
      `select e.account_id, sum(e.amount)::text posted,
              coalesce(sum(e.amount) filter (where t.kind='adjustment'),0)::text credits,
              coalesce(-sum(e.amount) filter (where t.kind='spend'),0)::text spend
       from ledger_entries e join ledger_transactions t on t.id=e.transaction_id where e.ledger_account='customer_funds' group by e.account_id`,
    );
    expect(per.length).toBeGreaterThan(3);
    for (const r of per) expect(BigInt(r.posted)).toBe(BigInt(r.credits) - BigInt(r.spend));
    const [sys] = await h.db.query<{ f: string; r: string }>(
      "select coalesce(sum(amount) filter (where ledger_account='funding_source'),0)::text f, coalesce(sum(amount) filter (where ledger_account='revenue'),0)::text r from ledger_entries");
    const [cust] = await h.db.query<{ c: string }>("select sum(amount)::text c from ledger_entries where ledger_account='customer_funds'");
    expect(BigInt(sys!.f) + BigInt(sys!.r) + BigInt(cust!.c)).toBe(0n);
  });
});
