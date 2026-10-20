/** Shared plumbing for the beta/operator routes: feature gate, idempotent execution, sequence cursors, bounded body reads. */
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { IdempotencyKey } from "@llmcrypto/contracts";
import type { AppConfig, FeatureConfig } from "./config";
import { canonicalJson, sha256Hex } from "./crypto";
import type { Db, Queryable } from "./db";
import { ApiError, type AppEnv, type Ctx } from "./http";
import { abortIdempotent, beginIdempotent, completeIdempotent, type IdemScope } from "./idempotency";

/** A switched-off beta area is unavailable (404 FEATURE_DISABLED). That is NOT the same as the feature being complete. */
export const requireFeature = (config: AppConfig, name: keyof FeatureConfig): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!config.features[name]) throw new ApiError("FEATURE_DISABLED", "This beta feature is switched off in this deployment");
  await next();
};

export function idempotencyKeyOf(c: Ctx): string {
  const raw = c.req.header("Idempotency-Key");
  if (raw === undefined || raw === "") throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  const parsed = IdempotencyKey.safeParse(raw);
  if (!parsed.success) throw new ApiError("BAD_REQUEST", "Idempotency-Key must be 8-255 printable ASCII characters");
  return parsed.data;
}

export const payloadHash = (v: unknown): string => sha256Hex(canonicalJson(v));

export interface IdemOptions {
  db: Db;
  config: AppConfig;
  accountId: string;
  operation: string;
  /** Hash of everything that defines "the same request". */
  hash: string;
}
export interface IdemOutcome {
  status: ContentfulStatusCode;
  body: unknown;
  /** Small secret-free record stored for replays (usually just the created id). */
  result: object;
}

/**
 * Runs `exec` once per (account, operation, key). The business writes and the idempotency completion share one
 * transaction. Same key + same payload replays through `replay`; a changed payload is 409; a concurrent duplicate is 409.
 */
export async function runIdempotent<P = undefined>(
  c: Ctx,
  o: IdemOptions,
  exec: (q: Queryable, prepared: P) => Promise<IdemOutcome>,
  replay: (result: Record<string, unknown>) => Promise<{ status: ContentfulStatusCode; body: unknown }>,
  /** Mutable-state admission checks (balance, current revision, ...). Runs only when this call will execute, never on a replay. */
  prepare?: () => Promise<P>,
): Promise<Response> {
  const scope: IdemScope = { accountId: o.accountId, operation: o.operation, key: idempotencyKeyOf(c) };
  const now = o.config.now();
  const begin = await beginIdempotent(o.db, scope, o.hash, now, o.config.idempotencyStaleSeconds);
  c.header("Cache-Control", "no-store");
  if (begin.action === "reject") throw new ApiError(begin.code, begin.code === "IN_PROGRESS" ? "An identical request is still running" : "Idempotency-Key reused with a different payload");
  if (begin.action === "replay") {
    const r = await replay((begin.row.result ?? {}) as Record<string, unknown>);
    c.header("Idempotent-Replay", "true");
    return c.json(r.body, r.status);
  }
  try {
    const prepared = (prepare ? await prepare() : undefined) as P;
    const out = await o.db.tx(async (q) => {
      const r = await exec(q, prepared);
      await completeIdempotent(q, scope, { statusCode: r.status, result: r.result, at: now });
      return r;
    });
    return c.json(out.body, out.status);
  } catch (e) {
    await abortIdempotent(o.db, scope);
    throw e;
  }
}

/** Keyset cursor over a bigint sequence column. */
export const encodeSeq = (seq: string | number | bigint): string => Buffer.from(JSON.stringify({ s: String(seq) })).toString("base64url");
export function decodeSeq(cursor: string): string {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof v.s !== "string" || !/^\d{1,18}$/.test(v.s)) throw new Error("bad");
    return v.s;
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid cursor");
  }
}

/** Reads the request body but stops (413) as soon as it exceeds `max` bytes, even without a Content-Length. */
export async function readBodyLimited(c: Ctx, max: number): Promise<Buffer> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw new ApiError("PAYLOAD_TOO_LARGE", `Body is larger than ${max} bytes`);
  const body = c.req.raw.body;
  if (!body) throw new ApiError("BAD_REQUEST", "Request body is required");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError("PAYLOAD_TOO_LARGE", `Body is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  if (total === 0) throw new ApiError("BAD_REQUEST", "Request body is required");
  return Buffer.concat(chunks);
}
