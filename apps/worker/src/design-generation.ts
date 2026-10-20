/**
 * Design beta generation job. The API queues a `design_revisions` row (status queued); this runner claims it and makes ONE
 * metered model call through the gateway reservation path (./metered-completion), validates the output as untrusted text and
 * stores the result. Generated text is never executed, rendered as markup or deployed.
 *
 * - A claim is a conditional UPDATE with a lease, so two runners cannot generate one revision.
 * - There is no retry after the provider may have accepted work (a second call would be a second charge). A runner that died
 *   mid-generation leaves a `generating` row whose lease expires; the sweeper then fails it as INTERRUPTED and releases a hold
 *   that was never dispatched. A dispatched request is left to the usage reconcile job (USAGE_PENDING / stale dispatch sweep).
 * - Failure releases the hold when nothing was accepted (refusal, rejection). Malformed output after a successful call is
 *   charged (the provider did the work and reported usage) and recorded as MALFORMED_OUTPUT. UNCONFIRMED commercial policy.
 */
import { DesignDocument } from "@llmcrypto/contracts";
import { buildDesignMessages, failWithoutCharge, parseDesignOutput, type SqlDb } from "@llmcrypto/domain";
import { meteredComplete, type CompletionProvider } from "./metered-completion";

export interface DesignGenerationOptions {
  db: SqlDb;
  provider: CompletionProvider;
  now: () => Date;
  newId: (prefix: string) => string;
  ensurePrices: () => Promise<void>;
  /** Context window of a catalog model, or null when unknown (the revision then fails). */
  contextWindowOf: (model: string) => number | null;
  maxOutputTokens: number;
  timeoutMs: number;
  usagePendingSeconds: number;
  leaseSeconds?: number;
}
export interface DesignGenerationReport {
  succeeded: string[];
  failed: string[];
  interrupted: string[];
  errors: { revisionId: string; message: string }[];
}

interface Claimed {
  id: string;
  design_id: string;
  account_id: string;
  number: number;
  kind: "proposal" | "revision";
  instruction: string | null;
  model: string;
}

export const designRequestId = (revisionId: string): string => `req_${revisionId}`;

const FAILURE_MESSAGES: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Not enough available credit to cover this generation's maximum cost; nothing was charged",
  KEY_CAP_EXCEEDED: "A spend cap would be exceeded; nothing was charged",
  PROJECT_CAP_EXCEEDED: "The project's spend cap would be exceeded; nothing was charged",
  KEY_UNUSABLE: "The generation could not be reserved; nothing was charged",
  PRICING_UNAVAILABLE: "No price is effective for this model; nothing was charged",
  ESTIMATION_UNAVAILABLE: "Cost cannot be bounded safely for this model; nothing was charged",
  CONTEXT_EXCEEDED: "The brief and previous proposal are too large for this model's context window; nothing was charged",
  PROVIDER_REJECTED: "The provider rejected the request; nothing was charged",
  PROVIDER_TIMEOUT: "The provider timed out; any usage will be reconciled and the hold is kept until then",
  UPSTREAM_ERROR: "The provider failed; any usage will be reconciled",
  INTERRUPTED: "Generation was interrupted before it finished; any usage will be reconciled",
};

async function finish(o: DesignGenerationOptions, c: Claimed, r: { document: DesignDocument | null; code: string | null; message: string | null; requestId: string | null }): Promise<void> {
  const at = o.now();
  await o.db.tx(async (q) => {
    const rows = await q.query<{ account_id: string }>(
      `update design_revisions set status=$2, document=$3::jsonb, failure_code=$4, failure_message=$5, request_id=coalesce($6, request_id), finished_at=$7, lease_until=null
        where id=$1 and status='generating' returning account_id`,
      [c.id, r.document ? "succeeded" : "failed", r.document ? JSON.stringify(r.document) : null, r.code, r.message, r.requestId, at],
    );
    if (!rows.length) return; // the design was deleted or the row was swept
    await q.query("update designs set updated_at=$2 where id=$1", [c.design_id, at]);
    await q.query(
      "insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,null,$3,'design',$4,$5::jsonb,$6)",
      [o.newId("aud"), c.account_id, r.document ? "design.generated" : "design.generation_failed", c.design_id, JSON.stringify({ revision: c.number, ...(r.code ? { code: r.code } : {}) }), at],
    );
  });
}

async function runOne(o: DesignGenerationOptions, c: Claimed): Promise<"succeeded" | "failed"> {
  const [d] = await o.db.query<{ project_id: string; title: string; brief: string }>("select project_id, title, brief from designs where id=$1", [c.design_id]);
  if (!d) return "failed"; // deleted while queued; the revision row is gone with it
  let previous: DesignDocument | undefined;
  if (c.kind === "revision") {
    const [p] = await o.db.query<{ document: unknown }>(
      "select document from design_revisions where design_id=$1 and status='succeeded' and number < $2 order by number desc limit 1",
      [c.design_id, c.number],
    );
    const parsed = DesignDocument.safeParse(p?.document);
    if (parsed.success) previous = parsed.data;
  }
  const window = o.contextWindowOf(c.model);
  const requestId = designRequestId(c.id);
  if (window === null) {
    await finish(o, c, { document: null, code: "PRICING_UNAVAILABLE", message: FAILURE_MESSAGES["PRICING_UNAVAILABLE"]!, requestId: null });
    return "failed";
  }
  const out = await meteredComplete({
    db: o.db, provider: o.provider, requestId, accountId: c.account_id, projectId: d.project_id, runId: `design:${c.design_id}`, correlationId: c.id,
    model: c.model, contextWindowTokens: window,
    messages: buildDesignMessages({ title: d.title, brief: d.brief, previous, instruction: c.instruction ?? undefined }),
    maxOutputTokens: o.maxOutputTokens, timeoutMs: o.timeoutMs, usagePendingSeconds: o.usagePendingSeconds, ensurePrices: o.ensurePrices, now: o.now, newId: o.newId,
    onReserved: async () => {
      await o.db.query("update design_revisions set request_id=$2 where id=$1 and status='generating'", [c.id, requestId]);
    },
  });
  const [reqRow] = await o.db.query("select id from requests where id=$1", [requestId]);
  const rid = reqRow ? requestId : null;
  switch (out.status) {
    case "refused":
      await finish(o, c, { document: null, code: out.reason, message: FAILURE_MESSAGES[out.reason] ?? "The generation could not be reserved; nothing was charged", requestId: rid });
      return "failed";
    case "rejected":
      await finish(o, c, { document: null, code: "PROVIDER_REJECTED", message: FAILURE_MESSAGES["PROVIDER_REJECTED"]!, requestId: rid });
      return "failed";
    case "failed_charged":
    case "failed_pending":
      await finish(o, c, { document: null, code: out.code, message: FAILURE_MESSAGES[out.code] ?? "The provider failed", requestId: rid });
      return "failed";
    case "completed":
    case "completed_pending": {
      const parsed = parseDesignOutput(out.text);
      if (!parsed.ok) {
        const cut = out.finishReason === "length" ? "; the output was cut off at the token cap" : "";
        await finish(o, c, { document: null, code: "MALFORMED_OUTPUT", message: `The model's output was not a valid design (${parsed.reason}${cut}). The call was made and is billed as reported.`, requestId: rid });
        return "failed";
      }
      await finish(o, c, { document: parsed.document, code: null, message: null, requestId: rid });
      return "succeeded";
    }
  }
}

/** Fails `generating` rows whose runner is gone. Releases a hold that never reached the provider. */
async function sweep(o: DesignGenerationOptions, report: DesignGenerationReport): Promise<void> {
  const at = o.now();
  const stale = await o.db.query<Claimed>(
    "select id, design_id, account_id, number, kind, instruction, model from design_revisions where status='generating' and lease_until <= $1",
    [at],
  );
  for (const c of stale) {
    const rid = designRequestId(c.id);
    const [r] = await o.db.query<{ state: string }>("select state from requests where id=$1", [rid]);
    if (r && (r.state === "RESERVED" || r.state === "VALIDATED")) await failWithoutCharge(o.db, rid, { code: "INTERRUPTED", at, onlyUndispatched: true });
    await finish(o, c, { document: null, code: "INTERRUPTED", message: FAILURE_MESSAGES["INTERRUPTED"]!, requestId: r ? rid : null });
    report.interrupted.push(c.id);
  }
}

export async function runDesignGenerations(o: DesignGenerationOptions): Promise<DesignGenerationReport> {
  const report: DesignGenerationReport = { succeeded: [], failed: [], interrupted: [], errors: [] };
  await sweep(o, report);
  for (;;) {
    const at = o.now();
    const [c] = await o.db.query<Claimed>(
      `update design_revisions set status='generating', started_at=$1, lease_until=$2
        where id = (select id from design_revisions where status='queued' order by created_at, id limit 1) and status='queued'
        returning id, design_id, account_id, number, kind, instruction, model`,
      [at, new Date(at.getTime() + (o.leaseSeconds ?? 300) * 1000)],
    );
    if (!c) break;
    try {
      const outcome = await runOne(o, c);
      (outcome === "succeeded" ? report.succeeded : report.failed).push(c.id);
    } catch (e) {
      // Left `generating`: the sweeper fails it once the lease expires. It is never re-run (no second provider call).
      report.errors.push({ revisionId: c.id, message: e instanceof Error ? e.message : "unknown" });
    }
  }
  return report;
}
