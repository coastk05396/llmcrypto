import { describe, expect, it } from "vitest";
import type { Deposit, DepositStatus } from "@llmcrypto/contracts";
import { decimalToAtomic, dayToInstant, formatAtomic, formatCount, formatSignedUsd, formatUtc } from "../../apps/web/src/lib/format";
import { confirmationProgress, describeDepositFailure, isOpen, statusView } from "../../apps/web/src/lib/deposits";
import { EMPTY_FILTERS, REQUEST_STATES, REQUEST_STATUS, toFilters, toQuery } from "../../apps/web/src/lib/usage-view";
import { AttemptKeys } from "../../apps/web/src/lib/keys";

describe("amount formatting is exact and bigint-based", () => {
  it("signed USD from micro-USD", () => {
    expect(formatSignedUsd("2000000")).toBe("+2.00");
    expect(formatSignedUsd("-1234567")).toBe("-1.234567");
    expect(formatSignedUsd("0")).toBe("+0.00");
    expect(formatSignedUsd("9007199254740993", false)).toBe("9,007,199,254.740993");
    expect(formatSignedUsd("-19")).toBe("-0.000019");
  });
  it("atomic units <-> decimal tokens, never rounding", () => {
    expect(formatAtomic("1500000", 6)).toBe("1.5");
    expect(formatAtomic("1", 18)).toBe("0.000000000000000001");
    expect(formatAtomic("1000000000000000000000", 18)).toBe("1,000");
    expect(formatAtomic("5", 0)).toBe("5");
    expect(decimalToAtomic("1.5", 6)).toBe("1500000");
    expect(decimalToAtomic("0.000001", 6)).toBe("1");
    expect(decimalToAtomic("10", 18)).toBe("10000000000000000000");
  });
  it.each(["", "0", "0.0", "-1", "1.1234567", "abc", "1e3", "1,5", " "])("rejects %j for 6 decimals", (t) => {
    expect(decimalToAtomic(t, 6)).toBeNull();
  });
  it("counts and timestamps", () => {
    expect(formatCount("1234567890123")).toBe("1,234,567,890,123");
    expect(formatUtc("2026-10-18T12:30:05.123Z")).toBe("2026-10-18 12:30:05 UTC");
  });
  it("day to instant rejects impossible dates", () => {
    expect(dayToInstant("2026-10-18", false)).toBe("2026-10-18T00:00:00.000Z");
    expect(dayToInstant("2026-10-18", true)).toBe("2026-10-18T23:59:59.999Z");
    expect(dayToInstant("2026-02-30", false)).toBeNull();
    expect(dayToInstant("18/10/2026", false)).toBeNull();
  });
});

const dep = (status: DepositStatus, over: Partial<Deposit> = {}): Deposit => ({
  id: "dep_1", asset: "TUSD", decimals: 6, requiredConfirmations: 3, createdAt: "2026-10-18T00:00:00.000Z", address: "0xabc", assetContract: null,
  network: "testnet-a", amountAtomic: "1000000", expiresAt: "2026-10-18T01:00:00.000Z", status, confirmations: 0, creditedMicrousd: null, ledgerTransactionId: null, reviewReason: null, ...over,
});

describe("deposit states are explained in text for every status", () => {
  const all: DepositStatus[] = ["CREATED", "DETECTED", "CONFIRMING", "CREDITED", "EXPIRED", "REVIEW_REQUIRED", "REVERSED"];
  it.each(all)("%s has a label, explanation and next step", (s) => {
    const v = statusView(dep(s, { confirmations: 1 }));
    expect(v.label.length).toBeGreaterThan(2);
    expect(v.what.length).toBeGreaterThan(10);
    expect(v.next.length).toBeGreaterThan(10);
  });
  it("labels are distinct so no state relies on color", () => {
    expect(new Set(all.map((s) => statusView(dep(s)).label)).size).toBe(all.length);
  });
  it("confirming shows the count; progress only while confirming", () => {
    expect(statusView(dep("CONFIRMING", { confirmations: 2 })).what).toBe("Confirmations 2 of 3.");
    expect(confirmationProgress(dep("CONFIRMING", { confirmations: 2 }))).toEqual({ now: 2, max: 3 });
    expect(confirmationProgress(dep("CONFIRMING", { confirmations: 9 }))).toEqual({ now: 3, max: 3 });
    expect(confirmationProgress(dep("CREDITED", { confirmations: 3 }))).toBeNull();
    expect(all.filter(isOpen)).toEqual(["CREATED", "DETECTED", "CONFIRMING"]);
  });
  it("awaiting payment tells the payer the exact asset and network", () => {
    expect(statusView(dep("CREATED")).next).toContain("TUSD on testnet-a");
  });
  it("create failures: network errors keep the idempotency key, validation does not", () => {
    expect(describeDepositFailure({ kind: "network" }).retrySafe).toBe(true);
    const v = describeDepositFailure({ kind: "http", status: 422, code: "VALIDATION_FAILED", requestId: null, fieldErrors: [{ field: "amountAtomic", message: "too low" }], retryAfterSeconds: null });
    expect(v.retrySafe).toBe(false);
    expect(v.fields).toHaveLength(1);
    expect(describeDepositFailure({ kind: "http", status: 409, code: "IN_PROGRESS", requestId: null, fieldErrors: [], retryAfterSeconds: null }).message).toContain("already being created");
  });
  it("one idempotency key per identical payload, a new one when the payload changes", () => {
    let n = 0;
    const a = new AttemptKeys(() => `k${++n}`);
    const p = { asset: "TUSD", network: "testnet-a", amountAtomic: "1000000" };
    expect(a.keyFor(p)).toBe(a.keyFor({ ...p }));
    expect(a.keyFor({ ...p, amountAtomic: "2000000" })).not.toBe("k1");
  });
});

describe("usage filters", () => {
  it("blank form sends no filters", () => {
    expect(toFilters(EMPTY_FILTERS)).toEqual({ filters: {}, issues: [] });
  });
  it("dates become UTC instants and a reversed range is an issue", () => {
    const ok = toFilters({ ...EMPTY_FILTERS, from: "2026-10-01", to: "2026-10-18", model: " m ", status: "SETTLED", runId: " r1 " });
    expect(ok.filters).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-18T23:59:59.999Z", model: "m", status: "SETTLED", runId: "r1" });
    expect(toFilters({ ...EMPTY_FILTERS, from: "2026-10-18", to: "2026-10-01" }).issues[0]?.field).toBe("to");
  });
  it("query strings carry the cursor and limit and drop empties", () => {
    expect(toQuery({ model: "m", status: undefined, runId: "" }, "cur", 20)).toBe("model=m&cursor=cur&limit=20");
  });
  it("every request state has a distinct label", () => {
    expect(new Set(REQUEST_STATES.map((s) => REQUEST_STATUS[s].label)).size).toBe(REQUEST_STATES.length);
  });
});
