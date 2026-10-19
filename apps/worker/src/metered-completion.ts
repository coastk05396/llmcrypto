/**
 * One metered, non-streaming model call on the SAME reservation path the gateway uses (domain requests/reservations/ledger),
 * for server-side features that have no API key (design generation). Rules, identical to apps/api/src/gateway/dispatch.ts:
 *  - the hold is made before the provider is called; nothing is called when the hold is refused;
 *  - exactly one provider call: no retry after possible acceptance;
 *  - a provider that definitively rejected releases the hold (no charge); a call that ended without verified usage becomes
 *    USAGE_PENDING (hold kept for the reconcile job, never an assumed zero charge); verified usage is charged exactly once;
 *  - only metadata is stored, never prompt or completion text.
 */
import {
  beginRequest, failWithoutCharge, getActiveRates, markDispatched, markUsagePending, recordRequestFinish, reservationUpperBound, settleRequest,
  type ReserveRefusal, type SqlDb, type TokenUsage,
} from "@llmcrypto/domain";

export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  text: string;
}
export interface CompletionResult {
  text: string;
  finishReason: string;
  /** null = the provider did not report usage. */
  usage: TokenUsage | null;
}
/** The slice of the gateway Provider interface this module needs (apps/api Provider satisfies it structurally). */
export interface CompletionProvider {
  inputTokenUpperBound(model: string, texts: readonly string[]): bigint | null;
  complete(req: { providerRequestId: string; model: string; messages: CompletionMessage[]; maxOutputTokens: number }, signal: AbortSignal): Promise<CompletionResult>;
}

export interface MeteredCall {
  db: SqlDb;
  provider: CompletionProvider;
  requestId: string;
  accountId: string;
  projectId: string | null;
  runId: string | null;
  correlationId: string | null;
  model: string;
  contextWindowTokens: number;
  messages: CompletionMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  usagePendingSeconds: number;
  /** Registers the price version(s) the model is priced under (idempotent). */
  ensurePrices: () => Promise<void>;
  now: () => Date;
  newId: (prefix: string) => string;
  /** Called once the hold exists, before the provider is called (records the request id on the caller's row). */
  onReserved?: (info: { reservedMicrousd: bigint }) => Promise<void>;
}

export type MeteredOutcome =
  | { status: "completed"; text: string; finishReason: string; chargeMicrousd: bigint; reservedMicrousd: bigint }
  /** Text arrived but the provider reported no usage: nothing is charged yet, the hold stays for reconciliation. */
  | { status: "completed_pending"; text: string; finishReason: string; reservedMicrousd: bigint }
  | { status: "refused"; reason: ReserveRefusal | "PRICING_UNAVAILABLE" | "ESTIMATION_UNAVAILABLE" | "CONTEXT_EXCEEDED" }
  /** Provider rejected before accepting work: hold released, no charge. */
  | { status: "rejected"; reservedMicrousd: bigint }
  /** Provider failed after possibly accepting work and reported usage: charged for it. */
  | { status: "failed_charged"; code: string; chargeMicrousd: bigint; reservedMicrousd: bigint }
  /** Provider failed/timed out with no usage: hold kept (USAGE_PENDING) for the reconcile job. */
  | { status: "failed_pending"; code: string; reservedMicrousd: bigint };

const ABORT_GRACE_MS = 1000;

const faultOf = (e: unknown): { kind: "rejected" | "upstream" | "aborted"; usage: TokenUsage | null } | null => {
  if (typeof e !== "object" || e === null) return null;
  const o = e as { kind?: unknown; usage?: unknown };
  return o.kind === "rejected" || o.kind === "upstream" || o.kind === "aborted" ? { kind: o.kind, usage: (o.usage as TokenUsage | null | undefined) ?? null } : null;
};

export async function meteredComplete(c: MeteredCall): Promise<MeteredOutcome> {
  await c.ensurePrices();
  const now = c.now();
  const rates = await getActiveRates(c.db, c.model, now);
  if (!rates) return { status: "refused", reason: "PRICING_UNAVAILABLE" };
  const bound = c.provider.inputTokenUpperBound(c.model, c.messages.map((m) => m.text));
  if (bound === null) return { status: "refused", reason: "ESTIMATION_UNAVAILABLE" };
  if (bound + BigInt(c.maxOutputTokens) > BigInt(c.contextWindowTokens)) return { status: "refused", reason: "CONTEXT_EXCEEDED" };
  const reserved = reservationUpperBound(bound, BigInt(c.maxOutputTokens), rates);

  const begin = await beginRequest(c.db, {
    id: c.requestId, accountId: c.accountId, keyId: null, projectId: c.projectId, runId: c.runId, parentId: null, correlationId: c.correlationId,
    protocol: "openai_chat", model: c.model, stream: false, rates, reservedMicrousd: reserved, at: now, newId: c.newId,
  });
  if (!begin.ok) return { status: "refused", reason: begin.reason };
  if (c.onReserved) await c.onReserved({ reservedMicrousd: reserved });

  const providerRequestId = `prov_${c.requestId}`;
  await markDispatched(c.db, c.requestId, providerRequestId, c.now());

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, c.timeoutMs);
  const grace = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener("abort", () => void setTimeout(() => reject(Object.assign(new Error("aborted"), { kind: "aborted", usage: null })), ABORT_GRACE_MS).unref(), { once: true });
  });
  grace.catch(() => undefined);
  const deadline = (): Date => new Date(c.now().getTime() + c.usagePendingSeconds * 1000);
  try {
    const call = c.provider.complete({ providerRequestId, model: c.model, messages: c.messages, maxOutputTokens: c.maxOutputTokens }, ctl.signal);
    call.catch(() => undefined);
    const res = await Promise.race([call, grace]);
    await recordRequestFinish(c.db, c.requestId, res.finishReason, c.now());
    if (res.usage) {
      const s = await settleRequest(c.db, { requestId: c.requestId, usage: res.usage, outcome: "succeeded", at: c.now(), newId: c.newId });
      const charge = s.status === "settled" ? s.chargeMicrousd : 0n;
      return { status: "completed", text: res.text, finishReason: res.finishReason, chargeMicrousd: charge, reservedMicrousd: reserved };
    }
    await markUsagePending(c.db, c.requestId, { code: "USAGE_MISSING", deadline: deadline(), at: c.now() });
    return { status: "completed_pending", text: res.text, finishReason: res.finishReason, reservedMicrousd: reserved };
  } catch (e) {
    await recordRequestFinish(c.db, c.requestId, null, c.now());
    const f = faultOf(e);
    if (f?.kind === "rejected") {
      await failWithoutCharge(c.db, c.requestId, { code: "PROVIDER_REJECTED", at: c.now() });
      return { status: "rejected", reservedMicrousd: reserved };
    }
    const code = timedOut ? "PROVIDER_TIMEOUT" : "UPSTREAM_ERROR";
    if (f?.usage) {
      const s = await settleRequest(c.db, { requestId: c.requestId, usage: f.usage, outcome: "failed", failureCode: code, at: c.now(), newId: c.newId });
      return { status: "failed_charged", code, chargeMicrousd: s.status === "settled" ? s.chargeMicrousd : 0n, reservedMicrousd: reserved };
    }
    await markUsagePending(c.db, c.requestId, { code, deadline: deadline(), at: c.now() });
    return { status: "failed_pending", code, reservedMicrousd: reserved };
  } finally {
    clearTimeout(timer);
  }
}
