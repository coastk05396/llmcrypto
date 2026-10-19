/**
 * Optimization controls: policy (append-only versions), control catalog, request preview, evidence and report.
 * Every control is opt-in and off by default. Nothing here claims a saving: cache accounting prices recorded usage,
 * guidance/context injection reports bytes added, route comparison is an estimate, LoopGuard counts triggers.
 * No endpoint stores or returns prompt bodies, except that /preview echoes back the messages the caller just sent.
 */
import { Hono } from "hono";
import {
  EvidenceQuery, OptimizationControlList, OptimizationEvidenceList, OptimizationPolicy, OptimizationPolicyVersionList,
  OptimizationReport, OptimizationReportQuery, PolicyVersionQuery, PreviewOptimizationRequest, PreviewOptimizationResponse,
  RevertOptimizationPolicyRequest, UpdateOptimizationPolicyRequest,
  type OptimizationConfig, type OptimizationEvidence, type OptimizationFeature,
} from "@llmcrypto/contracts";
import { canManageProjects, canUseMemory, chargeFor, enablesSensitiveControl, getActiveRates, utf8Total, validateOptimizationConfig, type Msg } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireRecentSignIn, requireSecret, requireSession, type AuthContext } from "../auth/session";
import { filterCatalog, findCatalogModel } from "../catalog/routes";
import type { AppConfig } from "../config";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db, Queryable } from "../db";
import { ApiError, parseBody, parseWith, type AppEnv, type Ctx } from "../http";
import { POLICY_COLS, defaultPolicy, loadPolicy, loadPolicyVersion, planOptimization, toPolicy, type PolicyRow } from "./service";

export interface OptimizationDeps {
  db: Db;
  config: AppConfig;
}

const CONTROLS = OptimizationControlList.parse({
  items: [
    { id: "cache_accounting", feature: "cache_accounting", title: "Prompt-cache accounting", availability: "available", unavailableReason: null,
      description: "Reports the cached input tokens your provider already reports for each request, and what they cost compared with the same tokens at the full input rate.",
      privacyImpact: "None. Reads token counts already stored with each request; nothing is added to prompts.",
      tradeoff: "Accounting only. It does not cause any caching and does not change latency or routing." },
    { id: "concise_guidance", feature: "concise_guidance", title: "Concise guidance", availability: "available", unavailableReason: null,
      description: "Prepends a short system message that you write, to every request that does not opt out with X-Optimize: off.",
      privacyImpact: "Your guidance text is stored in the policy and sent to the model provider with every request.",
      tradeoff: "Adds input tokens to every request (you pay for them). Whether answers become shorter depends on the model and is not measured here, so no saving is claimed." },
    { id: "project_context", feature: "project_context", title: "Project context injection", availability: "available", unavailableReason: null,
      description: "Prepends the inject-flagged project notes of the request's project (X-Project-Id or the key's project), oldest first, within your note and character budget.",
      privacyImpact: "Notes you saved with storage consent are sent to the model provider on requests for that project only. Each use is recorded as evidence.",
      tradeoff: "Adds input tokens. Notes are reference data, not instructions. Other projects' notes are never used." },
    { id: "route_comparison", feature: "route_comparison", title: "Route comparison", availability: "available", unavailableReason: null,
      description: "Shows what a request's recorded token usage would have cost on other catalog models offered on the same protocol, at current rates.",
      privacyImpact: "None.",
      tradeoff: "Informational estimate only. The gateway never switches model or route, and other models may answer differently." },
    { id: "batching", feature: "batching", title: "Batching", availability: "unavailable",
      unavailableReason: "No provider batch API is integrated, so a queue/latency tradeoff cannot be delivered. Enabling it is refused.",
      description: "Would queue non-urgent requests to run as a provider batch at a lower price.",
      privacyImpact: "Requests would be held server-side until the batch runs.",
      tradeoff: "Would add minutes to hours of latency. Not implemented." },
    { id: "loop_guard", feature: "loop_guard", title: "LoopGuard", availability: "available", unavailableReason: null,
      description: "Notices the same request repeated within a run (or key) inside a time window. Advisory by default: it only records evidence and sets a response header. Enforcement blocks the request at your threshold and needs explicit consent.",
      privacyImpact: "A keyed digest of each request is kept for the window length to recognise repeats; prompt text is not stored.",
      tradeoff: "Enforcement can block legitimate retries (HTTP 429 loop_guard_blocked, nothing charged). Pick a threshold you accept." },
  ],
});

type Role = AuthContext["role"];
const mayChange = (role: Role): boolean => canManageProjects(role);

interface EvRow {
  id: string;
  seq: string;
  request_id: string;
  policy_version: number;
  feature: OptimizationFeature;
  status: OptimizationEvidence["status"];
  reason: string | null;
  detail: Record<string, string | number | boolean | null>;
  created_at: Date;
  model: string | null;
  protocol: string | null;
  usage_source: string | null;
  input_tokens: string | null;
  cached_tokens: string | null;
  output_tokens: string | null;
  charge: string | null;
}

async function toEvidence(q: Queryable, r: EvRow, now: Date): Promise<OptimizationEvidence> {
  const detail = { ...r.detail };
  let routeComparison: OptimizationEvidence["routeComparison"] = null;
  const hasUsage = r.usage_source === "provider" && r.input_tokens !== null && r.cached_tokens !== null && r.output_tokens !== null;
  if (r.feature === "cache_accounting" || r.feature === "route_comparison") {
    if (!hasUsage) detail["usage"] = "insufficient_data";
    else if (r.feature === "cache_accounting") {
      detail["usage"] = "recorded";
      detail["inputTokens"] = r.input_tokens;
      detail["cachedInputTokens"] = r.cached_tokens;
      detail["outputTokens"] = r.output_tokens;
    } else if (r.model && r.protocol) {
      detail["usage"] = "recorded";
      const usage = { inputTokens: BigInt(r.input_tokens!), cachedInputTokens: BigInt(r.cached_tokens!), outputTokens: BigInt(r.output_tokens!) };
      const alternatives: { model: string; estimatedChargeMicrousd: string }[] = [];
      for (const m of filterCatalog({})) {
        if (m.id === r.model || !(m.protocols as string[]).includes(r.protocol)) continue;
        const rates = await getActiveRates(q, m.id, now);
        if (rates) alternatives.push({ model: m.id, estimatedChargeMicrousd: chargeFor(usage, rates).toString() });
      }
      routeComparison = { basis: "recorded_usage_at_current_rates", actualChargeMicrousd: r.charge ?? "0", alternatives };
    }
  }
  return { id: r.id, requestId: r.request_id, policyVersion: r.policy_version, feature: r.feature, status: r.status, reason: r.reason, detail, routeComparison, createdAt: r.created_at.toISOString() };
}

export function optimizationRoutes({ db, config }: OptimizationDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession(db, config));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/controls", (c) => c.json(CONTROLS));

  app.get("/policy", async (c) => c.json(OptimizationPolicy.parse(await loadPolicy(db, c.get("auth").accountId))));

  /** Appends version N+1 under a row lock; the caller proves it saw version N (expectedVersion). */
  async function appendVersion(c: Ctx, auth: AuthContext, expectedVersion: number, build: (q: Queryable, cur: OptimizationPolicy) => Promise<{ config: OptimizationConfig; revertedFrom: number | null; note: string | null }>): Promise<OptimizationPolicy> {
    const now = config.now();
    return db.tx(async (q) => {
      await q.query("select id from accounts where id=$1 for update", [auth.accountId]);
      const cur = await loadPolicy(q, auth.accountId);
      if (cur.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", `Policy is at version ${cur.version}; reload and retry`);
      const next = await build(q, cur);
      const issues = validateOptimizationConfig(next.config);
      if (issues.length) throw new ApiError("VALIDATION_FAILED", "Request validation failed", issues);
      if (JSON.stringify(next.config) === JSON.stringify(cur.config)) return cur; // unchanged: no new version
      if (enablesSensitiveControl(cur.config, next.config)) requireRecentSignIn(auth, config);
      const version = cur.version + 1;
      await q.query(
        "insert into optimization_policies (account_id, version, config, reverted_from, note, created_by_user_id, created_at) values ($1,$2,$3::jsonb,$4,$5,$6,$7)",
        [auth.accountId, version, JSON.stringify(next.config), next.revertedFrom, next.note, auth.userId, now],
      );
      const changed = (Object.keys(next.config) as (keyof OptimizationConfig)[]).filter((k) => JSON.stringify(next.config[k]) !== JSON.stringify(cur.config[k]));
      await audit(q, {
        accountId: auth.accountId, actorUserId: auth.userId, action: next.revertedFrom === null ? "optimization.policy_updated" : "optimization.policy_reverted",
        targetType: "optimization_policy", targetId: String(version), requestId: c.get("requestId"), at: now,
        metadata: { version, changed: changed.join(","), ...(next.revertedFrom === null ? {} : { revertedFrom: next.revertedFrom }), loopGuardEnforced: next.config.loopGuard.enabled && next.config.loopGuard.mode === "enforce" },
      });
      const [row] = await q.query<PolicyRow>(`select ${POLICY_COLS} from optimization_policies where account_id=$1 and version=$2`, [auth.accountId, version]);
      return toPolicy(row!);
    });
  }

  app.put("/policy", async (c) => {
    const auth = c.get("auth");
    if (!mayChange(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const body = await parseBody(c, UpdateOptimizationPolicyRequest);
    const policy = await appendVersion(c, auth, body.expectedVersion, async () => ({ config: body.config, revertedFrom: null, note: body.note ?? null }));
    return c.json(OptimizationPolicy.parse(policy));
  });

  app.post("/policy/revert", async (c) => {
    const auth = c.get("auth");
    if (!mayChange(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const body = await parseBody(c, RevertOptimizationPolicyRequest);
    const policy = await appendVersion(c, auth, body.expectedVersion, async (q) => {
      const old = await loadPolicyVersion(q, auth.accountId, body.toVersion);
      if (!old) throw new ApiError("NOT_FOUND", "Policy version not found");
      return { config: old.config, revertedFrom: body.toVersion, note: `Revert to version ${body.toVersion}` };
    });
    return c.json(OptimizationPolicy.parse(policy));
  });

  app.get("/policy/versions", async (c) => {
    const auth = c.get("auth");
    const q = parseWith(PolicyVersionQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null; // keyset on (createdAt, version-as-id), newest first
    const rows = await db.query<PolicyRow>(
      `select ${POLICY_COLS} from optimization_policies where account_id=$1 and ($2::timestamptz is null or (created_at, version) < ($2::timestamptz, $3::int))
       order by created_at desc, version desc limit $4`,
      [auth.accountId, after?.[0] ?? null, Number(after?.[1] ?? "0"), q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const items = page.map(toPolicy);
    if (rows.length <= q.limit) items.push(defaultPolicy()); // the implicit baseline is the oldest entry
    return c.json(OptimizationPolicyVersionList.parse({ items, nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, String(last.version)) : null }));
  });

  app.post("/preview", async (c) => {
    const auth = c.get("auth");
    if (!canUseMemory(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
    const body = await parseBody(c, PreviewOptimizationRequest);
    if (!findCatalogModel(body.model)) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "model", message: `Unknown model "${body.model}"` }]);
    if (body.projectId !== undefined) {
      const [p] = await db.query("select 1 as x from projects where id=$1 and account_id=$2", [body.projectId, auth.accountId]);
      if (!p) throw new ApiError("NOT_FOUND", "Project not found");
    }
    const original: Msg[] = body.messages.map((m) => ({ role: m.role, text: m.content }));
    const plan = await planOptimization(db, {
      accountId: auth.accountId, projectId: body.projectId ?? null, model: body.model, messages: original, optOut: false, loopScope: null,
      digestSecret: requireSecret(config.apiKeyPepper, "API_KEY_HASH_PEPPER"), now: config.now(),
    });
    return c.json(PreviewOptimizationResponse.parse({
      policyVersion: plan.policyVersion,
      changes: plan.evidence.map((e) => ({ feature: e.feature, status: e.status, reason: e.reason, detail: e.detail })),
      messages: plan.messages.map((m) => ({ role: m.role, content: m.text, origin: m.origin })),
      originalUtf8Bytes: String(utf8Total(original)),
      alteredUtf8Bytes: String(utf8Total(plan.messages)),
    }));
  });

  app.get("/evidence", async (c) => {
    const auth = c.get("auth");
    const q = parseWith(EvidenceQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<EvRow>(
      `select e.id, e.seq::text as seq, e.request_id, e.policy_version, e.feature, e.status, e.reason, e.detail, e.created_at,
              r.model, r.protocol, u.usage_source, u.input_tokens::text as input_tokens, u.cached_input_tokens::text as cached_tokens,
              u.output_tokens::text as output_tokens, u.charge_microusd::text as charge
         from optimization_evidence e
         left join requests r on r.id = e.request_id and r.account_id = e.account_id
         left join usage_records u on u.request_id = r.id
        where e.account_id=$1 and ($2::text is null or e.request_id=$2) and ($3::text is null or e.feature=$3) and ($4::text is null or e.status=$4)
          and ($5::timestamptz is null or (e.created_at, e.seq) < ($5::timestamptz, $6::bigint))
        order by e.created_at desc, e.seq desc limit $7`,
      [auth.accountId, q.requestId ?? null, q.feature ?? null, q.status ?? null, after?.[0] ?? null, after?.[1] ?? "0", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const now = config.now();
    const items = [];
    for (const r of page) items.push(await toEvidence(db, r, now));
    return c.json(OptimizationEvidenceList.parse({ items, nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.seq) : null }));
  });

  app.get("/report", async (c) => {
    const auth = c.get("auth");
    const q = parseWith(OptimizationReportQuery, c.req.query());
    const from = q.from ?? null;
    const to = q.to ?? null;
    const win = "e.account_id=$1 and ($2::timestamptz is null or e.created_at >= $2) and ($3::timestamptz is null or e.created_at < $3)";
    const p = [auth.accountId, from, to];

    // Cache accounting: same recorded tokens, priced with and without the cached discount, each at its own rate snapshot.
    // Only settled requests with provider-reported usage and no overrun clamp are comparable.
    const [cache] = await db.query<{ n: string; i: string | null; c: string | null; o: string | null; baseline: string | null; actual: string | null }>(
      `select count(*)::text n, sum(u.input_tokens)::text i, sum(u.cached_input_tokens)::text c, sum(u.output_tokens)::text o,
              sum(ceil(((u.input_tokens + u.cached_input_tokens) * u.input_rate_microusd + u.output_tokens * u.output_rate_microusd) / 1000000::numeric))::text baseline,
              sum(u.charge_microusd)::text actual
         from optimization_evidence e join requests r on r.id=e.request_id and r.account_id=e.account_id join usage_records u on u.request_id=r.id
        where ${win} and e.feature='cache_accounting' and e.status='applied' and r.state='SETTLED' and u.usage_source='provider' and u.absorbed_microusd=0`,
      p,
    );
    const nCache = BigInt(cache?.n ?? "0");
    const [enabledCache] = await db.query<{ n: string }>(`select count(*)::text n from optimization_evidence e where ${win} and e.feature='cache_accounting' and e.status='applied'`, p);
    const cacheReport =
      nCache === 0n
        ? { status: "insufficient_data" as const, reason: BigInt(enabledCache?.n ?? "0") === 0n ? "No request ran with cache accounting enabled in this period." : "No settled request with provider-reported usage yet.", requests: "0" }
        : {
            status: "ok" as const, requests: nCache.toString(), inputTokens: cache!.i ?? "0", cachedInputTokens: cache!.c ?? "0", outputTokens: cache!.o ?? "0",
            baselineMicrousd: cache!.baseline ?? "0", actualMicrousd: cache!.actual ?? "0", differenceMicrousd: (BigInt(cache!.baseline ?? "0") - BigInt(cache!.actual ?? "0")).toString(),
          };

    const injection = async (feature: string): Promise<{ appliedRequests: string; addedUtf8Bytes: string }> => {
      const [r] = await db.query<{ n: string; b: string | null }>(
        `select count(*)::text n, sum((e.detail->>'addedUtf8Bytes')::numeric)::text b from optimization_evidence e where ${win} and e.feature=$4 and e.status='applied'`, [...p, feature]);
      return { appliedRequests: r?.n ?? "0", addedUtf8Bytes: r?.b ?? "0" };
    };
    const [rc] = await db.query<{ n: string }>(
      `select count(*)::text n from optimization_evidence e join usage_records u on u.request_id=e.request_id where ${win} and e.feature='route_comparison' and e.status='applied' and u.usage_source='provider'`, p);
    const [lg] = await db.query<{ adv: string; blk: string }>(
      `select count(*) filter (where status='advisory')::text adv, count(*) filter (where status='blocked')::text blk from optimization_evidence e where ${win} and e.feature='loop_guard'`, p);

    return c.json(OptimizationReport.parse({
      period: { from, to },
      cacheAccounting: cacheReport,
      conciseGuidance: { status: "insufficient_data", reason: "Guidance changes the prompt; the cost without it is not observable, so no baseline exists.", ...(await injection("concise_guidance")) },
      projectContext: { status: "insufficient_data", reason: "Injected notes change the prompt; the cost without them is not observable, so no baseline exists.", ...(await injection("project_context")) },
      routeComparison: { status: "informational", evaluatedRequests: rc?.n ?? "0" },
      loopGuard: { advisoryRequests: lg?.adv ?? "0", blockedRequests: lg?.blk ?? "0", note: "Counts of triggers. A blocked request was never sent, so no saving is claimed." },
    }));
  });

  return app;
}
