import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { authRoutes } from "./auth/routes";
import type { TelegramBot } from "./auth/telegram";
import { catalogRoutes, filterCatalog } from "./catalog/routes";
import type { AppConfig } from "./config";
import type { Db } from "./db";
import { ApiError, RateLimiter, errorBody, gatewayErrorPayload, protocolForPath, handleError, originCheck, requestId, type AppEnv, type Ctx } from "./http";
import { keyRoutes } from "./keys/routes";
import { authenticateApiKey } from "./keys/service";
import { isModelAllowed } from "@llmcrypto/domain";
import { billingRoutes } from "./billing/routes";
import { createGateway, gatewayRoutes, type Gateway } from "./gateway/dispatch";
import { FakeProvider } from "./gateway/fake-provider";
import type { Provider } from "./gateway/provider";
import { exportRoutes } from "./exports/routes";
import { usageRoutes } from "./usage/routes";
import { TestAddressProvider, type AddressProvider } from "./payments/address-provider";
import { depositRoutes } from "./payments/routes";
import { connectivityRoutes } from "./connectivity/routes";
import { memoryRoutes } from "./memory/routes";
import { optimizationRoutes } from "./optimization/routes";
import { projectRoutes } from "./projects/routes";
import { repositoryRoutes } from "./imports/routes";
import { designRoutes } from "./design/routes";
import { operatorRoutes } from "./operator/routes";
import { auditRoutes } from "./auditlog";
import { FeatureFlags } from "@llmcrypto/contracts";
import type { ChannelRegistry } from "@llmcrypto/domain";

export interface AppDeps {
  db: Db;
  config: AppConfig;
  /** Overrides the provider chosen by config.gateway.provider (tests inject a configured FakeProvider). */
  provider?: Provider | null;
  /** Pre-built gateway (tests keep a handle to await settlement via gateway.idle()). */
  gateway?: Gateway;
  /** Overrides the provider chosen by config.payments.addressSource. null = deposits unavailable (503). */
  addressProvider?: AddressProvider | null;
  /** Telegram bot port. null/undefined = Telegram sign-in answers 503 (no bot token exists; only FakeTelegramBot is implemented). */
  telegramBot?: TelegramBot | null;
  /** Notification channel providers (Telegram/WhatsApp). A missing channel answers 503. Only Fake providers exist; real delivery is BLOCKED (no credentials). */
  channels?: ChannelRegistry;
  /** Identifies the client for abuse limits. Defaults to the socket address; X-Forwarded-For is ignored until a trusted-proxy setting exists. */
  clientKey?: (c: Ctx) => string;
}

/** Remote address of the socket. */
function socketAddress(c: Ctx): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Client key for abuse limits. X-Forwarded-For is believed ONLY when the socket peer is a configured trusted proxy; the chain is then
 * walked from the right and the first address that is not itself a trusted proxy is the client (entries further left are
 * client-supplied and ignored). Without TRUSTED_PROXIES the header is never read.
 */
export function clientAddress(socket: string, forwardedFor: string | undefined, trusted: readonly string[]): string {
  if (!forwardedFor || !trusted.includes(socket)) return socket;
  const hops = forwardedFor.split(",").map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusted.includes(hops[i]!)) return hops[i]!.slice(0, 64);
  return socket;
}

export function createApp({ db, config, provider, gateway, addressProvider, telegramBot, channels, clientKey: clientKeyOverride }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const clientKey = clientKeyOverride ?? ((c: Ctx): string => clientAddress(socketAddress(c), c.req.header("X-Forwarded-For"), config.trustedProxies));
  // Rate limits are in-memory and per process (transient): they reset on restart and are not shared across instances.
  const limiters = {
    challenge: new RateLimiter(config.rateLimits.challenge, config.now),
    session: new RateLimiter(config.rateLimits.session, config.now),
    keys: new RateLimiter(config.rateLimits.keys, config.now),
  };

  app.use("*", requestId());
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.onError(handleError);
  app.notFound((c) => handleError(new ApiError("NOT_FOUND", "Not found"), c));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Console API: credentials are the session cookie, so no wildcard CORS; only the configured web origin.
  const api = new Hono<AppEnv>();
  api.use("*", cors({ origin: [...config.allowedOrigins], credentials: true, allowHeaders: ["Content-Type", "Idempotency-Key"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
  api.use("*", originCheck(config));
  // Streaming body cap BEFORE any handler parses JSON (a chunked body without Content-Length is counted as it arrives). Only the
  // archive upload route is exempt: it enforces its own, larger limit (repository.limits.maxArchiveBytes) the same way.
  const apiLimit = bodyLimit({
    maxSize: config.apiMaxBodyBytes,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", `Body is larger than ${config.apiMaxBodyBytes} bytes`, c.get("requestId") ?? "req"), 413),
  });
  api.use("*", (c, next) => (c.req.method === "POST" && /^\/api\/projects\/[^/]+\/repository-imports$/.test(c.req.path) ? next() : apiLimit(c, next)));
  api.route("/", authRoutes({ db, config, clientKey, limiters, telegramBot: telegramBot ?? null }));
  api.route("/", catalogRoutes());
  api.route("/keys", keyRoutes({ db, config, clientKey, limiter: limiters.keys }));
  api.route("/", billingRoutes({ db, config }));
  api.route("/usage", usageRoutes({ db, config }));
  api.route("/", exportRoutes({ db, config }));
  api.route("/deposits", depositRoutes({ db, config, addressProvider: addressProvider === undefined ? (config.payments.addressSource === "test" ? new TestAddressProvider() : null) : addressProvider }));
  api.route("/projects", projectRoutes({ db, config }));
  api.route("/projects", memoryRoutes({ db, config }));
  api.route("/projects", repositoryRoutes({ db, config }));
  api.route("/", designRoutes({ db, config }));
  api.route("/operator", operatorRoutes({ db, config }));
  api.route("/", auditRoutes({ db, config }));
  // Public and non-sensitive: lets the web app show which beta areas exist. A false flag means unavailable, NOT complete.
  api.get("/features", (c) => c.json(FeatureFlags.parse(config.features)));
  api.route("/optimization", optimizationRoutes({ db, config }));
  api.route("/connectivity", connectivityRoutes({ db, config, channels: channels ?? {} }));
  app.route("/api", api);

  // OpenAI-compatible model discovery. Public like the reference; an Authorization header, when present,
  // must be a live key (revoked/expired/unknown -> 401) and its model allowlist narrows the list.
  app.get("/v1/models", async (c) => {
    let allowlist: string[] = [];
    const authz = c.req.header("Authorization");
    if (authz !== undefined) {
      const m = /^Bearer (\S+)$/.exec(authz);
      const result = m?.[1] ? await authenticateApiKey(db, config, m[1]) : ({ ok: false } as const);
      if (!result.ok) throw new ApiError("UNAUTHENTICATED", "Invalid API key");
      if (!result.key.scopes.includes("gateway:invoke")) throw new ApiError("FORBIDDEN", "Key lacks the gateway:invoke scope");
      allowlist = result.key.model_allowlist;
    }
    const data = filterCatalog({})
      .filter((x) => isModelAllowed(allowlist, x.id))
      .map((x) => ({ id: x.id, object: "model" as const, created: Math.floor(Date.parse(x.updatedAt) / 1000), owned_by: x.provider }));
    return c.json({ object: "list" as const, data });
  });

  // Compatible gateway endpoints. Credentials are bearer API keys (never cookies), so no CORS/origin policy applies.
  const gw = gateway ?? createGateway({ db, config, provider: provider === undefined ? (config.gateway.provider === "fake" ? new FakeProvider() : null) : provider });
  app.use("/v1/*", bodyLimit({
    maxSize: config.gateway.maxRequestBytes,
    onError: (c) => c.json(gatewayErrorPayload(protocolForPath(c.req.path), 413, "request_too_large", "Request body is too large", null), 413),
  }));
  gatewayRoutes(app, gw);

  return app;
}
