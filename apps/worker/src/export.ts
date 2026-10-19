/**
 * Export jobs. The API inserts a 'queued' row into `jobs` (the outbox); this module claims it, renders CSV or JSONL
 * from the SAME read model the console uses (@llmcrypto/domain reporting), and stores the file until it expires.
 *
 * - Authorized rows only: the job is scoped to its account and re-checked against the creator's CURRENT membership role
 *   at run time (a demoted or removed user's queued export fails with FORBIDDEN instead of leaking rows).
 * - Reads and the result write share one transaction, so the file, its row count and its total describe one snapshot.
 * - A claim is a conditional UPDATE with a lease: two runners can never execute one job, and a crashed runner's job is
 *   retried after the lease (bounded attempts).
 * - usage total = sum of chargeMicrousd; ledger total = signed sum of amountMicrousd. Both are exact bigint sums.
 */
import { createHash } from "node:crypto";
import type { LedgerEntry, UsageRecord } from "@llmcrypto/contracts";
import { canExport, queryLedger, queryUsage, type Cursor, type Row, type SqlDb, type SqlExecutor } from "@llmcrypto/domain";
import { csvHeader, csvRow, type CsvColumn } from "./csv";

export interface ExportParams {
  kind: "usage" | "ledger";
  format: "csv" | "jsonl";
  filters: { from?: string; to?: string; model?: string; projectId?: string; keyId?: string; status?: string; runId?: string; kind?: string };
  /** Only rows created before this instant (the moment the export was requested), so a rerun is reproducible. */
  asOf: string;
  maxRows: number;
  ttlSeconds: number;
}

export interface JobRunnerOptions {
  db: SqlDb;
  now: () => Date;
  newId: (prefix: string) => string;
  leaseSeconds?: number;
  maxAttempts?: number;
  pageSize?: number;
}
export interface RunReport {
  succeeded: string[];
  failed: string[];
  retried: string[];
  expired: string[];
}

interface JobRow {
  id: string;
  account_id: string;
  created_by_user_id: string;
  params: ExportParams;
  attempts: number;
}

class ExportFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const USAGE_COLUMNS: CsvColumn<UsageRecord>[] = [
  { header: "id", get: (r) => r.id },
  { header: "requestId", get: (r) => r.requestId },
  { header: "correlationId", get: (r) => r.correlationId },
  { header: "runId", get: (r) => r.runId },
  { header: "parentId", get: (r) => r.parentId },
  { header: "createdAt", get: (r) => r.createdAt },
  { header: "model", get: (r) => r.model },
  { header: "projectId", get: (r) => r.projectId },
  { header: "keyId", get: (r) => r.keyId },
  { header: "status", get: (r) => r.status },
  { header: "inputTokens", numeric: true, get: (r) => r.inputTokens },
  { header: "cachedInputTokens", numeric: true, get: (r) => r.cachedInputTokens },
  { header: "outputTokens", numeric: true, get: (r) => r.outputTokens },
  { header: "chargeMicrousd", numeric: true, get: (r) => r.chargeMicrousd },
  { header: "priceVersion", get: (r) => r.priceVersion },
];
const LEDGER_COLUMNS: CsvColumn<LedgerEntry>[] = [
  { header: "id", get: (r) => r.id },
  { header: "transactionId", get: (r) => r.transactionId },
  { header: "createdAt", get: (r) => r.createdAt },
  { header: "kind", get: (r) => r.kind },
  { header: "amountMicrousd", numeric: true, get: (r) => r.amountMicrousd },
  { header: "sourceType", get: (r) => r.source.type },
  { header: "sourceId", get: (r) => r.source.id },
  { header: "priceVersion", get: (r) => r.priceVersion },
];

/** `to` is the earlier of the requested upper bound and the request time. */
function effectiveTo(p: ExportParams): string {
  const to = p.filters.to;
  return to !== undefined && Date.parse(to) < Date.parse(p.asOf) ? to : p.asOf;
}

async function render(q: SqlExecutor, job: JobRow, pageSize: number): Promise<{ body: string; rows: number; total: bigint; contentType: string; ext: string }> {
  const p = job.params;
  const to = effectiveTo(p);
  const csv = p.format === "csv";
  let body = csv ? (p.kind === "usage" ? csvHeader(USAGE_COLUMNS) : csvHeader(LEDGER_COLUMNS)) : "";
  let rows = 0;
  let total = 0n;
  let after: Cursor | null = null;
  for (;;) {
    const page: Row<UsageRecord | LedgerEntry>[] =
      p.kind === "usage"
        ? await queryUsage(q, { accountId: job.account_id }, { ...p.filters, to } as Parameters<typeof queryUsage>[2], after, pageSize)
        : await queryLedger(q, job.account_id, { ...(p.filters.from ? { from: p.filters.from } : {}), to, ...(p.filters.kind ? { kind: p.filters.kind as LedgerEntry["kind"] } : {}) }, after, pageSize);
    for (const r of page) {
      if (++rows > p.maxRows) throw new ExportFailure("EXPORT_TOO_LARGE", `Export exceeds ${p.maxRows} rows; narrow the filters`);
      if (p.kind === "usage") {
        const u = r.item as UsageRecord;
        total += BigInt(u.chargeMicrousd);
        body += csv ? csvRow(USAGE_COLUMNS, u) : `${JSON.stringify(u)}\n`;
      } else {
        const l = r.item as LedgerEntry;
        total += BigInt(l.amountMicrousd);
        body += csv ? csvRow(LEDGER_COLUMNS, l) : `${JSON.stringify(l)}\n`;
      }
    }
    const last = page[page.length - 1];
    if (page.length < pageSize || !last) break;
    after = [last.at, last.key];
  }
  return { body, rows, total, contentType: csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8", ext: csv ? "csv" : "jsonl" };
}

async function runOne(o: JobRunnerOptions, job: JobRow): Promise<void> {
  const at = o.now();
  await o.db.tx(async (q) => {
    const [m] = await q.query<{ role: string }>("select role from memberships where account_id=$1 and user_id=$2", [job.account_id, job.created_by_user_id]);
    if (!m || !canExport(job.params.kind, m.role)) throw new ExportFailure("FORBIDDEN", "The requester may no longer export this data");
    const out = await render(q, job, o.pageSize ?? 1000);
    const bytes = Buffer.byteLength(out.body, "utf8");
    await q.query(
      "insert into job_outputs (job_id, content_type, filename, body, byte_size, sha256) values ($1,$2,$3,$4,$5,$6)",
      [job.id, out.contentType, `${job.params.kind}-${job.id}.${out.ext}`, out.body, bytes, createHash("sha256").update(out.body).digest("hex")],
    );
    await q.query(
      `update jobs set status='succeeded', finished_at=$2, expires_at=$3, row_count=$4, total_microusd=$5, lease_until=null
       where id=$1 and status='running'`,
      [job.id, at, new Date(at.getTime() + job.params.ttlSeconds * 1000), String(out.rows), out.total.toString()],
    );
    await q.query(
      "insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,$3,'export.completed','job',$4,$5::jsonb,$6)",
      [o.newId("aud"), job.account_id, job.created_by_user_id, job.id, JSON.stringify({ kind: job.params.kind, format: job.params.format, rows: out.rows }), at],
    );
  });
}

/** Claims one runnable job (queued, or running with an expired lease) or returns null. */
async function claim(o: JobRunnerOptions, at: Date): Promise<JobRow | null> {
  const lease = new Date(at.getTime() + (o.leaseSeconds ?? 300) * 1000);
  const max = o.maxAttempts ?? 3;
  const rows = await o.db.query<JobRow>(
    `update jobs set status='running', attempts=attempts+1, started_at=$1, lease_until=$2
     where id = (select id from jobs where attempts < $3 and (status='queued' or (status='running' and lease_until <= $1)) order by created_at, id limit 1)
       and attempts < $3 and (status='queued' or (status='running' and lease_until <= $1))
     returning id, account_id, created_by_user_id, params, attempts`,
    [at, lease, max],
  );
  return rows[0] ?? null;
}

/** Drains every runnable job once, then expires old files. Safe to call concurrently from several runners. */
export async function runPendingJobs(o: JobRunnerOptions): Promise<RunReport> {
  const report: RunReport = { succeeded: [], failed: [], retried: [], expired: [] };
  const max = o.maxAttempts ?? 3;
  // Jobs that exhausted their attempts while "running" (the runner died each time) fail visibly instead of hanging.
  await o.db.query(
    `update jobs set status='failed', finished_at=$1, error_code='RUNNER_LOST', error_message='The export did not finish; request it again'
     where status='running' and lease_until <= $1 and attempts >= $2`,
    [o.now(), max],
  );
  for (;;) {
    const job = await claim(o, o.now());
    if (!job) break;
    try {
      await runOne(o, job);
      report.succeeded.push(job.id);
    } catch (e) {
      const at = o.now();
      const known = e instanceof ExportFailure;
      if (!known && job.attempts < max) {
        await o.db.query("update jobs set status='queued', lease_until=null where id=$1 and status='running'", [job.id]);
        report.retried.push(job.id);
        continue;
      }
      await o.db.query(
        "update jobs set status='failed', finished_at=$2, lease_until=null, error_code=$3, error_message=$4 where id=$1 and status='running'",
        [job.id, at, known ? e.code : "INTERNAL", known ? e.message : "Export failed unexpectedly"],
      );
      report.failed.push(job.id);
    }
  }
  const gone = await o.db.query<{ id: string }>("update jobs set status='expired' where status='succeeded' and expires_at <= $1 returning id", [o.now()]);
  for (const g of gone) {
    await o.db.query("delete from job_outputs where job_id=$1", [g.id]);
    report.expired.push(g.id);
  }
  return report;
}

/** In-process runner against the DB outbox. Production would run this in the worker process once a shared DB driver exists. */
export function startJobRunner(o: JobRunnerOptions & { intervalMs?: number; onError?: (e: unknown) => void }): { stop(): Promise<void>; kick(): Promise<RunReport> } {
  let active: Promise<RunReport> = Promise.resolve({ succeeded: [], failed: [], retried: [], expired: [] });
  let stopped = false;
  const tick = (): Promise<RunReport> => {
    active = active.then(() => runPendingJobs(o)).catch((e: unknown) => {
      o.onError?.(e);
      return { succeeded: [], failed: [], retried: [], expired: [] };
    });
    return active;
  };
  const timer = setInterval(() => { if (!stopped) void tick(); }, o.intervalMs ?? 2000);
  timer.unref();
  return {
    kick: tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
