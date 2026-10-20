/**
 * Repository import job (BETA). The API stores the uploaded archive in `repo_import_uploads` and queues a `repo_imports`
 * row; this runner claims it (conditional UPDATE with a lease, so two runners never process one import), reads the archive
 * in memory with the limits recorded on the row, and writes the derived file list, skipped list and dependency edges.
 *
 * Read-only by construction: nothing is extracted to disk, no file is executed, no package script or build step is run,
 * and no link is followed. Only paths, sizes, hashes, import edges and the single import line per edge are stored. The raw
 * archive is deleted as soon as the job ends, whether it succeeded or failed.
 */
import type { RepositoryImportStats } from "@llmcrypto/contracts";
import {
  classifyPath, goModulePath, hasSecretContent, isBinaryContent, languageOf, parseImports, resolveImport, resolveLimits,
  type ImportLimits, type ImportRef, type SkipReason, type SourceLanguage, type SqlDb, type SqlExecutor,
} from "@llmcrypto/domain";
import { ArchiveError, archiveSha256, openArchive, type ArchiveEntry } from "./repository-archive";

export interface RepoImportOptions {
  db: SqlDb;
  now: () => Date;
  newId: (prefix: string) => string;
  leaseSeconds?: number;
  maxAttempts?: number;
}
export interface RepoImportReport {
  succeeded: string[];
  failed: string[];
  retried: string[];
}

interface ImportRow {
  id: string;
  account_id: string;
  project_id: string;
  created_by_user_id: string;
  limits: Partial<ImportLimits>;
  attempts: number;
}

interface FileRec {
  path: string;
  language: SourceLanguage | null;
  sizeBytes: number;
  lineCount: number;
  sha256: string;
}
interface EdgeRec {
  from: string;
  line: number;
  specifier: string;
  snippet: string;
  language: SourceLanguage;
  toKind: "file" | "directory" | "external" | "unresolved";
  toPath: string | null;
  external: string | null;
}
export interface Analysis {
  files: FileRec[];
  skipped: { path: string; reason: SkipReason }[];
  edges: EdgeRec[];
  stats: RepositoryImportStats;
}

class ImportFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const dirsOf = (path: string): string[] => {
  const parts = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
};

/** Pure analysis of an opened archive. Exported so the unit tests can exercise it without a database. */
export function analyzeEntries(rawEntries: readonly ArchiveEntry[], limits: ImportLimits): Analysis {
  // A single wrapping top-level directory (the usual repository download layout) is stripped.
  const named = rawEntries.filter((e) => e.path !== "");
  const tops = new Set(named.map((e) => e.path.split("/")[0]!));
  const strip = tops.size === 1 && named.every((e) => e.kind === "dir" || e.path.includes("/")) ? [...tops][0]! : null;
  const pathOf = (e: ArchiveEntry): string => (strip === null ? e.path : e.path === strip ? "" : e.path.slice(strip.length + 1));

  const files: FileRec[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  const refsByFile: { path: string; language: SourceLanguage; refs: ImportRef[] }[] = [];
  const goModules = new Map<string, string>();
  let bytesRead = 0;
  let parseMs = 0;

  for (const e of rawEntries) {
    const path = pathOf(e);
    if (path === "" || e.kind === "dir") continue;
    if (e.skip) {
      skipped.push({ path, reason: e.skip });
      continue;
    }
    const byName = classifyPath(path);
    if (byName) {
      skipped.push({ path, reason: byName });
      continue;
    }
    if (e.size > limits.maxFileBytes) {
      skipped.push({ path, reason: "too_large" });
      continue;
    }
    if (files.length >= limits.maxFiles) {
      skipped.push({ path, reason: "file_limit" });
      continue;
    }
    const buf = e.read();
    bytesRead += buf.length;
    if (bytesRead > limits.maxTotalBytes) throw new ArchiveError("ARCHIVE_EXPANDS_TOO_MUCH", "Archive expands beyond the size limit");
    if (isBinaryContent(buf)) {
      skipped.push({ path, reason: "binary" });
      continue;
    }
    const text = buf.toString("utf8");
    if (hasSecretContent(text)) {
      skipped.push({ path, reason: "secret_content" });
      continue;
    }
    const language = languageOf(path);
    let lines = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
    if (text.length > 0 && !text.endsWith("\n")) lines++;
    files.push({ path, language, sizeBytes: buf.length, lineCount: lines, sha256: archiveSha256(buf) });
    if (language) {
      // Wall-clock and size budget: a hostile file may be slow to scan; it is skipped from the graph, never allowed to stall the worker.
      if (parseMs >= limits.maxParseMs || lines > limits.maxParseLines) {
        files.pop(); // not part of the graph: reported only in the skipped list
        skipped.push({ path, reason: "parse_budget" });
      } else {
        const t0 = Date.now();
        refsByFile.push({ path, language, refs: parseImports(language, text) });
        parseMs += Date.now() - t0;
      }
    }
    if (path === "go.mod" || path.endsWith("/go.mod")) {
      const mod = goModulePath(text);
      if (mod) goModules.set(path === "go.mod" ? "" : path.slice(0, -"/go.mod".length), mod);
    }
  }

  const fileSet = new Set(files.map((f) => f.path));
  const dirSet = new Set<string>();
  for (const f of files) for (const d of dirsOf(f.path)) dirSet.add(d);
  const ctx = { files: fileSet, dirs: dirSet, goModules };

  const edges: EdgeRec[] = [];
  let edgesTruncated = false;
  const externals = new Set<string>();
  let unresolved = 0;
  outer: for (const f of refsByFile) {
    for (const r of f.refs) {
      if (edges.length >= limits.maxEdges) {
        edgesTruncated = true;
        break outer;
      }
      const t = resolveImport(f.language, f.path, r.specifier, ctx);
      if (t.kind === "external") externals.add(t.name);
      if (t.kind === "unresolved") unresolved++;
      edges.push({
        from: f.path, line: r.line, specifier: r.specifier, snippet: r.snippet, language: f.language, toKind: t.kind,
        toPath: t.kind === "file" || t.kind === "directory" ? t.path : null, external: t.kind === "external" ? t.name : null,
      });
    }
  }

  const languages: Record<string, number> = {};
  for (const f of files) languages[f.language ?? "other"] = (languages[f.language ?? "other"] ?? 0) + 1;
  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  return {
    files, skipped, edges,
    stats: { files: files.length, skipped: skipped.length, edges: edges.length, edgesTruncated, externalPackages: externals.size, unresolvedImports: unresolved, languages, skippedByReason },
  };
}

/** Multi-row insert through one jsonb parameter (a handful of statements instead of one per row). */
async function insertRows(q: SqlExecutor, sql: string, extra: readonly unknown[], rows: readonly unknown[], chunk = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) await q.query(sql, [JSON.stringify(rows.slice(i, i + chunk)), ...extra]);
}

async function runOne(o: RepoImportOptions, imp: ImportRow): Promise<void> {
  const [up] = await o.db.query<{ body: Uint8Array }>("select body from repo_import_uploads where import_id=$1", [imp.id]);
  if (!up) throw new ImportFailure("IMPORT_FAILED", "The uploaded archive is no longer available");
  const limits = resolveLimits(imp.limits);
  const { entries } = openArchive(Buffer.from(up.body), limits);
  const a = analyzeEntries(entries, limits);
  const at = o.now();
  await o.db.tx(async (q) => {
    // Conditional on the row still being ours: a delete (or lost lease) during analysis writes nothing.
    const still = await q.query("select 1 as x from repo_imports where id=$1 and status='running' for update", [imp.id]);
    if (!still.length) return;
    const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, () => o.newId(prefix));
    const fileIds = ids("rfl", a.files.length);
    const scope = [imp.id, imp.account_id, imp.project_id];
    await insertRows(
      q,
      `insert into repo_files (id, import_id, account_id, project_id, path, language, size_bytes, line_count, sha256)
       select t.id, $2, $3, $4, t.path, t.language, t.size_bytes, t.line_count, t.sha256
       from jsonb_to_recordset($1::jsonb) as t(ord int, id text, path text, language text, size_bytes int, line_count int, sha256 text) order by t.ord`,
      scope,
      a.files.map((f, i) => ({ ord: i, id: fileIds[i], path: f.path, language: f.language, size_bytes: f.sizeBytes, line_count: f.lineCount, sha256: f.sha256 })),
    );
    await insertRows(
      q,
      "insert into repo_skipped (import_id, path, reason) select $2, t.path, t.reason from jsonb_to_recordset($1::jsonb) as t(path text, reason text)",
      [imp.id],
      a.skipped,
    );
    const edgeIds = ids("edg", a.edges.length);
    await insertRows(
      q,
      `insert into repo_edges (id, import_id, account_id, project_id, from_path, line, kind, specifier, to_kind, to_path, external_name, snippet, language)
       select t.id, $2, $3, $4, t.from_path, t.line, 'import', t.specifier, t.to_kind, t.to_path, t.external_name, t.snippet, t.language
       from jsonb_to_recordset($1::jsonb) as t(ord int, id text, from_path text, line int, specifier text, to_kind text, to_path text, external_name text, snippet text, language text) order by t.ord`,
      scope,
      a.edges.map((e, i) => ({ ord: i, id: edgeIds[i], from_path: e.from, line: e.line, specifier: e.specifier, to_kind: e.toKind, to_path: e.toPath, external_name: e.external, snippet: e.snippet, language: e.language })),
    );
    await q.query("delete from repo_import_uploads where import_id=$1", [imp.id]);
    await q.query("update repo_imports set status='succeeded', finished_at=$2, lease_until=null, stats=$3::jsonb where id=$1", [imp.id, at, JSON.stringify(a.stats)]);
    await q.query(
      "insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,$3,'repository.import_succeeded','repository_import',$4,$5::jsonb,$6)",
      [o.newId("aud"), imp.account_id, imp.created_by_user_id, imp.id, JSON.stringify({ projectId: imp.project_id, files: a.stats.files, skipped: a.stats.skipped, edges: a.stats.edges }), at],
    );
  });
}

async function claim(o: RepoImportOptions, at: Date): Promise<ImportRow | null> {
  const lease = new Date(at.getTime() + (o.leaseSeconds ?? 300) * 1000);
  const max = o.maxAttempts ?? 3;
  const rows = await o.db.query<ImportRow>(
    `update repo_imports set status='running', attempts=attempts+1, started_at=$1, lease_until=$2
     where id = (select id from repo_imports where attempts < $3 and (status='queued' or (status='running' and lease_until <= $1)) order by created_at, id limit 1)
       and attempts < $3 and (status='queued' or (status='running' and lease_until <= $1))
     returning id, account_id, project_id, created_by_user_id, limits, attempts`,
    [at, lease, max],
  );
  return rows[0] ?? null;
}

async function fail(o: RepoImportOptions, imp: ImportRow, code: string, message: string): Promise<void> {
  const at = o.now();
  await o.db.tx(async (q) => {
    const rows = await q.query("update repo_imports set status='failed', finished_at=$2, lease_until=null, error_code=$3, error_message=$4 where id=$1 and status='running' returning id", [imp.id, at, code, message]);
    await q.query("delete from repo_import_uploads where import_id=$1", [imp.id]);
    if (rows.length) {
      await q.query(
        "insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,$3,'repository.import_failed','repository_import',$4,$5::jsonb,$6)",
        [o.newId("aud"), imp.account_id, imp.created_by_user_id, imp.id, JSON.stringify({ projectId: imp.project_id, code }), at],
      );
    }
  });
}

/** Drains every runnable import once. Safe to call concurrently from several runners. */
export async function runRepositoryImports(o: RepoImportOptions): Promise<RepoImportReport> {
  const report: RepoImportReport = { succeeded: [], failed: [], retried: [] };
  const max = o.maxAttempts ?? 3;
  // Imports whose runner died on every attempt fail visibly and drop their stored archive.
  const lost = await o.db.query<{ id: string; account_id: string; project_id: string; created_by_user_id: string; limits: Partial<ImportLimits>; attempts: number }>(
    "select id, account_id, project_id, created_by_user_id, limits, attempts from repo_imports where status='running' and lease_until <= $1 and attempts >= $2",
    [o.now(), max],
  );
  for (const l of lost) await fail(o, l, "RUNNER_LOST", "The import did not finish; upload it again");
  for (;;) {
    const imp = await claim(o, o.now());
    if (!imp) break;
    try {
      await runOne(o, imp);
      report.succeeded.push(imp.id);
    } catch (e) {
      if (e instanceof ArchiveError) {
        await fail(o, imp, e.code, e.message);
        report.failed.push(imp.id);
      } else if (e instanceof ImportFailure) {
        await fail(o, imp, e.code, e.message);
        report.failed.push(imp.id);
      } else if (imp.attempts < max) {
        await o.db.query("update repo_imports set status='queued', lease_until=null where id=$1 and status='running'", [imp.id]);
        report.retried.push(imp.id);
      } else {
        await fail(o, imp, "IMPORT_FAILED", "The import failed unexpectedly");
        report.failed.push(imp.id);
      }
    }
  }
  return report;
}
