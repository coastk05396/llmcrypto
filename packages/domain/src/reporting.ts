/**
 * Read models for usage, agent runs and the ledger. The console endpoints AND the export worker call these same
 * functions, so a console page, a CSV/JSONL export and the ledger cannot drift apart: they are one query.
 *
 * Authorization is the caller's job (role, restricted key scope) and is expressed through the arguments here:
 * everything is scoped to `accountId`, and `keyId` narrows to one API key's own requests.
 * Ordering is (createdAt, id) ascending with keyset paging; `limit` is applied as given (callers ask for limit+1).
 */
import type { AgentRun, LedgerEntry, LedgerKind, RequestState, UsageDetail, UsageRecord } from "@llmcrypto/contracts";
import type { SqlExecutor } from "./sql";

export type Cursor = [Date, string];
export interface Row<T> {
  item: T;
  /** Keyset position of this row. */
  at: Date;
  key: string;
}

export interface UsageScope {
  accountId: string;
  /** Restrict to one API key's requests (API-key console sessions). */
  keyId?: string | null | undefined;
}
export interface UsageFilter {
  /** Internal exact lookup: request id or usage record id. */
  id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  model?: string | undefined;
  projectId?: string | undefined;
  keyId?: string | undefined;
  status?: RequestState | undefined;
  runId?: string | undefined;
}

interface UsageRow {
  id: string;
  request_id: string;
  correlation_id: string | null;
  run_id: string | null;
  parent_id: string | null;
  created_at: Date;
  model: string;
  project_id: string | null;
  key_id: string | null;
  state: RequestState;
  input_tokens: string;
  cached_input_tokens: string;
  output_tokens: string;
  charge: string;
  price_version_id: string;
}

/** `from` is inclusive, `to` exclusive. A scope key and a filter key must both match when both are given. */
export async function queryUsage(q: SqlExecutor, scope: UsageScope, f: UsageFilter, after: Cursor | null, limit: number): Promise<Row<UsageRecord>[]> {
  const rows = await q.query<UsageRow>(
    `select u.id, r.id as request_id, r.correlation_id, r.run_id, r.parent_id, r.created_at, r.model, r.project_id, r.key_id, r.state,
            u.input_tokens::text as input_tokens, u.cached_input_tokens::text as cached_input_tokens, u.output_tokens::text as output_tokens,
            u.charge_microusd::text as charge, u.price_version_id
     from requests r join usage_records u on u.request_id = r.id
     where r.account_id=$1 and ($2::text is null or r.key_id = $2)
       and ($3::timestamptz is null or r.created_at >= $3) and ($4::timestamptz is null or r.created_at < $4)
       and ($5::text is null or r.model = $5) and ($6::text is null or r.project_id = $6)
       and ($7::text is null or r.key_id = $7) and ($8::text is null or r.state = $8) and ($9::text is null or r.run_id = $9)
       and ($10::timestamptz is null or (r.created_at, r.id) > ($10::timestamptz, $11::text))
       and ($13::text is null or r.id=$13 or u.id=$13)
     order by r.created_at, r.id limit $12`,
    [scope.accountId, scope.keyId ?? null, f.from ?? null, f.to ?? null, f.model ?? null, f.projectId ?? null, f.keyId ?? null, f.status ?? null, f.runId ?? null, after?.[0] ?? null, after?.[1] ?? "", limit, f.id ?? null],
  );
  return rows.map((r) => ({
    at: r.created_at,
    key: r.request_id,
    item: {
      id: r.id, requestId: r.request_id, correlationId: r.correlation_id, runId: r.run_id, parentId: r.parent_id, createdAt: r.created_at.toISOString(),
      model: r.model, projectId: r.project_id, keyId: r.key_id, status: r.state, inputTokens: r.input_tokens, cachedInputTokens: r.cached_input_tokens,
      outputTokens: r.output_tokens, chargeMicrousd: r.charge, priceVersion: r.price_version_id,
    },
  }));
}

export async function queryUsageDetail(q: SqlExecutor, scope: UsageScope, id: string): Promise<UsageDetail | null> {
  const [usage] = await queryUsage(q, scope, { id }, null, 1);
  if (!usage) return null;
  const [r] = await q.query<{
    protocol: UsageDetail["protocol"]; stream: boolean; outcome: UsageDetail["outcome"]; failure_code: string | null;
    dispatched_at: Date | null; response_finished_at: Date | null; finished_at: Date | null; finish_reason: string | null;
    input_rate: string; cached_rate: string; output_rate: string; computed: string; absorbed: string; ledger_transaction_id: string | null;
  }>(`select r.protocol, r.stream, r.outcome, r.failure_code, r.dispatched_at, r.response_finished_at, r.finished_at, r.finish_reason,
       u.input_rate_microusd::text as input_rate, u.cached_input_rate_microusd::text as cached_rate,
       u.output_rate_microusd::text as output_rate, u.computed_charge_microusd::text as computed,
       u.absorbed_microusd::text as absorbed, u.ledger_transaction_id
       from requests r join usage_records u on u.request_id=r.id where r.id=$1`, [usage.item.requestId]);
  if (!r) return null;
  const ledger = await q.query<LedgerRow>(`select e.id, e.transaction_id, e.created_at, t.kind, e.amount::text as amount,
      t.source_type, t.source_id, t.price_version_id from ledger_entries e join ledger_transactions t on t.id=e.transaction_id
      where e.account_id=$1 and e.ledger_account='customer_funds' and t.source_type='request' and t.source_id=$2
      order by e.created_at, e.id`, [scope.accountId, usage.item.requestId]);
  return {
    ...usage.item, protocol: r.protocol, stream: r.stream, outcome: r.outcome, failureCode: r.failure_code,
    dispatchedAt: r.dispatched_at?.toISOString() ?? null, finishedAt: (r.response_finished_at ?? r.finished_at)?.toISOString() ?? null,
    latencyMs: r.response_finished_at && r.dispatched_at ? Math.max(0, r.response_finished_at.getTime() - r.dispatched_at.getTime()) : null,
    finishReason: r.finish_reason, rateSnapshot: { inputMicrousdPerMtok: r.input_rate, cachedInputMicrousdPerMtok: r.cached_rate, outputMicrousdPerMtok: r.output_rate },
    computedChargeMicrousd: r.computed, absorbedMicrousd: r.absorbed, ledgerTransactionId: r.ledger_transaction_id,
    ledgerEntries: ledger.map((e) => ({ id: e.id, transactionId: e.transaction_id, createdAt: e.created_at.toISOString(), kind: e.kind,
      amountMicrousd: e.amount, source: { type: e.source_type, id: e.source_id }, priceVersion: e.price_version_id })),
  };
}

export interface LedgerFilter {
  from?: string | undefined;
  to?: string | undefined;
  kind?: LedgerKind | undefined;
}
interface LedgerRow {
  id: string;
  transaction_id: string;
  created_at: Date;
  kind: LedgerEntry["kind"];
  amount: string;
  source_type: LedgerEntry["source"]["type"];
  source_id: string;
  price_version_id: string | null;
}

/** The customer's own funds postings (credits positive, spend negative). */
export async function queryLedger(q: SqlExecutor, accountId: string, f: LedgerFilter, after: Cursor | null, limit: number): Promise<Row<LedgerEntry>[]> {
  const rows = await q.query<LedgerRow>(
    `select e.id, e.transaction_id, e.created_at, t.kind, e.amount::text as amount, t.source_type, t.source_id, t.price_version_id
     from ledger_entries e join ledger_transactions t on t.id = e.transaction_id
     where e.ledger_account='customer_funds' and e.account_id=$1
       and ($2::timestamptz is null or e.created_at >= $2) and ($3::timestamptz is null or e.created_at < $3)
       and ($4::text is null or t.kind = $4)
       and ($5::timestamptz is null or (e.created_at, e.id) > ($5::timestamptz, $6::text))
     order by e.created_at, e.id limit $7`,
    [accountId, f.from ?? null, f.to ?? null, f.kind ?? null, after?.[0] ?? null, after?.[1] ?? "", limit],
  );
  return rows.map((r) => ({
    at: r.created_at,
    key: r.id,
    item: {
      id: r.id, transactionId: r.transaction_id, createdAt: r.created_at.toISOString(), kind: r.kind, amountMicrousd: r.amount,
      source: { type: r.source_type, id: r.source_id }, priceVersion: r.price_version_id,
    },
  }));
}

export interface AgentRunFilter {
  from?: string | undefined;
  to?: string | undefined;
  projectId?: string | undefined;
  keyId?: string | undefined;
}
interface RunRow {
  run_id: string | null;
  project_id: string | null;
  first_at: Date;
  last_at: Date;
  n: string;
  input_tokens: string;
  cached_input_tokens: string;
  output_tokens: string;
  charge: string;
  failed: string;
  pending: string;
  limited: string;
  gkey: string;
}

/** Refusals caused by a balance or cap limit (the failure_code the reservation step records). */
const LIMIT_CODES = ["INSUFFICIENT_FUNDS", "KEY_CAP_EXCEEDED", "PROJECT_CAP_EXCEEDED"];

/**
 * Requests grouped by (runId, projectId), ordered by first request time. Requests without a run id are NOT merged into a
 * guessed task: they form one explicit `unknown` group per project.
 */
export async function queryAgentRuns(q: SqlExecutor, scope: UsageScope, f: AgentRunFilter, after: Cursor | null, limit: number): Promise<Row<AgentRun>[]> {
  const rows = await q.query<RunRow>(
    `select r.run_id, r.project_id, min(r.created_at) as first_at, max(r.created_at) as last_at, count(*)::text as n,
            coalesce(sum(u.input_tokens),0)::text as input_tokens, coalesce(sum(u.cached_input_tokens),0)::text as cached_input_tokens,
            coalesce(sum(u.output_tokens),0)::text as output_tokens, coalesce(sum(u.charge_microusd),0)::text as charge,
            count(*) filter (where r.state in ('FAILED','CANCELLED') and not (coalesce(r.failure_code,'') = any($9::text[])))::text as failed,
            count(*) filter (where r.state = 'USAGE_PENDING')::text as pending,
            count(*) filter (where coalesce(r.failure_code,'') = any($9::text[]))::text as limited,
            coalesce(r.run_id,'') || chr(31) || coalesce(r.project_id,'') as gkey
     from requests r join usage_records u on u.request_id = r.id
     where r.account_id=$1 and ($2::text is null or r.key_id = $2)
       and ($3::timestamptz is null or r.created_at >= $3) and ($4::timestamptz is null or r.created_at < $4)
       and ($5::text is null or r.project_id = $5) and ($6::text is null or r.key_id = $6)
     group by r.run_id, r.project_id
     having ($7::timestamptz is null or (min(r.created_at), coalesce(r.run_id,'') || chr(31) || coalesce(r.project_id,'')) > ($7::timestamptz, $8::text))
     order by first_at, gkey limit $10`,
    [scope.accountId, scope.keyId ?? null, f.from ?? null, f.to ?? null, f.projectId ?? null, f.keyId ?? null, after?.[0] ?? null, after?.[1] ?? "", LIMIT_CODES, limit],
  );
  return rows.map((r) => ({
    at: r.first_at,
    key: r.gkey,
    item: {
      runId: r.run_id, correlation: r.run_id === null ? "unknown" : "known", projectId: r.project_id, requestCount: r.n,
      firstAt: r.first_at.toISOString(), lastAt: r.last_at.toISOString(), inputTokens: r.input_tokens, cachedInputTokens: r.cached_input_tokens,
      outputTokens: r.output_tokens, chargeMicrousd: r.charge, failedCount: r.failed, pendingCount: r.pending, limitRejectedCount: r.limited,
    },
  }));
}

/** Roles that read account-wide usage / the ledger (SPEC: ledger is the billing role; the owner also holds it). */
export const USAGE_READ_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "billing"]);
export const LEDGER_READ_ROLES: ReadonlySet<string> = new Set(["owner", "billing"]);
/** An export carries exactly the rows the same caller could read on the console, so it needs the same role. */
export const canExport = (kind: "usage" | "ledger", role: string): boolean => (kind === "usage" ? USAGE_READ_ROLES : LEDGER_READ_ROLES).has(role);
