import { Hono } from "hono";
import { CreateDepositRequest, DepositList, DepositListQuery, IdempotencyKey, PaymentNetworkList } from "@llmcrypto/contracts";
import { expireIntents } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession } from "../auth/session";
import type { AppConfig } from "../config";
import { canonicalJson, randomId, sha256Hex } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db } from "../db";
import { ApiError, parseBody, parseWith, type AppEnv, type Ctx } from "../http";
import { abortIdempotent, beginIdempotent, completeIdempotent, type IdemScope } from "../idempotency";
import type { AddressProvider } from "./address-provider";
import { INTENT_COLUMNS, amountIssues, findRoute, getIntent, insertIntent, toDeposit, type IntentRow } from "./intents";

export interface DepositDeps {
  db: Db;
  config: AppConfig;
  /** null = no address source configured: deposits are unavailable (503). */
  addressProvider: AddressProvider | null;
}

const OPERATION = "createDeposit";
/** Roles that may create and read deposit intents (the owner also holds the billing role). */
const DEPOSIT_ROLES = new Set(["owner", "billing"]);

function requireBilling(c: Ctx): void {
  if (!DEPOSIT_ROLES.has(c.get("auth").role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
}

export function depositRoutes({ db, config, addressProvider }: DepositDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession(db, config));

  // Declared before /:id so "networks" is never read as an intent id.
  app.get("/networks", (c) => {
    requireBilling(c);
    c.header("Cache-Control", "no-store");
    return c.json(PaymentNetworkList.parse({
      items: config.payments.routes.map((r) => ({
        network: r.network, asset: r.asset, chainId: r.chainId, assetContract: r.assetContract === "" ? null : r.assetContract, decimals: r.decimals,
        requiredConfirmations: r.confirmations, expirySeconds: r.expirySeconds, minAmountAtomic: r.minAmountAtomic.toString(),
        maxAmountAtomic: r.maxAmountAtomic === null ? null : r.maxAmountAtomic.toString(),
      })),
    }));
  });

  app.post("/", async (c) => {
    const auth = c.get("auth");
    requireBilling(c);
    const rawKey = c.req.header("Idempotency-Key");
    if (rawKey === undefined || rawKey === "") throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    const parsedKey = IdempotencyKey.safeParse(rawKey);
    if (!parsedKey.success) throw new ApiError("BAD_REQUEST", "Idempotency-Key must be 8-255 printable ASCII characters");
    c.header("Cache-Control", "no-store");
    // Fail closed: no networks or no address source means nothing may be promised to a customer.
    if (config.payments.routes.length === 0 || addressProvider === null) {
      throw new ApiError("UNAVAILABLE", "No payment networks configured: deposits are not available");
    }
    const body = await parseBody(c, CreateDepositRequest);
    const route = findRoute(config.payments.routes, body);
    if (!route) throw new ApiError("VALIDATION_FAILED", "Unsupported network or asset", [{ field: "network", message: `${body.network}/${body.asset} is not a configured payment pair` }]);
    const amount = BigInt(body.amountAtomic);
    const issues = amountIssues(route, amount);
    if (issues.length) throw new ApiError("VALIDATION_FAILED", "Request validation failed", issues);

    const scope: IdemScope = { accountId: auth.accountId, operation: OPERATION, key: parsedKey.data };
    const now = config.now();
    const outcome = await beginIdempotent(db, scope, sha256Hex(canonicalJson(body)), now, config.idempotencyStaleSeconds);
    if (outcome.action === "reject") throw new ApiError(outcome.code, outcome.code === "IN_PROGRESS" ? "An identical request is still running" : "Idempotency-Key reused with a different payload");
    if (outcome.action === "replay") {
      const depositId = (outcome.row.result as { depositId?: string } | null)?.depositId;
      const row = depositId ? await getIntent(db, auth.accountId, depositId) : undefined;
      if (!row) throw new ApiError("INTERNAL", "Original result unavailable");
      c.header("Idempotent-Replay", "true");
      return c.json(toDeposit(row), 201);
    }

    try {
      const id = randomId("dep");
      // Unique per intent and deterministic for it; the matcher correlates transfers by this destination.
      const address = await addressProvider.addressFor({ intentId: id, accountId: auth.accountId, network: route.network, asset: route.asset });
      const row = await db.tx(async (q) => {
        await q.query("select id from accounts where id=$1 for update", [auth.accountId]); // serializes the open-intent cap
        const [open] = await q.query<{ n: string }>("select count(*)::text as n from deposit_intents where account_id=$1 and status='CREATED' and accept_until >= $2", [auth.accountId, now]);
        if (Number(open?.n ?? "0") >= config.payments.maxOpenIntents) {
          throw new ApiError("VALIDATION_FAILED", "Too many open deposit intents; wait for one to be paid or to expire", [{ field: "amountAtomic", message: `at most ${config.payments.maxOpenIntents} open intents per account` }]);
        }
        await insertIntent(q, { id, accountId: auth.accountId, userId: auth.userId, route, address, amountAtomic: amount, at: now });
        await audit(q, {
          accountId: auth.accountId, actorUserId: auth.userId, action: "deposit.intent_created", targetType: "deposit_intent", targetId: id, requestId: c.get("requestId"), at: now,
          metadata: { network: route.network, asset: route.asset, amountAtomic: body.amountAtomic },
        });
        await completeIdempotent(q, scope, { statusCode: 201, result: { depositId: id }, at: now });
        return getIntent(q, auth.accountId, id);
      });
      if (!row) throw new ApiError("INTERNAL", "Deposit was not persisted");
      return c.json(toDeposit(row), 201);
    } catch (e) {
      await abortIdempotent(db, scope);
      throw e;
    }
  });

  app.get("/", async (c) => {
    const auth = c.get("auth");
    requireBilling(c);
    const q = parseWith(DepositListQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    await expireIntents(db, config.now(), auth.accountId);
    const rows = await db.query<IntentRow>(
      `select ${INTENT_COLUMNS} from deposit_intents where account_id=$1 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text))
       order by created_at, id limit $4`,
      [auth.accountId, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    c.header("Cache-Control", "no-store");
    return c.json(DepositList.parse({ items: page.map(toDeposit), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }));
  });

  app.get("/:id", async (c) => {
    const auth = c.get("auth");
    requireBilling(c);
    await expireIntents(db, config.now(), auth.accountId);
    const row = await getIntent(db, auth.accountId, c.req.param("id")); // account-scoped: other accounts' ids are 404
    if (!row) throw new ApiError("NOT_FOUND", "Deposit not found");
    c.header("Cache-Control", "no-store");
    return c.json(toDeposit(row));
  });

  return app;
}
