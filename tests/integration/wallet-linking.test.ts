/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, concat, stringToBytes, toHex } from "viem";
import { ErrorEnvelope, IdentityList, LinkedIdentity, SessionView } from "@llmcrypto/contracts";
import { base58Decode, base58Encode, buildTronMessage, normalizeTronAddress, tronAddressFromBytes20, tronMessageDigest, verifyTronSignature } from "../../apps/api/src/auth/tron";
import { BASE_TIME, ORIGIN, advance, call, challenge, login, makeHarness, newEvmWallet, newTronWallet, sign, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

async function link(session: { cookie: string }, w: ReturnType<typeof newTronWallet> | ReturnType<typeof newEvmWallet>, over: { signer?: typeof w } = {}) {
  advance(h, 1); // distinct created_at so list order is deterministic
  const ch = await challenge(h.app, w, { cookie: session.cookie, purpose: "link" });
  if (ch.status !== 201) return ch as any;
  const signature = await sign(over.signer ?? w, ch.json.message);
  return call(h.app, "POST", "/api/identities", { cookie: session.cookie, body: { challengeId: ch.json.challengeId, signature } });
}

describe("TRON primitives", () => {
  it("encodes known TRON addresses", () => {
    // privkey 0x..01 -> EVM 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf; zero address
    expect(tronAddressFromBytes20(Buffer.from("7E5F4552091A69125d5DfCb7b8C2659029395Bdf", "hex"))).toBe("TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC");
    expect(tronAddressFromBytes20(Buffer.alloc(20))).toBe("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
    expect(normalizeTronAddress("TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC")).toBe("TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC");
    expect(normalizeTronAddress("TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HD")).toBeNull(); // checksum
    expect(normalizeTronAddress("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf")).toBeNull();
    expect(normalizeTronAddress("")).toBeNull();
  });
  it("base58 round-trips including leading zero bytes", () => {
    for (const hex of ["", "00", "0000ff", "ff00", "0123456789abcdef"]) {
      const bytes = Buffer.from(hex, "hex");
      expect(Buffer.from(base58Decode(base58Encode(bytes))!).toString("hex")).toBe(hex);
    }
    expect(base58Decode("0OIl")).toBeNull();
  });
  it("digest follows the signMessageV2 construction (prefix + UTF-8 byte length + message)", () => {
    const message = "héllo"; // 6 UTF-8 bytes, 5 chars: length must be bytes
    const manual = keccak256(concat([stringToBytes("\x19TRON Signed Message:\n"), stringToBytes("6"), stringToBytes(message)]));
    expect(tronMessageDigest(message)).toBe(manual);
    expect(toHex(stringToBytes(message)).length).toBe(2 + 12);
  });
});

describe("TRON sign-in", () => {
  it("creates an account for a new TRON wallet, then logs into the same one", async () => {
    const w = newTronWallet();
    const a = await login(h.app, w);
    expect(SessionView.parse(a.view).membership.role).toBe("owner");
    const b = await login(h.app, w);
    expect(b.accountId).toBe(a.accountId);
    const ch = await challenge(h.app, newTronWallet());
    expect(ch.json.message).toContain("with your TRON account");
    expect(ch.json.message).not.toContain("Ethereum");
  });

  it("separates networks by chain policy: same address on nile is a different identity", async () => {
    const mainnet = newTronWallet("mainnet");
    const a = await login(h.app, mainnet);
    const onNile = await login(h.app, { ...mainnet, chainId: "nile" });
    expect(onNile.accountId).not.toBe(a.accountId);
  });

  it("rejects bad addresses, networks, wrong signers, replay and expiry", async () => {
    const w = newTronWallet();
    expect((await call(h.app, "POST", "/api/auth/wallet/challenges", { body: { protocol: "tron", address: w.address.slice(0, -1) + "x", chainId: "mainnet" } })).status).toBe(422);
    expect((await call(h.app, "POST", "/api/auth/wallet/challenges", { body: { protocol: "tron", address: w.address, chainId: "shasta" } })).status).toBe(422);

    const ch = await challenge(h.app, w);
    const wrong = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature: await sign(newTronWallet(), ch.json.message) } });
    expect(wrong.status).toBe(401);

    const ch2 = await challenge(h.app, w);
    const body = { challengeId: ch2.json.challengeId, signature: await sign(w, ch2.json.message) };
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body })).status).toBe(200);
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body })).status).toBe(401);

    const ch3 = await challenge(h.app, w);
    const sig3 = await sign(w, ch3.json.message);
    advance(h, 301);
    expect((await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch3.json.challengeId, signature: sig3 } })).status).toBe(401);
  });

  it("an EVM-style (EIP-191) signature over a TRON message does not verify", async () => {
    const w = newTronWallet();
    const ch = await challenge(h.app, w);
    const evmStyle = await w.account.signMessage({ message: ch.json.message });
    const r = await call(h.app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature: evmStyle } });
    expect(r.status).toBe(401);
  });

  it("verifier rejects wrong domain, network, nonce, address and tampered text; accepts v=0/1 and no 0x", async () => {
    const w = newTronWallet();
    const now = new Date(BASE_TIME);
    const expires = new Date(now.getTime() + 300_000);
    const base = { address: w.address, network: "mainnet", domain: "app.example.test", uri: ORIGIN, nonce: "n0nce0123456789a", issuedAt: now, expiresAt: expires, purpose: "login" as const };
    const x = { domain: "app.example.test", uri: ORIGIN, nonce: base.nonce, address: w.address, network: "mainnet", allowedNetworks: ["mainnet"], now };
    const msg = buildTronMessage(base);
    const sig = await w.account.sign({ hash: tronMessageDigest(msg) });
    expect(await verifyTronSignature(msg, sig, x)).toEqual({ ok: true });
    expect((await verifyTronSignature(msg, sig.slice(2), x)).ok).toBe(true);
    const v01 = sig.slice(0, -2) + (sig.endsWith("1b") ? "00" : "01");
    expect((await verifyTronSignature(msg, v01, x)).ok).toBe(true);

    const reject = async (m: string, xx = x) => (await verifyTronSignature(m, await w.account.sign({ hash: tronMessageDigest(m) }), xx)).ok;
    expect(await reject(buildTronMessage({ ...base, domain: "evil.test" }))).toBe(false);
    expect(await reject(buildTronMessage({ ...base, uri: "https://evil.test" }))).toBe(false);
    expect(await reject(buildTronMessage({ ...base, network: "nile" }))).toBe(false);
    expect(await reject(buildTronMessage({ ...base, nonce: "other0123456789a" }))).toBe(false);
    expect(await reject(msg, { ...x, address: newTronWallet().address })).toBe(false);
    expect(await reject(msg, { ...x, now: new Date(expires.getTime()) })).toBe(false);
    expect(await reject(msg, { ...x, allowedNetworks: ["nile"] })).toBe(false);
    expect((await verifyTronSignature(msg + "\nextra", sig, x)).ok).toBe(false);
    expect((await verifyTronSignature(msg, "0x" + "00".repeat(65), x)).ok).toBe(false);
  });
});

describe("wallet linking", () => {
  it("links a TRON wallet to an EVM account; either wallet then signs into the same account", async () => {
    const evm = await login(h.app, newEvmWallet());
    const tron = newTronWallet();
    const r = await link(evm, tron);
    expect(r.status).toBe(201);
    expect(LinkedIdentity.parse(r.json).chainPolicy).toBe("tron:mainnet");
    const list = await call(h.app, "GET", "/api/identities", { cookie: evm.cookie });
    expect(IdentityList.parse(list.json).items.map((i) => i.protocol)).toEqual(["evm", "tron"]);
    const viaTron = await login(h.app, tron);
    expect(viaTron.accountId).toBe(evm.accountId);
    expect(viaTron.userId).toBe(evm.userId);
  });

  it("requires a current session to request a link challenge", async () => {
    const r = await challenge(h.app, newTronWallet(), { purpose: "link" });
    expect(r.status).toBe(401);
    const dead = await login(h.app);
    await call(h.app, "DELETE", "/api/session", { cookie: dead.cookie });
    expect((await challenge(h.app, newTronWallet(), { cookie: dead.cookie, purpose: "link" })).status).toBe(401);
  });

  it("requires proof of the new wallet: a signature from another key links nothing", async () => {
    const me = await login(h.app);
    const target = newTronWallet();
    const r = await link(me, target, { signer: newTronWallet() });
    expect(r.status).toBe(401);
    expect(IdentityList.parse((await call(h.app, "GET", "/api/identities", { cookie: me.cookie })).json).items).toHaveLength(1);
    const [row] = await h.db.query("select 1 from linked_identities where address=$1", [target.address]);
    expect(row).toBeUndefined();
  });

  it("a link challenge is bound to the requesting session and cannot be used by another user", async () => {
    const a = await login(h.app);
    const b = await login(h.app);
    const w = newTronWallet();
    const ch = await challenge(h.app, w, { cookie: a.cookie, purpose: "link" });
    const signature = await sign(w, ch.json.message);
    const stolen = await call(h.app, "POST", "/api/identities", { cookie: b.cookie, body: { challengeId: ch.json.challengeId, signature } });
    expect(stolen.status).toBe(401);
    // the thief's attempt does not burn the owner's challenge
    const ok = await call(h.app, "POST", "/api/identities", { cookie: a.cookie, body: { challengeId: ch.json.challengeId, signature } });
    expect(ok.status).toBe(201);
  });

  it("never merges accounts: linking a wallet owned by another account is 409 and changes nothing", async () => {
    const a = await login(h.app, newEvmWallet());
    const bWallet = newTronWallet();
    const b = await login(h.app, bWallet);
    const r = await link(a, bWallet);
    expect(r.status).toBe(409);
    expect(ErrorEnvelope.parse(r.json).error.code).toBe("IDENTITY_CONFLICT");
    expect(IdentityList.parse((await call(h.app, "GET", "/api/identities", { cookie: a.cookie })).json).items).toHaveLength(1);
    const still = await login(h.app, bWallet);
    expect(still.accountId).toBe(b.accountId);
    expect(still.accountId).not.toBe(a.accountId);
    // linking the same wallet twice to one account also conflicts
    const dup = await link(a, a.wallet);
    expect(dup.status).toBe(409);
  });

  it("requires a recent sign-in for link and unlink (step-up)", async () => {
    const me = await login(h.app);
    advance(h, 901);
    const r = await challenge(h.app, newTronWallet(), { cookie: me.cookie, purpose: "link" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("STEP_UP_REQUIRED");
    const u = await call(h.app, "DELETE", "/api/identities/idn_x", { cookie: me.cookie });
    expect(u.status).toBe(403);
  });

  it("blocks unlinking the last sign-in method, allows it with an alternative, then blocks again", async () => {
    const evm = await login(h.app, newEvmWallet());
    const [only] = IdentityList.parse((await call(h.app, "GET", "/api/identities", { cookie: evm.cookie })).json).items;
    const blocked = await call(h.app, "DELETE", `/api/identities/${only!.id}`, { cookie: evm.cookie });
    expect(blocked.status).toBe(409);
    expect(ErrorEnvelope.parse(blocked.json).error.code).toBe("LAST_AUTH_METHOD");

    const tron = newTronWallet();
    const linked = LinkedIdentity.parse((await link(evm, tron)).json);
    const ok = await call(h.app, "DELETE", `/api/identities/${only!.id}`, { cookie: evm.cookie });
    expect(ok.status).toBe(204);
    // sessions established with the unlinked wallet are revoked with it, including the caller's own
    expect((await call(h.app, "GET", "/api/session", { cookie: evm.cookie })).status).toBe(401);
    const viaTron = await login(h.app, tron);
    expect(viaTron.accountId).toBe(evm.accountId);
    const remaining = IdentityList.parse((await call(h.app, "GET", "/api/identities", { cookie: viaTron.cookie })).json).items;
    expect(remaining.map((i) => i.id)).toEqual([linked.id]);
    expect((await call(h.app, "DELETE", `/api/identities/${linked.id}`, { cookie: viaTron.cookie })).status).toBe(409);

    // the unlinked wallet no longer opens the account; signing in with it starts a brand-new account
    const again = await login(h.app, evm.wallet);
    expect(again.accountId).not.toBe(evm.accountId);
  });

  it("concurrent unlinks cannot remove every method", async () => {
    const evm = await login(h.app, newEvmWallet());
    const t = LinkedIdentity.parse((await link(evm, newTronWallet())).json);
    const e = IdentityList.parse((await call(h.app, "GET", "/api/identities", { cookie: evm.cookie })).json).items.find((i) => i.id !== t.id)!;
    const rs = await Promise.all([e.id, t.id].map((id) => call(h.app, "DELETE", `/api/identities/${id}`, { cookie: evm.cookie })));
    expect(rs.map((r) => r.status).sort()).toEqual([204, 409]);
  });

  it("cannot unlink another user's identity (404) or an unknown id", async () => {
    const a = await login(h.app);
    const b = await login(h.app);
    await link(b, newTronWallet());
    const [bFirst] = IdentityList.parse((await call(h.app, "GET", "/api/identities", { cookie: b.cookie })).json).items;
    expect((await call(h.app, "DELETE", `/api/identities/${bFirst!.id}`, { cookie: a.cookie })).status).toBe(404);
    expect((await call(h.app, "DELETE", "/api/identities/nope", { cookie: a.cookie })).status).toBe(404);
    expect((await call(h.app, "DELETE", `/api/identities/${bFirst!.id}`, { cookie: a.cookie, origin: null })).status).toBe(403);
  });

  it("audits link and unlink without signatures", async () => {
    const evm = await login(h.app);
    const t = LinkedIdentity.parse((await link(evm, newTronWallet())).json);
    await call(h.app, "DELETE", `/api/identities/${t.id}`, { cookie: evm.cookie });
    const ev = await h.db.query<{ action: string; metadata: unknown }>("select action, metadata from audit_events where account_id=$1 order by created_at", [evm.accountId]);
    expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(["identity.linked", "identity.unlinked"]));
    expect(JSON.stringify(ev)).not.toMatch(/0x[0-9a-f]{130}/i);
  });
});
