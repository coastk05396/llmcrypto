import { describe, expect, it } from "vitest";
import { canManageKeys, isModelAllowed, isRecentSignIn, keyDisplayPrefix, keyUnusableReason, validateKeyRequest, wouldExceedSpendCap } from "./key-policy";

const now = new Date("2026-10-18T12:00:00Z");
const known = new Set(["m1", "m2"]);

describe("key policy", () => {
  it("only owner and admin manage keys", () => {
    expect(["owner", "admin", "billing", "member"].map((r) => canManageKeys(r as never))).toEqual([true, true, false, false]);
  });
  it("validates semantics", () => {
    expect(validateKeyRequest({ scopes: ["gateway:invoke"], modelAllowlist: ["m1"] }, known, now)).toEqual([]);
    const f = validateKeyRequest(
      { scopes: ["usage:read", "usage:read"], modelAllowlist: ["nope"], spendCapMicrousd: "0", expiresAt: "2026-10-18T11:59:59Z" },
      known,
      now,
    ).map((i) => i.field);
    expect(f).toEqual(["scopes", "modelAllowlist[0]", "spendCapMicrousd", "expiresAt"]);
  });
  it("allowlist semantics", () => {
    expect(isModelAllowed([], "x")).toBe(true);
    expect(isModelAllowed(["m1"], "m2")).toBe(false);
  });
  it("revoked beats expired; expiry boundary is exclusive of the future", () => {
    expect(keyUnusableReason({ revokedAt: now, expiresAt: new Date(0) }, now)).toBe("revoked");
    expect(keyUnusableReason({ revokedAt: null, expiresAt: now }, now)).toBe("expired");
    expect(keyUnusableReason({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBeNull();
  });
  it("spend cap uses exact integers", () => {
    expect(wouldExceedSpendCap(null, "1", "1")).toBe(false);
    expect(wouldExceedSpendCap("100", "99", "1")).toBe(false);
    expect(wouldExceedSpendCap("100", "99", "2")).toBe(true);
    expect(wouldExceedSpendCap("9007199254740993", "9007199254740992", "1")).toBe(false);
  });
  it("prefix and step-up window", () => {
    expect(keyDisplayPrefix("sk_abcdefghijkl")).toBe("sk_abcde");
    expect(isRecentSignIn(new Date(now.getTime() - 900_000), now)).toBe(true);
    expect(isRecentSignIn(new Date(now.getTime() - 901_000), now)).toBe(false);
  });
});
