/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { beginRequest, getActiveRates, recordAlert, verifyLedger } from "@llmcrypto/domain";
import { randomId } from "../../apps/api/src/crypto";
import { loadConfig } from "../../apps/api/src/config";
import { createSession } from "../../apps/api/src/auth/session";
import { ensureSamplePriceVersion } from "../../apps/api/src/gateway/prices";
import { grantOperator, revokeOperator, syncConfiguredOperators } from "../../apps/api/src/operator/service";
import { reconcilePayments } from "../../apps/worker/src/reconcile-payments";
import { ingestTransfer } from "@llmcrypto/domain";
import { observeOnce } from "../../apps/worker/src/chain-observer";
import { FakeChainClient } from "../../apps/worker/src/fake-chain-client";
import { BASE_TIME, advance, call, login, makeHarness, seedMember, type Harness, type LoggedIn } from "./helpers";
import { createKey, fund, idemKey } from "./metering-helpers";
import { ROUTE_A, ROUTE_B, TOKEN_A, balanceOf, createDeposit, txHash } from "./payments-helpers";

const AMOUNT = 5_000_000n;
let h: Harness;
let chain: FakeChainClient;
beforeAll(async () => {
  const base = loadConfig({}).operator;
  h = await makeHarness({
    payments: { routes: [ROUTE_A, ROUTE_B], addressSource: "test", maxOpenIntents: 10 },
    operator: { ...base, stuckReservationSeconds: 60, adjustmentTtlSeconds: 600, adjustmentMaxMicrousd: 100_000_000n, elevationSeconds: 900, stepUpWindowSeconds: 300 },
  });
  chain = new FakeChainClient({ "testnet-a": "1001", "testnet-b": "2002" }, () => new Date(h.clock.now));
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

const op = <T = any>(who: { cookie: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call<T>(h.app, method, `/api/operator${path}`, { cookie: who.cookie, ...(body !== undefined ? { body } : {}), headers });
const propose = (who: { cookie: string }, body: Record<string, unknown>, key: string = idemKey()) => op<any>(who, "POST", "/adjustments", body, { "Idempotency-Key": key });
const approve = (who: { cookie: string }, id: string, body: Record<string, unknown> = {}) => op<any>(who, "POST", `/adjustments/${id}/approve`, body);
const rejectAdj = (who: { cookie: string }, id: string, body: Record<string, unknown> = {}) => op<any>(who, "POST", `/adjustments/${id}/reject`, body);

/** A signed-in user granted out-of-band (CLI path) and elevated for THIS session. */
async function newOperator(elevate = true): Promise<LoggedIn> {
  const s = await login(h.app);
  await grantOperator(h.db, { userId: s.userId, grantedBy: "cli", note: "test", at: h.config.now() });
  if (elevate) expect((await op(s, "POST", "/session")).status).toBe(200);
  return s;
}
const customer = async (micro = 0n): Promise<LoggedIn> => {
  const s = await login(h.app);
  if (micro > 0n) await fund(h, s.accountId, micro);
  return s;
};
const posted = async (accountId: string): Promise<bigint> => BigInt((await h.db.query<any>("select coalesce(sum(amount),0)::text s from ledger_entries where ledger_account='customer_funds' and account_id=$1", [accountId]))[0].s);

/** An open payment review (underpaid deposit) for a fresh customer. */
async function underpaidReview(): Promise<{ s: LoggedIn; reviewId: string }> {
  const s = await login(h.app);
  const d = await createDeposit(h, s, { network: "testnet-a", asset: "TUSD", amountAtomic: AMOUNT.toString() });
  chain.send({ network: "testnet-a", txHash: txHash(), assetContract: TOKEN_A, to: d.json.address, amountAtomic: AMOUNT - 1n });
  chain.mine("testnet-a", 5);
  await observeOnce({ db: h.db, client: chain, now: () => new Date(h.clock.now), newId: randomId });
  const [r] = await h.db.query<any>("select id from payment_reviews where deposit_id=$1 and status='open'", [d.json.id]);
  return { s, reviewId: r.id };
}

describe("privilege separation (A10)", () => {
  const routes: [string, string, unknown?][] = [
    ["GET", "/reconciliation"], ["GET", "/payment-reviews"], ["GET", "/payment-alerts"], ["POST", "/payment-alerts/x/resolve", { note: "reason" }], ["GET", "/stuck-reservations"],
    ["GET", "/ledger-mismatches"], ["GET", "/adjustments"], ["POST", "/adjustments", { accountId: "a", action: "credit", amountMicrousd: "5", reason: "ten chars+" }],
    ["POST", "/adjustments/x/approve", {}], ["POST", "/adjustments/x/reject", {}], ["POST", "/session"], ["DELETE", "/session"],
  ];

  it("customers of every role are refused everywhere (403), anonymous is 401, and no customer wallet or role confers operator powers", async () => {
    const owner = await customer(10_000_000n);
    const roles = [owner, await seedMember(h, owner.accountId, "admin"), await seedMember(h, owner.accountId, "billing"), await seedMember(h, owner.accountId, "member")];
    for (const who of roles) {
      for (const [m, path, body] of routes) {
        const r = await op<any>(who, m, path, body, { "Idempotency-Key": idemKey() });
        expect(r.status, `${m} ${path}`).toBe(403);
        expect(r.json.error.code).toBe("FORBIDDEN");
      }
      expect((await op<any>(who, "GET", "/session")).json).toEqual({ isOperator: false, elevated: false, elevatedUntil: null });
    }
    for (const [m, path, body] of routes) expect((await call(h.app, m, `/api/operator${path}`, { ...(body ? { body } : {}) })).status, `${m} ${path}`).toBe(401);
    // A wallet-backed account whose address could be anything still gets nothing: operator status is a row, never an address.
    const wallet = await login(h.app);
    expect((await op(wallet, "GET", "/reconciliation")).status).toBe(403);
  });

  it("there is no HTTP route that grants, edits or lists operators", async () => {
    const o = await newOperator();
    for (const [m, path] of [["POST", "/operators"], ["PUT", "/operators/x"], ["GET", "/operators"], ["POST", "/grant"], ["PATCH", "/session"]] as const) {
      const r = await op(o, m, path, m === "GET" ? undefined : { userId: o.userId });
      expect([404, 405]).toContain(r.status);
    }
    const c = await customer();
    expect((await call(h.app, "POST", "/api/operator/session", { cookie: c.cookie, body: { userId: c.userId } })).status).toBe(403);
    expect((await h.db.query<any>("select count(*)::int n from operators where user_id=$1", [c.userId]))[0].n).toBe(0);
  });

  it("API-key (restricted) sessions never reach operator routes, even for an operator's own key", async () => {
    const o = await newOperator();
    const key = await createKey(h, o, { scopes: ["usage:read"] });
    const sess = await h.db.tx((q) => createSession(q, h.config, o.userId, o.accountId, { kind: "api_key", methodRef: key.id }));
    const r = await op(({ cookie: `session=${sess.token}` }), "GET", "/reconciliation");
    expect(r.status).toBe(403);
  });

  it("step-up: an operator is not elevated by default, needs very recent authentication, and the elevation is per session and expires", async () => {
    const o = await newOperator(false);
    expect((await op<any>(o, "GET", "/session")).json).toEqual({ isOperator: true, elevated: false, elevatedUntil: null });
    for (const [m, path] of [["GET", "/reconciliation"], ["GET", "/payment-reviews"], ["GET", "/adjustments"]] as const) {
      const r = await op<any>(o, m, path);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("STEP_UP_REQUIRED");
    }
    advance(h, 301); // authenticated more than 300 s ago
    const late = await op<any>(o, "POST", "/session");
    expect(late.status).toBe(403);
    expect(late.json.error.code).toBe("STEP_UP_REQUIRED");

    h.clock.now = new Date(BASE_TIME);
    const fresh = await newOperator(); // new sign-in: elevation succeeds
    expect((await op(fresh, "GET", "/reconciliation")).status).toBe(200);
    // Another session of the same operator is NOT elevated (bound to the session row).
    const [{ account_id }] = await h.db.query<any>("select account_id from sessions where user_id=$1", [fresh.userId]);
    const second = await h.db.tx((q) => createSession(q, h.config, fresh.userId, account_id));
    expect((await op<any>({ cookie: `session=${second.token}` }, "GET", "/reconciliation")).json.error.code).toBe("STEP_UP_REQUIRED");
    // The elevation lapses by itself.
    advance(h, 901);
    expect((await op<any>(fresh, "GET", "/reconciliation")).json.error.code).toBe("STEP_UP_REQUIRED");
    // Ending it explicitly works too.
    h.clock.now = new Date(BASE_TIME);
    const again = await newOperator();
    expect((await op(again, "DELETE", "/session")).status).toBe(204);
    expect((await op<any>(again, "GET", "/reconciliation")).json.error.code).toBe("STEP_UP_REQUIRED");
    expect((await h.db.query<any>("select count(*)::int n from audit_events where action in ('operator.elevated','operator.elevation_ended') and actor_user_id=$1", [again.userId]))[0].n).toBe(2);
  });

  it("grants come from the CLI path or configuration only; revocation takes effect immediately; config is authoritative only for config grants", async () => {
    const a = await login(h.app);
    const b = await login(h.app);
    const cli = await newOperator();
    const cfg = { ...h.config, operator: { ...h.config.operator, configuredUserIds: [a.userId, "usr_does_not_exist"] } };
    expect(await syncConfiguredOperators(h.db, cfg)).toEqual({ granted: [a.userId], revoked: [], unknown: ["usr_does_not_exist"] });
    expect(await syncConfiguredOperators(h.db, cfg)).toEqual({ granted: [], revoked: [], unknown: ["usr_does_not_exist"] });
    expect((await op<any>(a, "GET", "/session")).json.isOperator).toBe(true);
    expect((await op<any>(b, "GET", "/session")).json.isOperator).toBe(false);
    // Removing a config grant from configuration revokes it; the CLI grant is untouched.
    expect(await syncConfiguredOperators(h.db, { ...cfg, operator: { ...cfg.operator, configuredUserIds: [] } })).toMatchObject({ revoked: [a.userId] });
    expect((await op<any>(a, "GET", "/session")).json.isOperator).toBe(false);
    expect((await op(cli, "GET", "/reconciliation")).status).toBe(200);
    // Revoking an active, elevated operator cuts access on the next request.
    expect(await revokeOperator(h.db, cli.userId, h.config.now())).toBe(true);
    expect((await op<any>(cli, "GET", "/reconciliation")).json.error.code).toBe("FORBIDDEN");
    expect((await h.db.query<any>("select count(*)::int n from operator_elevations where user_id=$1", [cli.userId]))[0].n).toBe(0);
    expect(await revokeOperator(h.db, cli.userId, h.config.now())).toBe(false);
  });

  it("an operator keeps ordinary customer access only to their own account", async () => {
    const o = await newOperator();
    const other = await customer(3_000_000n);
    await fund(h, o.accountId, 1_000_000n);
    const mine = await call<any>(h.app, "GET", "/api/accounts/current/balance", { cookie: o.cookie });
    expect(mine.json.postedMicrousd).toBe("1000000");
    expect((await call<any>(h.app, "GET", "/api/ledger", { cookie: o.cookie })).json.items.every((x: any) => x.amountMicrousd === "1000000")).toBe(true);
    expect(other.accountId).not.toBe(o.accountId);
  });
});

describe("reconciliation views", () => {
  it("payment reviews: open by default, resolved on request, paged, with the owning account", async () => {
    const o = await newOperator();
    const r1 = await underpaidReview();
    const r2 = await underpaidReview();
    const list = (await op<any>(o, "GET", "/payment-reviews?limit=1")).json;
    expect(list.items).toHaveLength(1);
    expect(list.nextCursor).toBeTruthy();
    const all = (await op<any>(o, "GET", "/payment-reviews?limit=100")).json.items;
    expect(all.map((x: any) => x.id)).toEqual(expect.arrayContaining([r1.reviewId, r2.reviewId]));
    expect(all.find((x: any) => x.id === r1.reviewId)).toMatchObject({ kind: "deposit", reason: "UNDERPAID", status: "open", accountId: r1.s.accountId, resolvedAt: null });
    expect((await op<any>(o, "GET", "/payment-reviews?status=resolved")).json.items.map((x: any) => x.id)).not.toContain(r1.reviewId);
    expect((await op(o, "GET", "/payment-reviews?status=bogus")).status).toBe(422);
  });

  it("alerts: list unresolved, resolve once (audited), resolved list", async () => {
    const o = await newOperator();
    const acct = await customer();
    const key = `test-alert-${randomId("k")}`;
    await recordAlert(h.db, { newId: randomId, dedupeKey: key, kind: "LEDGER_MISMATCH", severity: "critical", accountId: acct.accountId, details: { part: "x" }, at: h.config.now() });
    const open = (await op<any>(o, "GET", "/payment-alerts?limit=200")).json.items;
    const a = open.find((x: any) => x.details.part === "x" && x.accountId === acct.accountId);
    expect(a).toMatchObject({ kind: "LEDGER_MISMATCH", severity: "critical", resolvedAt: null });
    expect((await op(o, "POST", `/payment-alerts/${a.id}/resolve`, { note: "x" })).status).toBe(422);
    const res = await op<any>(o, "POST", `/payment-alerts/${a.id}/resolve`, { note: "checked against the ledger" });
    expect(res.status).toBe(200);
    expect(res.json.resolvedAt).toBeTruthy();
    expect((await op(o, "POST", `/payment-alerts/${a.id}/resolve`, { note: "again please" })).status).toBe(404);
    expect((await op<any>(o, "GET", "/payment-alerts?limit=200")).json.items.map((x: any) => x.id)).not.toContain(a.id);
    expect((await op<any>(o, "GET", "/payment-alerts?resolved=true&limit=200")).json.items.map((x: any) => x.id)).toContain(a.id);
    const aud = await h.db.query<any>("select account_id, metadata from audit_events where action='operator.alert_resolved' and target_id=$1", [a.id]);
    expect(aud[0]).toMatchObject({ account_id: acct.accountId, metadata: { note: "checked against the ledger" } });
  });

  it("stuck reservations: reported by reason and age, and gone once settled or released", async () => {
    const o = await newOperator();
    const c = await customer(20_000_000n);
    await ensureSamplePriceVersion(h.db, h.config.now());
    const rates = (await getActiveRates(h.db, "sample-fast-1", h.config.now()))!;
    const mk = async (state: "RESERVED" | "DISPATCHED" | "USAGE_PENDING", pastDeadline = false) => {
      const id = randomId("req");
      const b = await beginRequest(h.db, { id, accountId: c.accountId, keyId: null, projectId: null, runId: null, parentId: null, correlationId: null, protocol: "openai_chat", model: "sample-fast-1", stream: false, rates, reservedMicrousd: 1000n, at: h.config.now(), newId: randomId });
      expect(b.ok).toBe(true);
      if (state !== "RESERVED") await h.db.query("update requests set state=$2, dispatched_at=$3, usage_deadline=$4 where id=$1", [id, state, h.config.now(), new Date(h.config.now().getTime() + (pastDeadline ? 30_000 : 3_600_000))]);
      return id;
    };
    const a = await mk("RESERVED");
    const b = await mk("DISPATCHED");
    const p = await mk("USAGE_PENDING", true);
    const fresh = (await op<any>(o, "GET", "/stuck-reservations")).json;
    expect(fresh.items.filter((x: any) => x.accountId === c.accountId)).toEqual([]); // younger than the 60 s threshold
    advance(h, 120);
    const stuck = (await op<any>(o, "GET", "/stuck-reservations")).json.items.filter((x: any) => x.accountId === c.accountId);
    expect(Object.fromEntries(stuck.map((x: any) => [x.requestId, x.reason]))).toEqual({ [a]: "not_dispatched", [b]: "dispatched_stale", [p]: "usage_pending_past_deadline" });
    expect(stuck[0]).toMatchObject({ amountMicrousd: "1000", ageSeconds: 120 });
    await h.db.query("update reservations set status='released', closed_at=$2 where request_id=$1", [a, h.config.now()]);
    expect((await op<any>(o, "GET", "/stuck-reservations")).json.items.map((x: any) => x.requestId)).not.toContain(a);
  });

  it("ledger mismatches: consistent books report nothing; each class of disagreement is found", async () => {
    const o = await newOperator();
    const c = await customer(7_000_000n);
    expect((await op<any>(o, "GET", "/ledger-mismatches")).json).toEqual({ items: [], truncated: false });
    expect(await verifyLedger(h.db)).toMatchObject({ totalSum: 0n });
    // A settled spend whose reservation record disagrees with the ledger.
    await ensureSamplePriceVersion(h.db, h.config.now());
    const rates = (await getActiveRates(h.db, "sample-fast-1", h.config.now()))!;
    const rid = randomId("req");
    await beginRequest(h.db, { id: rid, accountId: c.accountId, keyId: null, projectId: null, runId: null, parentId: null, correlationId: null, protocol: "openai_chat", model: "sample-fast-1", stream: false, rates, reservedMicrousd: 5000n, at: h.config.now(), newId: randomId });
    const { markDispatched, settleRequest } = await import("@llmcrypto/domain");
    await markDispatched(h.db, rid, "prov_x", h.config.now());
    await settleRequest(h.db, { requestId: rid, usage: { inputTokens: 100n, cachedInputTokens: 0n, outputTokens: 100n }, outcome: "succeeded", at: h.config.now(), newId: randomId });
    expect((await op<any>(o, "GET", "/ledger-mismatches")).json.items).toEqual([]);
    await h.db.query("update reservations set charge_microusd = charge_microusd + 1 where request_id=$1", [rid]);
    const m = (await op<any>(o, "GET", "/ledger-mismatches")).json.items;
    expect(m.map((x: any) => x.kind).sort()).toEqual(["reservation_charge_mismatch", "usage_charge_mismatch"]);
    expect(m[0]).toMatchObject({ accountId: c.accountId });
    await h.db.query("update reservations set charge_microusd = charge_microusd - 1 where request_id=$1", [rid]);
    // Unbalanced entries and a negative balance (triggers bypassed on purpose, as a corrupted database would be).
    await h.db.exec("set session_replication_role = replica");
    const tx = randomId("ltx");
    await h.db.query("insert into ledger_transactions (id, account_id, kind, source_type, source_id, price_version_id, reason, created_at) values ($1,$2,'adjustment','adjustment',$3,null,'corrupt',$4)", [tx, c.accountId, randomId("src"), h.config.now()]);
    await h.db.query("insert into ledger_entries (id, transaction_id, ledger_account, account_id, amount, created_at) values ($1,$2,'customer_funds',$3,-99999999,$4)", [randomId("le"), tx, c.accountId, h.config.now()]);
    await h.db.exec("set session_replication_role = origin");
    const bad = (await op<any>(o, "GET", "/ledger-mismatches")).json.items;
    expect(bad.map((x: any) => x.kind).sort()).toEqual(["ledger_not_zero", "negative_balance", "unbalanced_transaction"]);
    expect(bad.find((x: any) => x.kind === "negative_balance")).toMatchObject({ accountId: c.accountId, actualMicrousd: expect.stringMatching(/^-/) });
    const summary = (await op<any>(o, "GET", "/reconciliation")).json;
    expect(summary.ledgerMismatches).toBe(3);
    expect(summary).toMatchObject({ openReviews: expect.any(Number), openAlerts: expect.any(Number), stuckReservations: expect.any(Number), pendingAdjustments: expect.any(Number) });
    // Put the corruption right so later tests start from consistent books.
    await h.db.exec("set session_replication_role = replica");
    await h.db.query("delete from ledger_entries where transaction_id=$1", [tx]);
    await h.db.query("delete from ledger_transactions where id=$1", [tx]);
    await h.db.exec("set session_replication_role = origin");
    expect((await op<any>(o, "GET", "/ledger-mismatches")).json.items).toEqual([]);
  });
});

describe("dual-approval, append-only adjustments", () => {
  it("credit: proposal moves no money; the proposer cannot approve; a second operator's approval posts one balanced ledger transaction", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer(1_000_000n);
    const before = await posted(c.accountId);
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "2500000", reason: "Goodwill credit for an outage on 2026-10-01" });
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ status: "pending", action: "credit", amountMicrousd: "2500000", accountId: c.accountId, proposedBy: a.userId, ledgerTransactionId: null, decidedBy: null });
    expect(await posted(c.accountId)).toBe(before);

    const self = await approve(a, p.json.id);
    expect(self.status).toBe(403);
    expect(self.json.error.code).toBe("FORBIDDEN");
    expect((await rejectAdj(a, p.json.id)).status).toBe(403); // rejecting your own proposal is also a decision
    expect(await posted(c.accountId)).toBe(before);

    // Database backstop: even a direct insert of the proposer's decision is refused.
    await expect(h.db.query("insert into operator_adjustment_decisions (adjustment_id, decision, decided_by_user_id, created_at) values ($1,'rejected',$2,$3)", [p.json.id, a.userId, h.config.now()])).rejects.toThrow(/proposer/);

    const ok = await approve(b, p.json.id, { reason: "verified outage report" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: "approved", decidedBy: b.userId, decisionReason: "verified outage report" });
    expect(await posted(c.accountId)).toBe(before + 2_500_000n);
    const [tx] = await h.db.query<any>("select kind, source_type, source_id, (select sum(amount)::text from ledger_entries where transaction_id=t.id) s from ledger_transactions t where id=$1", [ok.json.ledgerTransactionId]);
    expect(tx).toMatchObject({ kind: "adjustment", source_type: "adjustment", source_id: p.json.id, s: "0" });
    expect(await verifyLedger(h.db)).toMatchObject({ totalSum: 0n, unbalancedTransactions: [] });
    expect((await call<any>(h.app, "GET", "/api/accounts/current/balance", { cookie: c.cookie })).json.postedMicrousd).toBe((before + 2_500_000n).toString());

    // Decided once: no second approval, no rejection after approval.
    expect((await approve(b, p.json.id)).status).toBe(409);
    expect((await rejectAdj(b, p.json.id)).status).toBe(409);
    expect(await posted(c.accountId)).toBe(before + 2_500_000n);
  });

  it("only operators can decide; a customer cannot approve even their own account's adjustment", async () => {
    const a = await newOperator();
    const c = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "10", reason: "tiny test credit for tests" });
    expect((await approve(c, p.json.id)).status).toBe(403);
    const unelevated = await newOperator(false);
    expect((await approve(unelevated, p.json.id)).json.error.code).toBe("STEP_UP_REQUIRED");
    expect((await op<any>(a, "GET", "/adjustments")).json.items.find((x: any) => x.id === p.json.id).status).toBe("pending");
  });

  it("rejection by a second operator closes the proposal without moving money", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer(500_000n);
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "1000", reason: "credit that will be declined" });
    const r = await rejectAdj(b, p.json.id, { reason: "no evidence" });
    expect(r.json).toMatchObject({ status: "rejected", decidedBy: b.userId, decisionReason: "no evidence", ledgerTransactionId: null });
    expect(await posted(c.accountId)).toBe(500_000n);
    expect((await approve(b, p.json.id)).status).toBe(409);
  });

  it("concurrent approvals by two other operators: exactly one wins, one ledger transaction", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const d = await newOperator();
    const c = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "777", reason: "race to approve this credit" });
    const results = await Promise.all([approve(b, p.json.id), approve(d, p.json.id), approve(b, p.json.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await posted(c.accountId)).toBe(777n);
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where source_id=$1", [p.json.id]))[0].n).toBe(1);
  });

  it.each([
    ["zero amount", { action: "credit", amountMicrousd: "0" }],
    ["missing amount", { action: "credit" }],
    ["negative amount", { action: "credit", amountMicrousd: "-5" }],
    ["fractional amount", { action: "credit", amountMicrousd: "1.5" }],
    ["above the maximum", { action: "credit", amountMicrousd: "100000001" }],
    ["debit above the maximum", { action: "debit", amountMicrousd: "100000001" }],
    ["reject_review without a review", { action: "reject_review" }],
    ["unknown action", { action: "refund", amountMicrousd: "5" }],
    ["short reason", { action: "credit", amountMicrousd: "5", reason: "short" }],
    ["extra field", { action: "credit", amountMicrousd: "5", ledgerAccount: "revenue" }],
  ])("proposal bounds: %s -> 422", async (_n, over) => {
    const a = await newOperator();
    const c = await customer();
    const n = async () => (await h.db.query<any>("select count(*)::int n from operator_adjustments"))[0].n;
    const before = await n();
    const r = await propose(a, { accountId: c.accountId, reason: "a sufficiently long reason", ...over });
    expect(r.status).toBe(422);
    expect(await n()).toBe(before);
  });

  it("proposal bounds: reject_review with an amount -> 422", async () => {
    const a = await newOperator();
    const { reviewId } = await underpaidReview();
    const r = await propose(a, { action: "reject_review", amountMicrousd: "5", reason: "a reject must not carry an amount", reviewId });
    expect(r.status).toBe(422);
    expect(r.json.error.fieldErrors[0].field).toBe("amountMicrousd");
  });

  it("the maximum itself is allowed; unknown accounts 404; operators cannot adjust an account they belong to", async () => {
    const a = await newOperator();
    const c = await customer();
    expect((await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "100000000", reason: "exactly the allowed maximum" })).status).toBe(201);
    expect((await propose(a, { accountId: "acct_nope", action: "credit", amountMicrousd: "5", reason: "no such account here" })).status).toBe(404);
    const own = await propose(a, { accountId: a.accountId, action: "credit", amountMicrousd: "5", reason: "paying myself, which is forbidden" });
    expect(own.status).toBe(422);
    expect(own.json.error.fieldErrors[0].field).toBe("accountId");
  });

  it("debit: needs available funds at approval time; holds count; the debit returns funds to the funding source", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer(1_000n);
    const tooMuch = await propose(a, { accountId: c.accountId, action: "debit", amountMicrousd: "5000", reason: "reverse a mistaken credit" });
    const r = await approve(b, tooMuch.json.id);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("INSUFFICIENT_FUNDS");
    expect(await posted(c.accountId)).toBe(1_000n);
    expect((await op<any>(b, "GET", "/adjustments?status=pending&limit=200")).json.items.map((x: any) => x.id)).toContain(tooMuch.json.id); // still undecided
    const ok = await propose(a, { accountId: c.accountId, action: "debit", amountMicrousd: "400", reason: "reverse part of a mistaken credit" });
    expect((await approve(b, ok.json.id)).status).toBe(200);
    expect(await posted(c.accountId)).toBe(600n);
    expect(await verifyLedger(h.db)).toMatchObject({ totalSum: 0n });
    const entries = await h.db.query<any>("select ledger_account, amount::text amount from ledger_entries where transaction_id=(select ledger_transaction_id from operator_adjustment_decisions where adjustment_id=$1) order by amount", [ok.json.id]);
    expect(entries).toEqual([{ ledger_account: "customer_funds", amount: "-400" }, { ledger_account: "funding_source", amount: "400" }]);
  });

  it("proposals expire; expired ones cannot be approved; list status reflects it", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "50", reason: "will lapse before approval" });
    advance(h, 601);
    const b2 = await newOperator();
    const r = await approve(b2, p.json.id);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/expired/);
    expect((await op<any>(b2, "GET", "/adjustments?status=expired&limit=200")).json.items.map((x: any) => x.id)).toContain(p.json.id);
    expect(await posted(c.accountId)).toBe(0n);
    void b;
  });

  it("proposals and decisions are append-only at the database", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "9", reason: "append only check please" });
    await approve(b, p.json.id);
    for (const sql of [
      "update operator_adjustments set amount_microusd=1 where id=$1", "delete from operator_adjustments where id=$1",
      "update operator_adjustment_decisions set decision='rejected' where adjustment_id=$1", "delete from operator_adjustment_decisions where adjustment_id=$1",
    ]) await expect(h.db.query(sql, [p.json.id]), sql).rejects.toThrow(/append-only/);
  });

  it("propose is idempotent per key and requires one", async () => {
    const a = await newOperator();
    const c = await customer();
    const body = { accountId: c.accountId, action: "credit", amountMicrousd: "11", reason: "idempotent proposal check" };
    const k = idemKey();
    const one = await propose(a, body, k);
    const two = await propose(a, body, k);
    expect(two.json.id).toBe(one.json.id);
    expect(two.headers.get("idempotent-replay")).toBe("true");
    expect((await propose(a, { ...body, amountMicrousd: "12" }, k)).json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await op<any>(a, "POST", "/adjustments", body)).json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await h.db.query<any>("select count(*)::int n from operator_adjustments where account_id=$1", [c.accountId]))[0].n).toBe(1);
  });
});

describe("resolving payment reviews through the ledger", () => {
  it("reverses a primary manually credited transfer once without double debiting", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const [event] = await h.db.query<any>("select e.* from chain_events e join payment_reviews r on r.chain_event_id=e.id where r.id=$1", [reviewId]);
    const p = await propose(a, { action: "credit", accountId: s.accountId, amountMicrousd: "4999999", reason: "Credit the primary received transfer", reviewId });
    expect(p.status).toBe(201);
    expect((await approve(b, p.json.id)).status).toBe(200);
    expect(await posted(s.accountId)).toBe(4_999_999n);
    chain.reorgOut(event.network, event.tx_hash, event.event_index, event.asset_contract);
    const options = { db: h.db, client: chain, now: () => new Date(h.clock.now), newId: randomId };
    expect((await observeOnce(options)).errors).toEqual([]);
    expect(await posted(s.accountId)).toBe(0n);
    await observeOnce(options);
    await reconcilePayments(options);
    expect(await posted(s.accountId)).toBe(0n);
    expect((await verifyLedger(h.db)).totalSum).toBe(0n);
  });

  it.each(["observer", "reconciler"])("%s compensates a historical event credit exactly once while preserving the primary payment", async (mode) => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const [event] = await h.db.query<any>("select e.* from chain_events e join payment_reviews r on r.chain_event_id=e.id where r.id=$1", [reviewId]);
    chain.send({ network: "testnet-a", txHash: txHash(), assetContract: TOKEN_A, to: event.to_address, amountAtomic: AMOUNT });
    chain.mine("testnet-a", 3);
    const options = { db: h.db, client: chain, now: () => new Date(h.clock.now), newId: randomId };
    await observeOnce(options);
    const [before] = await h.db.query<any>("select * from deposit_intents where id=$1", [event.deposit_id]);
    const p = await propose(a, { action: "credit", accountId: s.accountId, amountMicrousd: "4999999", reason: "Credit historical received transfer", reviewId });
    expect((await approve(b, p.json.id)).status).toBe(200);
    expect(await posted(s.accountId)).toBe(9_999_999n);
    chain.reorgOut(event.network, event.tx_hash, event.event_index, event.asset_contract);
    const run = mode === "observer" ? observeOnce : reconcilePayments;
    expect((await run(options)).errors).toEqual([]);
    expect(await posted(s.accountId)).toBe(AMOUNT);
    expect((await h.db.query<any>("select * from deposit_intents where id=$1", [event.deposit_id]))[0]).toEqual(before);
    expect(await h.db.query("select id from payment_alerts where account_id=$1 and kind='CREDITED_TRANSFER_REVERSED'", [s.accountId])).toHaveLength(1);
    await run(options);
    expect(await posted(s.accountId)).toBe(AMOUNT);
    expect(await h.db.query("select id from ledger_transactions where source_type='adjustment' and source_id=$1 and kind='reversal'", [p.json.id])).toHaveLength(1);
    expect(await verifyLedger(h.db)).toMatchObject({ totalSum: 0n, unbalancedTransactions: [] });
  });

  it("refuses approval when the reviewed event has already been removed", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const p = await propose(a, { action: "credit", accountId: s.accountId, amountMicrousd: "4999999", reason: "Credit actual received transfer", reviewId });
    const [event] = await h.db.query<any>("select e.* from chain_events e join payment_reviews r on r.chain_event_id=e.id where r.id=$1", [reviewId]);
    chain.reorgOut(event.network, event.tx_hash, event.event_index, event.asset_contract);
    const transfer = { network: event.network, chainId: event.chain_id, txHash: event.tx_hash, eventIndex: event.event_index, assetContract: event.asset_contract, from: event.from_address, to: event.to_address, amountAtomic: BigInt(event.amount_atomic), blockNumber: BigInt(event.block_number), blockHash: event.block_hash, blockTime: event.block_time, confirmations: 0, removed: true, headBlock: chain.head(event.network) };
    await ingestTransfer(h.db, transfer, { now: h.config.now(), newId: randomId });
    expect((await approve(b, p.json.id)).status).toBe(409);
    expect(await posted(s.accountId)).toBe(0n);
    expect(await h.db.query("select * from operator_adjustment_decisions where adjustment_id=$1", [p.json.id])).toHaveLength(0);
  });

  it.each(["duplicate_event", "reorg_reversal"])("two historical reviews of one event cannot both credit it (%s)", async (kind) => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const duplicateId = randomId("prv");
    await h.db.query(`insert into payment_reviews (id, kind, reason, account_id, deposit_id, chain_event_id, details, created_at)
      select $2, $3, 'DUPLICATE_PAYMENT', account_id, deposit_id, chain_event_id, details, created_at from payment_reviews where id=$1`, [reviewId, duplicateId, kind]);
    const first = await propose(a, { accountId: s.accountId, action: "credit", amountMicrousd: "4999999", reason: "Credit actual received amount", reviewId });
    const second = await propose(a, { accountId: s.accountId, action: "credit", amountMicrousd: "4999999", reason: "Historical duplicate of same event", reviewId: duplicateId });
    expect((await approve(b, first.json.id)).status).toBe(200);
    expect((await approve(b, second.json.id)).status).toBe(409);
    expect(await posted(s.accountId)).toBe(4_999_999n);
    expect((await h.db.query<any>("select status from payment_reviews where id=$1", [duplicateId]))[0].status).toBe("open");
  });
  it("credit resolution: dual-approved credit posts through the ledger and closes the review; the deposit credit path is untouched", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    expect(await balanceOf({ ...h, chain } as any, s)).toBe("0");
    const p = await propose(a, { accountId: s.accountId, action: "credit", amountMicrousd: "4999999", reason: "Underpaid by 1 unit; crediting the amount received", reviewId });
    expect(p.status).toBe(201);
    expect((await propose(b, { accountId: s.accountId, action: "credit", amountMicrousd: "1", reason: "duplicate proposal for the same review", reviewId })).status).toBe(409);
    expect((await op<any>(a, "GET", "/payment-reviews")).json.items.find((x: any) => x.id === reviewId).status).toBe("open"); // not resolved by a proposal
    expect((await approve(a, p.json.id)).status).toBe(403);
    const ok = await approve(b, p.json.id);
    expect(ok.status).toBe(200);
    expect(await posted(s.accountId)).toBe(4_999_999n);
    const [rv] = await h.db.query<any>("select status, resolution, resolved_at from payment_reviews where id=$1", [reviewId]);
    expect(rv).toMatchObject({ status: "resolved", resolution: `credited by adjustment ${p.json.id}` });
    expect((await op<any>(a, "GET", "/payment-reviews?status=resolved&limit=200")).json.items.find((x: any) => x.id === reviewId)).toMatchObject({ status: "resolved", resolution: expect.stringContaining("credited") });
    expect((await propose(a, { accountId: s.accountId, action: "credit", amountMicrousd: "1", reason: "review already resolved above", reviewId })).status).toBe(409);
    expect(await verifyLedger(h.db)).toMatchObject({ totalSum: 0n });
  });

  it("reject resolution: closes the review with no money movement; account mismatches are refused", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const other = await customer();
    const bad = await propose(a, { accountId: other.accountId, action: "credit", amountMicrousd: "5", reason: "wrong account for this review", reviewId });
    expect(bad.status).toBe(422);
    expect(bad.json.error.fieldErrors[0].field).toBe("reviewId");
    expect((await propose(a, { action: "debit", accountId: s.accountId, amountMicrousd: "5", reason: "a debit cannot resolve a review", reviewId })).status).toBe(422);
    expect((await propose(a, { action: "reject_review", accountId: other.accountId, reason: "wrong account for this reject", reviewId })).status).toBe(422);
    const p = await propose(a, { action: "reject_review", reason: "Customer confirmed the transfer was a mistake", reviewId });
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ action: "reject_review", amountMicrousd: "0", accountId: s.accountId });
    const before = await posted(s.accountId);
    const ok = await approve(b, p.json.id);
    expect(ok.json).toMatchObject({ status: "approved", ledgerTransactionId: null });
    expect(await posted(s.accountId)).toBe(before);
    expect((await h.db.query<any>("select status, resolution from payment_reviews where id=$1", [reviewId]))[0]).toMatchObject({ status: "resolved", resolution: `rejected by adjustment ${p.json.id}` });
  });

  it("rejecting dust does not block a later valid payment or reopen the rejected observation", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const [deposit] = await h.db.query<any>("select i.id, i.address from deposit_intents i join payment_reviews r on r.deposit_id=i.id where r.id=$1", [reviewId]);
    const p = await propose(a, { action: "reject_review", reason: "Reject invalid observation only", reviewId });
    expect((await approve(b, p.json.id)).status).toBe(200);
    chain.send({ network: "testnet-a", txHash: txHash(), assetContract: TOKEN_A, to: deposit.address, amountAtomic: AMOUNT });
    chain.mine("testnet-a", 3);
    await observeOnce({ db: h.db, client: chain, now: () => new Date(h.clock.now), newId: randomId });
    expect((await h.db.query<any>("select status from deposit_intents where id=$1", [deposit.id]))[0].status).toBe("CREDITED");
    expect(await posted(s.accountId)).toBe(AMOUNT);
    expect(await h.db.query("select id from payment_reviews where deposit_id=$1", [deposit.id])).toHaveLength(1);
  });

  it("resolving an old invalid observation preserves the later valid payment's ledger pointer", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const { s, reviewId } = await underpaidReview();
    const [deposit] = await h.db.query<any>("select i.id, i.address from deposit_intents i join payment_reviews r on r.deposit_id=i.id where r.id=$1", [reviewId]);
    chain.send({ network: "testnet-a", txHash: txHash(), assetContract: TOKEN_A, to: deposit.address, amountAtomic: AMOUNT });
    chain.mine("testnet-a", 3);
    await observeOnce({ db: h.db, client: chain, now: () => new Date(h.clock.now), newId: randomId });
    const [before] = await h.db.query<any>("select status, ledger_transaction_id, credited_microusd::text as credited from deposit_intents where id=$1", [deposit.id]);
    const p = await propose(a, { action: "credit", accountId: s.accountId, amountMicrousd: "4999999", reason: "Credit distinct invalid transfer separately", reviewId });
    expect((await approve(b, p.json.id)).status).toBe(200);
    expect((await h.db.query<any>("select status, ledger_transaction_id, credited_microusd::text as credited from deposit_intents where id=$1", [deposit.id]))[0]).toEqual(before);
    expect(before.status).toBe("CREDITED");
    expect(await posted(s.accountId)).toBe(AMOUNT + 4_999_999n);
  });

  it("an account-less review (unmatched transfer) can be rejected but never credited", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const id = randomId("prv");
    await h.db.query("insert into payment_reviews (id, kind, reason, account_id, details, created_at) values ($1,'unmatched_event','NO_MATCHING_INTENT',null,'{}'::jsonb,$2)", [id, h.config.now()]);
    const c = await customer();
    expect((await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "5", reason: "crediting an unmatched transfer", reviewId: id })).status).toBe(422);
    expect((await propose(a, { action: "credit", amountMicrousd: "5", reason: "credit without an account", reviewId: id })).status).toBe(422);
    const p = await propose(a, { action: "reject_review", reason: "No customer could be identified for this transfer", reviewId: id });
    expect(p.status).toBe(201);
    expect(p.json.accountId).toBeNull();
    expect((await approve(a, p.json.id)).status).toBe(403);
    expect((await approve(b, p.json.id)).status).toBe(200);
    expect((await h.db.query<any>("select status from payment_reviews where id=$1", [id]))[0].status).toBe("resolved");
  });
});

describe("customer audit view", () => {
  it("every operator step on an account appears in that customer's audit view, without the operator's identity; other accounts see nothing", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer(1_000_000n);
    const stranger = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "123456", reason: "Refund for duplicate charge on invoice 42" });
    await approve(b, p.json.id);
    const rej = await propose(a, { accountId: c.accountId, action: "debit", amountMicrousd: "10", reason: "this one will be declined" });
    await rejectAdj(b, rej.json.id);

    const view = (await call<any>(h.app, "GET", "/api/audit?source=operator&limit=50", { cookie: c.cookie })).json.items as any[];
    expect(view.map((e) => e.action).sort()).toEqual(["operator.adjustment_approved", "operator.adjustment_proposed", "operator.adjustment_proposed", "operator.adjustment_rejected"]);
    for (const e of view) {
      expect(e.actor).toBe("operator");
      expect(e.actorUserId).toBeNull();
    }
    const proposed = view.find((e) => e.action === "operator.adjustment_proposed" && e.targetId === p.json.id);
    expect(proposed.details).toMatchObject({ action: "credit", amountMicrousd: "123456" });
    expect(proposed.details).not.toHaveProperty("reason"); // operator commentary is not shown to customers
    expect(JSON.stringify(view)).not.toContain("duplicate charge on invoice 42");
    const approved = view.find((e) => e.action === "operator.adjustment_approved");
    expect(approved.details).toMatchObject({ ledgerTransactionId: expect.any(String), amountMicrousd: "123456" });
    expect(JSON.stringify(view)).not.toContain(a.userId);
    expect(JSON.stringify(view)).not.toContain(b.userId);
    // Customer-side events remain, in the unfiltered view, with the member as actor.
    const all = (await call<any>(h.app, "GET", "/api/audit?limit=200", { cookie: c.cookie })).json.items as any[];
    expect(all.length).toBeGreaterThan(view.length);
    expect(all.filter((e) => e.actor === "operator")).toHaveLength(4);
    expect((await call<any>(h.app, "GET", "/api/audit?source=operator", { cookie: stranger.cookie })).json.items).toEqual([]);
    const page = (await call<any>(h.app, "GET", "/api/audit?source=operator&limit=2", { cookie: c.cookie })).json;
    expect(page.items).toHaveLength(2);
    const next = (await call<any>(h.app, "GET", `/api/audit?source=operator&limit=2&cursor=${page.nextCursor}`, { cookie: c.cookie })).json;
    expect(next.items).toHaveLength(2);
    expect([...page.items, ...next.items].map((e: any) => e.id)).toEqual(view.map((e) => e.id));
    // Roles: members cannot read the account's audit log; billing and owner can.
    expect((await call(h.app, "GET", "/api/audit", { cookie: (await seedMember(h, c.accountId, "member")).cookie })).status).toBe(403);
    expect((await call(h.app, "GET", "/api/audit", { cookie: (await seedMember(h, c.accountId, "billing")).cookie })).status).toBe(200);
    expect((await call(h.app, "GET", "/api/audit", {})).status).toBe(401);
    expect((await call(h.app, "GET", "/api/audit?source=other", { cookie: c.cookie })).status).toBe(422);
  });

  it("operator elevation and grants are audited without an account, so they never appear in a customer view", async () => {
    const o = await newOperator();
    const rows = await h.db.query<any>("select account_id, action from audit_events where actor_user_id=$1 and action='operator.elevated'", [o.userId]);
    expect(rows).toEqual([{ account_id: null, action: "operator.elevated" }]);
    expect((await call<any>(h.app, "GET", "/api/audit?source=operator", { cookie: o.cookie })).json.items).toEqual([]);
  });
});

describe("deciders, review value and the daily ceiling (security review M5)", () => {
  it("refuses approval if the proposer joined the target account after proposing", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "10", reason: "Membership changes before approval" });
    expect(p.status).toBe(201);
    await h.db.query("insert into memberships (id, account_id, user_id, role, created_at) values ($1,$2,$3,'member',$4)", [randomId("mem"), c.accountId, a.userId, h.config.now()]);
    expect((await approve(b, p.json.id)).status).toBe(403);
    expect(await posted(c.accountId)).toBe(0n);
  });

  it("an operator who is a member of the target account cannot decide on it (even though a different user proposed)", async () => {
    const a = await newOperator();
    const b = await newOperator();
    const c = await customer();
    const p = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "10", reason: "tiny credit, decider is a member" });
    await h.db.query("insert into memberships (id, account_id, user_id, role, created_at) values ($1,$2,$3,'member',$4)", [randomId("mem"), c.accountId, b.userId, h.config.now()]);
    const r = await approve(b, p.json.id);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/belong/);
    expect(await posted(c.accountId)).toBe(0n);
  });

  it("a review credit cannot exceed the reviewed transfer's computed value", async () => {
    const a = await newOperator();
    const { s, reviewId } = await underpaidReview(); // 4,999,999 atomic units at 6 decimals and 1 USD per token = 4,999,999 micro-USD
    const over = await propose(a, { accountId: s.accountId, action: "credit", amountMicrousd: "5000000", reason: "claims more than was actually received", reviewId });
    expect(over.status).toBe(422);
    expect(over.json.error.fieldErrors[0]).toMatchObject({ field: "amountMicrousd", message: expect.stringContaining("4999999") });
    expect((await propose(a, { accountId: s.accountId, action: "credit", amountMicrousd: "4999999", reason: "exactly what was received", reviewId })).status).toBe(201);
  });

  it("the rolling 24-hour ceiling blocks the approval that would exceed it, and lifts as approvals age out", async () => {
    const base = h.config;
    const [{ s: used }] = await h.db.query<any>("select coalesce(sum(a.amount_microusd),0)::text s from operator_adjustment_decisions d join operator_adjustments a on a.id=d.adjustment_id where d.decision='approved'");
    const limited = { ...h.config, operator: { ...h.config.operator, dailyLimitMicrousd: BigInt(used) + 1_000n } };
    h.config.operator = limited.operator; // same object the app reads
    try {
      const a = await newOperator();
      const b = await newOperator();
      const c = await customer();
      const p1 = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "700", reason: "first credit within the ceiling" });
      const p2 = await propose(a, { accountId: c.accountId, action: "credit", amountMicrousd: "400", reason: "second credit would pass the ceiling" });
      expect((await approve(b, p1.json.id)).status).toBe(200);
      const blocked = await approve(b, p2.json.id);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect(await posted(c.accountId)).toBe(700n);
      expect((await rejectAdj(b, p2.json.id)).status).toBe(200); // declining is never blocked
    } finally {
      h.config.operator = base.operator;
    }
  });
});
