import { Hono } from "hono";
import { LedgerPage, LedgerQuery, type Balance } from "@llmcrypto/contracts";
import { accountBalance, queryLedger } from "@llmcrypto/domain";
import { requireSession } from "../auth/session";
import type { AppConfig } from "../config";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db } from "../db";
import { ApiError, parseWith, type AppEnv } from "../http";

export interface BillingDeps {
  db: Db;
  config: AppConfig;
}

/** Roles that may read the ledger (SPEC: billing role; the owner also holds it). */
const LEDGER_ROLES = new Set(["owner", "billing"]);

export function billingRoutes({ db, config }: BillingDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/accounts/current/balance", requireSession(db, config), async (c) => {
    const auth = c.get("auth");
    const b = await accountBalance(db, auth.accountId);
    const body: Balance = {
      availableMicrousd: b.available.toString(), heldMicrousd: b.held.toString(), postedMicrousd: b.posted.toString(), asOf: config.now().toISOString(),
    };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.get("/ledger", requireSession(db, config), async (c) => {
    const auth = c.get("auth");
    if (!LEDGER_ROLES.has(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const q = parseWith(LedgerQuery, c.req.query());
    const rows = await queryLedger(db, auth.accountId, q, q.cursor ? decodeCursor(q.cursor) : null, q.limit + 1);
    const items = rows.slice(0, q.limit);
    const last = items.length ? rows[items.length - 1] : undefined;
    const body = LedgerPage.parse({ items: items.map((r) => r.item), nextCursor: rows.length > q.limit && last ? encodeCursor(last.at, last.key) : null });
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  return app;
}
