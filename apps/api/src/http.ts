import type { Context, MiddlewareHandler } from "hono";
import { ERROR_CODES, httpStatusFor, type ErrorCode, type ErrorEnvelope } from "@llmcrypto/contracts";
import type { z } from "zod";
import type { AppConfig, RateRule } from "./config";
import { randomId } from "./crypto";
import type { AuthContext } from "./auth/session";

export interface AppEnv {
  Variables: { requestId: string; auth: AuthContext };
}
export type Ctx = Context<AppEnv>;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: { field: string; message: string }[],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
  get status(): number {
    return httpStatusFor(this.code);
  }
}
/**
 * Error on the /v1 gateway surface. Carries its own HTTP status and an upstream-compatible code; rendered as an
 * OpenAI-style error on /v1/chat/completions and as an Anthropic-style error on /v1/messages.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export type GatewayProtocol = "openai_chat" | "openai_responses" | "anthropic_messages";
export const protocolForPath = (path: string): GatewayProtocol =>
  path === "/v1/messages" ? "anthropic_messages" : path === "/v1/responses" ? "openai_responses" : "openai_chat";

function errorType(status: number, protocol: GatewayProtocol): string {
  const anthropic = protocol === "anthropic_messages";
  if (status === 401) return "authentication_error";
  if (status === 402) return anthropic ? "billing_error" : "insufficient_quota";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return anthropic ? "request_too_large" : "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (status === 504) return anthropic ? "timeout_error" : "server_error";
  if (status >= 500) return anthropic ? "api_error" : "server_error";
  return "invalid_request_error";
}

/** Protocol-correct error payload; also used for the in-stream SSE error event. */
export function gatewayErrorPayload(protocol: GatewayProtocol, status: number, code: string, message: string, param: string | null): unknown {
  const type = errorType(status, protocol);
  return protocol === "anthropic_messages" ? { type: "error", error: { type, message } } : { error: { message, type, param, code } };
}

export const codeExists = (c: string): c is ErrorCode => c in ERROR_CODES;

export function errorBody(code: ErrorCode, message: string, requestId: string, fieldErrors?: { field: string; message: string }[]): ErrorEnvelope {
  return { error: { code, message, requestId, ...(fieldErrors && fieldErrors.length ? { fieldErrors } : {}) } };
}

/** OpenAI-style error body for /v1/*, which keeps the upstream-compatible shape instead of the console envelope. */
function openAiError(err: ApiError): { error: { message: string; type: string; param: null; code: string } } {
  const type = err.status === 401 ? "authentication_error" : err.status === 429 ? "rate_limit_error" : err.status >= 500 ? "server_error" : "invalid_request_error";
  const code = err.code === "UNAUTHENTICATED" ? "invalid_api_key" : err.code.toLowerCase();
  return { error: { message: err.message, type, param: null, code } };
}

export function handleError(err: unknown, c: Ctx): Response {
  const requestId = c.get("requestId") ?? randomId("req");
  if (err instanceof GatewayError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    c.header("Cache-Control", "no-store");
    return c.json(gatewayErrorPayload(protocolForPath(c.req.path), err.status, err.code, err.message, err.param), err.status as 400);
  }
  let apiErr: ApiError;
  if (err instanceof ApiError) apiErr = err;
  else if (err instanceof SyntaxError) apiErr = new ApiError("BAD_REQUEST", "Malformed JSON body");
  else {
    // Never echo internals; the cause is logged server side without request bodies.
    console.error(JSON.stringify({ level: "error", requestId, name: err instanceof Error ? err.name : "unknown", message: err instanceof Error ? err.message : "" }));
    apiErr = new ApiError("INTERNAL", "Unexpected server error");
  }
  for (const [k, v] of Object.entries(apiErr.headers)) c.header(k, v);
  c.header("Cache-Control", "no-store");
  const body =
    c.req.path === "/v1/messages"
      ? gatewayErrorPayload("anthropic_messages", apiErr.status, apiErr.code.toLowerCase(), apiErr.message, null)
      : c.req.path.startsWith("/v1/")
        ? openAiError(apiErr)
        : errorBody(apiErr.code, apiErr.message, requestId, apiErr.fieldErrors);
  return c.json(body, apiErr.status as 400);
}

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const id = randomId("req");
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence for cookie-authenticated routes (with SameSite=Strict cookies): a mutating request
 * must carry an Origin header exactly matching an allowed origin. Missing Origin is rejected (fail closed).
 */
export const originCheck = (config: Pick<AppConfig, "allowedOrigins">): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (MUTATING.has(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || !config.allowedOrigins.includes(origin)) throw new ApiError("FORBIDDEN", "Origin not allowed");
    if (c.req.header("Sec-Fetch-Site") === "cross-site") throw new ApiError("FORBIDDEN", "Cross-site request rejected");
  }
  await next();
};

/** Transient in-memory fixed-window limiter. Per process only: resets on restart, not shared between instances. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly rule: RateRule, private readonly now: () => Date) {}
  /** Returns seconds to wait, or 0 when allowed. */
  take(key: string): number {
    const t = this.now().getTime();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.rule.windowSeconds * 1000 });
      return 0;
    }
    if (cur.count >= this.rule.limit) return Math.max(1, Math.ceil((cur.resetAt - t) / 1000));
    cur.count += 1;
    return 0;
  }
}

export const rateLimit = (limiter: RateLimiter, clientKey: (c: Ctx) => string, scope: string): MiddlewareHandler<AppEnv> => async (c, next) => {
  const wait = limiter.take(`${scope}:${clientKey(c)}`);
  if (wait > 0) throw new ApiError("RATE_LIMITED", "Too many requests", undefined, { "Retry-After": String(wait) });
  await next();
};

/** Parses a JSON object body against a zod schema: 400 for unparsable JSON, 422 with fieldErrors for invalid fields. */
export async function parseBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("BAD_REQUEST", "Malformed JSON body");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("BAD_REQUEST", "Body must be a JSON object");
  return parseWith(schema, raw);
}

export function parseWith<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "Request validation failed",
      r.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })),
    );
  }
  return r.data;
}
