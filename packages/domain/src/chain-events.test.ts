import { describe, expect, it } from "vitest";
import {
  decideDeposit, eventKey, microusdForAtomic, normalizeAddress, type IntentFacts, type TransferFacts,
} from "./chain-events";

const ADDR = "0x" + "a".repeat(40);
const TOKEN = "0x" + "b".repeat(40);
const T0 = new Date("2026-10-18T12:00:00Z");

const intent = (o: Partial<IntentFacts> = {}): IntentFacts => ({
  status: "CREATED", network: "net-a", chainId: "1001", assetContract: TOKEN, addressKey: ADDR, amountAtomic: 5_000_000n, decimals: 6,
  requiredConfirmations: 3, microusdPerToken: 1_000_000n, overpayment: "review", acceptUntil: new Date(T0.getTime() + 3_600_000), confirmations: 0,
  matchedEventKey: null, ...o,
});
const KEY = eventKey("net-a", "0xAB", 0, TOKEN);
const transfer = (o: Partial<TransferFacts> = {}): TransferFacts => ({
  eventKey: KEY, network: "net-a", chainId: "1001", assetContract: TOKEN, toKey: ADDR, amountAtomic: 5_000_000n, blockTime: T0, confirmations: 3, removed: false, ...o,
});

describe("event identity and conversion", () => {
  it("a tx hash alone is not the identity: event index and contract are part of the key", () => {
    expect(eventKey("n", "0xAB", 0, TOKEN)).not.toBe(eventKey("n", "0xAB", 1, TOKEN));
    expect(eventKey("n", "0xAB", 0, TOKEN)).not.toBe(eventKey("n", "0xAB", 0, "0x" + "c".repeat(40)));
    expect(eventKey("n", "0xAB", 0, TOKEN)).not.toBe(eventKey("m", "0xAB", 0, TOKEN));
    expect(eventKey("n", "0xAB", 0, TOKEN)).toBe(eventKey("n", "0xab", 0, TOKEN.toUpperCase().replace("0X", "0x")));
  });
  it("normalizes hex addresses only", () => {
    expect(normalizeAddress("0x" + "A".repeat(40))).toBe(ADDR.replace(/b/g, "b").replace(/a/g, "a"));
    expect(normalizeAddress("TXyZ")).toBe("TXyZ");
  });
  it("converts atomic units with the token decimals, rounding down", () => {
    expect(microusdForAtomic(5_000_000n, 6, 1_000_000n)).toBe(5_000_000n);
    expect(microusdForAtomic(10n ** 18n, 18, 1_000_000n)).toBe(1_000_000n);
    expect(microusdForAtomic(999_999_999_999n, 18, 1_000_000n)).toBe(0n);
    expect(microusdForAtomic(2n ** 70n, 6, 1_000_000n)).toBe((2n ** 70n * 1_000_000n) / 10n ** 6n);
  });
});

describe("decideDeposit", () => {
  it("a valid later payment replaces an invalid observation awaiting review", () => {
    expect(decideDeposit(intent({ status: "REVIEW_REQUIRED", matchedEventKey: "dust", confirmations: 100 }), transfer({ confirmations: 1 })))
      .toEqual({ kind: "progress", status: "CONFIRMING", confirmations: 1 });
    expect(decideDeposit(intent({ status: "REVIEW_REQUIRED", matchedEventKey: "dust" }), transfer()))
      .toMatchObject({ kind: "credit", creditedMicrousd: 5_000_000n });
  });
  it("pending (0 confirmations) -> DETECTED; below the requirement -> CONFIRMING; at it -> credit", () => {
    expect(decideDeposit(intent(), transfer({ confirmations: 0 }))).toEqual({ kind: "progress", status: "DETECTED", confirmations: 0 });
    expect(decideDeposit(intent(), transfer({ confirmations: 2 }))).toEqual({ kind: "progress", status: "CONFIRMING", confirmations: 2 });
    expect(decideDeposit(intent(), transfer({ confirmations: 3 }))).toEqual({ kind: "credit", creditedMicrousd: 5_000_000n, confirmations: 3 });
  });
  it.each([
    ["wrong network", { network: "net-b" }, "WRONG_NETWORK"],
    ["wrong chain id", { chainId: "9" }, "WRONG_CHAIN"],
    ["wrong token contract", { assetContract: "0x" + "c".repeat(40) }, "WRONG_ASSET"],
    ["native instead of token", { assetContract: "" }, "WRONG_ASSET"],
    ["wrong destination", { toKey: "0x" + "d".repeat(40) }, "WRONG_DESTINATION"],
    ["underpaid", { amountAtomic: 4_999_999n }, "UNDERPAID"],
    ["zero amount", { amountAtomic: 0n }, "UNDERPAID"],
    ["overpaid under the review policy", { amountAtomic: 5_000_001n }, "OVERPAID"],
    ["mined after the acceptance deadline", { blockTime: new Date(T0.getTime() + 3_600_001) }, "LATE_PAYMENT"],
  ] as const)("%s -> review, even when fully confirmed", (_n, over, reason) => {
    expect(decideDeposit(intent(), transfer(over))).toMatchObject({ kind: "review", reason });
  });
  it("overpayment under credit_full credits what was actually received", () => {
    expect(decideDeposit(intent({ overpayment: "credit_full" }), transfer({ amountAtomic: 7_000_000n }))).toMatchObject({ kind: "credit", creditedMicrousd: 7_000_000n });
  });
  it("a dust amount that converts to zero is reviewed, never credited as 0", () => {
    expect(decideDeposit(intent({ amountAtomic: 1n, decimals: 18 }), transfer({ amountAtomic: 1n }))).toMatchObject({ kind: "review", reason: "ZERO_CREDIT" });
  });
  it("an EXPIRED intent still honours a transfer mined before the deadline", () => {
    expect(decideDeposit(intent({ status: "EXPIRED" }), transfer())).toMatchObject({ kind: "credit" });
  });
  it("duplicate delivery of a credited transfer is a no-op; a second transfer is flagged, never credited", () => {
    const credited = intent({ status: "CREDITED", matchedEventKey: KEY });
    expect(decideDeposit(credited, transfer())).toEqual({ kind: "noop" });
    expect(decideDeposit(credited, transfer({ eventKey: eventKey("net-a", "0xAB", 1, TOKEN) }))).toEqual({ kind: "flag_event", reason: "DUPLICATE_PAYMENT" });
  });
  it("a second transfer while the first is in flight is flagged", () => {
    const inflight = intent({ status: "CONFIRMING", matchedEventKey: KEY, confirmations: 1 });
    expect(decideDeposit(inflight, transfer({ eventKey: "other" }))).toEqual({ kind: "flag_event", reason: "DUPLICATE_PAYMENT" });
  });
  it("confirmations never go backwards for the same transfer (stale delivery)", () => {
    const inflight = intent({ status: "CONFIRMING", matchedEventKey: KEY, confirmations: 2 });
    expect(decideDeposit(inflight, transfer({ confirmations: 1 }))).toEqual({ kind: "progress", status: "CONFIRMING", confirmations: 2 });
  });
  it("removal before credit reverts; after credit reverses; of an unrelated transfer does nothing", () => {
    expect(decideDeposit(intent({ status: "CONFIRMING", matchedEventKey: KEY }), transfer({ removed: true }))).toEqual({ kind: "revert" });
    expect(decideDeposit(intent({ status: "CREDITED", matchedEventKey: KEY }), transfer({ removed: true }))).toEqual({ kind: "reverse" });
    expect(decideDeposit(intent({ status: "CREDITED", matchedEventKey: KEY }), transfer({ removed: true, eventKey: "other" }))).toEqual({ kind: "noop" });
  });
  it("a reversed deposit never re-credits when the transfer reappears", () => {
    const reversed = intent({ status: "REVERSED", matchedEventKey: KEY });
    expect(decideDeposit(reversed, transfer())).toEqual({ kind: "flag_event", reason: "REAPPEARED_AFTER_REVERSAL" });
    expect(decideDeposit(reversed, transfer({ removed: true }))).toEqual({ kind: "noop" });
  });
  it("the invalid observation itself remains in review", () => {
    const review = intent({ status: "REVIEW_REQUIRED", matchedEventKey: KEY });
    expect(decideDeposit(review, transfer())).toEqual({ kind: "noop" });
    expect(decideDeposit(review, transfer({ eventKey: "other", amountAtomic: 1n }))).toMatchObject({ kind: "flag_event" });
  });
});
