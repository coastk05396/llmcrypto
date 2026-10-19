/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import type { ApiKey } from "@llmcrypto/contracts";
import type { ApiFailure } from "../../apps/web/src/lib/api";
import { AttemptKeys, activeKeyCount, describeCreateFailure, formatUsdDisplay, keyStatus, usdToMicrousd, validateKeyForm, type KeyFormValues } from "../../apps/web/src/lib/keys";
import { unlinkFailureCopy } from "../../apps/web/src/lib/identities";
import { firstRequestCurl } from "../../apps/web/src/lib/snippets";

const NOW = new Date("2026-10-18T12:00:00Z");
const base: KeyFormValues = { name: "ci", scopes: ["gateway:invoke"], models: [], spendCapUsd: "", expiresOn: "" };

describe("usdToMicrousd", () => {
  it.each([["50", "50000000"], ["12.5", "12500000"], ["0.000001", "1"], ["1.234567", "1234567"], [" 3 ", "3000000"]])("%s -> %s", (i, o) => {
    expect(usdToMicrousd(i)).toBe(o);
  });
  it.each(["", "0", "0.0", "-1", "1.1234567", "1e3", "abc", "1,5", "$5"])("rejects %j", (i) => {
    expect(usdToMicrousd(i)).toBeNull();
  });
  it("does not lose precision on large values", () => {
    expect(usdToMicrousd("999999999999.999999")).toBe("999999999999999999");
  });
});

describe("formatUsdDisplay", () => {
  it.each([["0", "0.00"], ["1500000", "1.50"], ["1234567", "1.234567"], ["12000000000", "12,000.00"], ["1", "0.000001"]])("%s -> %s", (i, o) => {
    expect(formatUsdDisplay(i)).toBe(o);
  });
});

describe("validateKeyForm", () => {
  it("builds the contract request with optional fields omitted", () => {
    expect(validateKeyForm(base, NOW).request).toEqual({ name: "ci", scopes: ["gateway:invoke"], modelAllowlist: [] });
  });
  it("includes cap, allowlist and end-of-day UTC expiry", () => {
    const r = validateKeyForm({ ...base, name: "  prod  ", models: ["m1"], spendCapUsd: "25", expiresOn: "2026-12-31" }, NOW).request;
    expect(r).toEqual({ name: "prod", scopes: ["gateway:invoke"], modelAllowlist: ["m1"], spendCapMicrousd: "25000000", expiresAt: "2026-12-31T23:59:59Z" });
  });
  it("reports every problem with the field it belongs to", () => {
    const { issues, request } = validateKeyForm({ name: " ", scopes: [], models: [], spendCapUsd: "0", expiresOn: "2026-10-17" }, NOW);
    expect(request).toBeNull();
    expect(issues.map((i) => i.field)).toEqual(["name", "scopes", "spendCapUsd", "expiresOn"]);
  });
  it("rejects a name over 100 characters", () => {
    expect(validateKeyForm({ ...base, name: "x".repeat(101) }, NOW).issues[0]?.field).toBe("name");
  });
});

describe("AttemptKeys (Idempotency-Key lifetime)", () => {
  const req = (name: string) => ({ name, scopes: ["gateway:invoke" as const], modelAllowlist: [] });
  it("reuses the key for an identical retry and mints a new one when the payload changes", () => {
    let n = 0;
    const a = new AttemptKeys(() => `key-${++n}`);
    expect(a.keyFor(req("a"))).toBe("key-1");
    expect(a.keyFor(req("a"))).toBe("key-1");
    expect(a.keyFor(req("b"))).toBe("key-2");
    a.reset();
    expect(a.keyFor(req("b"))).toBe("key-3");
  });
  it("default minting yields keys the contract accepts (8-255 printable ASCII)", () => {
    const k = new AttemptKeys().keyFor(req("a"));
    expect(k).toMatch(/^[\x21-\x7e]{8,255}$/);
  });
});

describe("key status", () => {
  const k = (o: Partial<Pick<ApiKey, "revokedAt" | "expiresAt">>) => ({ revokedAt: null, expiresAt: null, ...o });
  it("revoked wins over expired; expiry is checked against now", () => {
    expect(keyStatus(k({ revokedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-02T00:00:00Z" }), NOW)).toBe("revoked");
    expect(keyStatus(k({ expiresAt: "2026-10-18T12:00:00Z" }), NOW)).toBe("expired");
    expect(keyStatus(k({ expiresAt: "2026-10-18T12:00:01Z" }), NOW)).toBe("active");
    expect(keyStatus(k({}), NOW)).toBe("active");
  });
  it("activeKeyCount", () => {
    expect(activeKeyCount([k({}), k({ revokedAt: "2026-10-01T00:00:00Z" }), k({ expiresAt: "2026-10-01T00:00:00Z" })] as ApiKey[], NOW)).toBe(1);
  });
});

const http = (code: string | null, status: number, extra: Partial<Extract<ApiFailure, { kind: "http" }>> = {}): ApiFailure => ({
  kind: "http", status, code, requestId: "r", fieldErrors: [], retryAfterSeconds: null, ...extra,
});

describe("describeCreateFailure", () => {
  it("routes each server outcome to the right UI behaviour", () => {
    expect(describeCreateFailure(http("STEP_UP_REQUIRED", 403)).kind).toBe("step_up");
    expect(describeCreateFailure(http("UNAUTHENTICATED", 401)).kind).toBe("unauthenticated");
    expect(describeCreateFailure(http("VALIDATION_FAILED", 422, { fieldErrors: [{ field: "modelAllowlist[0]", message: "unknown model" }] }))).toMatchObject({ kind: "form", fields: [{ field: "modelAllowlist[0]" }] });
    expect(describeCreateFailure(http("IN_PROGRESS", 409)).kind).toBe("retry");
    expect(describeCreateFailure({ kind: "network" }).kind).toBe("retry");
    expect(describeCreateFailure(http("RATE_LIMITED", 429, { retryAfterSeconds: 7 }))).toMatchObject({ message: expect.stringContaining("7 seconds") });
  });
});

describe("unlinkFailureCopy", () => {
  it("explains the last-method guard instead of offering a retry", () => {
    expect(unlinkFailureCopy(http("LAST_AUTH_METHOD", 409))).toMatchObject({ stepUp: false, message: expect.stringContaining("only sign-in method") });
    expect(unlinkFailureCopy(http("STEP_UP_REQUIRED", 403)).stepUp).toBe(true);
  });
});

describe("firstRequestCurl", () => {
  it("uses the placeholder key, never a real secret, and the origin without trailing slash", () => {
    const c = firstRequestCurl("https://gw.example/", "m-1");
    expect(c).toContain("https://gw.example/v1/chat/completions");
    expect(c).toContain("Bearer YOUR_API_KEY");
    expect(c).toContain('"model": "m-1"');
    expect(c).not.toMatch(/sk_[A-Za-z0-9]/);
  });
});
