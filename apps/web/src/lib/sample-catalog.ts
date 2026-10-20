import type { CatalogResponse } from "@llmcrypto/contracts";

/** Date the bundled sample was written. Shown beside every sample price. */
export const SAMPLE_CATALOG_DATE = "2026-10-18";

/**
 * Bundled SAMPLE DATA used only when GET /api/catalog is unreachable. Providers, models and prices are
 * invented for layout and for the diagnostics sample; they are not offers and not real model prices.
 */
export const SAMPLE_CATALOG: CatalogResponse = {
  pricingVersion: `sample-${SAMPLE_CATALOG_DATE}`,
  items: [
    { id: "alpha-small", provider: "sample-alpha", displayName: "Alpha Small", protocols: ["openai_chat", "anthropic_messages"], inputMicrousdPerMtok: "250000", cachedInputMicrousdPerMtok: "25000", outputMicrousdPerMtok: "1250000", contextWindowTokens: "200000", updatedAt: `${SAMPLE_CATALOG_DATE}T00:00:00Z`, source: "web-bundled-sample" },
    { id: "alpha-large", provider: "sample-alpha", displayName: "Alpha Large", protocols: ["openai_chat", "openai_responses", "anthropic_messages"], inputMicrousdPerMtok: "3000000", cachedInputMicrousdPerMtok: "300000", outputMicrousdPerMtok: "15000000", contextWindowTokens: "200000", updatedAt: `${SAMPLE_CATALOG_DATE}T00:00:00Z`, source: "web-bundled-sample" },
    { id: "beta-fast", provider: "sample-beta", displayName: "Beta Fast", protocols: ["openai_chat"], inputMicrousdPerMtok: "150000", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "600000", contextWindowTokens: "128000", updatedAt: `${SAMPLE_CATALOG_DATE}T00:00:00Z`, source: "web-bundled-sample" },
    { id: "beta-reason", provider: "sample-beta", displayName: "Beta Reason", protocols: ["openai_chat", "openai_responses"], inputMicrousdPerMtok: "1250000", cachedInputMicrousdPerMtok: "125000", outputMicrousdPerMtok: "10000000", contextWindowTokens: "400000", updatedAt: `${SAMPLE_CATALOG_DATE}T00:00:00Z`, source: "web-bundled-sample" },
    { id: "gamma-long", provider: "sample-gamma", displayName: "Gamma Long Context", protocols: ["openai_chat"], inputMicrousdPerMtok: "1000000", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "4000000", contextWindowTokens: "1000000", updatedAt: `${SAMPLE_CATALOG_DATE}T00:00:00Z`, source: "web-bundled-sample" },
    { id: "gamma-mini", provider: "sample-gamma", displayName: "Gamma Mini", protocols: ["openai_chat", "anthropic_messages"], inputMicrousdPerMtok: "75000", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "300000", contextWindowTokens: "32000", updatedAt: `${SAMPLE_CATALOG_DATE}T00:00:00Z`, source: "web-bundled-sample" },
  ],
};
