import { z } from "zod";
import { AtomicAmount, Id, PageQuery, Timestamp, listEnvelope } from "./common";

/**
 * Repository graph (BETA, draft-0.5, behind FEATURE_REPOSITORY_GRAPH; definitions are UNCONFIRMED proposals from SPEC.md).
 * Upload = POST /api/projects/{id}/repository-imports with the raw archive as the request body (application/zip or
 * application/gzip) plus an Idempotency-Key. The import is a queued job; the graph is derived by static analysis only.
 */
export const RepositoryImportStatus = z.enum(["queued", "running", "succeeded", "failed"]);
export const RepositoryArchiveFormat = z.enum(["zip", "tar.gz"]);
export const RepositoryLanguage = z.enum(["javascript", "typescript", "python", "go"]);
export const RepositoryEdgeTargetKind = z.enum(["file", "directory", "external", "unresolved"]);

export const RepositoryLimits = z.object({
  maxArchiveBytes: z.number().int().positive(),
  maxEntries: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxPathBytes: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  maxRatio: z.number().int().positive(),
  maxEdges: z.number().int().positive(),
  /** draft-0.5 addition (absent on imports created before it). */
  maxParseMs: z.number().int().positive().optional(),
  maxParseLines: z.number().int().positive().optional(),
});

const Count = z.number().int().nonnegative();
export const RepositoryImportStats = z.object({
  files: Count,
  skipped: Count,
  edges: Count,
  /** true when maxEdges was reached and later edges were dropped. */
  edgesTruncated: z.boolean(),
  externalPackages: Count,
  unresolvedImports: Count,
  languages: z.record(z.string(), Count),
  skippedByReason: z.record(z.string(), Count),
});

export const RepositoryImport = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  format: RepositoryArchiveFormat,
  status: RepositoryImportStatus,
  uploadBytes: AtomicAmount,
  stats: RepositoryImportStats.nullable(),
  /** Set when status = failed. Codes: ARCHIVE_* (rejected archive), IMPORT_FAILED, RUNNER_LOST. */
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
  limits: RepositoryLimits,
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export const RepositoryImportList = listEnvelope(RepositoryImport);
export const RepositoryImportListQuery = PageQuery;
export const RepositoryImportAccepted = z.object({ importId: Id, status: RepositoryImportStatus });

export const RepositoryFile = z.object({
  path: z.string().min(1),
  language: RepositoryLanguage.nullable(),
  sizeBytes: Count,
  lineCount: Count,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  outgoing: Count,
  incoming: Count,
});
export const RepositoryFileList = listEnvelope(RepositoryFile);
export const RepositoryFileQuery = PageQuery.extend({ pathPrefix: z.string().min(1).max(512).optional() });

/** Evidence: the importing file, the 1-based line of the statement and that line's text (URL credentials redacted, <= 200 chars). */
export const RepositoryEdge = z.object({
  id: Id,
  from: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.literal("import"),
  specifier: z.string(),
  to: z.object({ kind: RepositoryEdgeTargetKind, path: z.string().nullable(), name: z.string().nullable() }),
  snippet: z.string(),
  language: RepositoryLanguage,
});
export const RepositoryEdgeList = listEnvelope(RepositoryEdge);
export const RepositoryEdgeQuery = PageQuery.extend({
  from: z.string().min(1).max(512).optional(),
  to: z.string().min(1).max(512).optional(),
  toKind: RepositoryEdgeTargetKind.optional(),
});

/** Derived architecture view: files rolled up by their first `depth` directories (root files are "."). */
export const RepositoryGraph = z.object({
  importId: Id,
  depth: z.number().int().min(1).max(4),
  nodes: z.array(z.object({ path: z.string().min(1), files: Count, languages: z.record(z.string(), Count) })),
  edges: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    count: z.number().int().positive(),
    /** Up to three import statements behind the rolled-up edge. */
    evidence: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive() })),
  })),
  external: z.array(z.object({ name: z.string().min(1), count: z.number().int().positive() })),
});
export const RepositoryGraphQuery = z.object({ depth: z.coerce.number().int().min(1).max(4).default(2) });

/** Complete, portable copy of one import (no file contents are stored, so none are exported). */
export const RepositoryExport = z.object({
  exportedAt: Timestamp,
  label: z.literal("derived by static analysis; not executed, not verified"),
  import: RepositoryImport,
  files: z.array(RepositoryFile),
  skipped: z.array(z.object({ path: z.string().min(1), reason: z.string().min(1) })),
  edges: z.array(RepositoryEdge),
});

export type RepositoryImport = z.infer<typeof RepositoryImport>;
export type RepositoryImportStats = z.infer<typeof RepositoryImportStats>;
export type RepositoryLimits = z.infer<typeof RepositoryLimits>;
export type RepositoryFile = z.infer<typeof RepositoryFile>;
export type RepositoryEdge = z.infer<typeof RepositoryEdge>;
export type RepositoryGraph = z.infer<typeof RepositoryGraph>;
export type RepositoryExport = z.infer<typeof RepositoryExport>;
export type RepositoryLanguage = z.infer<typeof RepositoryLanguage>;
