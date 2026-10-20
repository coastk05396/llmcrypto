import { z } from "zod";
import { AtomicAmount, Id, Microusd, Timestamp } from "./common";

export const ProtocolId = z.enum(["openai_chat", "openai_responses", "anthropic_messages", "gemini_generate_content"]);

export const CatalogQuery = z.object({
  provider: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(128).optional(),
});

/** Rates are micro-USD per one million tokens (integer string). */
export const CatalogModel = z.object({
  id: Id,
  provider: z.string().min(1),
  displayName: z.string().min(1),
  protocols: z.array(ProtocolId).min(1),
  inputMicrousdPerMtok: Microusd,
  cachedInputMicrousdPerMtok: Microusd.nullable(),
  outputMicrousdPerMtok: Microusd,
  contextWindowTokens: AtomicAmount,
  /** When this entry's price/availability was last confirmed. */
  updatedAt: Timestamp,
  /** Provenance label, e.g. "sample-seed" for fabricated demo data; never implies a live provider price. */
  source: z.string().min(1),
});

/** Not a paged list: the catalog is bounded and returned whole with its pricing version. */
export const CatalogResponse = z.object({
  pricingVersion: Id,
  items: z.array(CatalogModel),
});

export type ProtocolId = z.infer<typeof ProtocolId>;
export type CatalogQuery = z.infer<typeof CatalogQuery>;
export type CatalogModel = z.infer<typeof CatalogModel>;
export type CatalogResponse = z.infer<typeof CatalogResponse>;
