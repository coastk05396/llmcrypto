/**
 * Repository graph (BETA, FEATURE_REPOSITORY_GRAPH). Mounted under /api/projects.
 * - Upload is the raw archive as the request body; it is only stored and queued here. Reading it (and every safety check on
 *   its contents) happens in the worker (apps/worker/src/repository-import.ts). Nothing is extracted, executed or fetched.
 * - Every query is scoped by (account, project, import); another project's or account's id is a 404.
 * - Roles: owner/admin/member use it; billing cannot. Delete: owner/admin or the uploader. Delete is a real delete (cascade).
 * - Audit entries carry ids and counts only, never paths or file names.
 */
import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  RepositoryEdgeList, RepositoryEdgeQuery, RepositoryExport, RepositoryFile, RepositoryFileList, RepositoryFileQuery, RepositoryGraph,
  RepositoryGraphQuery, RepositoryImport, RepositoryImportAccepted, RepositoryImportList, RepositoryImportListQuery, type RepositoryEdge, type RepositoryLanguage,
} from "@llmcrypto/contracts";
import { canManageProjects, canUseMemory } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession, type AuthContext } from "../auth/session";
import { decodeSeq, encodeSeq, payloadHash, readBodyLimited, requireFeature, runIdempotent } from "../beta";
import type { AppConfig } from "../config";
import { randomId } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db, Queryable } from "../db";
import { ApiError, parseWith, type AppEnv, type Ctx } from "../http";
import { requireProject } from "../projects/routes";

export interface RepositoryDeps {
  db: Db;
  config: AppConfig;
}

interface ImportRow {
  id: string;
  project_id: string;
  name: string;
  format: "zip" | "tar.gz";
  upload_bytes: string;
  status: "queued" | "running" | "succeeded" | "failed";
  limits: RepositoryImport["limits"];
  stats: RepositoryImport["stats"];
  error_code: string | null;
  error_message: string | null;
  created_by_user_id: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}
const COLS = "id, project_id, name, format, upload_bytes::text as upload_bytes, status, limits, stats, error_code, error_message, created_by_user_id, created_at, started_at, finished_at";

const toImport = (r: ImportRow): RepositoryImport =>
  RepositoryImport.parse({
    id: r.id, projectId: r.project_id, name: r.name, format: r.format, status: r.status, uploadBytes: r.upload_bytes, stats: r.stats ?? null,
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? "Import failed" } : null, limits: r.limits,
    createdAt: r.created_at.toISOString(), startedAt: r.started_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null,
  });

const needUse = (auth: AuthContext): void => {
  if (!canUseMemory(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
};

/** Magic-byte format check. The worker re-validates; this only refuses obvious non-archives before storing them. */
function formatOf(b: Buffer): "zip" | "tar.gz" | null {
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return "zip";
  if (b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08) return "tar.gz";
  return null;
}

const nodeOf = (path: string, depth: number): string => path.split("/").slice(0, -1).slice(0, depth).join("/") || ".";

interface EdgeRow {
  id: string;
  seq_text: string;
  from_path: string;
  line: number;
  specifier: string;
  to_kind: "file" | "directory" | "external" | "unresolved";
  to_path: string | null;
  external_name: string | null;
  snippet: string;
  language: RepositoryLanguage;
}
const EDGE_COLS = "id, seq::text as seq_text, from_path, line, specifier, to_kind, to_path, external_name, snippet, language";
const toEdge = (r: EdgeRow): RepositoryEdge => ({
  id: r.id, from: r.from_path, line: r.line, kind: "import", specifier: r.specifier,
  to: { kind: r.to_kind, path: r.to_path, name: r.external_name }, snippet: r.snippet, language: r.language,
});

export function repositoryRoutes({ db, config }: RepositoryDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Per-route (not app.use("*")): this app is mounted at /projects next to routes of other areas, and a wildcard middleware here
  // would also gate routes registered after it (e.g. the designs routes) behind this feature flag.
  const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  };
  const gate = [requireSession(db, config), requireFeature(config, "repositoryGraph"), noStore] as const;
  const lim = config.repository.limits;

  async function load(q: Queryable, auth: AuthContext, projectId: string, importId: string): Promise<ImportRow> {
    const [r] = await q.query<ImportRow>(`select ${COLS} from repo_imports where id=$1 and project_id=$2 and account_id=$3`, [importId, projectId, auth.accountId]);
    if (!r) throw new ApiError("NOT_FOUND", "Import not found");
    return r;
  }
  const scoped = async (c: Ctx): Promise<{ auth: AuthContext; projectId: string; importId: string; row: ImportRow }> => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id") ?? "";
    await requireProject(db, auth.accountId, projectId);
    const importId = c.req.param("importId") ?? "";
    return { auth, projectId, importId, row: await load(db, auth, projectId, importId) };
  };

  app.post("/:id/repository-imports", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const name = (c.req.query("name") ?? "repository").trim();
    // eslint-disable-next-line no-control-regex -- control characters in a label are rejected on purpose
    if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "name", message: "must be 1-100 printable characters" }]);
    const body = await readBodyLimited(c, lim.maxArchiveBytes);
    const format = formatOf(body);
    if (!format) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "body", message: "must be a ZIP or tar.gz archive" }]);
    const sha = createHash("sha256").update(body).digest("hex");
    const now = config.now();
    return runIdempotent(
      c,
      { db, config, accountId: auth.accountId, operation: "createRepositoryImport", hash: payloadHash({ projectId, name, sha }) },
      async (q) => {
        await q.query("select id from projects where id=$1 for update", [projectId]); // serialises the per-project caps
        const [counts] = await q.query<{ active: string; total: string }>(
          "select count(*) filter (where status in ('queued','running'))::text as active, count(*)::text as total from repo_imports where project_id=$1",
          [projectId],
        );
        if (Number(counts?.active ?? 0) >= config.repository.maxActivePerProject) throw new ApiError("RATE_LIMITED", "Too many imports in progress for this project; wait for one to finish", undefined, { "Retry-After": "30" });
        if (Number(counts?.total ?? 0) >= config.repository.maxRetainedPerProject) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "(body)", message: `A project keeps at most ${config.repository.maxRetainedPerProject} imports; delete one first` }]);
        const id = randomId("rim");
        await q.query(
          `insert into repo_imports (id, account_id, project_id, created_by_user_id, name, format, upload_bytes, upload_sha256, status, limits, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9::jsonb,$10)`,
          [id, auth.accountId, projectId, auth.userId, name, format, body.length, sha, JSON.stringify(lim), now],
        );
        await q.query("insert into repo_import_uploads (import_id, body) values ($1,$2)", [id, body]);
        await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "repository.import_requested", targetType: "repository_import", targetId: id, requestId: c.get("requestId"), at: now, metadata: { projectId, format, bytes: body.length } });
        return { status: 202, body: RepositoryImportAccepted.parse({ importId: id, status: "queued" }), result: { importId: id } };
      },
      async (result) => {
        const importId = String(result["importId"] ?? "");
        const [row] = await db.query<ImportRow>(`select ${COLS} from repo_imports where id=$1 and account_id=$2`, [importId, auth.accountId]);
        if (!row) throw new ApiError("NOT_FOUND", "The original import no longer exists");
        return { status: 202, body: RepositoryImportAccepted.parse({ importId, status: row.status }) };
      },
    );
  });

  app.get("/:id/repository-imports", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const q = parseWith(RepositoryImportListQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<ImportRow>(
      `select ${COLS} from repo_imports where project_id=$1 and account_id=$2 and ($3::timestamptz is null or (created_at, id) > ($3::timestamptz, $4::text)) order by created_at, id limit $5`,
      [projectId, auth.accountId, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(RepositoryImportList.parse({ items: page.map(toImport), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }));
  });

  app.get("/:id/repository-imports/:importId", ...gate, async (c) => c.json(toImport((await scoped(c)).row)));

  app.delete("/:id/repository-imports/:importId", ...gate, async (c) => {
    const { auth, projectId, row } = await scoped(c);
    if (!canManageProjects(auth.role) && row.created_by_user_id !== auth.userId) throw new ApiError("FORBIDDEN", "Only an owner, admin or the uploader can delete an import");
    const now = config.now();
    await db.tx(async (q) => {
      const [n] = await q.query<{ files: string; edges: string }>(
        "select (select count(*) from repo_files where import_id=$1)::text as files, (select count(*) from repo_edges where import_id=$1)::text as edges",
        [row.id],
      );
      // One DELETE removes the import, its stored archive (if still queued), files, skipped list and edges (ON DELETE CASCADE).
      await q.query("delete from repo_imports where id=$1 and project_id=$2 and account_id=$3", [row.id, projectId, auth.accountId]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "repository.deleted", targetType: "repository_import", targetId: row.id, requestId: c.get("requestId"), at: now, metadata: { projectId, files: Number(n?.files ?? 0), edges: Number(n?.edges ?? 0) } });
    });
    return c.body(null, 204);
  });

  app.get("/:id/repository-imports/:importId/files", ...gate, async (c) => {
    const { auth, row } = await scoped(c);
    const q = parseWith(RepositoryFileQuery, c.req.query());
    const after = q.cursor ? decodeSeq(q.cursor) : "0";
    const rows = await db.query<{ seq: string; path: string; language: RepositoryLanguage | null; size_bytes: number; line_count: number; sha256: string; outgoing: string; incoming: string }>(
      `select f.seq::text as seq, f.path, f.language, f.size_bytes, f.line_count, f.sha256,
              (select count(*) from repo_edges e where e.import_id = f.import_id and e.from_path = f.path)::text as outgoing,
              (select count(*) from repo_edges e where e.import_id = f.import_id and e.to_path = f.path)::text as incoming
       from repo_files f where f.import_id=$1 and f.account_id=$2 and f.seq > $3::bigint and ($4::text is null or left(f.path, length($4)) = $4)
       order by f.seq limit $5`,
      [row.id, auth.accountId, after, q.pathPrefix ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(RepositoryFileList.parse({
      items: page.map((r) => ({ path: r.path, language: r.language, sizeBytes: r.size_bytes, lineCount: r.line_count, sha256: r.sha256, outgoing: Number(r.outgoing), incoming: Number(r.incoming) })),
      nextCursor: rows.length > q.limit && last ? encodeSeq(last.seq) : null,
    }));
  });

  app.get("/:id/repository-imports/:importId/edges", ...gate, async (c) => {
    const { auth, row } = await scoped(c);
    const q = parseWith(RepositoryEdgeQuery, c.req.query());
    const after = q.cursor ? decodeSeq(q.cursor) : "0";
    const rows = await db.query<EdgeRow>(
      `select ${EDGE_COLS} from repo_edges where import_id=$1 and account_id=$2 and seq > $3::bigint
         and ($4::text is null or from_path=$4) and ($5::text is null or to_path=$5) and ($6::text is null or to_kind=$6) order by seq limit $7`,
      [row.id, auth.accountId, after, q.from ?? null, q.to ?? null, q.toKind ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(RepositoryEdgeList.parse({ items: page.map(toEdge), nextCursor: rows.length > q.limit && last ? encodeSeq(last.seq_text) : null }));
  });

  app.get("/:id/repository-imports/:importId/graph", ...gate, async (c) => {
    const { auth, row } = await scoped(c);
    const { depth } = parseWith(RepositoryGraphQuery, c.req.query());
    if (row.status !== "succeeded") throw new ApiError("NOT_FOUND", "The graph is available once the import has succeeded");
    const files = await db.query<{ path: string; language: string | null }>("select path, language from repo_files where import_id=$1 and account_id=$2", [row.id, auth.accountId]);
    const edges = await db.query<{ from_path: string; line: number; to_kind: string; to_path: string | null; external_name: string | null }>(
      "select from_path, line, to_kind, to_path, external_name from repo_edges where import_id=$1 and account_id=$2 order by seq",
      [row.id, auth.accountId],
    );
    const nodes = new Map<string, { files: number; languages: Record<string, number> }>();
    for (const f of files) {
      const n = nodes.get(nodeOf(f.path, depth)) ?? { files: 0, languages: {} };
      n.files++;
      n.languages[f.language ?? "other"] = (n.languages[f.language ?? "other"] ?? 0) + 1;
      nodes.set(nodeOf(f.path, depth), n);
    }
    const rolled = new Map<string, { from: string; to: string; count: number; evidence: { path: string; line: number }[] }>();
    const ext = new Map<string, number>();
    for (const e of edges) {
      if (e.to_kind === "external" && e.external_name) ext.set(e.external_name, (ext.get(e.external_name) ?? 0) + 1);
      if ((e.to_kind !== "file" && e.to_kind !== "directory") || !e.to_path) continue;
      const from = nodeOf(e.from_path, depth);
      const to = e.to_kind === "directory" ? nodeOf(`${e.to_path}/_`, depth) : nodeOf(e.to_path, depth);
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      const cur = rolled.get(key) ?? { from, to, count: 0, evidence: [] };
      cur.count++;
      if (cur.evidence.length < 3) cur.evidence.push({ path: e.from_path, line: e.line });
      rolled.set(key, cur);
    }
    return c.json(RepositoryGraph.parse({
      importId: row.id, depth,
      nodes: [...nodes].sort(([a], [b]) => a.localeCompare(b)).map(([path, n]) => ({ path, ...n })),
      edges: [...rolled.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
      external: [...ext].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    }));
  });

  app.get("/:id/repository-imports/:importId/export", ...gate, async (c) => {
    const { auth, projectId, row } = await scoped(c);
    if (row.status !== "succeeded") throw new ApiError("NOT_FOUND", "The export is available once the import has succeeded");
    const now = config.now();
    const body = await db.tx(async (q) => {
      const files = await q.query<{ path: string; language: RepositoryLanguage | null; size_bytes: number; line_count: number; sha256: string; outgoing: string; incoming: string }>(
        `select f.path, f.language, f.size_bytes, f.line_count, f.sha256,
                (select count(*) from repo_edges e where e.import_id = f.import_id and e.from_path = f.path)::text as outgoing,
                (select count(*) from repo_edges e where e.import_id = f.import_id and e.to_path = f.path)::text as incoming
         from repo_files f where f.import_id=$1 and f.account_id=$2 order by f.seq`,
        [row.id, auth.accountId],
      );
      const skipped = await q.query<{ path: string; reason: string }>("select path, reason from repo_skipped where import_id=$1 order by path", [row.id]);
      const edges = await q.query<EdgeRow>(`select ${EDGE_COLS} from repo_edges where import_id=$1 and account_id=$2 order by seq`, [row.id, auth.accountId]);
      return RepositoryExport.parse({
        exportedAt: now.toISOString(), label: "derived by static analysis; not executed, not verified", import: toImport(row),
        files: files.map((r) => RepositoryFile.parse({ path: r.path, language: r.language, sizeBytes: r.size_bytes, lineCount: r.line_count, sha256: r.sha256, outgoing: Number(r.outgoing), incoming: Number(r.incoming) })),
        skipped, edges: edges.map(toEdge),
      });
    });
    await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "repository.exported", targetType: "repository_import", targetId: row.id, requestId: c.get("requestId"), at: now, metadata: { projectId, files: body.files.length, edges: body.edges.length } });
    return c.body(JSON.stringify(body), 200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="repository-${row.id}.json"` });
  });

  return app;
}
