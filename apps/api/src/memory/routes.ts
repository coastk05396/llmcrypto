/**
 * Project memory: explicit, versioned notes. Mounted under /api/projects.
 * - Nothing is stored without storageConsent=true on the request; nothing is ingested automatically.
 * - Every query is scoped by (account, project); a project of another account is 404.
 * - Edits are compare-and-set on `version` (409 VERSION_CONFLICT); delete is a real delete.
 * - Retention: a note expires `retentionDays` after its last edit; expired notes are invisible and never injected, and
 *   the worker (apps/worker/src/memory-retention.ts) removes them.
 * - Roles: owner/admin/member use notes; billing cannot. Retention settings are owner/admin.
 * - Audit entries carry ids and lengths only, never note text.
 */
import { Hono } from "hono";
import {
  CreateMemoryRequest, Memory, MemoryExport, MemoryList, MemoryListQuery, MemorySettings, MemoryUsageList, MemoryUsageQuery,
  UpdateMemoryRequest, UpdateMemorySettingsRequest, type MemoryUsage,
} from "@llmcrypto/contracts";
import { canManageProjects, canUseMemory, memoryExpiry } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession, type AuthContext } from "../auth/session";
import type { AppConfig } from "../config";
import { randomId } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db, Queryable } from "../db";
import { ApiError, parseBody, parseWith, type AppEnv } from "../http";
import { requireProject } from "../projects/routes";

export interface MemoryDeps {
  db: Db;
  config: AppConfig;
}

/** Notes per project. A bound keeps the injected context and the export reviewable. */
export const MAX_NOTES_PER_PROJECT = 200;
const EXPORT_USAGE_LIMIT = 1000;

interface NoteRow {
  id: string;
  seq: string;
  project_id: string;
  text: string;
  version: number;
  inject: boolean;
  created_at: Date;
  updated_at: Date;
}
// NOTE: `seq` is aliased to text in the select list, and a bare `order by seq` resolves to that alias (text order: 10 < 2).
// Every ORDER BY below therefore qualifies the column with its table.
const COLS = "id, seq::text as seq, project_id, text, version, inject, created_at, updated_at";
/** Unexpired notes only: $RET is the retention-days parameter, $NOW the clock. */
const alive = (ret: string, now: string): string => `(${ret}::int is null or updated_at + make_interval(days => ${ret}::int) > ${now}::timestamptz)`;

const toMemory = (r: NoteRow, retentionDays: number | null): Memory => ({
  id: r.id, projectId: r.project_id, text: r.text, version: r.version, inject: r.inject,
  expiresAt: memoryExpiry(r.updated_at, retentionDays)?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

async function retentionOf(q: Queryable, projectId: string): Promise<number | null> {
  const [s] = await q.query<{ retention_days: number | null }>("select retention_days from project_memory_settings where project_id=$1", [projectId]);
  return s?.retention_days ?? null;
}
async function settingsOf(q: Queryable, projectId: string): Promise<MemorySettings> {
  const [s] = await q.query<{ retention_days: number | null; version: number; updated_at: Date }>("select retention_days, version, updated_at from project_memory_settings where project_id=$1", [projectId]);
  return { projectId, retentionDays: s?.retention_days ?? null, version: s?.version ?? 0, updatedAt: s ? s.updated_at.toISOString() : null };
}
const toUsage = (r: { id: string; memory_id: string; version: number; request_id: string; status: "injected" | "skipped"; reason: string | null; created_at: Date }): MemoryUsage => ({
  id: r.id, memoryId: r.memory_id, version: r.version, requestId: r.request_id, status: r.status, reason: r.reason, createdAt: r.created_at.toISOString(),
});
/** Only owner/admin may mark a note for injection into gateway requests (members can write notes, not put text into every request). */
const needInjectRight = (auth: AuthContext, inject: boolean | undefined): void => {
  if (inject === true && !canManageProjects(auth.role)) throw new ApiError("FORBIDDEN", "Only an owner or admin can mark a note for injection");
};
const needUse = (auth: AuthContext): void => {
  if (!canUseMemory(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
};

export function memoryRoutes({ db, config }: MemoryDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession(db, config));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/:id/memories", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const body = await parseBody(c, CreateMemoryRequest);
    needInjectRight(auth, body.inject);
    if (body.expectedVersion !== undefined && body.expectedVersion !== 0) throw new ApiError("VERSION_CONFLICT", "A new note starts at version 1; expectedVersion must be 0 or omitted");
    const now = config.now();
    const id = randomId("mem");
    const out = await db.tx(async (q) => {
      await q.query("select id from projects where id=$1 for update", [projectId]); // serialises the per-project cap
      const ret = await retentionOf(q, projectId);
      const [{ n } = { n: "0" }] = await q.query<{ n: string }>(`select count(*)::text n from project_memories where project_id=$1 and ${alive("$2", "$3")}`, [projectId, ret, now]);
      if (Number(n) >= MAX_NOTES_PER_PROJECT) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "(body)", message: `A project holds at most ${MAX_NOTES_PER_PROJECT} notes` }]);
      await q.query(
        "insert into project_memories (id, account_id, project_id, text, version, inject, created_by_user_id, updated_by_user_id, created_at, updated_at) values ($1,$2,$3,$4,1,$5,$6,$6,$7,$7)",
        [id, auth.accountId, projectId, body.text, body.inject ?? false, auth.userId, now],
      );
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "memory.created", targetType: "project_memory", targetId: id, requestId: c.get("requestId"), at: now, metadata: { projectId, length: body.text.length, inject: body.inject ?? false } });
      return toMemory({ id, seq: "0", project_id: projectId, text: body.text, version: 1, inject: body.inject ?? false, created_at: now, updated_at: now }, ret);
    });
    return c.json(Memory.parse(out), 201);
  });

  app.get("/:id/memories", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const q = parseWith(MemoryListQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const ret = await retentionOf(db, projectId);
    const rows = await db.query<NoteRow>(
      `select ${COLS} from project_memories where project_id=$1 and account_id=$2 and ${alive("$3", "$4")}
         and ($5::timestamptz is null or (created_at, seq) > ($5::timestamptz, $6::bigint)) order by created_at, project_memories.seq limit $7`,
      [projectId, auth.accountId, ret, config.now(), after?.[0] ?? null, after?.[1] ?? "0", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(MemoryList.parse({ items: page.map((r) => toMemory(r, ret)), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.seq) : null }));
  });

  // Static sub-paths first so they are not read as a memory id.
  app.get("/:id/memories/export", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const now = config.now();
    const body = await db.tx(async (q) => {
      const settings = await settingsOf(q, projectId);
      const notes = await q.query<NoteRow>(`select ${COLS} from project_memories where project_id=$1 and account_id=$2 and ${alive("$3", "$4")} order by created_at, project_memories.seq`, [projectId, auth.accountId, settings.retentionDays, now]);
      const usage = await q.query<{ id: string; seq: string; memory_id: string; version: number; request_id: string; status: "injected" | "skipped"; reason: string | null; created_at: Date }>(
        "select id, seq::text as seq, memory_id, version, request_id, status, reason, created_at from memory_usage where project_id=$1 and account_id=$2 order by created_at, memory_usage.seq limit $3",
        [projectId, auth.accountId, EXPORT_USAGE_LIMIT + 1],
      );
      return MemoryExport.parse({
        projectId, exportedAt: now.toISOString(), settings, notes: notes.map((r) => toMemory(r, settings.retentionDays)),
        usage: usage.slice(0, EXPORT_USAGE_LIMIT).map(toUsage), usageTruncated: usage.length > EXPORT_USAGE_LIMIT, noteCount: String(notes.length),
      });
    });
    await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "memory.exported", targetType: "project", targetId: projectId, requestId: c.get("requestId"), at: now, metadata: { notes: body.notes.length } });
    return c.body(JSON.stringify(body), 200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="memory-${projectId}.json"` });
  });

  app.get("/:id/memories/usage", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const q = parseWith(MemoryUsageQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<{ id: string; seq: string; memory_id: string; version: number; request_id: string; status: "injected" | "skipped"; reason: string | null; created_at: Date }>(
      `select id, seq::text as seq, memory_id, version, request_id, status, reason, created_at from memory_usage
        where project_id=$1 and account_id=$2 and ($3::text is null or memory_id=$3) and ($4::timestamptz is null or (created_at, seq) < ($4::timestamptz, $5::bigint))
        order by created_at desc, memory_usage.seq desc limit $6`,
      [projectId, auth.accountId, q.memoryId ?? null, after?.[0] ?? null, after?.[1] ?? "0", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(MemoryUsageList.parse({ items: page.map(toUsage), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.seq) : null }));
  });

  app.get("/:id/memories/:memoryId", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const ret = await retentionOf(db, projectId);
    const [r] = await db.query<NoteRow>(`select ${COLS} from project_memories where id=$1 and project_id=$2 and account_id=$3 and ${alive("$4", "$5")}`, [c.req.param("memoryId"), projectId, auth.accountId, ret, config.now()]);
    if (!r) throw new ApiError("NOT_FOUND", "Note not found");
    return c.json(Memory.parse(toMemory(r, ret)));
  });

  app.put("/:id/memories/:memoryId", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    const memoryId = c.req.param("memoryId");
    await requireProject(db, auth.accountId, projectId);
    const body = await parseBody(c, UpdateMemoryRequest);
    needInjectRight(auth, body.inject);
    const now = config.now();
    const out = await db.tx(async (q) => {
      const ret = await retentionOf(q, projectId);
      // Editing the text of a note that is injected into requests is itself an injection right.
      const [cur0] = await q.query<{ inject: boolean }>("select inject from project_memories where id=$1 and project_id=$2 and account_id=$3", [memoryId, projectId, auth.accountId]);
      if (cur0?.inject) needInjectRight(auth, true);
      // Compare-and-set: exactly one of two concurrent edits at the same version wins.
      const rows = await q.query<NoteRow>(
        `update project_memories set text=$4, version=version+1, inject=coalesce($5, inject), updated_by_user_id=$6, updated_at=$7
          where id=$1 and project_id=$2 and account_id=$3 and version=$8 and ${alive("$9", "$7")} returning ${COLS}`,
        [memoryId, projectId, auth.accountId, body.text, body.inject ?? null, auth.userId, now, body.expectedVersion, ret],
      );
      const r = rows[0];
      if (!r) {
        const [cur] = await q.query<{ version: number }>(`select version from project_memories where id=$1 and project_id=$2 and account_id=$3 and ${alive("$4", "$5")}`, [memoryId, projectId, auth.accountId, ret, now]);
        if (!cur) throw new ApiError("NOT_FOUND", "Note not found");
        throw new ApiError("VERSION_CONFLICT", `Note is at version ${cur.version}; reload and retry`);
      }
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "memory.updated", targetType: "project_memory", targetId: memoryId, requestId: c.get("requestId"), at: now, metadata: { projectId, version: r.version, length: body.text.length, inject: r.inject } });
      return toMemory(r, ret);
    });
    return c.json(Memory.parse(out));
  });

  app.delete("/:id/memories/:memoryId", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    const memoryId = c.req.param("memoryId");
    await requireProject(db, auth.accountId, projectId);
    const now = config.now();
    await db.tx(async (q) => {
      const rows = await q.query("delete from project_memories where id=$1 and project_id=$2 and account_id=$3 returning id", [memoryId, projectId, auth.accountId]);
      if (!rows.length) throw new ApiError("NOT_FOUND", "Note not found");
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "memory.deleted", targetType: "project_memory", targetId: memoryId, requestId: c.get("requestId"), at: now, metadata: { projectId } });
    });
    return c.body(null, 204);
  });

  app.get("/:id/memory-settings", async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    return c.json(MemorySettings.parse(await settingsOf(db, projectId)));
  });

  app.put("/:id/memory-settings", async (c) => {
    const auth = c.get("auth");
    if (!canManageProjects(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const projectId = c.req.param("id");
    await requireProject(db, auth.accountId, projectId);
    const body = await parseBody(c, UpdateMemorySettingsRequest);
    const now = config.now();
    const out = await db.tx(async (q) => {
      const rows =
        body.expectedVersion === 0
          ? await q.query("insert into project_memory_settings (project_id, account_id, retention_days, version, updated_by_user_id, updated_at) values ($1,$2,$3,1,$4,$5) on conflict (project_id) do nothing returning project_id", [projectId, auth.accountId, body.retentionDays, auth.userId, now])
          : await q.query("update project_memory_settings set retention_days=$3, version=version+1, updated_by_user_id=$4, updated_at=$5 where project_id=$1 and account_id=$2 and version=$6 returning project_id", [projectId, auth.accountId, body.retentionDays, auth.userId, now, body.expectedVersion]);
      if (!rows.length) throw new ApiError("VERSION_CONFLICT", "Retention settings changed; reload and retry");
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "memory.retention_updated", targetType: "project", targetId: projectId, requestId: c.get("requestId"), at: now, metadata: { retentionDays: body.retentionDays } });
      return settingsOf(q, projectId);
    });
    return c.json(MemorySettings.parse(out));
  });

  return app;
}
