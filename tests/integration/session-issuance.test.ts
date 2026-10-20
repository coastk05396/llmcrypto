import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config";
import { linkPassword, recoverPassword, signupPassword, verifyPasswordLogin } from "../../apps/api/src/auth/password";
import { createSession, resolveSession } from "../../apps/api/src/auth/session";
import { loginWithWallet, unlinkIdentity } from "../../apps/api/src/auth/linking";
import { loginWithTelegram } from "../../apps/api/src/auth/telegram";
import type { ChallengeRow } from "../../apps/api/src/auth/challenges";
import { login, makeHarness, type Harness } from "./helpers";

let h: Harness;
const password = "a long generated test passphrase";
beforeAll(async () => {
  h = await makeHarness({ auth: { ...loadConfig({}).auth, argon2: { memoryKiB: 64, timeCost: 1 } } });
});
afterAll(async () => { await h.db.close(); });

describe("session issuance after method revocation", () => {
  it("rejects a password verified before recovery, even at the same clock instant", async () => {
    const account = await signupPassword(h.db, h.config, { username: "race.password", password }, "test");
    const proof = await verifyPasswordLogin(h.db, h.config, "race.password", password);
    expect(proof).not.toBeNull();
    expect(await recoverPassword(h.db, h.config, { username: "race.password", recoveryCode: account.recovery.recoveryCodes[0]!, newPassword: "a new long test passphrase" }, "test")).toBe(true);
    await expect(h.db.tx(q => createSession(q, h.config, account.userId, account.accountId, { ...proof!, kind: "password", methodRef: account.credentialId }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await h.db.query("select id from sessions where user_id=$1 and revoked_at is null", [account.userId])).toHaveLength(0);
  });

  it("rejects a resolved wallet identity after unlink", async () => {
    const account = await login(h.app);
    const auth = (await resolveSession(h.db, h.config, account.cookie.slice("session=".length)))!;
    await linkPassword(h.db, h.config, auth, { username: "race.wallet", password }, "test");
    const [challenge] = await h.db.query<ChallengeRow>("select * from wallet_challenges where lower(address)=lower($1)", [account.wallet.address.toLowerCase()]);
    const proof = await loginWithWallet(h.db, challenge!, h.clock.now, "test");
    await unlinkIdentity(h.db, auth, proof.identityId, h.clock.now, "test");
    await expect(h.db.tx(q => createSession(q, h.config, proof.userId, proof.accountId, { ...proof, kind: "wallet", methodRef: proof.identityId }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a resolved Telegram identity after unlink", async () => {
    const proof = await loginWithTelegram(h.db, "99880001", h.clock.now, "test");
    await h.db.query("update telegram_identities set unlinked_at=$2 where id=$1", [proof.identityId, h.clock.now]);
    await expect(h.db.tx(q => createSession(q, h.config, proof.userId, proof.accountId, { ...proof, kind: "telegram", methodRef: proof.identityId }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a Telegram proof resolved before password recovery", async () => {
    const account = await loginWithTelegram(h.db, "99880002", h.clock.now, "test");
    const session = await h.db.tx(q => createSession(q, h.config, account.userId, account.accountId, { ...account, kind: "telegram", methodRef: account.identityId }));
    const auth = (await resolveSession(h.db, h.config, session.token))!;
    const codes = await linkPassword(h.db, h.config, auth, { username: "race.telegram", password }, "test");
    const proof = await loginWithTelegram(h.db, "99880002", h.clock.now, "test");
    expect(await recoverPassword(h.db, h.config, { username: "race.telegram", recoveryCode: codes.recoveryCodes[0]!, newPassword: "a new long test passphrase" }, "test")).toBe(true);
    await expect(h.db.tx(q => createSession(q, h.config, proof.userId, proof.accountId, { ...proof, kind: "telegram", methodRef: proof.identityId }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a wallet proof resolved before password recovery", async () => {
    const account = await login(h.app);
    const auth = (await resolveSession(h.db, h.config, account.cookie.slice("session=".length)))!;
    const codes = await linkPassword(h.db, h.config, auth, { username: "race.recovery", password }, "test");
    const [challenge] = await h.db.query<ChallengeRow>("select * from wallet_challenges where lower(address)=lower($1)", [account.wallet.address.toLowerCase()]);
    const proof = await loginWithWallet(h.db, challenge!, h.clock.now, "test");
    expect(await recoverPassword(h.db, h.config, { username: "race.recovery", recoveryCode: codes.recoveryCodes[0]!, newPassword: "a new long test passphrase" }, "test")).toBe(true);
    await expect(h.db.tx(q => createSession(q, h.config, proof.userId, proof.accountId, { ...proof, kind: "wallet", methodRef: proof.identityId }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
