/**
 * Design beta (BETA, FEATURE_DESIGN_BETA): brief -> metered proposal -> revisions -> exportable artifact.
 * - Creating a design / revision only QUEUES a generation (apps/worker/src/design-generation.ts runs it through the gateway
 *   reservation path). The response carries `maxCostMicrousd`, a quote; the real hold, charge and release are visible on the
 *   revision's `cost`. A quote above the available balance is refused up front (409 INSUFFICIENT_FUNDS) and creates nothing.
 * - Everything is scoped by account; a design of another account (or project) is a 404. Roles: owner/admin/member; billing cannot.
 * - Output is untrusted text: it is validated when generated, labelled AI-generated on every surface, and exported as inert
 *   markdown/JSON for a person to read. Nothing here executes, renders as HTML, or deploys anything.
 * - Audit entries carry ids, counts and codes, never the brief or the document.
 */
import { Hono } from "hono";
import {
  CreateDesignRequest, CreateDesignRevisionRequest, Design, DesignDocument, DesignExportQuery, DesignList, DesignListQuery, DesignRevisionAccepted,
  type DesignRevision,
} from "@llmcrypto/contracts";
import {
  accountBalance, buildDesignMessages, canManageProjects, canUseMemory, designExportJson, designExportMarkdown, getActiveRates, inputTokenUpperBound,
  reservationUpperBound,
} from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession, type AuthContext } from "../auth/session";
import { payloadHash, requireFeature, runIdempotent } from "../beta";
import { findCatalogModel } from "../catalog/routes";
import type { AppConfig } from "../config";
import { randomId } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db, Queryable } from "../db";
import { ApiError, parseBody, parseWith, type AppEnv, type Ctx } from "../http";
import { ensureSamplePriceVersion } from "../gateway/prices";
import { requireProject } from "../projects/routes";

export interface DesignDeps {
  db: Db;
  config: AppConfig;
}

interface DesignRow {
  id: string;
  project_id: string;
  created_by_user_id: string;
  title: string;
  brief: string;
  model: string;
  created_at: Date;
  updated_at: Date;
}
interface RevisionRow {
  id: string;
  number: number;
  kind: "proposal" | "revision";
  instruction: string | null;
  status: DesignRevision["status"];
  model: string;
  request_id: string | null;
  max_cost_microusd: string;
  document: unknown;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  finished_at: Date | null;
  req_state: string | null;
  req_outcome: string | null;
  res_status: string | null;
  charge: string | null;
}
const REV_SELECT = `select r.id, r.number, r.kind, r.instruction, r.status, r.model, r.request_id, r.max_cost_microusd::text as max_cost_microusd, r.document,
       r.failure_code, r.failure_message, r.created_at, r.finished_at, q.state as req_state, q.outcome as req_outcome, rs.status as res_status, u.charge_microusd::text as charge
  from design_revisions r left join requests q on q.id = r.request_id left join reservations rs on rs.request_id = r.request_id left join usage_records u on u.request_id = r.request_id`;

function costOf(r: RevisionRow): DesignRevision["cost"] {
  const base = { maxMicrousd: r.max_cost_microusd, requestId: r.request_id };
  if (!r.request_id || !r.req_state) return { state: "none", chargedMicrousd: null, ...base };
  if (r.req_state === "USAGE_PENDING") return { state: "pending", chargedMicrousd: null, ...base };
  if (r.req_state === "SETTLED") {
    if (r.res_status === "settled") return { state: "charged", chargedMicrousd: r.charge ?? "0", ...base };
    return { state: "released", chargedMicrousd: "0", ...base };
  }
  if (r.req_state === "FAILED" || r.req_state === "CANCELLED") return { state: "released", chargedMicrousd: "0", ...base };
  return { state: "reserved", chargedMicrousd: null, ...base };
}
const toRevision = (r: RevisionRow): DesignRevision => ({
  number: r.number, kind: r.kind, instruction: r.instruction, status: r.status, model: r.model, aiGenerated: true,
  document: r.status === "succeeded" ? DesignDocument.parse(r.document) : null,
  failure: r.failure_code ? { code: r.failure_code, message: r.failure_message ?? "Generation failed" } : null,
  cost: costOf(r), createdAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});
const totalCharged = (revs: DesignRevision[]): string => revs.reduce((s, r) => s + (r.cost.state === "charged" ? BigInt(r.cost.chargedMicrousd ?? "0") : 0n), 0n).toString();

const needUse = (auth: AuthContext): void => {
  if (!canUseMemory(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
};

export function designRoutes({ db, config }: DesignDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const gate = [requireSession(db, config), requireFeature(config, "designBeta")] as const;
  const dc = config.design;
  let pricesReady: Promise<void> | undefined;
  const ensurePrices = (): Promise<void> => (pricesReady ??= ensureSamplePriceVersion(db, config.now()).catch((e: unknown) => {
    pricesReady = undefined;
    throw e;
  }));

  /** Upper-bound quote for a generation and an up-front funds check. Writes nothing. */
  async function quote(auth: AuthContext, model: string, texts: string[]): Promise<bigint> {
    await ensurePrices();
    const rates = await getActiveRates(db, model, config.now());
    if (!rates) throw new ApiError("UNAVAILABLE", "No price is effective for this model");
    const max = reservationUpperBound(inputTokenUpperBound(texts), BigInt(dc.maxOutputTokens), rates);
    const bal = await accountBalance(db, auth.accountId);
    if (bal.available < max) throw new ApiError("INSUFFICIENT_FUNDS", `This generation can cost up to ${max.toString()} micro-USD; available credit is ${bal.available.toString()}`);
    return max;
  }

  async function loadDesign(q: Queryable, auth: AuthContext, id: string): Promise<DesignRow> {
    const [d] = await q.query<DesignRow>("select id, project_id, created_by_user_id, title, brief, model, created_at, updated_at from designs where id=$1 and account_id=$2", [id, auth.accountId]);
    if (!d) throw new ApiError("NOT_FOUND", "Design not found");
    return d;
  }
  const revisionsOf = async (q: Queryable, designId: string): Promise<DesignRevision[]> =>
    (await q.query<RevisionRow>(`${REV_SELECT} where r.design_id=$1 order by r.number`, [designId])).map(toRevision);

  app.post("/projects/:id/designs", ...gate, async (c: Ctx) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id") ?? "";
    await requireProject(db, auth.accountId, projectId);
    const body = await parseBody(c, CreateDesignRequest);
    const model = body.model ?? dc.model;
    const cat = findCatalogModel(model);
    if (!cat || !cat.protocols.includes("openai_chat")) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "model", message: "must be a catalog model served on the chat protocol" }]);
    const now = config.now();
    return runIdempotent<bigint>(
      c,
      { db, config, accountId: auth.accountId, operation: "createDesign", hash: payloadHash({ projectId, ...body, model }) },
      async (q, max) => {
        await q.query("select id from projects where id=$1 for update", [projectId]);
        const [n] = await q.query<{ per_project: string; active: string }>(
          `select (select count(*) from designs where project_id=$1)::text as per_project,
                  (select count(*) from design_revisions where account_id=$2 and status in ('queued','generating'))::text as active`,
          [projectId, auth.accountId],
        );
        if (Number(n?.per_project ?? 0) >= dc.maxDesignsPerProject) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "(body)", message: `A project holds at most ${dc.maxDesignsPerProject} designs` }]);
        if (Number(n?.active ?? 0) >= dc.maxActivePerAccount) throw new ApiError("RATE_LIMITED", "Too many generations in progress; wait for one to finish", undefined, { "Retry-After": "30" });
        const id = randomId("dsn");
        await q.query("insert into designs (id, account_id, project_id, created_by_user_id, title, brief, model, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)", [id, auth.accountId, projectId, auth.userId, body.title, body.brief, model, now]);
        await q.query(
          `insert into design_revisions (id, design_id, account_id, number, kind, instruction, status, model, max_cost_microusd, created_at)
           values ($1,$2,$3,1,'proposal',null,'queued',$4,$5,$6)`,
          [randomId("drv"), id, auth.accountId, model, max.toString(), now],
        );
        await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "design.created", targetType: "design", targetId: id, requestId: c.get("requestId"), at: now, metadata: { projectId, model, briefLength: body.brief.length } });
        return { status: 202, body: DesignRevisionAccepted.parse({ designId: id, revision: 1, status: "queued", maxCostMicrousd: max.toString() }), result: { designId: id, revision: 1, maxCostMicrousd: max.toString() } };
      },
      async (r) => {
        const designId = String(r["designId"] ?? "");
        const [rev] = await db.query<{ status: DesignRevision["status"] }>("select status from design_revisions where design_id=$1 and account_id=$2 and number=1", [designId, auth.accountId]);
        if (!rev) throw new ApiError("NOT_FOUND", "The original design no longer exists");
        return { status: 202, body: DesignRevisionAccepted.parse({ designId, revision: 1, status: rev.status, maxCostMicrousd: String(r["maxCostMicrousd"] ?? "0") }) };
      },
      () => quote(auth, model, buildDesignMessages({ title: body.title, brief: body.brief }).map((m) => m.text)),
    );
  });

  app.get("/projects/:id/designs", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const projectId = c.req.param("id") ?? "";
    await requireProject(db, auth.accountId, projectId);
    const q = parseWith(DesignListQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<DesignRow>(
      `select id, project_id, created_by_user_id, title, brief, model, created_at, updated_at from designs
        where project_id=$1 and account_id=$2 and ($3::timestamptz is null or (created_at, id) > ($3::timestamptz, $4::text)) order by created_at, id limit $5`,
      [projectId, auth.accountId, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items = [];
    for (const d of page) {
      const revs = await revisionsOf(db, d.id);
      const latest = revs[revs.length - 1];
      if (!latest) continue;
      items.push({ id: d.id, projectId: d.project_id, title: d.title, model: d.model, latestRevision: latest.number, latestStatus: latest.status, totalChargedMicrousd: totalCharged(revs), createdAt: d.created_at.toISOString(), updatedAt: d.updated_at.toISOString() });
    }
    const last = page[page.length - 1];
    return c.json(DesignList.parse({ items, nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }));
  });

  app.get("/designs/:designId", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const d = await loadDesign(db, auth, c.req.param("designId") ?? "");
    const revs = await revisionsOf(db, d.id);
    c.header("Cache-Control", "no-store");
    return c.json(Design.parse({
      id: d.id, projectId: d.project_id, title: d.title, brief: d.brief, model: d.model, latestRevision: revs[revs.length - 1]?.number ?? 1,
      totalChargedMicrousd: totalCharged(revs), aiGenerated: true, revisions: revs, createdAt: d.created_at.toISOString(), updatedAt: d.updated_at.toISOString(),
    }));
  });

  app.post("/designs/:designId/revisions", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const d = await loadDesign(db, auth, c.req.param("designId") ?? "");
    const body = await parseBody(c, CreateDesignRevisionRequest);
    const now = config.now();
    return runIdempotent<bigint>(
      c,
      { db, config, accountId: auth.accountId, operation: "createDesignRevision", hash: payloadHash({ designId: d.id, ...body }) },
      async (q, max) => {
        await q.query("select id from designs where id=$1 for update", [d.id]); // serialises concurrent revisions of one design
        const [cur] = await q.query<{ number: number; status: string }>("select number, status from design_revisions where design_id=$1 order by number desc limit 1", [d.id]);
        if (!cur || cur.number !== body.baseRevision) throw new ApiError("VERSION_CONFLICT", `Design is at revision ${cur?.number ?? 0}; reload and retry`);
        if (cur.status === "queued" || cur.status === "generating") throw new ApiError("VERSION_CONFLICT", "A generation is still running for this design");
        const [act] = await q.query<{ n: string }>("select count(*)::text as n from design_revisions where account_id=$1 and status in ('queued','generating')", [auth.accountId]);
        if (Number(act?.n ?? 0) >= dc.maxActivePerAccount) throw new ApiError("RATE_LIMITED", "Too many generations in progress; wait for one to finish", undefined, { "Retry-After": "30" });
        const number = cur.number + 1;
        await q.query(
          `insert into design_revisions (id, design_id, account_id, number, kind, instruction, status, model, max_cost_microusd, created_at)
           values ($1,$2,$3,$4,'revision',$5,'queued',$6,$7,$8)`,
          [randomId("drv"), d.id, auth.accountId, number, body.instruction, d.model, max.toString(), now],
        );
        await q.query("update designs set updated_at=$2 where id=$1", [d.id, now]);
        await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "design.revision_requested", targetType: "design", targetId: d.id, requestId: c.get("requestId"), at: now, metadata: { revision: number, instructionLength: body.instruction.length } });
        return { status: 202, body: DesignRevisionAccepted.parse({ designId: d.id, revision: number, status: "queued", maxCostMicrousd: max.toString() }), result: { designId: d.id, revision: number, maxCostMicrousd: max.toString() } };
      },
      async (r) => {
        const number = Number(r["revision"] ?? 0);
        const [rev] = await db.query<{ status: DesignRevision["status"] }>("select status from design_revisions where design_id=$1 and account_id=$2 and number=$3", [d.id, auth.accountId, number]);
        if (!rev) throw new ApiError("NOT_FOUND", "The original revision no longer exists");
        return { status: 202, body: DesignRevisionAccepted.parse({ designId: d.id, revision: number, status: rev.status, maxCostMicrousd: String(r["maxCostMicrousd"] ?? "0") }) };
      },
      async () => {
        const revs = await revisionsOf(db, d.id);
        const latest = revs[revs.length - 1];
        if (!latest) throw new ApiError("NOT_FOUND", "Design not found");
        if (body.baseRevision !== latest.number) throw new ApiError("VERSION_CONFLICT", `Design is at revision ${latest.number}; reload and retry`);
        if (latest.status === "queued" || latest.status === "generating") throw new ApiError("VERSION_CONFLICT", "A generation is still running for this design");
        if (revs.length >= dc.maxRevisionsPerDesign) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "(body)", message: `A design holds at most ${dc.maxRevisionsPerDesign} revisions` }]);
        const previous = [...revs].reverse().find((r) => r.status === "succeeded")?.document ?? undefined;
        const max = await quote(auth, d.model, buildDesignMessages({ title: d.title, brief: d.brief, previous, instruction: body.instruction }).map((m) => m.text));
        return max;
      },
    );
  });

  app.get("/designs/:designId/export", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const d = await loadDesign(db, auth, c.req.param("designId") ?? "");
    const q = parseWith(DesignExportQuery, c.req.query());
    const revs = await revisionsOf(db, d.id);
    const rev = q.revision !== undefined ? revs.find((r) => r.number === q.revision) : [...revs].reverse().find((r) => r.status === "succeeded");
    if (!rev || rev.status !== "succeeded" || !rev.document) throw new ApiError("NOT_FOUND", "No successful revision to export");
    const now = config.now();
    const input = {
      design: { id: d.id, projectId: d.project_id, title: d.title, brief: d.brief },
      revision: { number: rev.number, kind: rev.kind, instruction: rev.instruction, createdAt: rev.createdAt },
      generation: { model: rev.model, requestId: rev.cost.requestId, chargedMicrousd: rev.cost.chargedMicrousd },
      document: rev.document, exportedAt: now.toISOString(),
    };
    await audit(db, { accountId: auth.accountId, actorUserId: auth.userId, action: "design.exported", targetType: "design", targetId: d.id, requestId: c.get("requestId"), at: now, metadata: { revision: rev.number, format: q.format } });
    const md = q.format === "markdown";
    return c.body(md ? designExportMarkdown(input) : JSON.stringify(designExportJson(input)), 200, {
      "Content-Type": md ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="design-${d.id}-r${rev.number}.${md ? "md" : "json"}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store",
    });
  });

  app.delete("/designs/:designId", ...gate, async (c) => {
    const auth = c.get("auth");
    needUse(auth);
    const d = await loadDesign(db, auth, c.req.param("designId") ?? "");
    if (!canManageProjects(auth.role) && d.created_by_user_id !== auth.userId) throw new ApiError("FORBIDDEN", "Only an owner, admin or the creator can delete a design");
    const now = config.now();
    await db.tx(async (q) => {
      // Deletes the brief, instructions and documents. Requests, usage and ledger rows hold no text and stay (financial records).
      await q.query("delete from designs where id=$1 and account_id=$2", [d.id, auth.accountId]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "design.deleted", targetType: "design", targetId: d.id, requestId: c.get("requestId"), at: now, metadata: { projectId: d.project_id } });
    });
    return c.body(null, 204);
  });

  return app;
}
