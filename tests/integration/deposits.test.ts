/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Deposit, DepositList, ErrorEnvelope, PaymentNetworkList } from "@llmcrypto/contracts";
import { parsePaymentRoutes } from "../../apps/api/src/payments/config";
import { TestAddressProvider } from "../../apps/api/src/payments/address-provider";
import { call, login, makeHarness, seedMember } from "./helpers";
import { idemKey } from "./metering-helpers";
import { ROUTE_A, ROUTE_B, TOKEN_A, balanceOf, createDeposit, getDeposit, makePaymentsHarness, txHash, type PaymentsHarness } from "./payments-helpers";

const BODY = { network: "testnet-a", asset: "TUSD", amountAtomic: "5000000" };
const code = (r: { json: unknown }) => ErrorEnvelope.parse(r.json).error.code;

describe("no payment networks configured", () => {
  it("lists nothing and refuses to create intents with a clear 503", async () => {
    const h = await makeHarness();
    const s = await login(h.app);
    const nets = await call<any>(h.app, "GET", "/api/deposits/networks", { cookie: s.cookie });
    expect(nets.status).toBe(200);
    expect(PaymentNetworkList.parse(nets.json).items).toEqual([]);
    const r = await createDeposit(h, s, BODY);
    expect(r.status).toBe(503);
    expect(code(r)).toBe("UNAVAILABLE");
    expect(r.json.error.message).toMatch(/No payment networks configured/);
    expect((await call<any>(h.app, "GET", "/api/deposits", { cookie: s.cookie })).json.items).toEqual([]);
    expect(await h.db.query("select 1 from deposit_intents")).toHaveLength(0);
    await h.db.close();
  });

  it("networks configured but no address source is equally unavailable (fail closed)", async () => {
    const h = await makePaymentsHarness([ROUTE_A], "none");
    const s = await login(h.app);
    const r = await createDeposit(h, s, BODY);
    expect(r.status).toBe(503);
    expect(r.json.error.message).toMatch(/No payment networks configured/);
    await h.db.close();
  });

  it("the key check still comes first: a missing Idempotency-Key is 400 even when unconfigured", async () => {
    const h = await makeHarness();
    const s = await login(h.app);
    const r = await call<any>(h.app, "POST", "/api/deposits", { cookie: s.cookie, body: BODY });
    expect(r.status).toBe(400);
    expect(code(r)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await h.db.close();
  });
});

describe("PAYMENT_NETWORKS_CONFIG parsing", () => {
  const good = {
    network: "n", asset: "A", chainId: "1", assetContract: "0xabc", decimals: 6, confirmations: 3, expirySeconds: 3600, graceSeconds: 0, microusdPerToken: "1000000", overpayment: "review",
  };
  it("unset or blank means no networks", () => {
    expect(parsePaymentRoutes(undefined)).toEqual([]);
    expect(parsePaymentRoutes("  ")).toEqual([]);
  });
  it("accepts a complete route and normalizes native to an empty contract", () => {
    const [r, n] = parsePaymentRoutes(JSON.stringify({ routes: [good, { ...good, asset: "NAT", assetContract: null }] }));
    expect(r).toMatchObject({ network: "n", decimals: 6, microusdPerToken: 1_000_000n, minAmountAtomic: 1n, maxAmountAtomic: null });
    expect(n?.assetContract).toBe("");
  });
  it.each([
    ["not JSON", "{nope"],
    ["missing policy field", JSON.stringify({ routes: [{ ...good, microusdPerToken: undefined }] })],
    ["missing confirmations", JSON.stringify({ routes: [{ ...good, confirmations: undefined }] })],
    ["unknown key", JSON.stringify({ routes: [{ ...good, treasury: "x" }] })],
    ["duplicate pair", JSON.stringify({ routes: [good, good] })],
    ["zero rate", JSON.stringify({ routes: [{ ...good, microusdPerToken: "0" }] })],
    ["max below min", JSON.stringify({ routes: [{ ...good, minAmountAtomic: "10", maxAmountAtomic: "5" }] })],
    ["bad overpayment policy", JSON.stringify({ routes: [{ ...good, overpayment: "keep" }] })],
  ])("rejects %s at load time", (_n, raw) => {
    expect(() => parsePaymentRoutes(raw)).toThrow();
  });
});

describe("deposit intents", () => {
  let h: PaymentsHarness;
  beforeAll(async () => {
    h = await makePaymentsHarness();
  });
  afterAll(async () => {
    await h.db.close();
  });

  it("lists the configured pairs with their approved parameters", async () => {
    const s = await login(h.app);
    const r = await call<any>(h.app, "GET", "/api/deposits/networks", { cookie: s.cookie });
    const list = PaymentNetworkList.parse(r.json);
    expect(list.items.map((i) => `${i.network}/${i.asset}`)).toEqual(["testnet-a/TUSD", "testnet-b/TUSD"]);
    expect(list.items[0]).toMatchObject({ chainId: "1001", assetContract: TOKEN_A, decimals: 6, requiredConfirmations: 3, minAmountAtomic: "1000000", maxAmountAtomic: "1000000000" });
    expect(list.items[1]?.maxAmountAtomic).toBeNull();
  });

  it("creates an intent with a unique address, expiry, and snapshot of the route", async () => {
    const s = await login(h.app);
    const r = await createDeposit(h, s, BODY);
    expect(r.status).toBe(201);
    const d = Deposit.parse(r.json);
    expect(d).toMatchObject({ status: "CREATED", network: "testnet-a", asset: "TUSD", assetContract: TOKEN_A, amountAtomic: "5000000", decimals: 6, requiredConfirmations: 3, confirmations: 0, creditedMicrousd: null, ledgerTransactionId: null, reviewReason: null });
    expect(d.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(Date.parse(d.expiresAt) - Date.parse(d.createdAt)).toBe(3600_000);
    const r2 = await createDeposit(h, s, BODY);
    expect(Deposit.parse(r2.json).address).not.toBe(d.address); // distinct key = distinct intent = distinct address
    const audit = await h.db.query<any>("select action, metadata from audit_events where target_id=$1", [d.id]);
    expect(audit.map((a) => a.action)).toEqual(["deposit.intent_created"]);
  });

  it("requires an Idempotency-Key; rejects malformed ones", async () => {
    const s = await login(h.app);
    const none = await call<any>(h.app, "POST", "/api/deposits", { cookie: s.cookie, body: BODY });
    expect(none.status).toBe(400);
    expect(code(none)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const short = await createDeposit(h, s, BODY, "short");
    expect(short.status).toBe(400);
    expect(code(short)).toBe("BAD_REQUEST");
  });

  it("is idempotent: same key and payload replays the same intent; a changed payload is 409; concurrent duplicates make one", async () => {
    const s = await login(h.app);
    const key = idemKey();
    const first = await createDeposit(h, s, BODY, key);
    const replay = await createDeposit(h, s, BODY, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect(replay.json).toEqual(first.json);
    const changed = await createDeposit(h, s, { ...BODY, amountAtomic: "6000000" }, key);
    expect(changed.status).toBe(409);
    expect(code(changed)).toBe("IDEMPOTENCY_CONFLICT");

    const k2 = idemKey();
    const rs = await Promise.all(Array.from({ length: 5 }, () => createDeposit(h, s, BODY, k2)));
    const ids = new Set(rs.filter((r) => r.status === 201).map((r) => r.json.id));
    expect(ids.size).toBe(1);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    expect((await h.db.query("select 1 from deposit_intents where id=$1", [[...ids][0]]))).toHaveLength(1);
  });

  it("validates pair and amount bounds with field errors (422), and rejects a client-supplied tx hash", async () => {
    const s = await login(h.app);
    for (const body of [
      { ...BODY, network: "mainnet-x" },
      { ...BODY, asset: "NOPE" },
      { ...BODY, amountAtomic: "999999" },
      { ...BODY, amountAtomic: "1000000001" },
      { ...BODY, amountAtomic: "-5" },
      { ...BODY, amountAtomic: "1.5" },
      { ...BODY, txHash: txHash() },
    ]) {
      const r = await createDeposit(h, s, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(code(r)).toBe("VALIDATION_FAILED");
      expect(r.json.error.fieldErrors.length).toBeGreaterThan(0);
    }
    expect((await call<any>(h.app, "POST", "/api/deposits", { cookie: s.cookie, rawBody: "{", headers: { "Idempotency-Key": idemKey() } })).status).toBe(400);
  });

  it("a failed validation does not burn the Idempotency-Key", async () => {
    const s = await login(h.app);
    const key = idemKey();
    expect((await createDeposit(h, s, { ...BODY, amountAtomic: "1" }, key)).status).toBe(422);
    expect((await createDeposit(h, s, BODY, key)).status).toBe(201);
  });

  it("no endpoint accepts a transaction hash to confirm or credit a deposit", async () => {
    const s = await login(h.app);
    const d = (await createDeposit(h, s, BODY)).json;
    for (const path of [`/api/deposits/${d.id}/confirm`, `/api/deposits/${d.id}/credit`, `/api/deposits/confirm`]) {
      const r = await call<any>(h.app, "POST", path, { cookie: s.cookie, body: { txHash: txHash() }, headers: { "Idempotency-Key": idemKey() } });
      expect([404, 405]).toContain(r.status);
    }
    expect(await balanceOf(h, s)).toBe("0");
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREATED");
  });

  it("enforces roles: owner and billing may use it; admin and member may not; anonymous is 401", async () => {
    const owner = await login(h.app);
    const billing = await seedMember(h, owner.accountId, "billing");
    const admin = await seedMember(h, owner.accountId, "admin");
    const member = await seedMember(h, owner.accountId, "member");
    expect((await createDeposit(h, billing, BODY)).status).toBe(201);
    for (const who of [admin, member]) {
      expect((await createDeposit(h, who, BODY)).status).toBe(403);
      expect((await call(h.app, "GET", "/api/deposits", { cookie: who.cookie })).status).toBe(403);
      expect((await call(h.app, "GET", "/api/deposits/networks", { cookie: who.cookie })).status).toBe(403);
    }
    expect((await call(h.app, "POST", "/api/deposits", { body: BODY, headers: { "Idempotency-Key": idemKey() } })).status).toBe(401);
    expect((await call(h.app, "GET", "/api/deposits")).status).toBe(401);
    const noOrigin = await call(h.app, "POST", "/api/deposits", { cookie: owner.cookie, body: BODY, origin: null, headers: { "Idempotency-Key": idemKey() } });
    expect(noOrigin.status).toBe(403);
  });

  it("isolates accounts: another account gets 404 on get, sees nothing in lists, and keys do not collide", async () => {
    const a = await login(h.app);
    const b = await login(h.app);
    const key = idemKey();
    const da = (await createDeposit(h, a, BODY, key)).json;
    const db = (await createDeposit(h, b, BODY, key)).json; // same key, different account: independent
    expect(db.id).not.toBe(da.id);
    const cross = await getDeposit(h, b, da.id);
    expect(cross.status).toBe(404);
    expect(code(cross)).toBe("NOT_FOUND");
    const listB = DepositList.parse((await call<any>(h.app, "GET", "/api/deposits", { cookie: b.cookie })).json);
    expect(listB.items.map((i) => i.id)).toEqual([db.id]);
  });

  it("caps open intents per account", async () => {
    const s = await login(h.app);
    for (let i = 0; i < 10; i++) expect((await createDeposit(h, s, BODY)).status).toBe(201);
    const r = await createDeposit(h, s, BODY);
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/Too many open deposit intents/);
  });

  it("pages the list with a stable cursor", async () => {
    const s = await login(h.app);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 1000);
      ids.push((await createDeposit(h, s, BODY)).json.id);
    }
    const p1 = DepositList.parse((await call<any>(h.app, "GET", "/api/deposits?limit=2", { cookie: s.cookie })).json);
    expect(p1.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(p1.nextCursor).not.toBeNull();
    const p2 = DepositList.parse((await call<any>(h.app, "GET", `/api/deposits?limit=2&cursor=${p1.nextCursor}`, { cookie: s.cookie })).json);
    expect(p2.items.map((i) => i.id)).toEqual(ids.slice(2));
    expect(p2.nextCursor).toBeNull();
    expect((await call(h.app, "GET", "/api/deposits?cursor=%%%", { cookie: s.cookie })).status).toBe(400);
  });

  it("expires an unpaid intent after expiry plus grace (shown as CREATED until the grace has passed)", async () => {
    const s = await login(h.app);
    const d = (await createDeposit(h, s, BODY)).json;
    h.clock.now = new Date(Date.parse(d.expiresAt) + 300_000); // inside the 600 s grace
    expect((await getDeposit(h, s, d.id)).json.status).toBe("CREATED");
    h.clock.now = new Date(Date.parse(d.expiresAt) + 601_000);
    expect((await getDeposit(h, s, d.id)).json.status).toBe("EXPIRED");
  });

  it("reflects a confirmed credit end to end (fake chain) in the deposit, the balance and the ledger", async () => {
    const s = await login(h.app);
    const d = (await createDeposit(h, s, BODY)).json;
    h.chain.send({ network: "testnet-a", txHash: txHash(), assetContract: TOKEN_A, to: d.address, amountAtomic: 5_000_000n });
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CONFIRMING", confirmations: 1, creditedMicrousd: null });
    h.chain.mine("testnet-a", 2);
    await h.observe();
    const done = Deposit.parse((await getDeposit(h, s, d.id)).json);
    expect(done).toMatchObject({ status: "CREDITED", creditedMicrousd: "5000000" });
    expect(done.ledgerTransactionId).not.toBeNull();
    expect(await balanceOf(h, s)).toBe("5000000");
    const ledger = await call<any>(h.app, "GET", "/api/ledger?kind=deposit", { cookie: s.cookie });
    expect(ledger.json.items).toHaveLength(1);
    expect(ledger.json.items[0]).toMatchObject({ amountMicrousd: "5000000", source: { type: "deposit", id: d.id } });
  });

  it("the test address provider refuses to run in production", async () => {
    const prior = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(new TestAddressProvider().addressFor({ intentId: "x", network: "n", asset: "a" })).rejects.toThrow(/production/);
    } finally {
      if (prior === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prior;
    }
  });

  it("scales amounts by the pair's decimals", async () => {
    const s = await login(h.app);
    const d = (await createDeposit(h, s, { network: "testnet-b", asset: "TUSD", amountAtomic: (2n * 10n ** 18n).toString() })).json;
    expect(d).toMatchObject({ decimals: 18, requiredConfirmations: 2 });
    h.chain.send({ network: "testnet-b", txHash: txHash(), assetContract: ROUTE_B.assetContract, to: d.address, amountAtomic: 2n * 10n ** 18n });
    h.chain.mine("testnet-b", 1);
    await h.observe();
    expect((await getDeposit(h, s, d.id)).json).toMatchObject({ status: "CREDITED", creditedMicrousd: "2000000" });
  });
});
