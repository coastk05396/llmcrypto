import { z } from "zod";
import { Id, Microusd, PageQuery, Timestamp, listEnvelope } from "./common";

/**
 * Design beta (BETA, draft-0.5, behind FEATURE_DESIGN_BETA; definitions are UNCONFIRMED proposals from SPEC.md).
 * Brief -> proposal (metered through the gateway reservation path) -> revisions -> exportable artifact. The output is
 * labelled AI-generated and is only ever text/JSON for a person to read: nothing generated is executed or deployed.
 */
export const DesignRevisionStatus = z.enum(["queued", "generating", "succeeded", "failed"]);

export const DesignDocument = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  sections: z.array(z.object({ heading: z.string().min(1).max(160), body: z.string().min(1).max(4000) })).min(1).max(20),
  components: z.array(z.object({ name: z.string().min(1).max(100), purpose: z.string().min(1).max(600) })).max(30),
  risks: z.array(z.string().min(1).max(400)).max(20),
});

/**
 * Cost of one generation. maxMicrousd = quote at creation (generic upper bound); the reservation hold is made when the
 * worker starts. state: none (queued), reserved (hold open), charged (settled, chargedMicrousd final), pending (usage
 * unknown, hold kept for reconciliation), released (failed before any charge).
 */
export const DesignCost = z.object({
  state: z.enum(["none", "reserved", "charged", "pending", "released"]),
  maxMicrousd: Microusd,
  chargedMicrousd: Microusd.nullable(),
  requestId: Id.nullable(),
});

export const DesignRevision = z.object({
  number: z.number().int().positive(),
  kind: z.enum(["proposal", "revision"]),
  instruction: z.string().nullable(),
  status: DesignRevisionStatus,
  model: z.string().min(1),
  aiGenerated: z.literal(true),
  document: DesignDocument.nullable(),
  failure: z.object({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
  cost: DesignCost,
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});

export const Design = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  brief: z.string(),
  model: z.string().min(1),
  latestRevision: z.number().int().positive(),
  totalChargedMicrousd: Microusd,
  aiGenerated: z.literal(true),
  revisions: z.array(DesignRevision),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const DesignSummary = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  model: z.string().min(1),
  latestRevision: z.number().int().positive(),
  latestStatus: DesignRevisionStatus,
  totalChargedMicrousd: Microusd,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const DesignList = listEnvelope(DesignSummary);
export const DesignListQuery = PageQuery;

export const CreateDesignRequest = z.strictObject({
  title: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(10).max(8000),
  /** Catalog model id served on the chat protocol. Defaults to the server's design model. */
  model: Id.optional(),
});
export const CreateDesignRevisionRequest = z.strictObject({
  instruction: z.string().trim().min(3).max(4000),
  /** The revision number the caller is revising; a stale value is 409 VERSION_CONFLICT. */
  baseRevision: z.number().int().positive(),
});
/** 202 body for creating a design (revision 1) and for requesting a revision. */
export const DesignRevisionAccepted = z.object({
  designId: Id,
  revision: z.number().int().positive(),
  status: DesignRevisionStatus,
  maxCostMicrousd: Microusd,
});

export const DesignExportFormat = z.enum(["markdown", "json"]);
export const DesignExportQuery = z.object({
  format: DesignExportFormat.default("markdown"),
  revision: z.coerce.number().int().positive().optional(),
});
export const DESIGN_EXPORT_LABEL = "AI-generated proposal. Not reviewed, not verified, never executed or deployed by this service.";
/** JSON artifact. The markdown artifact carries the same label and provenance as text. */
export const DesignExport = z.object({
  format: z.literal("llmcrypto-design-export-v1"),
  label: z.literal(DESIGN_EXPORT_LABEL),
  exportedAt: Timestamp,
  design: z.object({ id: Id, projectId: Id, title: z.string(), brief: z.string() }),
  revision: z.object({ number: z.number().int().positive(), kind: z.enum(["proposal", "revision"]), instruction: z.string().nullable(), createdAt: Timestamp }),
  generation: z.object({ model: z.string().min(1), requestId: Id.nullable(), chargedMicrousd: Microusd.nullable() }),
  document: DesignDocument,
});

export type DesignDocument = z.infer<typeof DesignDocument>;
export type DesignRevision = z.infer<typeof DesignRevision>;
export type Design = z.infer<typeof Design>;
export type DesignSummary = z.infer<typeof DesignSummary>;
export type DesignExport = z.infer<typeof DesignExport>;
export type DesignRevisionAccepted = z.infer<typeof DesignRevisionAccepted>;
