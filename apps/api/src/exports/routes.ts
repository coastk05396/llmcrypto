/**
 * Export requests and job status/download.
 * POST /api/exports only queues work (a row in the `jobs` outbox, committed together with its idempotency record);
 * apps/worker/src/export.ts produces the file. Jobs belong to their creator: other users, other accounts and
 * API-key sessions get 404/403, never the file.
 */
import { Hono } from "hono";
import { CreateExportRequest, IdempotencyKey, Job, type ExportAccepted, type JobStatus } from "@llmcrypto/contracts";
import { canExport } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession } from "../auth/session";
import type { AppConfig } from "../config";
import { canonicalJson, randomId, sha256Hex } from "../crypto";
import type { Db } from "../db";
import { ApiError, parseBody, type AppEnv, type Ctx } from "../http";
import { abortIdempotent, beginIdempotent, completeIdempotent, type IdemScope } from "../idempotency";

export interface ExportDeps {
  db: Db;
  config: AppConfig;
}

/** Queued or running exports one account may have at a time. */
const MAX_ACTIVE_JOBS = 5;

interface JobRow {
  id: string;
  status: JobStatus;
  expires_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  row_count: string | null;
  total_microusd: string | null;
  kind: string;
  params: { kind: "usage" | "ledger" };
}

const COLS = "id, status, expires_at, error_code, error_message, row_count::text as row_count, total_microusd::text as total_microusd, kind, params";

function toJob(r: JobRow, now: Date): Job {
  const status: JobStatus = r.status === "succeeded" && r.expires_at !== null && r.expires_at.getTime() <= now.getTime() ? "expired" : r.status;
  return Job.parse({
    jobId: r.id,
    status,
    ...(status === "succeeded" && r.expires_at ? { downloadUrl: `/api/jobs/${r.id}/download`, expiresAt: r.expires_at.toISOString() } : {}),
    ...(status === "succeeded" && r.row_count !== null && r.total_microusd !== null ? { summary: { rowCount: r.row_count, totalMicrousd: r.total_microusd } } : {}),
    ...(status === "failed" ? { error: { code: r.error_code ?? "INTERNAL", message: r.error_message ?? "Export failed" } } : {}),
  });
}

export function exportRoutes({ db, config }: ExportDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const needSession = requireSession(db, config); // API-key sessions are refused centrally

  app.post("/exports", needSession, async (c) => {
    const auth = c.get("auth");
    const rawKey = c.req.header("Idempotency-Key");
    if (rawKey === undefined || rawKey === "") throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    const parsedKey = IdempotencyKey.safeParse(rawKey);
    if (!parsedKey.success) throw new ApiError("BAD_REQUEST", "Idempotency-Key must be 8-255 printable ASCII characters");
    const body = await parseBody(c, CreateExportRequest);
    if (!canExport(body.kind, auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const issues: { field: string; message: string }[] = [];
    const f = body.filters;
    if (f.from && f.to && Date.parse(f.from) >= Date.parse(f.to)) issues.push({ field: "filters.to", message: "must be after filters.from" });
    if (body.kind === "usage" && f.kind !== undefined) issues.push({ field: "filters.kind", message: "only applies to ledger exports" });
    if (body.kind === "ledger") {
      for (const k of ["model", "projectId", "keyId", "status", "runId"] as const) if (f[k] !== undefined) issues.push({ field: `filters.${k}`, message: "does not apply to ledger exports" });
    }
    if (issues.length) throw new ApiError("VALIDATION_FAILED", "Request validation failed", issues);

    const scope: IdemScope = { accountId: auth.accountId, operation: "createExport", key: parsedKey.data };
    const now = config.now();
    const outcome = await beginIdempotent(db, scope, sha256Hex(canonicalJson(body)), now, config.idempotencyStaleSeconds);
    c.header("Cache-Control", "no-store");
    if (outcome.action === "reject") throw new ApiError(outcome.code, outcome.code === "IN_PROGRESS" ? "An identical request is still running" : "Idempotency-Key reused with a different payload");
    if (outcome.action === "replay") {
      const jobId = (outcome.row.result as { jobId?: string } | null)?.jobId;
      const [row] = jobId ? await db.query<JobRow>(`select ${COLS} from jobs where id=$1 and account_id=$2`, [jobId, auth.accountId]) : [];
      if (!row) throw new ApiError("INTERNAL", "Original result unavailable");
      c.header("Idempotent-Replay", "true");
      return c.json({ jobId: row.id, status: toJob(row, now).status } satisfies ExportAccepted, 202);
    }

    try {
      const jobId = randomId("job");
      await db.tx(async (q) => {
        const [{ n } = { n: "0" }] = await q.query<{ n: string }>("select count(*)::text as n from jobs where account_id=$1 and status in ('queued','running')", [auth.accountId]);
        if (Number(n) >= MAX_ACTIVE_JOBS) throw new ApiError("RATE_LIMITED", "Too many exports in progress; wait for one to finish", undefined, { "Retry-After": "30" });
        const params = { kind: body.kind, format: body.format, filters: body.filters, asOf: now.toISOString(), maxRows: config.exportMaxRows, ttlSeconds: config.exportTtlSeconds };
        await q.query(
          "insert into jobs (id, account_id, created_by_user_id, kind, params, status, created_at) values ($1,$2,$3,'export',$4::jsonb,'queued',$5)",
          [jobId, auth.accountId, auth.userId, JSON.stringify(params), now],
        );
        await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "export.requested", targetType: "job", targetId: jobId, requestId: c.get("requestId"), at: now, metadata: { kind: body.kind, format: body.format } });
        await completeIdempotent(q, scope, { statusCode: 202, result: { jobId }, at: now });
      });
      return c.json({ jobId, status: "queued" } satisfies ExportAccepted, 202);
    } catch (e) {
      await abortIdempotent(db, scope);
      throw e;
    }
  });

  async function ownJob(c: Ctx, id: string): Promise<JobRow> {
    const auth = c.get("auth");
    const [row] = await db.query<JobRow>(`select ${COLS} from jobs where id=$1 and account_id=$2 and created_by_user_id=$3`, [id, auth.accountId, auth.userId]);
    if (!row) throw new ApiError("NOT_FOUND", "Job not found");
    return row;
  }

  app.get("/jobs/:id", needSession, async (c) => {
    const row = await ownJob(c, c.req.param("id"));
    c.header("Cache-Control", "no-store");
    return c.json(toJob(row, config.now()));
  });

  app.get("/jobs/:id/download", needSession, async (c) => {
    const auth = c.get("auth");
    const row = await ownJob(c, c.req.param("id"));
    const now = config.now();
    if (toJob(row, now).status !== "succeeded" || !canExport(row.params.kind, auth.role)) throw new ApiError("NOT_FOUND", "Job not found");
    const [out] = await db.query<{ content_type: string; filename: string; body: string }>("select content_type, filename, body from job_outputs where job_id=$1", [row.id]);
    if (!out) throw new ApiError("NOT_FOUND", "Job not found");
    await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "export.downloaded", targetType: "job", targetId: row.id, requestId: c.get("requestId"), at: now });
    return c.body(out.body, 200, {
      "Content-Type": out.content_type,
      "Content-Disposition": `attachment; filename="${out.filename}"`,
      "Cache-Control": "no-store",
    });
  });

  return app;
}
