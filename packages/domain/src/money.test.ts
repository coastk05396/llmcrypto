import { describe, expect, it } from "vitest";
import {
  MICROS_PER_USD,
  formatMicrousd,
  formatUsd,
  mulCeilDiv,
  parseMicrousd,
  tokenCharge,
} from "./money";

describe("parseMicrousd / formatMicrousd", () => {
  it("round-trips canonical integer strings beyond 2^53", () => {
    const s = "9007199254740993123";
    expect(formatMicrousd(parseMicrousd(s))).toBe(s);
    expect(parseMicrousd("0")).toBe(0n);
  });

  it.each(["", "-1", "01", "1.5", "1e6", " 1", "0x10", "+1", "NaN"])("rejects %j", (s) => {
    expect(() => parseMicrousd(s)).toThrow(RangeError);
  });

  it("refuses to format negative amounts", () => {
    expect(() => formatMicrousd(-1n)).toThrow(RangeError);
  });
});

describe("mulCeilDiv", () => {
  it.each([
    [0n, 5n, 3n, 0n],
    [1n, 1n, 1_000_000n, 1n], // any positive fraction rounds up
    [10n, 1n, 3n, 4n],
    [9n, 1n, 3n, 3n], // exact stays exact
    [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n],
  ])("ceil(%s*%s/%s)=%s", (a, n, d, want) => {
    expect(mulCeilDiv(a, n, d)).toBe(want);
  });

  it("rejects negatives and zero denominator", () => {
    expect(() => mulCeilDiv(-1n, 1n, 1n)).toThrow(RangeError);
    expect(() => mulCeilDiv(1n, -1n, 1n)).toThrow(RangeError);
    expect(() => mulCeilDiv(1n, 1n, 0n)).toThrow(RangeError);
  });
});

describe("tokenCharge", () => {
  it("charges per million tokens exactly", () => {
    // $3.00 / Mtok = 3_000_000 micro-USD per Mtok; 1M tokens -> $3.00
    expect(tokenCharge(1_000_000n, 3_000_000n)).toBe(3_000_000n);
  });

  it("rounds a sub-micro charge up once to 1 micro-USD", () => {
    expect(tokenCharge(1n, 1n)).toBe(1n);
    expect(tokenCharge(0n, 5_000_000n)).toBe(0n);
  });

  it("is exact for very large token counts", () => {
    expect(tokenCharge(10n ** 15n, 2_500_000n)).toBe(2_500_000n * 10n ** 9n);
  });
});

describe("formatUsd", () => {
  it("always prints six fractional digits", () => {
    expect(formatUsd(0n)).toBe("0.000000");
    expect(formatUsd(1n)).toBe("0.000001");
    expect(formatUsd(MICROS_PER_USD * 12n + 340_000n)).toBe("12.340000");
  });
});
