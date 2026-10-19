import { z } from "zod";
import { Id, Microusd, PageQuery, Timestamp, listEnvelope } from "./common";

/** Proposed scope set; extend with the gateway slice. */
export const KeyScope = z.enum(["gateway:invoke", "usage:read"]);

export const CreateKeyRequest = z.object({
  name: z.string().min(1).max(100),
  projectId: Id.optional(),
  scopes: z.array(KeyScope).min(1),
  modelAllowlist: z.array(z.string().min(1)),
  spendCapMicrousd: Microusd.optional(),
  expiresAt: Timestamp.optional(),
});

/** Metadata only; the secret is never part of this shape. */
export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  projectId: Id.nullable(),
  prefix: z.string().min(1),
  scopes: z.array(KeyScope),
  modelAllowlist: z.array(z.string()),
  spendCapMicrousd: Microusd.nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
});

/**
 * 201 body. First response carries the secret once (PROVIDED). A replay inside the
 * window from the same session returns it again; after the window it returns NON_RECOVERABLE
 * with secret null and never mints a second key.
 */
export const CreateKeyResponse = z.discriminatedUnion("secretStatus", [
  z.object({ key: ApiKey, secretStatus: z.literal("PROVIDED"), secret: z.string().min(1) }),
  z.object({ key: ApiKey, secretStatus: z.literal("NON_RECOVERABLE"), secret: z.null() }),
]);

export const KeyListQuery = PageQuery;
export const KeyList = listEnvelope(ApiKey);

export type KeyScope = z.infer<typeof KeyScope>;
export type CreateKeyRequest = z.infer<typeof CreateKeyRequest>;
export type ApiKey = z.infer<typeof ApiKey>;
export type CreateKeyResponse = z.infer<typeof CreateKeyResponse>;
export type KeyListQuery = z.infer<typeof KeyListQuery>;
export type KeyList = z.infer<typeof KeyList>;
