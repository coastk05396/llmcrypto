/** Projects: the isolation unit for keys, usage and memory. Create is owner/admin; every role can list (names only). */
import { Hono } from "hono";
import { CreateProjectRequest, Project, ProjectList, ProjectListQuery } from "@llmcrypto/contracts";
import { canManageProjects } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession } from "../auth/session";
import type { AppConfig } from "../config";
import { randomId } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db, Queryable } from "../db";
import { ApiError, parseBody, parseWith, type AppEnv } from "../http";

export interface ProjectDeps {
  db: Db;
  config: AppConfig;
}
interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
}
const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString() });

/** Account-scoped lookup; another account's id is indistinguishable from a missing one (404). */
export async function requireProject(q: Queryable, accountId: string, id: string): Promise<ProjectRow> {
  const [r] = await q.query<ProjectRow>("select id, name, created_at from projects where id=$1 and account_id=$2", [id, accountId]);
  if (!r) throw new ApiError("NOT_FOUND", "Project not found");
  return r;
}

export function projectRoutes({ db, config }: ProjectDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession(db, config));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/", async (c) => {
    const auth = c.get("auth");
    if (!canManageProjects(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const body = await parseBody(c, CreateProjectRequest);
    const now = config.now();
    const id = randomId("prj");
    const row = await db.tx(async (q) => {
      await q.query("select id from accounts where id=$1 for update", [auth.accountId]); // serialises the duplicate-name check
      const [dup] = await q.query("select 1 as x from projects where account_id=$1 and lower(name)=lower($2)", [auth.accountId, body.name]);
      if (dup) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "name", message: "A project with this name already exists" }]);
      await q.query("insert into projects (id, account_id, name, created_at) values ($1,$2,$3,$4)", [id, auth.accountId, body.name, now]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "project.created", targetType: "project", targetId: id, requestId: c.get("requestId"), at: now });
      return { id, name: body.name, created_at: now };
    });
    return c.json(Project.parse(toProject(row)), 201);
  });

  app.get("/", async (c) => {
    const auth = c.get("auth");
    const q = parseWith(ProjectListQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<ProjectRow>(
      `select id, name, created_at from projects where account_id=$1 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text))
       order by created_at, id limit $4`,
      [auth.accountId, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(ProjectList.parse({ items: page.map(toProject), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }));
  });

  app.get("/:id", async (c) => c.json(Project.parse(toProject(await requireProject(db, c.get("auth").accountId, c.req.param("id"))))));

  return app;
}
