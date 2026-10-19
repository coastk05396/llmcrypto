import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ErrorEnvelope,
  IDEMPOTENT_OPERATIONS,
  PageQuery,
  decideIdempotency,
  schemaRegistry,
  type SchemaName,
} from "@llmcrypto/contracts";

const dir = new URL("../../packages/contracts/", import.meta.url);
const readJson = (p: string): unknown => JSON.parse(readFileSync(new URL(p, dir), "utf8"));

interface SuccessCase {
  name: string;
  operation: string;
  kind: "request" | "response";
  status?: number;
  schema: SchemaName;
  body: unknown;
}
interface ErrorCase {
  name: string;
  status: number;
  retryAfterSeconds?: number;
  body: unknown;
}
const success = (readJson("fixtures/success.json") as { cases: SuccessCase[] }).cases;
const errors = (readJson("fixtures/errors.json") as { cases: ErrorCase[] }).cases;

interface OpenApi {
  openapi: string;
  paths: Record<string, Record<string, { operationId?: string; parameters?: { $ref?: string }[] }>>;
  components: { schemas: Record<string, { enum?: string[] }> };
}
const oas = parse(readFileSync(new URL("openapi.yaml", dir), "utf8")) as OpenApi;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "oas", components: oas.components });
const oasValidate = (name: string, body: unknown): boolean =>
  (ajv.getSchema(`oas#/components/schemas/${name}`) ?? (() => { throw new Error(`no OpenAPI schema ${name}`); })())(body) as boolean;

describe("success fixtures", () => {
  it.each(success)("$name validates against zod and OpenAPI ($schema)", (c) => {
    expect(schemaRegistry[c.schema].safeParse(c.body).success).toBe(true);
    expect(oasValidate(c.schema, c.body)).toBe(true);
  });

  it("every operationId in OpenAPI has a fixture, and every fixture operation exists", () => {
    const ids = Object.values(oas.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    const covered = new Set(success.map((c) => c.operation));
    for (const id of covered) expect(ids).toContain(id);
    // operations with bodies; bodiless ones (getSession is covered by SessionView via createWalletSession).
    const bodiless = new Set(["getSession", "deleteSession", "unlinkIdentity", "listIdentities", "revokeKey", "getCatalog", "getBalance", "listKeys", "getDeposit", "listUsage", "listLedger", "getJob", "unlinkPassword", "unlinkTelegram", "downloadJob", "deleteMemory", "unpairBinding", "deleteRepositoryImport", "deleteDesign", "endOperatorSession", "listModels", "createChatCompletion", "createResponse", "createMessage", "generateContentNotImplemented"]);
    for (const id of ids) if (id && !bodiless.has(id)) expect(covered.has(id)).toBe(true);
  });
});

describe("error fixtures and code table", () => {
  it.each(errors)("$name matches envelope and mapped status", (c) => {
    const parsed = ErrorEnvelope.parse(c.body);
    expect(c.status).toBe(ERROR_CODES[parsed.error.code].status);
    expect(oasValidate("ErrorEnvelope", c.body)).toBe(true);
    if (c.status === 429) expect(c.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("has a fixture for every error code", () => {
    const seen = new Set(errors.map((c) => (c.body as ErrorEnvelope).error.code));
    expect([...seen].sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });

  it("OpenAPI ErrorCode enum equals the shared table", () => {
    expect([...(oas.components.schemas["ErrorCode"]?.enum ?? [])].sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });

  it("only uses the documented status families", () => {
    for (const { status } of Object.values(ERROR_CODES)) expect([400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]).toContain(status);
    expect(ERROR_CODES.INSUFFICIENT_FUNDS.status).toBe(409);
  });
});

describe("OpenAPI document", () => {
  it("is 3.1 and every $ref resolves", () => {
    expect(oas.openapi).toBe("3.1.0");
    const text = readFileSync(new URL("openapi.yaml", dir), "utf8");
    const refs = [...text.matchAll(/\$ref: '#\/components\/(\w+)\/(\w+)'/g)];
    expect(refs.length).toBeGreaterThan(20);
    const components = oas.components as unknown as Record<string, Record<string, unknown>>;
    for (const m of refs) expect(components[m[1]!]?.[m[2]!], m[0]).toBeDefined();
  });

  it("every registry schema has an OpenAPI component", () => {
    for (const name of Object.keys(schemaRegistry)) expect(oas.components.schemas[name], name).toBeDefined();
  });

  it("idempotent operations require the Idempotency-Key parameter", () => {
    const withKey = Object.values(oas.paths)
      .flatMap((p) => Object.values(p))
      .filter((o) => o.parameters?.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"))
      .map((o) => o.operationId);
    expect(withKey.sort()).toEqual(["createDeposit", "createDesign", "createDesignRevision", "createExport", "createKey", "createRepositoryImport", "proposeAdjustment"]);
    expect(IDEMPOTENT_OPERATIONS).toContain("ledgerMutation");
  });
});

describe("invalid input is rejected", () => {
  const bad: [SchemaName, unknown][] = [
    ["Balance", { availableMicrousd: 1.5, heldMicrousd: "0", postedMicrousd: "0", asOf: "2026-10-18T12:00:00Z" }],
    ["Balance", { availableMicrousd: "1.5", heldMicrousd: "0", postedMicrousd: "0", asOf: "2026-10-18T12:00:00Z" }],
    ["Balance", { availableMicrousd: "-1", heldMicrousd: "0", postedMicrousd: "0", asOf: "2026-10-18T12:00:00Z" }],
    ["Balance", { availableMicrousd: "007", heldMicrousd: "0", postedMicrousd: "0", asOf: "2026-10-18T12:00:00Z" }],
    ["WalletChallengeRequest", { protocol: "btc", address: "x", chainId: "1" }],
    ["CreateMemoryRequest", { text: "x", storageConsent: false }],
    ["UpdateMemoryRequest", { text: "x", expectedVersion: 1, storageConsent: false }],
    ["UpdateMemoryRequest", { text: "x", expectedVersion: 0, storageConsent: true }],
    ["UpdateMemorySettingsRequest", { retentionDays: 0, expectedVersion: 0 }],
    ["UpdateMemorySettingsRequest", { retentionDays: 366, expectedVersion: 0 }],
    ["CreateProjectRequest", { name: "" }],
    ["CreateProjectRequest", { name: "ok", extra: true }],
    ["RevertOptimizationPolicyRequest", { toVersion: -1, expectedVersion: 0 }],
    ["UpdateOptimizationPolicyRequest", { expectedVersion: 0, config: { cacheAccounting: { enabled: true } } }],
    ["PreviewOptimizationRequest", { model: "m", messages: [] }],
    ["CreatePairingRequest", { channel: "sms" }],
    ["ConfirmPairingRequest", { events: ["not_an_event"] }],
    ["UpdateBindingRequest", { events: ["test"] }],
    ["CreateKeyResponse", { secretStatus: "NON_RECOVERABLE", secret: "leak", key: {} }],
    ["ErrorEnvelope", { error: { code: "NOPE", message: "m", requestId: "r" } }],
    ["PasswordSetupRequest", { username: "ab", password: "a long enough password" }],
    ["PasswordSetupRequest", { username: "alice.dev", password: "short" }],
    ["KeySessionRequest", {}],
    ["TelegramVerifyRequest", {}],
    ["Job", { jobId: "job_1", status: "succeeded", downloadUrl: "https://elsewhere.test/x" }],
    // draft-0.5 beta/operator additions
    ["CreateDesignRequest", { title: "t", brief: "too short" }],
    ["CreateDesignRequest", { title: "t", brief: "a long enough brief for design", extra: 1 }],
    ["CreateDesignRevisionRequest", { instruction: "ok instruction", baseRevision: 0 }],
    ["CreateDesignRevisionRequest", { instruction: "ok instruction" }],
    ["Design", { id: "d", projectId: "p", title: "t", brief: "b", model: "m", latestRevision: 1, totalChargedMicrousd: "0", aiGenerated: false, revisions: [], createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z" }],
    ["DesignExport", { format: "llmcrypto-design-export-v1", label: "reviewed and approved", exportedAt: "2026-10-18T12:00:00Z", design: { id: "d", projectId: "p", title: "t", brief: "b" }, revision: { number: 1, kind: "proposal", instruction: null, createdAt: "2026-10-18T12:00:00Z" }, generation: { model: "m", requestId: null, chargedMicrousd: null }, document: { title: "t", summary: "s", sections: [{ heading: "h", body: "b" }], components: [], risks: [] } }],
    ["ProposeAdjustmentRequest", { action: "credit", amountMicrousd: "-5", reason: "a sufficiently long reason" }],
    ["ProposeAdjustmentRequest", { action: "credit", amountMicrousd: "5", reason: "short" }],
    ["ProposeAdjustmentRequest", { action: "transfer", amountMicrousd: "5", reason: "a sufficiently long reason" }],
    ["ProposeAdjustmentRequest", { action: "credit", amountMicrousd: "5", reason: "a sufficiently long reason", ledgerAccount: "revenue" }],
    ["DecideAdjustmentRequest", { reason: "ok", approvedBy: "me" }],
    ["ResolveAlertRequest", { note: "x" }],
    ["Adjustment", { id: "a", accountId: null, action: "credit", amountMicrousd: "5", reason: "r", reviewId: null, proposedBy: "u", status: "applied", decidedBy: null, decisionReason: null, ledgerTransactionId: null, createdAt: "2026-10-18T12:00:00Z", expiresAt: "2026-10-18T12:00:00Z", decidedAt: null }],
    ["AuditEventList", { items: [{ id: "a", action: "x", actor: "admin", actorUserId: null, targetType: null, targetId: null, details: {}, createdAt: "2026-10-18T12:00:00Z" }], nextCursor: null }],
    ["RepositoryImport", { id: "r", projectId: "p", name: "n", format: "rar", status: "queued", uploadBytes: "1", stats: null, error: null, limits: { maxArchiveBytes: 1, maxEntries: 1, maxFiles: 1, maxTotalBytes: 1, maxFileBytes: 1, maxPathBytes: 1, maxDepth: 1, maxRatio: 1, maxEdges: 1 }, createdAt: "2026-10-18T12:00:00Z", startedAt: null, finishedAt: null }],
    ["RepositoryEdgeList", { items: [{ id: "e", from: "a.ts", line: 0, kind: "import", specifier: "x", to: { kind: "file", path: "b.ts", name: null }, snippet: "s", language: "typescript" }], nextCursor: null }],
    ["RepositoryEdgeList", { items: [{ id: "e", from: "a.ts", line: 1, kind: "call", specifier: "x", to: { kind: "file", path: "b.ts", name: null }, snippet: "s", language: "typescript" }], nextCursor: null }],
    ["RepositoryGraph", { importId: "r", depth: 9, nodes: [], edges: [], external: [] }],
    ["FeatureFlags", { repositoryGraph: "yes", designBeta: true }],
  ];
  it.each(bad)("%s rejects %j (zod and OpenAPI agree)", (name, body) => {
    expect(schemaRegistry[name].safeParse(body).success).toBe(false);
    expect(oasValidate(name, body)).toBe(false);
  });
});

describe("optimization config bounds (zod and OpenAPI agree)", () => {
  const ok = success.find((c) => c.operation === "updateOptimizationPolicy" && c.kind === "request")!.body as { expectedVersion: number; config: Record<string, Record<string, unknown>> };
  const withLoop = (patch: Record<string, unknown>) => ({ ...ok, config: { ...ok.config, loopGuard: { ...ok.config["loopGuard"], ...patch } } });
  it.each([{ threshold: 1 }, { threshold: 1001 }, { windowSeconds: 59 }, { mode: "block" }, { enforcementConsent: "yes" }])("rejects loopGuard %j", (patch) => {
    expect(schemaRegistry.UpdateOptimizationPolicyRequest.safeParse(withLoop(patch)).success).toBe(false);
    expect(oasValidate("UpdateOptimizationPolicyRequest", withLoop(patch))).toBe(false);
  });
  it("rejects unknown config keys", () => {
    const body = { ...ok, config: { ...ok.config, autoCache: { enabled: true } } };
    expect(schemaRegistry.UpdateOptimizationPolicyRequest.safeParse(body).success).toBe(false);
    expect(oasValidate("UpdateOptimizationPolicyRequest", body)).toBe(false);
  });
});

describe("list paging and idempotency semantics", () => {
  it("defaults limit to 50 and caps at 200", () => {
    expect(PageQuery.parse({}).limit).toBe(50);
    expect(PageQuery.parse({ limit: "200" }).limit).toBe(200);
    expect(PageQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("decides execute / replay / conflict / in-progress", () => {
    expect(decideIdempotency(undefined, "h1")).toEqual({ action: "execute" });
    expect(decideIdempotency({ state: "completed", payloadHash: "h1", result: { a: 1 } }, "h1")).toEqual({ action: "replay", result: { a: 1 } });
    expect(decideIdempotency({ state: "completed", payloadHash: "h1", result: 1 }, "h2")).toEqual({ action: "reject", code: "IDEMPOTENCY_CONFLICT" });
    expect(decideIdempotency({ state: "in_flight", payloadHash: "h1" }, "h1")).toEqual({ action: "reject", code: "IN_PROGRESS" });
    expect(decideIdempotency({ state: "in_flight", payloadHash: "h1" }, "h2")).toEqual({ action: "reject", code: "IDEMPOTENCY_CONFLICT" });
  });
});
