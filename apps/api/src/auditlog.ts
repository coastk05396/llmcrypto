/** Customer-facing audit view: GET /api/audit. Owner/admin/billing read their own account's events, newest first. */
import { Hono } from "hono";
import { AuditEventList, AuditQuery } from "@llmcrypto/contracts";
import { requireSession } from "./auth/session";
import type { AppConfig } from "./config";
import { decodeCursor, encodeCursor } from "./cursor";
import type { Db } from "./db";
import { ApiError, parseWith, type AppEnv } from "./http";

/** Operator-written free text (reasons, notes) is internal: customers see what happened and how much, not the operator's commentary. */
const withoutFreeText = (m: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(m).filter(([k]) => k !== "reason" && k !== "note"));

export function auditRoutes({ db, config }: { db: Db; config: AppConfig }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/audit", requireSession(db, config), async (c) => {
    const auth = c.get("auth");
    if (auth.role === "member") throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const q = parseWith(AuditQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<{ id: string; action: string; actor_user_id: string | null; target_type: string | null; target_id: string | null; metadata: Record<string, unknown>; created_at: Date }>(
      `select id, action, actor_user_id, target_type, target_id, metadata, created_at from audit_events
        where account_id=$1 and ($2::text = 'all' or action like 'operator.%') and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::text))
        order by created_at desc, id desc limit $5`,
      [auth.accountId, q.source, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    c.header("Cache-Control", "no-store");
    return c.json(AuditEventList.parse({
      items: page.map((r) => {
        const operator = r.action.startsWith("operator.");
        return {
          id: r.id, action: r.action, actor: operator ? "operator" : r.actor_user_id ? "member" : "system", actorUserId: operator ? null : r.actor_user_id,
          targetType: r.target_type, targetId: r.target_id, details: operator ? withoutFreeText(r.metadata) : r.metadata, createdAt: r.created_at.toISOString(),
        };
      }),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    }));
  });
  return app;
}
