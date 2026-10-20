/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Binding, BindingList, ChannelStatusList, DeliveryList, PairingCode } from "@llmcrypto/contracts";
import { ChannelError, FakeChannelProvider, enqueueNotification, renderNotification, type ChannelRegistry } from "@llmcrypto/domain";
import { createApp } from "../../apps/api/src/app";
import { createGateway } from "../../apps/api/src/gateway/dispatch";
import { FakeProvider } from "../../apps/api/src/gateway/fake-provider";
import { randomId } from "../../apps/api/src/crypto";
import { runNotificationDelivery } from "../../apps/worker/src/notifications";
import { BASE_TIME, advance, call, dumpDatabase, login, makeHarness, seedMember, type Harness, type LoggedIn } from "./helpers";
import { createKey, fund } from "./metering-helpers";
import { ROUTE_A, createDeposit, makePaymentsHarness } from "./payments-helpers";
import { txHash } from "./payments-helpers";
import { DEFAULT_OPTIMIZATION_CONFIG } from "@llmcrypto/contracts";

let h: Harness;
let app: ReturnType<typeof createApp>;
let tg: FakeChannelProvider;
let wa: FakeChannelProvider;
let fakeProvider: FakeProvider;
let gwApp: ReturnType<typeof createApp>;

beforeAll(async () => {
  h = await makeHarness({}, { GATEWAY_PROVIDER: "fake" });
  tg = new FakeChannelProvider("telegram");
  wa = new FakeChannelProvider("whatsapp");
  app = createApp({ db: h.db, config: h.config, channels: { telegram: tg, whatsapp: wa } });
  fakeProvider = new FakeProvider();
  const gateway = createGateway({ db: h.db, config: h.config, provider: fakeProvider });
  gwApp = createApp({ db: h.db, config: h.config, gateway, channels: { telegram: tg, whatsapp: wa } });
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(async () => {
  h.clock.now = new Date(BASE_TIME);
  tg.sent.length = 0;
  wa.sent.length = 0;
  // Test isolation: the runner is global, so events a previous test left queued must not be picked up by this one.
  await h.db.query("update notification_events set status='done' where status <> 'done'");
});

type Who = Pick<LoggedIn, "cookie">;
const api = <T = any>(method: string, path: string, s: Who | null, body?: unknown, a = app) =>
  call<T>(a, method, path, { cookie: s?.cookie, ...(body !== undefined ? { body } : {}) });
const runner = (channels: ChannelRegistry = { telegram: tg, whatsapp: wa }, extra: Record<string, unknown> = {}) =>
  runNotificationDelivery({ db: h.db, channels, now: () => new Date(h.clock.now), newId: randomId, ...extra });

/** Pairs a fresh channel user to the account through the real flow and returns the binding. */
async function pair(s: LoggedIn, provider: FakeChannelProvider, sender: string, events: string[] = []) {
  const code = await api<any>("POST", "/api/connectivity/pairings", s, { channel: provider.channel });
  expect(code.status, JSON.stringify(code.json)).toBe(201);
  provider.userSends(sender, `/start ${code.json.code}`);
  const ok = await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s, { events });
  expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  return ok.json as { id: string; destination: string; events: string[] };
}
const deliveries = (accountId: string) => h.db.query<any>("select binding_id, event_kind, status, attempts, error_code, provider_message_id from notification_deliveries where account_id=$1 order by created_at, id", [accountId]);
const events = (accountId: string) => h.db.query<any>("select kind, status, dedupe_key, data from notification_events where account_id=$1 order by created_at, id", [accountId]);

describe("channel availability", () => {
  it("reports each channel's mode; an unconfigured channel cannot be paired (503) and never claims to be live", async () => {
    const s = await login(app);
    const r = await api<any>("GET", "/api/connectivity/channels", s);
    expect(ChannelStatusList.parse(r.json).items).toEqual([
      { channel: "telegram", available: true, mode: "fake", note: expect.stringMatching(/never delivered/) },
      { channel: "whatsapp", available: true, mode: "fake", note: expect.any(String) },
    ]);
    const bare = createApp({ db: h.db, config: h.config });
    const s2 = await login(bare);
    const none = await api<any>("GET", "/api/connectivity/channels", s2, undefined, bare);
    expect(none.json.items.map((i: any) => [i.channel, i.available, i.mode])).toEqual([["telegram", false, "unconfigured"], ["whatsapp", false, "unconfigured"]]);
    const p = await api<any>("POST", "/api/connectivity/pairings", s2, { channel: "telegram" }, bare);
    expect(p.status).toBe(503);
    expect(p.json.error.code).toBe("UNAVAILABLE");
  });
});

describe("pairing: single-use codes, claim by the channel user, replay and isolation", () => {
  it("telegram happy path: code shown once, stored only as a digest, masked destination, audited", async () => {
    const s = await login(app);
    const code = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    expect(PairingCode.parse(code.json)).toMatchObject({ channel: "telegram", expiresAt: "2026-10-18T12:10:00.000Z" });
    expect(code.json.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const raw = code.json.code.replace("-", "");
    tg.userSends("987654321", `hello ${code.json.code.toLowerCase()}`);
    const b = await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s, { events: ["insufficient_funds", "insufficient_funds"] });
    expect(b.status).toBe(201);
    expect(Binding.parse(b.json)).toMatchObject({ channel: "telegram", destination: "••••4321", events: ["insufficient_funds"] });
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(raw); // only the keyed digest is stored
    expect((await h.db.query<any>("select consumed_at, claimed_destination from notification_pairings where id=$1", [code.json.pairingId]))[0].claimed_destination).toBe("987654321");
    expect(BindingList.parse((await api("GET", "/api/connectivity/bindings", s)).json).items).toHaveLength(1);
    const aud = await h.db.query<any>("select action, metadata from audit_events where account_id=$1 and action like 'connectivity.%' order by created_at, id", [s.accountId]);
    expect(aud.map((a) => a.action).sort()).toEqual(["connectivity.paired", "connectivity.pairing_started"]);
    expect(JSON.stringify(aud)).not.toContain(raw);
    expect(JSON.stringify(aud)).not.toContain("987654321");
  });

  it("whatsapp pairs the same way with its own sender format", async () => {
    const s = await login(app);
    const b = await pair(s, wa, "15551230001", ["loop_guard"]);
    expect(b).toMatchObject({ destination: "••••0001", events: ["loop_guard"] });
    const badSender = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "whatsapp" });
    wa.userSends("not-a-number", badSender.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${badSender.json.pairingId}/confirm`, s, {})).status).toBe(422); // invalid sender never claims
  });

  it("replay: a consumed code cannot be confirmed again or claimed by another channel user", async () => {
    const s = await login(app);
    const code = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    tg.userSends("1111111111", code.json.code);
    const first = await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s);
    expect(first.status).toBe(201);
    const again = await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s);
    expect(again.status).toBe(422);
    expect(again.json.error.fieldErrors[0].field).toBe("pairing");
    tg.userSends("2222222222", code.json.code); // someone else replays the code
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s)).status).toBe(422);
    expect((await api<any>("GET", "/api/connectivity/bindings", s)).json.items).toHaveLength(1);
    expect((await h.db.query<any>("select claimed_destination from notification_pairings where id=$1", [code.json.pairingId]))[0].claimed_destination).toBe("1111111111");
  });

  it("concurrent confirms consume the code once: exactly one binding", async () => {
    const s = await login(app);
    const code = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    tg.userSends("3333333333", code.json.code);
    const rs = await Promise.all(Array.from({ length: 6 }, () => api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 422)).toHaveLength(5);
    expect((await h.db.query<any>("select count(*)::int n from notification_bindings where account_id=$1", [s.accountId]))[0].n).toBe(1);
  });

  it("not claimed yet, expired, or wrong channel: 422 and nothing is bound; a late claim still works before expiry", async () => {
    const s = await login(app);
    const code = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s)).status).toBe(422); // nobody sent it
    wa.userSends("15550001111", code.json.code); // sent to the WhatsApp number instead: that channel's digest differs
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s)).status).toBe(422);
    tg.userSends("4444444444", code.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s)).status).toBe(201);

    const old = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    tg.userSends("5555555555", old.json.code);
    advance(h, 601);
    expect((await api<any>("POST", `/api/connectivity/pairings/${old.json.pairingId}/confirm`, s)).status).toBe(422);
    expect((await h.db.query<any>("select count(*)::int n from notification_bindings where account_id=$1", [s.accountId]))[0].n).toBe(1);
    // an expired code cannot be claimed late either
    const late = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    advance(h, 601);
    tg.userSends("6666666666", late.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${late.json.pairingId}/confirm`, s)).status).toBe(422);
    expect((await h.db.query<any>("select claimed_destination from notification_pairings where id=$1", [late.json.pairingId]))[0].claimed_destination).toBeNull();
  });

  it("repeated unclaimed confirms burn the pairing", async () => {
    const s = await login(app);
    const code = await api<any>("POST", "/api/connectivity/pairings", s, { channel: "telegram" });
    for (let i = 0; i < 31; i++) await api("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s);
    tg.userSends("7777777777", code.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, s)).status).toBe(422);
  });

  it("account isolation: another account or another user cannot confirm, list, update, unpair or test a binding", async () => {
    const a = await login(app);
    const b = await login(app);
    const code = await api<any>("POST", "/api/connectivity/pairings", a, { channel: "telegram" });
    tg.userSends("8888888888", code.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, b)).status).toBe(404); // B cannot consume A's pairing
    const otherAdmin = await seedMember(h, a.accountId, "admin"); // same account, different user: the code is bound to its issuer
    expect((await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, otherAdmin)).status).toBe(404);
    const bind = (await api<any>("POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, a)).json;
    expect(bind.id).toBeTruthy();
    expect((await api<any>("GET", "/api/connectivity/bindings", b)).json.items).toEqual([]);
    expect((await api<any>("GET", "/api/connectivity/bindings", otherAdmin)).json.items).toHaveLength(1); // account-wide for owner/admin
    expect((await api("PUT", `/api/connectivity/bindings/${bind.id}`, b, { events: ["loop_guard"] })).status).toBe(404);
    expect((await api("DELETE", `/api/connectivity/bindings/${bind.id}`, b)).status).toBe(404);
    expect((await api("POST", `/api/connectivity/bindings/${bind.id}/test`, b)).status).toBe(404);
    // the same channel account may be paired by two accounts independently; each proves control with its own code
    const code2 = await api<any>("POST", "/api/connectivity/pairings", b, { channel: "telegram" });
    tg.userSends("8888888888", code2.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${code2.json.pairingId}/confirm`, b)).status).toBe(201);
    expect((await api<any>("GET", "/api/connectivity/bindings", a)).json.items).toHaveLength(1);
    // pairing the same channel account twice in one account is refused
    const dup = await api<any>("POST", "/api/connectivity/pairings", a, { channel: "telegram" });
    tg.userSends("8888888888", dup.json.code);
    expect((await api<any>("POST", `/api/connectivity/pairings/${dup.json.pairingId}/confirm`, a)).status).toBe(422);
  });

  it("roles, step-up, API-key sessions and the open-code cap", async () => {
    const owner = await login(app);
    const member = await seedMember(h, owner.accountId, "member");
    const billing = await seedMember(h, owner.accountId, "billing");
    for (const who of [member, billing]) {
      expect((await api("POST", "/api/connectivity/pairings", who, { channel: "telegram" })).status).toBe(403);
      expect((await api("GET", "/api/connectivity/bindings", who)).status).toBe(403);
      expect((await api("GET", "/api/connectivity/deliveries", who)).status).toBe(403);
      expect((await api("GET", "/api/connectivity/channels", who)).status).toBe(403);
    }
    expect((await api("POST", "/api/connectivity/pairings", null, { channel: "telegram" })).status).toBe(401);
    expect((await call(app, "POST", "/api/connectivity/pairings", { cookie: owner.cookie, body: { channel: "telegram" }, origin: null })).status).toBe(403);
    expect((await api("POST", "/api/connectivity/pairings", owner, { channel: "sms" })).status).toBe(422);
    expect((await call(app, "POST", "/api/connectivity/pairings", { cookie: owner.cookie, rawBody: "{" })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await api("POST", "/api/connectivity/pairings", owner, { channel: "telegram" })).status).toBe(201);
    const capped = await api<any>("POST", "/api/connectivity/pairings", owner, { channel: "telegram" });
    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toBe("60");
    const k = await createKey(h as any, owner, { scopes: ["usage:read"] });
    const ks = await call<any>(app, "POST", "/api/auth/key-sessions", { body: { apiKey: k.secret } });
    const kc = ks.setCookie.find((c) => c.startsWith("session="))!.split(";")[0]!;
    expect((await api("GET", "/api/connectivity/bindings", { cookie: kc })).status).toBe(403);
    advance(h, 16 * 60);
    expect((await api<any>("POST", "/api/connectivity/pairings", owner, { channel: "telegram" })).json.error.code).toBe("STEP_UP_REQUIRED");
  });
});

describe("preferences and unpair", () => {
  it("event preferences are replaceable and validated; unpair is final and skips queued messages", async () => {
    const s = await login(app);
    const b = await pair(s, tg, "1010101010", ["insufficient_funds"]);
    const up = await api<any>("PUT", `/api/connectivity/bindings/${b.id}`, s, { events: ["loop_guard", "deposit_credited"] });
    expect(up.status).toBe(200);
    expect(up.json.events).toEqual(["loop_guard", "deposit_credited"]);
    expect((await api<any>("GET", "/api/connectivity/bindings", s)).json.items[0].events).toEqual(["loop_guard", "deposit_credited"]);
    expect((await api("PUT", `/api/connectivity/bindings/${b.id}`, s, { events: ["test"] })).status).toBe(422);
    expect((await api("PUT", `/api/connectivity/bindings/${b.id}`, s, { events: ["nope"] })).status).toBe(422);
    expect((await api("PUT", `/api/connectivity/bindings/${b.id}`, s, { events: [] })).status).toBe(200);

    // queue a test message, then unpair before the worker runs: it is skipped, nothing is sent
    expect((await api("POST", `/api/connectivity/bindings/${b.id}/test`, s)).status).toBe(202);
    expect((await api("DELETE", `/api/connectivity/bindings/${b.id}`, s)).status).toBe(204);
    expect((await api("DELETE", `/api/connectivity/bindings/${b.id}`, s)).status).toBe(404);
    expect((await api("GET", "/api/connectivity/bindings", s)).json.items).toEqual([]);
    expect((await api("POST", `/api/connectivity/bindings/${b.id}/test`, s)).status).toBe(404);
    await runner();
    expect(tg.sent).toHaveLength(0);
    expect((await events(s.accountId))[0].status).toBe("done");
    // and the channel account can be paired again afterwards
    expect((await pair(s, tg, "1010101010")).id).not.toBe(b.id);
  });
});

describe("delivery worker: outbox, minimal data, failure and concurrency", () => {
  it("test message: fixed template only, status sent, rate limited to one per minute", async () => {
    const s = await login(app);
    const b = await pair(s, tg, "2020202020");
    const t = await api<any>("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    expect(t.status).toBe(202);
    expect(t.json.bindingId).toBe(b.id);
    const limited = await api<any>("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(tg.sent).toHaveLength(0); // asynchronous: nothing happens until the worker runs
    expect(await runner()).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({ to: "2020202020", text: renderNotification("test", null) });
    const list = DeliveryList.parse((await api("GET", "/api/connectivity/deliveries", s)).json);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ bindingId: b.id, channel: "telegram", eventKind: "test", status: "sent", attempts: 1, errorCode: null, sentAt: "2026-10-18T12:00:00.000Z" });
    expect(await runner()).toMatchObject({ claimed: 0 }); // nothing to redo
    advance(h, 61);
    expect((await api("POST", `/api/connectivity/bindings/${b.id}/test`, s)).status).toBe(202);
  });

  it("gateway alerts reach only subscribed bindings, once per hour per cause, and carry no keys, prompts or amounts", async () => {
    const s = await login(gwApp);
    await fund(h, s.accountId, 10n); // too little for any request
    const key = await createKey(h as any, s);
    const subscribed = await pair(s, tg, "3030303030", ["insufficient_funds"]);
    const other = await pair(s, wa, "15559990000", ["loop_guard"]);
    const marker = "ALERT-PROMPT-MARKER-4242";
    const post = (content: string) => gwApp.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ model: "sample-fast-1", max_tokens: 200, messages: [{ role: "user", content }] }) });
    const r1 = await post(marker);
    expect(r1.status).toBe(402);
    const r2 = await post(`${marker} again`);
    expect(r2.status).toBe(402);
    expect(await events(s.accountId)).toHaveLength(1); // deduplicated: one alert per key per hour
    expect(await runner()).toMatchObject({ claimed: 1, sent: 1 });
    expect(tg.sent).toHaveLength(1);
    expect(wa.sent).toHaveLength(0); // not subscribed to insufficient_funds
    const text = tg.sent[0]!.text;
    expect(text).toBe(renderNotification("insufficient_funds", r1.headers.get("x-request-id")));
    for (const secret of [key.secret, marker, "sk_"]) expect(text).not.toContain(secret);
    expect(JSON.stringify(await events(s.accountId))).not.toContain(marker);
    expect((await deliveries(s.accountId)).map((d) => [d.binding_id, d.status])).toEqual([[subscribed.id, "sent"]]);
    advance(h, 3601); // next hour: a new alert is allowed
    await post("later");
    expect(await events(s.accountId)).toHaveLength(2);
    void other;
  });

  it("LoopGuard advisory and enforced blocks raise a loop_guard alert", async () => {
    const s = await login(gwApp);
    await fund(h, s.accountId, 5_000_000n);
    const key = await createKey(h as any, s);
    await pair(s, tg, "4040404040", ["loop_guard"]);
    const lg = { ...DEFAULT_OPTIMIZATION_CONFIG.loopGuard, enabled: true, threshold: 2 };
    expect((await api("PUT", "/api/optimization/policy", s, { expectedVersion: 0, config: { ...DEFAULT_OPTIMIZATION_CONFIG, loopGuard: lg } }, gwApp)).status).toBe(200);
    const post = () => gwApp.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ model: "sample-fast-1", max_tokens: 20, messages: [{ role: "user", content: "again and again" }] }) });
    await post();
    expect((await post()).headers.get("x-loopguard")).toMatch(/advisory/);
    expect(await runner()).toMatchObject({ sent: 1 });
    expect(tg.sent[0]!.text).toContain("LoopGuard noticed repeated identical requests");
  });

  it("deposit events: a credit and a review each enqueue an alert in the credit's own transaction", async () => {
    const p = await makePaymentsHarness([ROUTE_A]);
    const papp = createApp({ db: p.db, config: p.config, channels: { telegram: tg } });
    const s = await login(papp);
    const sendBack = new FakeChannelProvider("telegram");
    const lapp = createApp({ db: p.db, config: p.config, channels: { telegram: sendBack } });
    const code = await call<any>(lapp, "POST", "/api/connectivity/pairings", { cookie: s.cookie, body: { channel: "telegram" } });
    sendBack.userSends("5050505050", code.json.code);
    const bnd = await call<any>(lapp, "POST", `/api/connectivity/pairings/${code.json.pairingId}/confirm`, { cookie: s.cookie, body: { events: ["deposit_credited", "deposit_needs_review"] } });
    expect(bnd.status).toBe(201);
    const d1 = await createDeposit(p, s, { network: "testnet-a", asset: "TUSD", amountAtomic: "5000000" });
    p.chain.send({ network: "testnet-a", txHash: txHash(), assetContract: ROUTE_A.assetContract, to: d1.json.address, amountAtomic: 5_000_000n } as any);
    p.chain.mine("testnet-a", 3);
    await p.observe();
    const d2 = await createDeposit(p, s, { network: "testnet-a", asset: "TUSD", amountAtomic: "5000000" });
    p.chain.send({ network: "testnet-a", txHash: txHash(), assetContract: ROUTE_A.assetContract, to: d2.json.address, amountAtomic: 4_000_000n } as any); // underpaid -> review
    p.chain.mine("testnet-a", 3);
    await p.observe();
    await p.observe(); // a repeated observation must not duplicate the alerts
    const out = await runNotificationDelivery({ db: p.db, channels: { telegram: sendBack }, now: () => new Date(p.clock.now), newId: randomId });
    expect(out).toMatchObject({ claimed: 2, sent: 2 });
    expect(sendBack.sent.map((m) => m.text).sort()).toEqual([renderNotification("deposit_credited", d1.json.id), renderNotification("deposit_needs_review", d2.json.id)].sort());
    for (const m of sendBack.sent) expect(m.text).not.toMatch(/5000000|4000000|0x/);
    await p.db.close();
  });

  it("transient failures retry with backoff and then succeed; the provider's idempotency token prevents a duplicate", async () => {
    const s = await login(app);
    const b = await pair(s, tg, "6060606060");
    await api("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    tg.failNext(new ChannelError("transient", "UPSTREAM_503", "down"), new ChannelError("transient", "UPSTREAM_503", "down"));
    expect(await runner()).toMatchObject({ claimed: 1, retrying: 1, sent: 0 });
    expect((await deliveries(s.accountId))[0]).toMatchObject({ status: "pending", attempts: 1, error_code: "UPSTREAM_503" });
    expect(await runner()).toMatchObject({ claimed: 0 }); // not before the backoff
    advance(h, 31);
    expect(await runner()).toMatchObject({ claimed: 1, retrying: 1 });
    advance(h, 30);
    expect(await runner()).toMatchObject({ claimed: 0 }); // second backoff is 60 s
    advance(h, 31);
    expect(await runner()).toMatchObject({ claimed: 1, sent: 1 });
    expect(tg.sent).toHaveLength(1);
    expect((await deliveries(s.accountId))[0]).toMatchObject({ status: "sent", attempts: 3, error_code: null });
    expect((await events(s.accountId))[0].status).toBe("done");
  });

  it("permanent errors and exhausted retries end as failed, visibly, without affecting anything else", async () => {
    const s = await login(app);
    const b = await pair(s, tg, "7070707070");
    await api("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    tg.failNext(new ChannelError("permanent", "BOT_BLOCKED", "user blocked the bot"));
    expect(await runner()).toMatchObject({ failed: 1, sent: 0 });
    expect((await deliveries(s.accountId))[0]).toMatchObject({ status: "failed", attempts: 1, error_code: "BOT_BLOCKED" });
    const failed = DeliveryList.parse((await api("GET", `/api/connectivity/deliveries?bindingId=${b.id}`, s)).json).items[0]!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "BOT_BLOCKED", sentAt: null });

    advance(h, 61);
    await api("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    tg.failNext(...Array.from({ length: 3 }, () => new ChannelError("transient", "TIMEOUT", "slow")));
    for (let i = 0; i < 3; i++) {
      await runner();
      advance(h, 130);
    }
    const last = (await deliveries(s.accountId)).at(-1)!;
    expect(last).toMatchObject({ status: "failed", attempts: 3, error_code: "TIMEOUT" });
    expect(tg.sent).toHaveLength(0);
    // a channel with no provider configured fails visibly instead of silently dropping
    advance(h, 61);
    await api("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    const noProvider = { whatsapp: wa } as ChannelRegistry;
    for (let i = 0; i < 3; i++) {
      await runner(noProvider);
      advance(h, 130);
    }
    expect((await deliveries(s.accountId)).at(-1)).toMatchObject({ status: "failed", error_code: "CHANNEL_NOT_CONFIGURED" });
  });

  it("two runners at once deliver each message exactly once; a crashed runner's event is retried after its lease", async () => {
    const s = await login(app);
    const b = await pair(s, tg, "8080808080");
    await api("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    const reports = await Promise.all([runner(), runner(), runner()]);
    expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(tg.sent).toHaveLength(1);

    advance(h, 61);
    await api("POST", `/api/connectivity/bindings/${b.id}/test`, s);
    // simulate a runner that claimed the event and died: status running with a lease
    await h.db.query("update notification_events set status='running', lease_until=$1 where status='queued' and account_id=$2", [new Date(h.clock.now.getTime() + 120_000), s.accountId]);
    expect(await runner()).toMatchObject({ claimed: 0 });
    advance(h, 121);
    expect(await runner()).toMatchObject({ claimed: 1, sent: 1 });
    expect(tg.sent).toHaveLength(2);
  });

  it("deliveries are account-scoped and paged; enqueue writes nothing when nobody subscribes", async () => {
    const a = await login(app);
    const b = await login(app);
    const ba = await pair(a, tg, "9090909090");
    for (let i = 0; i < 3; i++) {
      await api("POST", `/api/connectivity/bindings/${ba.id}/test`, a);
      await runner();
      advance(h, 61);
    }
    const p1 = await api<any>("GET", "/api/connectivity/deliveries?limit=2", a);
    expect(p1.json.items).toHaveLength(2);
    const p2 = await api<any>("GET", `/api/connectivity/deliveries?limit=2&cursor=${p1.json.nextCursor}`, a);
    expect(p2.json.items).toHaveLength(1);
    expect(p2.json.nextCursor).toBeNull();
    expect((await api<any>("GET", "/api/connectivity/deliveries", b)).json.items).toEqual([]);
    expect((await api<any>("GET", `/api/connectivity/deliveries?bindingId=${ba.id}`, b)).json.items).toEqual([]);
    expect(await enqueueNotification(h.db, { id: randomId("nev"), accountId: b.accountId, kind: "insufficient_funds", dedupeKey: "x", at: h.clock.now })).toBe(false);
    expect(await events(b.accountId)).toEqual([]);
  });
});
