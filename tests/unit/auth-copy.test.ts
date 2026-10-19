import { describe, expect, it } from "vitest";
import type { ApiFailure } from "../../apps/web/src/lib/api";
import {
  forbiddenCopy, formatRetry, isStepUpRequired, isVersionConflict, keySessionCopy, passwordSignInCopy, recoveryCopy, removeMethodCopy, signupCopy, stepUpCopy, telegramCopy,
} from "../../apps/web/src/lib/auth-copy";

const http = (status: number, code: string | null = null, retryAfterSeconds: number | null = null): ApiFailure =>
  ({ kind: "http", status, code, requestId: "req_1", fieldErrors: [], retryAfterSeconds });

describe("formatRetry", () => {
  it("uses only the server-provided Retry-After", () => {
    expect(formatRetry(1)).toBe("1 second");
    expect(formatRetry(45)).toBe("45 seconds");
    expect(formatRetry(300)).toBe("5 minutes");
    expect(formatRetry(null)).toBe("a little while");
  });
});

describe("password sign-in copy", () => {
  it("is one generic message for every 401 (never says whether the user exists)", () => {
    const wrong = passwordSignInCopy(http(401, "UNAUTHENTICATED"));
    expect(wrong.body).toBe("The username or password is incorrect.");
    expect(wrong.body.toLowerCase()).not.toContain("exist");
    expect(wrong.body.toLowerCase()).not.toContain("unknown");
    expect(passwordSignInCopy(http(401, null))).toEqual(wrong);
  });
  it("429 states the wait from Retry-After, even for correct secrets", () => {
    const c = passwordSignInCopy(http(429, "RATE_LIMITED", 120));
    expect(c.title).toBe("Too many attempts");
    expect(c.body).toContain("2 minutes");
    expect(c.body).toContain("even if the details are correct");
  });
  it("network failure is not reported as a wrong password", () => {
    expect(passwordSignInCopy({ kind: "network" }).title).toBe("Could not sign in");
  });
});

describe("other method copy", () => {
  it("Telegram 503 is a configuration state, not user error", () => {
    const c = telegramCopy(http(503, "UNAVAILABLE"));
    expect(c.title).toBe("Telegram is not configured");
    expect(c.tone).toBe("info");
  });
  it("Telegram step-up requirement asks to verify first", () => {
    expect(telegramCopy(http(403, "STEP_UP_REQUIRED")).title).toBe("Verify it is you first");
  });
  it("key session maps 401, 403 and 429 distinctly", () => {
    expect(keySessionCopy(http(401)).title).toBe("Key not accepted");
    expect(keySessionCopy(http(403)).title).toBe("Key cannot open the console");
    expect(keySessionCopy(http(429, null, 30)).body).toContain("30 seconds");
  });
  it("signup and recovery do not leak which part failed", () => {
    expect(signupCopy(http(409)).title).toBe("Username unavailable");
    expect(recoveryCopy(http(401)).body).toContain("username or recovery code");
  });
  it("step-up 403 is the generic did-not-verify message", () => {
    expect(stepUpCopy(http(403, "FORBIDDEN")).body).toBe("That did not verify. Check it and try again.");
  });
  it("removal: last method, missing and step-up are explained", () => {
    expect(removeMethodCopy(http(409, "LAST_AUTH_METHOD"), "The password").body).toContain("only sign-in method");
    expect(removeMethodCopy(http(404, "NOT_FOUND"), "The password").title).toBe("Already removed");
    expect(removeMethodCopy(http(403, "STEP_UP_REQUIRED"), "The password").title).toBe("Verify it is you");
  });
});

describe("failure classifiers", () => {
  it("separates STEP_UP_REQUIRED from a plain role refusal", () => {
    expect(isStepUpRequired(http(403, "STEP_UP_REQUIRED"))).toBe(true);
    expect(isStepUpRequired(http(403, "FORBIDDEN"))).toBe(false);
    expect(forbiddenCopy(http(403, "FORBIDDEN"), "policy")).toContain("role or session");
    expect(forbiddenCopy(http(403, "STEP_UP_REQUIRED"), "policy")).toBeNull();
    expect(forbiddenCopy(http(404), "policy")).toBeNull();
  });
  it("only VERSION_CONFLICT is a version conflict (other 409s are not)", () => {
    expect(isVersionConflict(http(409, "VERSION_CONFLICT"))).toBe(true);
    expect(isVersionConflict(http(409, "LAST_AUTH_METHOD"))).toBe(false);
    expect(isVersionConflict({ kind: "network" })).toBe(false);
  });
});
