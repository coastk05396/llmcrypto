import { z } from "zod";
import { AtomicAmount, Id, PageQuery, Timestamp, listEnvelope } from "./common";

/**
 * POST /api/projects/{id}/memories. Creates a note at version 1. expectedVersion, when sent, must be 0 ("no note
 * yet"); any other value is VERSION_CONFLICT. storageConsent must be literal true: nothing is stored implicitly.
 */
export const CreateMemoryRequest = z.object({
  text: z.string().min(1).max(10_000),
  expectedVersion: z.number().int().nonnegative().optional(),
  /** Draft addition: spec requires explicit storage consent; the client must send literal true. */
  storageConsent: z.literal(true),
  /** draft-0.4 addition: eligible for scoped injection into gateway requests (default false). Still needs the policy opt-in. */
  inject: z.boolean().optional(),
});

/** PUT /api/projects/{id}/memories/{memoryId}: full replacement of the text; mismatch -> 409 VERSION_CONFLICT. */
export const UpdateMemoryRequest = z.strictObject({
  text: z.string().min(1).max(10_000),
  expectedVersion: z.number().int().positive(),
  storageConsent: z.literal(true),
  inject: z.boolean().optional(),
});

export const Memory = z.object({
  id: Id,
  projectId: Id,
  text: z.string(),
  version: z.number().int().positive(),
  /** draft-0.4: whether the note may be injected into this project's gateway requests. */
  inject: z.boolean(),
  /** draft-0.4: when retention will delete the note (null = kept until deleted). */
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const MemoryList = listEnvelope(Memory);
export const MemoryListQuery = PageQuery;

export const MemorySettings = z.object({
  projectId: Id,
  /** null = notes are kept until the user deletes them. */
  retentionDays: z.number().int().min(1).max(365).nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp.nullable(),
});
export const UpdateMemorySettingsRequest = z.strictObject({
  retentionDays: z.number().int().min(1).max(365).nullable(),
  expectedVersion: z.number().int().nonnegative(),
});

export const MemoryUsage = z.object({
  id: Id,
  memoryId: Id,
  version: z.number().int().positive(),
  requestId: z.string().min(1),
  status: z.enum(["injected", "skipped"]),
  reason: z.string().nullable(),
  createdAt: Timestamp,
});
export const MemoryUsageList = listEnvelope(MemoryUsage);
export const MemoryUsageQuery = PageQuery.extend({ memoryId: Id.optional() });

/** Complete, portable copy of a project's stored memory data. */
export const MemoryExport = z.object({
  projectId: Id,
  exportedAt: Timestamp,
  settings: MemorySettings,
  notes: z.array(Memory),
  usage: z.array(MemoryUsage),
  usageTruncated: z.boolean(),
  noteCount: AtomicAmount,
});

export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>;
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequest>;
export type Memory = z.infer<typeof Memory>;
export type MemoryList = z.infer<typeof MemoryList>;
export type MemorySettings = z.infer<typeof MemorySettings>;
export type MemoryUsage = z.infer<typeof MemoryUsage>;
export type MemoryExport = z.infer<typeof MemoryExport>;
