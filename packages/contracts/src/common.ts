import { z } from "zod";

export const CONTRACT_VERSION = "draft-0.5";

/** Opaque identifier. */
export const Id = z.string().min(1).max(128);
/** UTC RFC 3339 timestamp, e.g. 2026-10-18T12:00:00Z. */
export const Timestamp = z.iso.datetime();
/** Non-negative integer decimal string, no leading zeros. Used for tokens and chain amounts. */
export const AtomicAmount = z.string().regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer decimal string");
/** Non-negative micro-USD (six fractional USD digits) as an integer decimal string. */
export const Microusd = AtomicAmount;
/** Signed micro-USD for ledger postings; "-0" is not canonical. */
export const SignedMicrousd = z.string().regex(/^(0|-?[1-9][0-9]*)$/, "must be a canonical signed integer decimal string");

export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

/** Query params arrive as strings; coerce then bound. Ordering is stable by (createdAt, id). */
export const PageQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export const listEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export type AtomicAmount = z.infer<typeof AtomicAmount>;
export type Microusd = z.infer<typeof Microusd>;
export type SignedMicrousd = z.infer<typeof SignedMicrousd>;
export type PageQuery = z.infer<typeof PageQuery>;
