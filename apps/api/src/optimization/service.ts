/**
 * Optimization policy storage and the per-request plan the gateway and the preview endpoint share.
 * Policies are append-only versions (db/migrations/007). A stored config that no longer parses fails closed to the
 * all-off defaults (reported with the stored version), never to a looser reading.
 */
import { DEFAULT_OPTIMIZATION_CONFIG, OptimizationConfig, type OptimizationPolicy } from "@llmcrypto/contracts";
import { applyInjection, decideLoop, fingerprintInput, type EvidenceDraft, type LoopDecision, type MemoryUseDraft, type Msg, type NoteInput, type SqlExecutor, type TaggedMsg } from "@llmcrypto/domain";
import { hmacHex } from "../crypto";

interface PolicyRow {
  version: number;
  config: unknown;
  reverted_from: number | null;
  note: string | null;
  created_by_user_id: string;
  created_at: Date;
}
const POLICY_COLS = "version, config, reverted_from, note, created_by_user_id, created_at";

export const defaultPolicy = (): OptimizationPolicy => ({ version: 0, config: DEFAULT_OPTIMIZATION_CONFIG, createdAt: null, createdByUserId: null, revertedFrom: null, note: null });

export function toPolicy(r: PolicyRow): OptimizationPolicy {
  const parsed = OptimizationConfig.safeParse(r.config);
  return {
    version: r.version,
    config: parsed.success ? parsed.data : DEFAULT_OPTIMIZATION_CONFIG,
    createdAt: r.created_at.toISOString(),
    createdByUserId: r.created_by_user_id,
    revertedFrom: r.reverted_from,
    note: r.note,
  };
}

export async function loadPolicy(q: SqlExecutor, accountId: string): Promise<OptimizationPolicy> {
  const [r] = await q.query<PolicyRow>(`select ${POLICY_COLS} from optimization_policies where account_id=$1 order by version desc limit 1`, [accountId]);
  return r ? toPolicy(r) : defaultPolicy();
}
export async function loadPolicyVersion(q: SqlExecutor, accountId: string, version: number): Promise<OptimizationPolicy | undefined> {
  if (version === 0) return defaultPolicy();
  const [r] = await q.query<PolicyRow>(`select ${POLICY_COLS} from optimization_policies where account_id=$1 and version=$2`, [accountId, version]);
  return r ? toPolicy(r) : undefined;
}
export { POLICY_COLS };
export type { PolicyRow };

export interface EvidenceRow extends EvidenceDraft {
  fingerprint?: string;
  scopeKey?: string;
}

export interface PlanArgs {
  accountId: string;
  projectId: string | null;
  model: string;
  messages: readonly Msg[];
  optOut: boolean;
  /** Run id, else key id. null = repeats are not evaluated (preview). */
  loopScope: string | null;
  digestSecret: string;
  now: Date;
}
export interface Plan {
  policyVersion: number;
  messages: TaggedMsg[];
  evidence: EvidenceRow[];
  memory: MemoryUseDraft[];
  /** Set when an enforced LoopGuard stops the request. Only the loop evidence is then recorded. */
  blocked: EvidenceRow | null;
  /** Set for an advisory trigger so the caller can surface a response header. */
  advisory: LoopDecision | null;
}

/** Notes that may be injected: inject-flagged, unexpired, oldest first. */
export async function eligibleNotes(q: SqlExecutor, projectId: string, accountId: string, now: Date, limit: number): Promise<NoteInput[]> {
  const rows = await q.query<{ id: string; version: number; text: string }>(
    `select m.id, m.version, m.text from project_memories m
       left join project_memory_settings s on s.project_id = m.project_id
      where m.project_id=$1 and m.account_id=$2 and m.inject
        and (s.retention_days is null or m.updated_at + make_interval(days => s.retention_days) > $3)
      order by m.created_at, m.seq limit $4`,
    [projectId, accountId, now, limit],
  );
  return rows;
}

export async function countPriorRepeats(q: SqlExecutor, accountId: string, scopeKey: string, fingerprint: string, since: Date): Promise<number> {
  const [r] = await q.query<{ n: string }>(
    "select count(*)::text as n from optimization_evidence where account_id=$1 and feature='loop_guard' and scope_key=$2 and fingerprint=$3 and created_at > $4",
    [accountId, scopeKey, fingerprint, since],
  );
  return Number(r?.n ?? "0");
}

/** Decides what the policy does to one request. Reads only; persisting the evidence is the caller's job. */
export async function planOptimization(q: SqlExecutor, a: PlanArgs): Promise<Plan> {
  const policy = await loadPolicy(q, a.accountId);
  const cfg = policy.config;
  const notes = cfg.projectContext.enabled && a.projectId ? await eligibleNotes(q, a.projectId, a.accountId, a.now, 50) : [];
  const inj = applyInjection({ config: cfg, messages: a.messages, notes, hasProject: a.projectId !== null, optOut: a.optOut });
  const plan: Plan = { policyVersion: policy.version, messages: inj.messages, evidence: [...inj.evidence], memory: inj.memory, blocked: null, advisory: null };

  if (cfg.loopGuard.enabled) {
    if (a.loopScope === null) {
      plan.evidence.push({ feature: "loop_guard", status: "skipped", reason: "repeats_not_evaluated_here", detail: {} });
    } else {
      const fingerprint = hmacHex(a.digestSecret, `loopguard|${fingerprintInput(a.model, a.messages)}`);
      const since = new Date(a.now.getTime() - cfg.loopGuard.windowSeconds * 1000);
      const prior = await countPriorRepeats(q, a.accountId, a.loopScope, fingerprint, since);
      const d = decideLoop(cfg.loopGuard, prior);
      const row: EvidenceRow = { feature: "loop_guard", status: d.status, reason: d.reason, detail: d.detail, fingerprint, scopeKey: a.loopScope };
      if (d.status === "blocked") {
        plan.blocked = row;
        return plan;
      }
      if (d.status === "advisory") plan.advisory = d;
      plan.evidence.push(row);
    }
  }
  return plan;
}

export async function insertEvidence(q: SqlExecutor, newId: (p: string) => string, accountId: string, requestId: string, policyVersion: number, rows: readonly EvidenceRow[], at: Date): Promise<void> {
  for (const e of rows) {
    await q.query(
      `insert into optimization_evidence (id, account_id, request_id, policy_version, feature, status, reason, detail, fingerprint, scope_key, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [newId("oev"), accountId, requestId, policyVersion, e.feature, e.status, e.reason, JSON.stringify(e.detail), e.fingerprint ?? null, e.scopeKey ?? null, at],
    );
  }
}
export async function insertMemoryUse(q: SqlExecutor, newId: (p: string) => string, accountId: string, projectId: string, requestId: string, rows: readonly MemoryUseDraft[], at: Date): Promise<void> {
  for (const m of rows) {
    await q.query(
      "insert into memory_usage (id, account_id, project_id, memory_id, version, request_id, status, reason, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [newId("mus"), accountId, projectId, m.memoryId, m.version, requestId, m.status, m.reason, at],
    );
  }
}
