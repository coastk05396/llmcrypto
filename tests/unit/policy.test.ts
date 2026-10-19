import { DEFAULT_OPTIMIZATION_CONFIG, type OptimizationConfig } from "@llmcrypto/contracts";
import { describe, expect, it } from "vitest";
import { enablesSensitive, formatDetail, normalizeConfig, sameConfig, summarizeConfig, validateConfig } from "../../apps/web/src/lib/policy";
import { DELIVERY_STATUS, EVENT_KINDS, modeLabel, sameEvents } from "../../apps/web/src/lib/connectivity";

const base = (): OptimizationConfig => structuredClone(DEFAULT_OPTIMIZATION_CONFIG);

describe("policy validation", () => {
  it("the default policy (everything off) is valid and summarises to nothing on", () => {
    expect(validateConfig(base())).toEqual([]);
    expect(summarizeConfig(base())).toEqual([]);
  });
  it("LoopGuard enforcement needs explicit consent", () => {
    const c = base();
    c.loopGuard = { ...c.loopGuard, enabled: true, mode: "enforce", enforcementConsent: false };
    expect(validateConfig(c).map((i) => i.field)).toContain("enforcementConsent");
    c.loopGuard.enforcementConsent = true;
    expect(validateConfig(c)).toEqual([]);
  });
  it("LoopGuard threshold and window follow the contract bounds", () => {
    const c = base();
    c.loopGuard.threshold = 1;
    c.loopGuard.windowSeconds = 30;
    expect(validateConfig(c).map((i) => i.field).sort()).toEqual(["threshold", "windowSeconds"]);
    c.loopGuard.threshold = Number.NaN;
    expect(validateConfig(c).map((i) => i.field)).toContain("threshold");
    c.loopGuard.threshold = 1000;
    c.loopGuard.windowSeconds = 86_400;
    expect(validateConfig(c)).toEqual([]);
  });
  it("enabled guidance needs text and is capped at 500 characters", () => {
    const c = base();
    c.conciseGuidance.enabled = true;
    expect(validateConfig(c).map((i) => i.field)).toContain("guidanceText");
    c.conciseGuidance.text = "Be brief.";
    expect(validateConfig(c)).toEqual([]);
    c.conciseGuidance.text = "x".repeat(501);
    expect(validateConfig(c).map((i) => i.message).join()).toContain("500");
  });
  it("project context budgets are bounded", () => {
    const c = base();
    c.projectContext.maxNotes = 21;
    c.projectContext.maxChars = 99;
    expect(validateConfig(c).map((i) => i.field).sort()).toEqual(["maxChars", "maxNotes"]);
  });
});

describe("policy helpers", () => {
  it("drops the stale consent flag when mode is advisory", () => {
    const c = base();
    c.loopGuard = { ...c.loopGuard, mode: "advisory", enforcementConsent: true };
    expect(normalizeConfig(c).loopGuard.enforcementConsent).toBe(false);
    expect(sameConfig(normalizeConfig(c), base())).toBe(true);
  });
  it("flags only request-altering or blocking enablement as needing a recent sign-in", () => {
    const off = base();
    const withCache = { ...base(), cacheAccounting: { enabled: true } };
    expect(enablesSensitive(off, withCache)).toBe(false);
    expect(enablesSensitive(off, { ...base(), conciseGuidance: { enabled: true, text: "x" } })).toBe(true);
    expect(enablesSensitive(off, { ...base(), projectContext: { ...off.projectContext, enabled: true } })).toBe(true);
    const enforce = { ...base(), loopGuard: { ...off.loopGuard, enabled: true, mode: "enforce" as const, enforcementConsent: true } };
    expect(enablesSensitive(off, enforce)).toBe(true);
    expect(enablesSensitive(enforce, enforce)).toBe(false); // turning things off or leaving them is never sensitive
    expect(enablesSensitive(enforce, off)).toBe(false);
  });
  it("formats evidence details without ever needing text fields", () => {
    expect(formatDetail({ addedUtf8Bytes: 42, applied: true, why: null })).toBe("addedUtf8Bytes: 42, applied: true, why: none");
    expect(formatDetail({})).toBe("");
  });
});

describe("connectivity labels", () => {
  it("never labels a test double or unconfigured channel as live", () => {
    expect(modeLabel("fake").label).toBe("Test double");
    expect(modeLabel("unconfigured").label).toBe("Not configured");
    expect(modeLabel("live").label).toBe("Live");
  });
  it("offers exactly the five subscribable events and no 'test'", () => {
    expect(EVENT_KINDS).toHaveLength(5);
    expect(EVENT_KINDS).not.toContain("test");
  });
  it("covers every delivery status, and compares event sets order-insensitively", () => {
    expect(Object.keys(DELIVERY_STATUS).sort()).toEqual(["failed", "pending", "sent", "skipped"]);
    expect(sameEvents(["loop_guard", "key_cap_reached"], ["key_cap_reached", "loop_guard"])).toBe(true);
    expect(sameEvents([], ["loop_guard"])).toBe(false);
  });
});
