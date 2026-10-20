import { describe, expect, it } from "vitest";
import { assertBalanced, availableFunds, creditPostings, spendPostings } from "./ledger";
import { chargeFor, ceilPerMillion, inputTokenUpperBound, reservationUpperBound, utf8Length, type RateSnapshot } from "./pricing";
import { clampToHold, decideReservation } from "./reservations";

const rates = (over: Partial<RateSnapshot> = {}): RateSnapshot => ({
  priceVersion: "pv", model: "m", inputMicrousdPerMtok: 3_000_000n, cachedInputMicrousdPerMtok: 300_000n, outputMicrousdPerMtok: 15_000_000n, ...over,
});

describe("chargeFor", () => {
  it("rounds the exact total up once, not per category", () => {
    // 1 input token at 1 micro/Mtok and 1 output token at 1 micro/Mtok: each alone ceils to 1 (sum 2); together 2/1e6 -> 1.
    const r = rates({ inputMicrousdPerMtok: 1n, cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: 1n });
    expect(chargeFor({ inputTokens: 1n, cachedInputTokens: 0n, outputTokens: 1n }, r)).toBe(1n);
  });
  it("is exact on whole-micro boundaries and 0 for zero usage", () => {
    expect(chargeFor({ inputTokens: 1_000_000n, cachedInputTokens: 0n, outputTokens: 0n }, rates())).toBe(3_000_000n);
    expect(chargeFor({ inputTokens: 0n, cachedInputTokens: 0n, outputTokens: 0n }, rates())).toBe(0n);
  });
  it("rounds any fractional micro-USD up", () => {
    // 1000 in * 3_000_000 + 500 out * 15_000_000 = 3e9 + 7.5e9 = 1.05e10 -> 10500 exactly
    expect(chargeFor({ inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 500n }, rates())).toBe(10_500n);
    expect(chargeFor({ inputTokens: 1001n, cachedInputTokens: 0n, outputTokens: 500n }, rates())).toBe(10_503n);
    expect(ceilPerMillion(1n)).toBe(1n);
  });
  it("bills cached tokens at the input rate when the model has no cached rate, never overlapping with input", () => {
    const noCache = rates({ cachedInputMicrousdPerMtok: null });
    expect(chargeFor({ inputTokens: 0n, cachedInputTokens: 1_000_000n, outputTokens: 0n }, noCache)).toBe(3_000_000n);
    expect(chargeFor({ inputTokens: 500_000n, cachedInputTokens: 500_000n, outputTokens: 0n }, rates())).toBe(1_650_000n);
  });
  it("handles values beyond 2^53 without precision loss", () => {
    const big = 9_007_199_254_740_993n;
    expect(chargeFor({ inputTokens: big, cachedInputTokens: 0n, outputTokens: 0n }, rates({ inputMicrousdPerMtok: 1_000_000n }))).toBe(big);
  });
  it("rejects negative tokens", () => {
    expect(() => chargeFor({ inputTokens: -1n, cachedInputTokens: 0n, outputTokens: 0n }, rates())).toThrow(RangeError);
  });
});

describe("reservation bound", () => {
  it("covers every possible actual charge within the bound", () => {
    const r = rates();
    const bound = reservationUpperBound(100n, 50n, r);
    for (const [i, c, o] of [[100n, 0n, 50n], [0n, 100n, 50n], [50n, 50n, 10n]] as const) {
      expect(chargeFor({ inputTokens: i, cachedInputTokens: c, outputTokens: o }, r)).toBeLessThanOrEqual(bound);
    }
  });
  it("never undercounts input tokens: bytes plus framing", () => {
    expect(utf8Length("aé€😀")).toBe(1 + 2 + 3 + 4);
    expect(inputTokenUpperBound(["abc", "é"])).toBe(16n + (3n + 8n) + (2n + 8n));
  });
});

describe("ledger postings", () => {
  it("builds balanced postings and rejects unbalanced ones", () => {
    expect(() => assertBalanced(creditPostings("a", 5n))).not.toThrow();
    expect(() => assertBalanced(spendPostings("a", 5n))).not.toThrow();
    expect(() => assertBalanced([{ ledgerAccount: "customer_funds", accountId: "a", amount: 5n }, { ledgerAccount: "revenue", accountId: null, amount: -4n }])).toThrow(/Unbalanced/);
    expect(() => assertBalanced([{ ledgerAccount: "revenue", accountId: null, amount: 1n }])).toThrow();
    expect(() => assertBalanced([{ ledgerAccount: "customer_funds", accountId: null, amount: 1n }, { ledgerAccount: "revenue", accountId: null, amount: -1n }])).toThrow();
  });
  it("available is posted minus holds and never negative", () => {
    expect(availableFunds(100n, 30n)).toBe(70n);
    expect(availableFunds(10n, 30n)).toBe(0n);
  });
});

describe("decideReservation", () => {
  it("checks funds, then key cap, then project cap", () => {
    expect(decideReservation({ posted: 100n, held: 40n, amount: 60n })).toEqual({ ok: true });
    expect(decideReservation({ posted: 100n, held: 40n, amount: 61n })).toEqual({ ok: false, reason: "INSUFFICIENT_FUNDS" });
    expect(decideReservation({ posted: 100n, held: 0n, amount: 10n, key: { cap: 15n, used: 6n } })).toEqual({ ok: false, reason: "KEY_CAP_EXCEEDED" });
    expect(decideReservation({ posted: 100n, held: 0n, amount: 10n, key: { cap: null, used: 6n }, project: { cap: 15n, used: 6n } })).toEqual({ ok: false, reason: "PROJECT_CAP_EXCEEDED" });
    expect(decideReservation({ posted: 100n, held: 0n, amount: 9n, key: { cap: 15n, used: 6n } })).toEqual({ ok: true });
  });
  it("clamps charges to the hold and reports the absorbed remainder", () => {
    expect(clampToHold(5n, 10n)).toEqual({ charge: 5n, absorbed: 0n });
    expect(clampToHold(12n, 10n)).toEqual({ charge: 10n, absorbed: 2n });
  });
});
