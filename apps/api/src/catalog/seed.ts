import type { CatalogModel } from "@llmcrypto/contracts";

/**
 * SAMPLE DATA ONLY. These models, providers and prices are fabricated for development and tests.
 * They are not real offerings and must not be presented as live provider prices.
 * Rates are micro-USD per one million tokens (integer strings).
 */
export const SAMPLE_PRICING_VERSION = "pv_sample_2026-10-18";
export const SAMPLE_SOURCE = "sample-seed";
const UPDATED_AT = "2026-10-18T00:00:00Z";

const m = (
  id: string, provider: string, displayName: string, protocols: CatalogModel["protocols"],
  input: string, cached: string | null, output: string, ctx: string,
): CatalogModel => ({
  id, provider, displayName, protocols,
  inputMicrousdPerMtok: input, cachedInputMicrousdPerMtok: cached, outputMicrousdPerMtok: output,
  contextWindowTokens: ctx, updatedAt: UPDATED_AT, source: SAMPLE_SOURCE,
});

export const SAMPLE_CATALOG: readonly CatalogModel[] = [
  m("sample-frontier-1", "sample-provider-a", "Sample Frontier 1 (fake)", ["openai_chat", "anthropic_messages"], "3000000", "300000", "15000000", "200000"),
  m("sample-fast-1", "sample-provider-a", "Sample Fast 1 (fake)", ["openai_chat", "anthropic_messages", "openai_responses"], "250000", "25000", "1250000", "128000"),
  m("sample-reasoner-1", "sample-provider-b", "Sample Reasoner 1 (fake)", ["openai_chat", "openai_responses"], "1500000", null, "6000000", "128000"),
  m("sample-mini-1", "sample-provider-b", "Sample Mini 1 (fake)", ["openai_chat"], "150000", "15000", "600000", "64000"),
  m("sample-long-context-1", "sample-provider-c", "Sample Long Context 1 (fake)", ["gemini_generate_content", "openai_chat"], "1250000", "125000", "5000000", "1000000"),
  m("sample-lite-1", "sample-provider-c", "Sample Lite 1 (fake)", ["openai_chat"], "50000", null, "200000", "32000"),
];
