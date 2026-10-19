/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped rows */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abortIdempotent, beginIdempotent, completeIdempotent, type IdemScope } from "../../apps/api/src/idempotency";
import { BASE_TIME, login, makeHarness, type Harness } from "./helpers";

let h: Harness;
let accountId: string;
beforeAll(async () => {
  h = await makeHarness();
  accountId = (await login(h.app)).accountId;
});
afterAll(async () => {
  await h.db.close();
});

const scope = (key: string): IdemScope => ({ accountId, operation: "test", key });

describe("idempotency claims", () => {
  it("a reclaimed stale claim cannot ALSO complete: the slow original's transaction rolls back, the new claimant commits once", async () => {
    const key = "claim-test-0001";
    const a = scope(key);
    const b = scope(key);
    const t0 = new Date(BASE_TIME);
    expect(await beginIdempotent(h.db, a, "hash", t0, 120)).toEqual({ action: "execute" });
    // Within the stale window a duplicate is refused.
    expect(await beginIdempotent(h.db, scope(key), "hash", new Date(t0.getTime() + 10_000), 120)).toEqual({ action: "reject", code: "IN_PROGRESS" });
    // Past the stale window B reclaims the key (A is slow, not dead).
    const t1 = new Date(t0.getTime() + 300_000);
    expect(await beginIdempotent(h.db, b, "hash", t1, 120)).toEqual({ action: "execute" });
    expect(a.claim).not.toBe(b.claim);
    // A finishes its business write + completion first: the completion matches no row, so the transaction (and its write) rolls back.
    await h.db.query("create table if not exists zz_effects (n text)");
    await expect(h.db.tx(async (q) => {
      await q.query("insert into zz_effects values ('A')");
      await completeIdempotent(q, a, { statusCode: 201, result: { who: "A" }, at: t1 });
    })).rejects.toThrow(/claim lost/);
    await abortIdempotent(h.db, a); // the displaced claimant's abort must not delete B's claim
    await h.db.tx(async (q) => {
      await q.query("insert into zz_effects values ('B')");
      await completeIdempotent(q, b, { statusCode: 201, result: { who: "B" }, at: t1 });
    });
    expect((await h.db.query<any>("select n from zz_effects")).map((r) => r.n)).toEqual(["B"]);
    const replay = await beginIdempotent(h.db, scope(key), "hash", t1, 120);
    expect(replay).toMatchObject({ action: "replay", row: { result: { who: "B" } } });
    // A second completion of an already-completed row also fails instead of silently doing nothing.
    await expect(h.db.tx((q) => completeIdempotent(q, b, { statusCode: 201, result: {}, at: t1 }))).rejects.toThrow(/claim lost/);
  });

  it("abort by the holder frees the key for a retry", async () => {
    const a = scope("claim-test-0002");
    await beginIdempotent(h.db, a, "h", BASE_TIME, 120);
    await abortIdempotent(h.db, a);
    expect(await beginIdempotent(h.db, scope("claim-test-0002"), "h", BASE_TIME, 120)).toEqual({ action: "execute" });
  });
});

describe("client address and sign-in lockout", () => {
  it("X-Forwarded-For is believed only from a trusted proxy, walking from the right", async () => {
    const { clientAddress } = await import("../../apps/api/src/app");
    expect(clientAddress("10.0.0.9", "1.2.3.4", [])).toBe("10.0.0.9");
    expect(clientAddress("10.0.0.9", "1.2.3.4", ["10.0.0.1"])).toBe("10.0.0.9"); // peer is not a trusted proxy
    expect(clientAddress("10.0.0.1", "1.2.3.4", ["10.0.0.1"])).toBe("1.2.3.4");
    expect(clientAddress("10.0.0.1", "6.6.6.6, 1.2.3.4", ["10.0.0.1"])).toBe("1.2.3.4"); // left entries are client-supplied
    expect(clientAddress("10.0.0.1", "1.2.3.4, 10.0.0.2", ["10.0.0.1", "10.0.0.2"])).toBe("1.2.3.4");
    expect(clientAddress("10.0.0.1", "10.0.0.2", ["10.0.0.1", "10.0.0.2"])).toBe("10.0.0.1");
    expect(clientAddress("10.0.0.1", undefined, ["10.0.0.1"])).toBe("10.0.0.1");
  });
});
