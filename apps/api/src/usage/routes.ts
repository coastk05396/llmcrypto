import { Hono } from "hono";
import { AgentRunPage, AgentRunQuery, UsageDetail, UsagePage, UsageQuery } from "@llmcrypto/contracts";
import { queryAgentRuns, queryUsage, queryUsageDetail, type Row } from "@llmcrypto/domain";
import { isRestricted, requireSession, type AuthContext } from "../auth/session";
import type { AppConfig } from "../config";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db } from "../db";
import { ApiError, parseWith, type AppEnv } from "../http";

export interface UsageDeps {
  db: Db;
  config: AppConfig;
}

/** Roles that see account-wide usage. There are no per-project grants yet, so a plain member sees an empty page. */
const ACCOUNT_WIDE = new Set(["owner", "admin", "billing"]);

/** API-key sessions read only their own key's requests; roles do not widen that. */
function scopeOf(auth: AuthContext): { accountId: string; keyId: string | null } {
  return { accountId: auth.accountId, keyId: isRestricted(auth) ? auth.methodRef : null };
}
const mayRead = (auth: AuthContext): boolean => isRestricted(auth) || ACCOUNT_WIDE.has(auth.role);

function page<T>(rows: Row<T>[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.length ? rows[items.length - 1] : undefined;
  return { items: items.map((r) => r.item), nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.key) : null };
}

export function usageRoutes({ db, config }: UsageDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const readable = requireSession(db, config, "key_scope");

  app.get("/", readable, async (c) => {
    const auth = c.get("auth");
    const q = parseWith(UsageQuery, c.req.query());
    c.header("Cache-Control", "no-store");
    if (!mayRead(auth)) return c.json(UsagePage.parse({ items: [], nextCursor: null }));
    const rows = await queryUsage(db, scopeOf(auth), q, q.cursor ? decodeCursor(q.cursor) : null, q.limit + 1);
    return c.json(UsagePage.parse(page(rows, q.limit)));
  });

  app.get("/agent-runs", readable, async (c) => {
    const auth = c.get("auth");
    const q = parseWith(AgentRunQuery, c.req.query());
    c.header("Cache-Control", "no-store");
    if (!mayRead(auth)) return c.json(AgentRunPage.parse({ items: [], nextCursor: null }));
    const rows = await queryAgentRuns(db, scopeOf(auth), q, q.cursor ? decodeCursor(q.cursor) : null, q.limit + 1);
    return c.json(AgentRunPage.parse(page(rows, q.limit)));
  });
  app.get("/:id", readable, async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = c.get("auth");
    if (!mayRead(auth)) throw new ApiError("NOT_FOUND", "Usage record not found");
    const detail = await db.tx((q) => queryUsageDetail(q, scopeOf(auth), c.req.param("id")));
    if (!detail) throw new ApiError("NOT_FOUND", "Usage record not found");
    return c.json(UsageDetail.parse(detail));
  });
  return app;
}
