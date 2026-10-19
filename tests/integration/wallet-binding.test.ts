/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, challenge, makeHarness, newEvmWallet, sign, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.db.close();
});

const session = (body: unknown, extra: { cookie?: string; noChallengeCookies?: boolean } = {}) => call<any>(h.app, "POST", "/api/auth/wallet/sessions", { body, ...extra });

describe("wallet sign-in challenges are bound to the browser that requested them", () => {
  it("the challenge response sets a per-challenge HttpOnly SameSite=Strict cookie scoped to the sessions endpoint; only a digest is stored", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const sc = ch.setCookie.find((c) => c.startsWith(`wc_${ch.json.challengeId}=`))!;
    expect(sc).toBeTruthy();
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\/api\/auth\/wallet\/sessions/);
    expect(sc).toMatch(/Max-Age=300/);
    const token = /^wc_[^=]+=([^;]+)/.exec(sc)![1]!;
    const [row] = await h.db.query<any>("select binding_hash from wallet_challenges where id=$1", [ch.json.challengeId]);
    expect(row.binding_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await h.db.query("select * from wallet_challenges"))).not.toContain(token);
    expect(JSON.stringify(ch.json)).not.toContain(token); // never in the response body
  });

  it("a signature relayed WITHOUT the browser's cookie cannot start a session, and the challenge stays usable by the real browser", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    const signature = await sign(w, ch.json.message);
    const stolen = await session({ challengeId: ch.json.challengeId, signature }, { noChallengeCookies: true });
    expect(stolen.status).toBe(401);
    expect(stolen.json.error.code).toBe("CHALLENGE_INVALID");
    const wrongCookie = await session({ challengeId: ch.json.challengeId, signature }, { cookie: `wc_${ch.json.challengeId}=${"A".repeat(43)}`, noChallengeCookies: true });
    expect(wrongCookie.status).toBe(401);
    const real = await session({ challengeId: ch.json.challengeId, signature });
    expect(real.status).toBe(200);
    expect(real.setCookie.some((c) => c.startsWith("session="))).toBe(true);
  });

  it("another challenge's cookie does not unlock this challenge; two outstanding challenges (two tabs) both work", async () => {
    const w = newEvmWallet();
    const a = await challenge(h.app, w);
    const b = await challenge(h.app, w);
    const [sa, sb] = [await sign(w, a.json.message), await sign(w, b.json.message)];
    const aCookie = a.setCookie.find((c) => c.startsWith("wc_"))!.split(";")[0]!.split("=")[1]!;
    const crossed = await session({ challengeId: b.json.challengeId, signature: sb }, { cookie: `wc_${b.json.challengeId}=${aCookie}`, noChallengeCookies: true });
    expect(crossed.status).toBe(401);
    expect((await session({ challengeId: a.json.challengeId, signature: sa })).status).toBe(200);
    expect((await session({ challengeId: b.json.challengeId, signature: sb })).status).toBe(200);
  });

  it("a challenge issued before the binding existed (no stored digest) is refused", async () => {
    const w = newEvmWallet();
    const ch = await challenge(h.app, w);
    await h.db.query("update wallet_challenges set binding_hash = null where id=$1", [ch.json.challengeId]);
    expect((await session({ challengeId: ch.json.challengeId, signature: await sign(w, ch.json.message) })).status).toBe(401);
  });
});
