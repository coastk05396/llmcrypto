import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIMIZATION_CONFIG, type OptimizationConfig } from "@llmcrypto/contracts";
import { applyInjection, decideLoop, enablesSensitiveControl, fingerprintInput, validateOptimizationConfig, MEMORY_PREFIX } from "./optimization";
import { renderNotification } from "./notifications";
import { isMemoryExpired, memoryExpiry } from "./memory-policy";

const cfg = (over: Partial<OptimizationConfig>): OptimizationConfig => ({ ...(JSON.parse(JSON.stringify(DEFAULT_OPTIMIZATION_CONFIG)) as OptimizationConfig), ...over });
const msgs = [{ role: "user" as const, text: "hi" }];

describe("applyInjection", () => {
  it("does nothing and records nothing when every control is off", () => {
    const r = applyInjection({ config: DEFAULT_OPTIMIZATION_CONFIG, messages: msgs, notes: [{ id: "n", version: 1, text: "t" }], hasProject: true, optOut: false });
    expect(r.messages.map((m) => m.text)).toEqual(["hi"]);
    expect(r.evidence).toEqual([]);
    expect(r.memory).toEqual([]);
  });
  it("orders guidance before project notes before the request, tagging each origin", () => {
    const r = applyInjection({
      config: cfg({ conciseGuidance: { enabled: true, text: " be brief " }, projectContext: { enabled: true, maxNotes: 5, maxChars: 500 } }),
      messages: msgs, notes: [{ id: "n1", version: 3, text: "a" }], hasProject: true, optOut: false,
    });
    expect(r.messages.map((m) => [m.origin, m.text])).toEqual([["guidance", "be brief"], ["project_memory", `${MEMORY_PREFIX}- a`], ["request", "hi"]]);
    expect(r.memory).toEqual([{ memoryId: "n1", version: 3, status: "injected", reason: null }]);
  });
  it("opt-out skips only the altering controls", () => {
    const r = applyInjection({
      config: cfg({ conciseGuidance: { enabled: true, text: "x" }, cacheAccounting: { enabled: true } }), messages: msgs, notes: [], hasProject: false, optOut: true,
    });
    expect(r.messages).toHaveLength(1);
    expect(r.evidence.map((e) => [e.feature, e.status])).toEqual([["cache_accounting", "applied"], ["concise_guidance", "skipped"]]);
  });
  it("counts characters against the budget and reports what was left out", () => {
    const notes = [{ id: "a", version: 1, text: "x".repeat(60) }, { id: "b", version: 1, text: "y".repeat(60) }];
    const r = applyInjection({ config: cfg({ projectContext: { enabled: true, maxNotes: 5, maxChars: 100 } }), messages: msgs, notes, hasProject: true, optOut: false });
    expect(r.memory.map((m) => [m.memoryId, m.status, m.reason])).toEqual([["a", "injected", null], ["b", "skipped", "over_budget"]]);
    const none = applyInjection({ config: cfg({ projectContext: { enabled: true, maxNotes: 5, maxChars: 100 } }), messages: msgs, notes: [{ id: "z", version: 1, text: "q".repeat(200) }], hasProject: true, optOut: false });
    expect(none.evidence[0]).toMatchObject({ status: "skipped", reason: "over_budget" });
    expect(none.messages).toHaveLength(1);
  });
});

describe("decideLoop", () => {
  const lg = { ...DEFAULT_OPTIMIZATION_CONFIG.loopGuard, enabled: true, threshold: 3 };
  it("counts the current request and stays advisory unless enforcement has consent", () => {
    expect(decideLoop(lg, 1).status).toBe("skipped");
    expect(decideLoop(lg, 2).status).toBe("advisory");
    expect(decideLoop({ ...lg, mode: "enforce" }, 9).status).toBe("advisory"); // no consent: never blocks
    expect(decideLoop({ ...lg, mode: "enforce", enforcementConsent: true }, 1).status).toBe("skipped");
    expect(decideLoop({ ...lg, mode: "enforce", enforcementConsent: true }, 2)).toMatchObject({ status: "blocked", detail: { count: 3, threshold: 3 } });
  });
  it("fingerprint input depends on model, roles and text", () => {
    const base = fingerprintInput("m", msgs);
    expect(fingerprintInput("m", msgs)).toBe(base);
    expect(fingerprintInput("m2", msgs)).not.toBe(base);
    expect(fingerprintInput("m", [{ role: "system", text: "hi" }])).not.toBe(base);
  });
});

describe("validateOptimizationConfig / enablesSensitiveControl", () => {
  it("rejects batching, empty guidance, unconsented or contradictory enforcement", () => {
    const lg = DEFAULT_OPTIMIZATION_CONFIG.loopGuard;
    expect(validateOptimizationConfig(DEFAULT_OPTIMIZATION_CONFIG)).toEqual([]);
    expect(validateOptimizationConfig(cfg({ batching: { enabled: true } }))).toHaveLength(1);
    expect(validateOptimizationConfig(cfg({ conciseGuidance: { enabled: true, text: "" } }))).toHaveLength(1);
    expect(validateOptimizationConfig(cfg({ loopGuard: { ...lg, enabled: true, mode: "enforce" } }))).toHaveLength(1);
    expect(validateOptimizationConfig(cfg({ loopGuard: { ...lg, enabled: true, mode: "enforce", enforcementConsent: true } }))).toEqual([]);
    expect(validateOptimizationConfig(cfg({ loopGuard: { ...lg, mode: "advisory", enforcementConsent: true } }))).toHaveLength(1);
  });
  it("flags only turning on prompt-altering or enforcing controls", () => {
    const on = cfg({ projectContext: { enabled: true, maxNotes: 5, maxChars: 2000 } });
    expect(enablesSensitiveControl(DEFAULT_OPTIMIZATION_CONFIG, on)).toBe(true);
    expect(enablesSensitiveControl(on, on)).toBe(false);
    expect(enablesSensitiveControl(on, DEFAULT_OPTIMIZATION_CONFIG)).toBe(false);
    expect(enablesSensitiveControl(DEFAULT_OPTIMIZATION_CONFIG, cfg({ cacheAccounting: { enabled: true }, routeComparison: { enabled: true } }))).toBe(false);
  });
});

describe("notification rendering and memory retention", () => {
  it("renders a fixed template and drops references that do not look like opaque ids", () => {
    expect(renderNotification("loop_guard", "req_1")).toBe("LLM Gateway: LoopGuard noticed repeated identical requests. Reference: req_1. Open the console for details.");
    expect(renderNotification("loop_guard", "sk_secret value with spaces")).not.toContain("secret");
    expect(renderNotification("test", null)).not.toContain("Reference");
  });
  it("retention counts from the last edit", () => {
    const t = new Date("2026-10-18T00:00:00Z");
    expect(memoryExpiry(t, null)).toBeNull();
    expect(memoryExpiry(t, 2)?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(isMemoryExpired(t, 2, new Date("2026-10-20T00:00:00Z"))).toBe(true);
    expect(isMemoryExpired(t, 2, new Date("2026-10-19T23:59:59Z"))).toBe(false);
    expect(isMemoryExpired(t, null, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });
});
