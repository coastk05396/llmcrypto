/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditPostings, ingestTransfer, postTransaction, verifyLedger, type ObservedTransfer } from "@llmcrypto/domain";
import { randomId } from "../../apps/api/src/crypto";
import { observeOnce } from "../../apps/worker/src/chain-observer";
import { type LoggedIn, login } from "./helpers";
import { ROUTE_A, TOKEN_A, TOKEN_B, TOKEN_OTHER, balanceOf, createDeposit, getDeposit, makePaymentsHarness, txHash, type PaymentsHarness } from "./payments-helpers";

const AMOUNT = 5_000_000n;
const BODY = { network: "testnet-a", asset: "TUSD", amountAtomic: AMOUNT.toString() };

let h: PaymentsHarness;
beforeAll(async () => {
  h = await makePaymentsHarness();
});
afterAll(async () => {
  await h.db.close();
});

async function newIntent(s?: LoggedIn, body: Record<string, unknown> = BODY): Promise<{ s: LoggedIn; d: any }> {
  const who = s ?? (await login(h.app));
  const r = await createDeposit(h, who, body);
  if (r.status !== 201) throw new Error(`intent failed ${r.status} ${JSON.stringify(r.json)}`);
  return { s: who, d: r.json };
}
const depositTxs = (accountId: string, kind = "deposit") =>
  h.db.query<any>("select id, kind from ledger_transactions where account_id=$1 and source_type='deposit' and kind=$2", [accountId, kind]);
const send = (d: any, over: Record<string, unknown> = {}) => {
  const hash = txHash();
  h.chain.send({ network: "testnet-a", txHash: hash, assetContract: TOKEN_A, to: d.address, amountAtomic: AMOUNT, ...over } as any);
  return hash;
};
const reviews = (depositId: string) => h.db.query<any>("select kind, reason, status, account_id from payment_reviews where deposit_id=$1 order by created_at", [depositId]);
const alerts = () => h.db.query<any>("select kind, severity, dedupe_key from payment_alerts order by created_at");
const obs = (over: Partial<ObservedTransfer> & Pick<ObservedTransfer, "to">): ObservedTransfer => ({
  network: "testnet-a", chainId: "1001", txHash: txHash(), eventIndex: 0, assetContract: TOKEN_A, from: null, amountAtomic: AMOUNT, blockNumber: 2000n, blockHash: "0xaa",
  blockTime: new Date(h.clock.now), confirmations: 3, removed: false, headBlock: 2002n, ...over,
});
const ingest = (t: ObservedTransfer) => ingestTransfer(h.db, t, { now: new Date(h.clock.now), newId: randomId });

describe("crediting", () => {
  it("dust review survives a valid later transfer without creating another creditable review on replay", async () => {
    const { s, d } = await newIntent();
    const dust = obs({ to: d.address, amountAtomic: 1n });
    await ingest(dust);
    const valid = obs({ to: d.address, confirmations: 1 });
    await ingest(valid);
    await ingest(dust);
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CONFIRMING", confirmations: 1 });
    expect(await reviews(d.id)).toHaveLength(1);
    await ingest({ ...valid, confirmations: 3, headBlock: valid.headBlock + 2n });
    expect(await balanceOf(h, s)).toBe(AMOUNT.toString());
    expect(await reviews(d.id)).toHaveLength(1);
  });
  it("a wrong-token observation leaves a later valid payment creditable", async () => {
    const { s, d } = await newIntent();
    const wrong = obs({ to: d.address, assetContract: TOKEN_OTHER });
    await ingest(wrong);
    await ingest(obs({ to: d.address }));
    await ingest(wrong);
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREDITED");
    expect(await balanceOf(h, s)).toBe(AMOUNT.toString());
    expect(await reviews(d.id)).toEqual([expect.objectContaining({ reason: "WRONG_ASSET", status: "open" })]);
  });
  it("one finalized transfer yields exactly one balanced credit (source=deposit)", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREDITED", creditedMicrousd: AMOUNT.toString() });
    expect(await balanceOf(h, s)).toBe(AMOUNT.toString());
    const tx = await depositTxs(s.accountId);
    expect(tx).toHaveLength(1);
    const entries = await h.db.query<any>("select ledger_account, amount::text as amount from ledger_entries where transaction_id=$1 order by amount", [tx[0].id]);
    expect(entries.map((e) => [e.ledger_account, e.amount])).toEqual([["funding_source", `-${AMOUNT}`], ["customer_funds", AMOUNT.toString()]]);
    const row = (await h.db.query<any>("select source_type, source_id, kind from ledger_transactions where id=$1", [tx[0].id]))[0];
    expect(row).toMatchObject({ source_type: "deposit", source_id: d.id, kind: "deposit" });
    expect((await verifyLedger(h.db)).totalSum).toBe(0n);
    expect((await h.db.query<any>("select action from audit_events where target_id=$1 order by created_at", [d.id])).map((a) => a.action)).toContain("deposit.credited");
  });

  it("walks DETECTED -> CONFIRMING -> CREDITED as confirmations arrive, and does not credit before finality", async () => {
    const { s, d } = await newIntent();
    const hash = send(d, { mined: false });
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "DETECTED", confirmations: 0 });
    h.chain.confirmPending("testnet-a", hash, 0, TOKEN_A);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CONFIRMING", confirmations: 1 });
    h.chain.mine("testnet-a", 1);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CONFIRMING", confirmations: 2 });
    expect(await balanceOf(h, s)).toBe("0");
    h.chain.mine("testnet-a", 1);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREDITED", confirmations: 3 });
  });

  it("duplicate delivery (repeated polls, duplicated listings, direct re-ingest) still produces one credit", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    h.chain.duplicateListings = true;
    try {
      await h.observe();
      await h.observe();
      await h.reconcile();
    } finally {
      h.chain.duplicateListings = false;
    }
    const listed = await h.chain.getTransfersTo("testnet-a", d.address);
    await ingest(listed[0]!);
    await ingest(listed[0]!);
    await Promise.all([ingest(listed[0]!), ingest(listed[0]!), ingest(listed[0]!)]);
    expect(await depositTxs(s.accountId)).toHaveLength(1);
    expect(await balanceOf(h, s)).toBe(AMOUNT.toString());
    expect(await h.db.query("select 1 from chain_events where deposit_id=$1", [d.id])).toHaveLength(1);
  });

  it("two transfers in one transaction (different event index) are distinct events and each is accounted for", async () => {
    const one = await newIntent();
    const two = await newIntent();
    const hash = txHash();
    h.chain.send({ network: "testnet-a", txHash: hash, eventIndex: 0, assetContract: TOKEN_A, to: one.d.address, amountAtomic: AMOUNT });
    h.chain.send({ network: "testnet-a", txHash: hash, eventIndex: 1, assetContract: TOKEN_A, to: two.d.address, amountAtomic: AMOUNT });
    h.chain.mine("testnet-a", 2);
    await h.observe();
    expect((await getDeposit(h, one.s, one.d.id)).json.status).toBe("CREDITED");
    expect((await getDeposit(h, two.s, two.d.id)).json.status).toBe("CREDITED");
    expect(await h.db.query("select 1 from chain_events where tx_hash=$1", [hash])).toHaveLength(2);
    // The same tx hash + index on a different asset contract is yet another event.
    const extra = await newIntent();
    h.chain.send({ network: "testnet-a", txHash: hash, eventIndex: 0, assetContract: TOKEN_OTHER, to: extra.d.address, amountAtomic: AMOUNT });
    await h.observe();
    expect(await h.db.query("select 1 from chain_events where tx_hash=$1", [hash])).toHaveLength(3);
  });

  it("a second transfer to an already credited intent is queued for review and never credited", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    await h.observe();
    send(d, { eventIndex: 3 });
    h.chain.mine("testnet-a", 2);
    await h.observe();
    expect(await depositTxs(s.accountId)).toHaveLength(1);
    expect(await balanceOf(h, s)).toBe(AMOUNT.toString());
    expect(await reviews(d.id)).toEqual([expect.objectContaining({ kind: "duplicate_event", reason: "DUPLICATE_PAYMENT", status: "open" })]);
  });
});

describe("mismatches go to review and are never credited", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["wrong asset (other token contract)", { assetContract: TOKEN_OTHER }, "WRONG_ASSET"],
    ["native coin instead of the token", { assetContract: "" }, "WRONG_ASSET"],
    ["wrong chain id on the right network", { chainId: "9999" }, "WRONG_CHAIN"],
    ["underpayment", { amountAtomic: AMOUNT - 1n }, "UNDERPAID"],
    ["overpayment (review policy)", { amountAtomic: AMOUNT + 1n }, "OVERPAID"],
  ];
  it.each(cases)("%s", async (_n, over, reason) => {
    const { s, d } = await newIntent();
    send(d, over);
    h.chain.mine("testnet-a", 5);
    await h.observe();
    const dep = (await getDeposit(h, s, d.id)).json;
    expect(dep).toMatchObject({ status: "REVIEW_REQUIRED", reviewReason: reason, creditedMicrousd: null, ledgerTransactionId: null });
    expect(await balanceOf(h, s)).toBe("0");
    expect(await reviews(d.id)).toEqual([expect.objectContaining({ kind: "deposit", reason, status: "open", account_id: s.accountId })]);
    await h.observe(); // review is sticky: more polling changes nothing
    expect((await getDeposit(h, s, d.id)).json.status).toBe("REVIEW_REQUIRED");
  });

  it("wrong network: a transfer to the address on another configured network is reviewed", async () => {
    const { s, d } = await newIntent();
    h.chain.send({ network: "testnet-b", txHash: txHash(), assetContract: TOKEN_B, to: d.address, amountAtomic: AMOUNT });
    h.chain.mine("testnet-b", 5);
    await h.observe(); // only the intent's own network is scanned: nothing seen
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREATED");
    await h.observe({ scanNetworks: ["testnet-a", "testnet-b"] });
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "REVIEW_REQUIRED", reviewReason: "WRONG_NETWORK" });
    expect(await balanceOf(h, s)).toBe("0");
  });

  it("a transfer to an address no intent owns is unmatched, queued without an account, and credits nobody", async () => {
    const before = (await h.db.query<any>("select count(*)::int as n from ledger_transactions"))[0].n;
    const r = await ingest(obs({ to: "0x" + "9".repeat(40) }));
    expect(r.outcome).toBe("unmatched");
    const rows = await h.db.query<any>("select kind, reason, account_id from payment_reviews where kind='unmatched_event' order by created_at desc limit 1");
    expect(rows[0]).toMatchObject({ reason: "UNMATCHED", account_id: null });
    expect((await h.db.query<any>("select count(*)::int as n from ledger_transactions"))[0].n).toBe(before);
  });

  it("overpayment is credited in full only where the pair's approved policy says so", async () => {
    const s = await login(h.app);
    const d = (await createDeposit(h, s, { network: "testnet-b", asset: "TUSD", amountAtomic: (10n ** 18n).toString() })).json;
    h.chain.send({ network: "testnet-b", txHash: txHash(), assetContract: TOKEN_B, to: d.address, amountAtomic: 3n * 10n ** 18n });
    h.chain.mine("testnet-b", 2);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREDITED", creditedMicrousd: "3000000" });
  });
});

describe("expiry", () => {
  it("a late transfer (mined after expiry + grace) is reviewed, not credited", async () => {
    const { s, d } = await newIntent();
    h.clock.now = new Date(Date.parse(d.expiresAt) + 700_000);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("EXPIRED");
    send(d);
    h.chain.mine("testnet-a", 5);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "REVIEW_REQUIRED", reviewReason: "LATE_PAYMENT" });
    expect(await balanceOf(h, s)).toBe("0");
  });

  it("a transfer mined in time but observed after the intent was marked expired is still honoured", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    h.clock.now = new Date(Date.parse(d.expiresAt) + 400_000); // observer lag, still inside grace: block time is in time
    // Observer outage past the acceptance deadline: the sweep marks it EXPIRED before the event is first seen.
    await h.db.query("update deposit_intents set status='EXPIRED' where id=$1", [d.id]);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREDITED" });
  });

  it("an intent that is never paid expires and an expired intent is not watched forever", async () => {
    const { s, d } = await newIntent();
    h.clock.now = new Date(Date.parse(d.expiresAt) + 601_000);
    const r = await h.observe();
    expect(r.expired).toContain(d.id);
    expect((await getDeposit(h, s, d.id)).json.status).toBe("EXPIRED");
    h.clock.now = new Date(h.clock.now.getTime() + 8 * 86_400_000);
    const later = await observeOnce({ db: h.db, client: h.chain, now: () => new Date(h.clock.now), newId: randomId });
    expect(later.intentsScanned).toBe((await h.db.query("select 1 from deposit_intents where status in ('CREATED','DETECTED','CONFIRMING')")).length);
  });
});

describe("reorg", () => {
  it("before credit: the intent reverts, then credits once after the transfer is re-included and finalized", async () => {
    const { s, d } = await newIntent();
    const hash = send(d);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CONFIRMING");
    h.chain.reorgOut("testnet-a", hash, 0, TOKEN_A);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREATED", confirmations: 0 });
    expect(await depositTxs(s.accountId)).toHaveLength(0);
    h.chain.reorgIn("testnet-a", hash, 0, TOKEN_A);
    h.chain.mine("testnet-a", 2);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREDITED");
    expect(await depositTxs(s.accountId)).toHaveLength(1);
  });

  it("after credit: a compensating ledger transaction, account review and critical alert; history is kept; no re-credit", async () => {
    const { s, d } = await newIntent();
    const hash = send(d);
    h.chain.mine("testnet-a", 2);
    await h.observe();
    expect(await balanceOf(h, s)).toBe(AMOUNT.toString());
    const creditTx = (await depositTxs(s.accountId))[0].id;

    h.chain.reorgOut("testnet-a", hash, 0, TOKEN_A);
    const rep = await h.reconcile();
    expect(rep.nonCanonical).toHaveLength(1);
    const dep = (await getDeposit(h, s, d.id)).json;
    expect(dep.status).toBe("REVERSED");
    expect(await balanceOf(h, s)).toBe("0");
    const reversal = await depositTxs(s.accountId, "reversal");
    expect(reversal).toHaveLength(1);
    // The original credit is untouched and the reversal is its exact negative.
    expect((await depositTxs(s.accountId)).map((t) => t.id)).toEqual([creditTx]);
    const sums = await h.db.query<any>("select transaction_id, sum(amount)::text as s from ledger_entries where ledger_account='customer_funds' and account_id=$1 group by 1 order by 2", [s.accountId]);
    expect(sums.map((r) => r.s).sort()).toEqual([`-${AMOUNT}`, AMOUNT.toString()].sort());
    expect((await verifyLedger(h.db)).totalSum).toBe(0n);
    expect(await reviews(d.id)).toEqual([expect.objectContaining({ kind: "reorg_reversal", status: "open", account_id: s.accountId })]);
    expect((await alerts()).find((a) => a.dedupe_key === `reversed:${d.id}`)).toMatchObject({ kind: "CREDITED_TRANSFER_REVERSED", severity: "critical" });
    expect((await h.db.query<any>("select action from audit_events where target_id=$1", [d.id])).map((a) => a.action)).toEqual(expect.arrayContaining(["deposit.credited", "deposit.reversed"]));
    await expect(h.db.query("delete from ledger_transactions where id=$1", [creditTx])).rejects.toThrow(/append-only/);

    // Idempotent: another run reverses nothing and raises no new alert.
    const again = await h.reconcile();
    expect(again.nonCanonical).toHaveLength(0);
    expect(again.alerts).toHaveLength(0);
    expect(await depositTxs(s.accountId, "reversal")).toHaveLength(1);

    // The transfer reappears: flagged, never credited again.
    h.chain.reorgIn("testnet-a", hash, 0, TOKEN_A);
    h.chain.mine("testnet-a", 5);
    await h.observe({});
    await h.reconcile();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("REVERSED");
    expect(await balanceOf(h, s)).toBe("0");
    expect((await reviews(d.id)).map((r) => r.reason)).toEqual(expect.arrayContaining(["CREDITED_TRANSFER_REVERSED", "REAPPEARED_AFTER_REVERSAL"]));
  });

  it("a transfer missing from the address listing but still canonical is not treated as reorged", async () => {
    const { s, d } = await newIntent();
    const hash = send(d);
    await h.observe();
    h.chain.hideFromListing("testnet-a", hash, 0, TOKEN_A);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CONFIRMING");
  });
});

describe("out-of-order and stale deliveries", () => {
  it("finalization seen before any earlier state goes straight to CREDITED", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 10);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREDITED");
  });

  it("an older observation arriving after a newer one is ignored (no regression, no double credit)", async () => {
    const { s, d } = await newIntent();
    const t = obs({ to: d.address, confirmations: 3, headBlock: 2010n });
    await ingest(t);
    const stale = await ingest({ ...t, confirmations: 1, headBlock: 2005n });
    expect(stale.outcome).toBe("stale_ignored");
    const staleRemoval = await ingest({ ...t, removed: true, headBlock: 2006n });
    expect(staleRemoval.outcome).toBe("stale_ignored");
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREDITED", confirmations: 3 });
    expect(await depositTxs(s.accountId)).toHaveLength(1);
    expect(await depositTxs(s.accountId, "reversal")).toHaveLength(0);
  });

  it("listings delivered in reverse order converge to the same state", async () => {
    const { s, d } = await newIntent();
    send(d, { eventIndex: 0 });
    send(d, { eventIndex: 1 });
    h.chain.mine("testnet-a", 2);
    h.chain.reverseListings = true;
    try {
      await h.observe();
    } finally {
      h.chain.reverseListings = false;
    }
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREDITED");
    expect(await depositTxs(s.accountId)).toHaveLength(1);
    expect(await reviews(d.id)).toHaveLength(1);
  });
});

describe("reconciliation", () => {
  it("detects an event the observer never saw, ingests it and records a MISSED_EVENT alert once", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    const first = await h.reconcile();
    expect(first.missedEvents).toHaveLength(1);
    expect(first.alerts.some((k) => k.startsWith("missed:"))).toBe(true);
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREDITED");
    const second = await h.reconcile();
    expect(second.missedEvents).toHaveLength(0);
    expect(second.alerts).toHaveLength(0);
  });

  it("flags a ledger/intent mismatch and an orphan deposit credit", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    await h.observe();
    await h.db.query("update deposit_intents set credited_microusd = credited_microusd + 1 where id=$1", [d.id]); // simulated drift
    const ghost = await login(h.app);
    await h.db.tx((q) => postTransaction(q, {
      id: randomId("ltx"), accountId: ghost.accountId, kind: "deposit", sourceType: "deposit", sourceId: "dep_ghost", priceVersion: null, reason: "x", at: h.clock.now,
      postings: creditPostings(ghost.accountId, 7n), newEntryId: () => randomId("le"),
    }));
    const rep = await h.reconcile();
    expect(rep.ledgerMismatches).toEqual(expect.arrayContaining([d.id, "dep_ghost"]));
    const list = await alerts();
    expect(list.filter((a) => a.kind === "LEDGER_MISMATCH" && a.dedupe_key === `ledger-mismatch:${d.id}`)).toHaveLength(1);
    expect(list.some((a) => a.kind === "ORPHAN_LEDGER_CREDIT" && a.severity === "critical")).toBe(true);
    void s;
  });

  it("a failing chain client changes nothing, is reported, and the next run recovers", async () => {
    const { s, d } = await newIntent();
    send(d);
    h.chain.mine("testnet-a", 2);
    h.chain.failAll(new Error("rpc down"));
    const o = await h.observe();
    expect(o.errors.length).toBeGreaterThan(0);
    const r = await h.reconcile();
    expect(r.errors.length).toBeGreaterThan(0);
    expect((await alerts()).some((a) => a.kind === "CHAIN_CLIENT_ERROR")).toBe(true);
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREATED");
    expect(await balanceOf(h, s)).toBe("0");
    h.chain.failAll(null);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREDITED");
  });

  it("a single failing intent does not stop the others", async () => {
    const a = await newIntent();
    const b = await newIntent();
    send(a.d);
    send(b.d);
    h.chain.mine("testnet-a", 2);
    h.chain.failNext("getTransfersTo");
    const o = await h.observe();
    expect(o.errors).toHaveLength(1);
    await h.observe();
    expect((await getDeposit(h, a.s, a.d.id)).json.status).toBe("CREDITED");
    expect((await getDeposit(h, b.s, b.d.id)).json.status).toBe("CREDITED");
  });

  it("the whole ledger stays balanced after all of the above", async () => {
    const rep = await verifyLedger(h.db);
    expect(rep.totalSum).toBe(0n);
    expect(rep.unbalancedTransactions).toEqual([]);
    expect(ROUTE_A.confirmations).toBe(3);
  });
});
