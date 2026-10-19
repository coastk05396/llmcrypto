import { fileURLToPath } from "node:url";
import { DEFAULT_ADJUSTMENT_BOUNDS, resolveLimits, type ImportLimits } from "@llmcrypto/domain";
import { parsePaymentRoutes, type PaymentsConfig } from "./payments/config";

export interface AppConfig {
  /** Origins allowed to call mutating /api routes (exact match). */
  allowedOrigins: readonly string[];
  /** ERC-4361 / TRON message domain (host[:port]) and URI; derived from WEB_ORIGIN unless AUTH_DOMAIN is set. */
  authDomain: string;
  authUri: string;
  evmChainIds: readonly string[];
  tronNetworks: readonly string[];
  /** Secrets are optional at load time; features that need one fail closed with 503 when absent. */
  sessionSecret: string | undefined;
  apiKeyPepper: string | undefined;
  keyReplaySecret: string | undefined;
  sessionTtlSeconds: number;
  challengeTtlSeconds: number;
  /** In-flight idempotency rows older than this are treated as crashed and may be re-executed. */
  idempotencyStaleSeconds: number;
  cookieSecure: boolean;
  migrationsDir: string;
  /** Transient in-memory limits (per process). */
  rateLimits: { challenge: RateRule; session: RateRule; keys: RateRule };
  /** Alternative sign-in methods: persisted failure limits, hashing cost, code lifetimes. */
  auth: AuthMethodsConfig;
  /** Export files are kept (and downloadable) this long after the job succeeds. */
  exportTtlSeconds: number;
  /** Hard cap on rows in one export; larger requests fail instead of exhausting memory. */
  exportMaxRows: number;
  /** Cap on any /api JSON body (the archive upload has its own limit). Enforced while the body streams in. */
  apiMaxBodyBytes: number;
  gateway: GatewayConfig;
  /** Payment networks, address source and policy. Empty by default: no networks are assumed. */
  payments: PaymentsConfig;
  /**
   * Beta areas. OFF by default. A switched-off area answers 404 FEATURE_DISABLED: that means unavailable, NOT done. The
   * product scope is not complete until both are on and verified (SPEC.md, "Beta tools").
   */
  features: FeatureConfig;
  repository: RepositoryConfig;
  design: DesignConfig;
  operator: OperatorConfig;
  /** ALLOW_TEST_COMPONENTS=true: test doubles may be used. */
  testComponents: boolean;
  /** Reverse proxies (exact IPs) whose X-Forwarded-For is believed. Empty = the header is never trusted. */
  trustedProxies: readonly string[];
  now: () => Date;
}
export interface FeatureConfig {
  repositoryGraph: boolean;
  designBeta: boolean;
}
export interface RepositoryConfig {
  /** Archive limits (see docs/import-limits.md). Clamped to hard ceilings in @llmcrypto/domain. */
  limits: ImportLimits;
  /** Queued + running imports per project. */
  maxActivePerProject: number;
  /** Retained imports per project; delete one to upload another. */
  maxRetainedPerProject: number;
}
export interface DesignConfig {
  /** Catalog model used when a request names none. */
  model: string;
  maxOutputTokens: number;
  maxRevisionsPerDesign: number;
  maxDesignsPerProject: number;
  /** Queued + generating revisions per account. */
  maxActivePerAccount: number;
}
export interface OperatorConfig {
  /** How long one elevation lasts. It is bound to a single session and cannot be extended without re-authenticating. */
  elevationSeconds: number;
  /** An elevation request needs authenticatedAt (sign-in or step-up) no older than this. Stricter than the customer step-up window. */
  stepUpWindowSeconds: number;
  adjustmentMaxMicrousd: bigint;
  adjustmentTtlSeconds: number;
  /** Ceiling on the sum of ALL credits and debits approved in any rolling 24 hours (across operators and accounts). UNCONFIRMED commercial policy. */
  dailyLimitMicrousd: bigint;
  /** Active holds older than this are reported as stuck. */
  stuckReservationSeconds: number;
  /** User ids granted operator status by configuration (granted_by = config); synced at startup. */
  configuredUserIds: readonly string[];
}
export interface AuthMethodsConfig {
  /** Failed attempts allowed per window for one account (any IP), one account+IP pair, and one IP (any account). */
  attempts: { account: RateRule; accountIp: RateRule; ip: RateRule };
  /** argon2id cost. Defaults follow the OWASP minimum (19 MiB, t=2, p=1); tests may lower them. */
  argon2: { memoryKiB: number; timeCost: number };
  recoveryCodeTtlSeconds: number;
  recoveryCodeCount: number;
  telegramCodeTtlSeconds: number;
  /** Verification tries before a Telegram code is burned. */
  telegramMaxAttempts: number;
  /** Lifetime of an API-key console session and the absolute ceiling for renewing it. */
  keySessionTtlSeconds: number;
  keySessionMaxSeconds: number;
  /** Absolute ceiling for renewing a wallet/password/Telegram session, measured from its creation. */
  sessionMaxSeconds: number;
}
export interface GatewayConfig {
  /** "fake" = the deterministic test provider (the only adapter that exists); "none" disables the gateway (503). */
  provider: "fake" | "none";
  /** Applied when a request omits its output cap. */
  defaultMaxOutputTokens: number;
  /** Requests asking for more are rejected (400), never silently clamped. */
  maxOutputTokensCeiling: number;
  maxRequestBytes: number;
  /** Provider call deadline; after possible acceptance a timeout becomes USAGE_PENDING, never an assumed zero charge. */
  providerTimeoutMs: number;
  /**
   * How long a USAGE_PENDING request is reconciled before the hold is released and the unresolved provider cost
   * is absorbed. UNCONFIRMED commercial policy (SPEC proposes 24 h); confirm before launch.
   */
  usagePendingSeconds: number;
  /** Per-key request rate (transient, per process) and concurrent in-flight requests. */
  rate: RateRule;
  maxConcurrentPerKey: number;
}
export interface RateRule {
  limit: number;
  windowSeconds: number;
}

const csv = (v: string | undefined, fallback: string[]): string[] =>
  v && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
const int = (v: string | undefined, fallback: number): number => {
  const n = v === undefined || v === "" ? fallback : Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid positive integer: ${v}`);
  return n;
};
/** Secrets must be at least 32 characters. A configured-but-short secret is a startup error (fail closed), never silently ignored. */
export const MIN_SECRET_LENGTH = 32;
const secret = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  if (v.length < MIN_SECRET_LENGTH) throw new Error(`a configured secret is shorter than ${MIN_SECRET_LENGTH} characters; refusing to start`);
  return v;
};

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

/** Builds config from environment variables. Only placeholder names live in .env.example. */
export function loadConfig(env: Record<string, string | undefined>, overrides: Partial<AppConfig> = {}): AppConfig {
  // Test doubles (the FakeProvider, the test deposit-address source, the dev credit helper) exist only when explicitly allowed, whatever NODE_ENV says.
  const testComponents = env["ALLOW_TEST_COMPONENTS"] === "true";
  if (!testComponents && (env["GATEWAY_PROVIDER"] === "fake" || env["PAYMENT_ADDRESS_SOURCE"] === "test")) {
    throw new Error("GATEWAY_PROVIDER=fake / PAYMENT_ADDRESS_SOURCE=test are test doubles and need ALLOW_TEST_COMPONENTS=true; refusing to start");
  }
  const webOrigin = env["WEB_ORIGIN"] || "http://localhost:5173";
  const url = new URL(webOrigin);
  const config: AppConfig = {
    allowedOrigins: [url.origin],
    authDomain: env["AUTH_DOMAIN"] || url.host,
    authUri: url.origin,
    evmChainIds: csv(env["AUTH_EVM_CHAIN_IDS"], ["1"]),
    tronNetworks: csv(env["AUTH_TRON_NETWORKS"], ["mainnet"]),
    sessionSecret: secret(env["SESSION_SECRET"]),
    apiKeyPepper: secret(env["API_KEY_HASH_PEPPER"]),
    keyReplaySecret: secret(env["KEY_REPLAY_ENCRYPTION_SECRET"]),
    sessionTtlSeconds: int(env["SESSION_TTL_SECONDS"], 86_400),
    challengeTtlSeconds: 300,
    idempotencyStaleSeconds: 120,
    cookieSecure: env["COOKIE_SECURE"] !== "false",
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    rateLimits: {
      challenge: { limit: 20, windowSeconds: 60 },
      session: { limit: 10, windowSeconds: 60 },
      keys: { limit: 30, windowSeconds: 60 },
    },
    auth: {
      attempts: {
        // Deliberately high: this bucket counts failures from EVERY client, so a low limit would let anyone lock the owner out by
        // guessing from many IPs. The tight bucket is account+IP; the per-IP bucket stops spraying. See docs/security-notes.md.
        account: { limit: 100, windowSeconds: 900 },
        accountIp: { limit: 5, windowSeconds: 900 },
        ip: { limit: 30, windowSeconds: 900 },
      },
      argon2: { memoryKiB: 19_456, timeCost: 2 },
      recoveryCodeTtlSeconds: 90 * 86_400,
      recoveryCodeCount: 8,
      telegramCodeTtlSeconds: 600,
      telegramMaxAttempts: 30,
      keySessionTtlSeconds: 3600,
      keySessionMaxSeconds: 8 * 3600,
      sessionMaxSeconds: 7 * 86_400,
    },
    exportTtlSeconds: int(env["EXPORT_TTL_SECONDS"], 86_400),
    exportMaxRows: int(env["EXPORT_MAX_ROWS"], 200_000),
    apiMaxBodyBytes: int(env["API_MAX_BODY_BYTES"], 1_048_576),
    gateway: {
      provider: env["GATEWAY_PROVIDER"] === "fake" ? "fake" : "none",
      defaultMaxOutputTokens: int(env["GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS"], 1024),
      maxOutputTokensCeiling: int(env["GATEWAY_MAX_OUTPUT_TOKENS_CEILING"], 8192),
      maxRequestBytes: int(env["GATEWAY_MAX_REQUEST_BYTES"], 1_048_576),
      providerTimeoutMs: int(env["GATEWAY_PROVIDER_TIMEOUT_MS"], 60_000),
      usagePendingSeconds: int(env["GATEWAY_USAGE_PENDING_SECONDS"], 86_400),
      rate: { limit: int(env["GATEWAY_RATE_LIMIT_PER_MINUTE"], 600), windowSeconds: 60 },
      maxConcurrentPerKey: int(env["GATEWAY_MAX_CONCURRENT_PER_KEY"], 16),
    },
    payments: {
      routes: parsePaymentRoutes(env["PAYMENT_NETWORKS_CONFIG"]),
      addressSource: env["PAYMENT_ADDRESS_SOURCE"] === "test" ? "test" : "none",
      maxOpenIntents: int(env["PAYMENT_MAX_OPEN_INTENTS"], 10),
    },
    features: { repositoryGraph: env["FEATURE_REPOSITORY_GRAPH"] === "true", designBeta: env["FEATURE_DESIGN_BETA"] === "true" },
    repository: {
      limits: resolveLimits({
        ...(env["REPOSITORY_MAX_ARCHIVE_BYTES"] ? { maxArchiveBytes: int(env["REPOSITORY_MAX_ARCHIVE_BYTES"], 0) } : {}),
        ...(env["REPOSITORY_MAX_FILES"] ? { maxFiles: int(env["REPOSITORY_MAX_FILES"], 0) } : {}),
        ...(env["REPOSITORY_MAX_TOTAL_BYTES"] ? { maxTotalBytes: int(env["REPOSITORY_MAX_TOTAL_BYTES"], 0) } : {}),
      }),
      maxActivePerProject: int(env["REPOSITORY_MAX_ACTIVE_PER_PROJECT"], 3),
      maxRetainedPerProject: int(env["REPOSITORY_MAX_RETAINED_PER_PROJECT"], 10),
    },
    design: {
      model: env["DESIGN_MODEL"] || "sample-fast-1",
      maxOutputTokens: int(env["DESIGN_MAX_OUTPUT_TOKENS"], 2048),
      maxRevisionsPerDesign: int(env["DESIGN_MAX_REVISIONS"], 20),
      maxDesignsPerProject: int(env["DESIGN_MAX_PER_PROJECT"], 50),
      maxActivePerAccount: int(env["DESIGN_MAX_ACTIVE_PER_ACCOUNT"], 3),
    },
    operator: {
      elevationSeconds: int(env["OPERATOR_ELEVATION_SECONDS"], 900),
      stepUpWindowSeconds: int(env["OPERATOR_STEP_UP_WINDOW_SECONDS"], 300),
      adjustmentMaxMicrousd: BigInt(int(env["OPERATOR_ADJUSTMENT_MAX_MICROUSD"], Number(DEFAULT_ADJUSTMENT_BOUNDS.maxMicrousd))),
      adjustmentTtlSeconds: int(env["OPERATOR_ADJUSTMENT_TTL_SECONDS"], DEFAULT_ADJUSTMENT_BOUNDS.ttlSeconds),
      dailyLimitMicrousd: BigInt(int(env["OPERATOR_DAILY_LIMIT_MICROUSD"], 5_000_000_000)),
      stuckReservationSeconds: int(env["OPERATOR_STUCK_RESERVATION_SECONDS"], 3600),
      configuredUserIds: csv(env["OPERATOR_USER_IDS"], []),
    },
    testComponents,
    trustedProxies: csv(env["TRUSTED_PROXIES"], []),
    now: () => new Date(),
  };
  return { ...config, ...overrides };
}
