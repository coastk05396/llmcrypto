import { z } from "zod";
import { AtomicAmount, Id, SignedMicrousd, Timestamp } from "./common";
import { LedgerKind, UsageFilters } from "./usage";

export const ExportKind = z.enum(["usage", "ledger"]);
export const ExportFormat = z.enum(["csv", "jsonl"]);

export const CreateExportRequest = z.object({
  kind: ExportKind,
  filters: UsageFilters.extend({ kind: LedgerKind.optional() }),
  format: ExportFormat,
});

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "expired"]);

/** 202 body of POST /api/exports. */
export const ExportAccepted = z.object({ jobId: Id, status: JobStatus });

/**
 * 200 body of GET /api/jobs/{id}. downloadUrl/expiresAt/summary only after success.
 * downloadUrl is a same-origin path (session cookie required); it stops working at expiresAt.
 * summary.totalMicrousd is the exported sum: usage = sum of chargeMicrousd, ledger = signed sum of amountMicrousd.
 */
export const Job = z.object({
  jobId: Id,
  status: JobStatus,
  downloadUrl: z.string().min(1).startsWith("/").optional(),
  expiresAt: Timestamp.optional(),
  summary: z.object({ rowCount: AtomicAmount, totalMicrousd: SignedMicrousd }).optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});

export type ExportKind = z.infer<typeof ExportKind>;
export type ExportFormat = z.infer<typeof ExportFormat>;
export type CreateExportRequest = z.infer<typeof CreateExportRequest>;
export type JobStatus = z.infer<typeof JobStatus>;
export type ExportAccepted = z.infer<typeof ExportAccepted>;
export type Job = z.infer<typeof Job>;
