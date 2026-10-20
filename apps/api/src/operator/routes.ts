/**
 * Operator workflows, mounted under /api/operator. See docs/operations/reconciliation.md.
 *
 * Authorization is layered and separate from customer roles: signed-in session -> operator grant (out-of-band) -> a live
 * per-session elevation. The only routes that do not need the elevation are GET/POST/DELETE /session (they establish it).
 * Customers never see these routes' data; a customer's wallet or membership role confers nothing here.
 *
 * Money moves only through append-only adjustments with dual control:
 *   propose (operator A) -> decide (operator B != A, unexpired, once) -> the ledger transaction posts in the SAME database
 *   transaction as the decision. Proposals and decisions are immutable rows; the database itself refuses a decision by the
 *   proposer. Resolving a payment review (credit or reject) is just such an adjustment linked to the review.
 * Every step writes an audit event; events that concern a customer account are visible in that customer's audit view with
 * the operator's identity withheld.
 */
import { Hono } from "hono";
import {
  Adjustment, AdjustmentList, AdjustmentQuery, DecideAdjustmentRequest, LedgerMismatchList, OperatorSession, PaymentAlert, PaymentAlertList, PaymentAlertQuery,
  PaymentReview, PaymentReviewList, PaymentReviewQuery, ProposeAdjustmentRequest, ReconciliationSummary, ResolveAlertRequest, StuckReservationList,
} from "@llmcrypto/contracts";
import {
  activeHolds, adjustmentStatus, availableFunds, canDecide, creditPostings, debitPostings, findLedgerMismatches, findStuckReservations, postedBalance,
  postTransaction, validateProposal,
} from "@llmcrypto/domain";
import { microusdForAtomic } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireSession } from "../auth/session";
import { decodeSeq, encodeSeq, payloadHash, runIdempotent } from "../beta";
import type { AppConfig } from "../config";
import { randomId } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db } from "../db";
import { ApiError, parseBody, parseWith, type AppEnv, type Ctx } from "../http";
import { isOperator, requireOperator } from "./service";

export interface OperatorDeps {
  db: Db;
  config: AppConfig;
}

const LIST_CAP = 200;

interface AdjRow {
  id: string;
  seq: string;
  account_id: string | null;
  action: "credit" | "debit" | "reject_review";
  amount: string;
  reason: string;
  review_id: string | null;
  proposed_by: string;
  created_at: Date;
  expires_at: Date;
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decision_reason: string | null;
  ledger_transaction_id: string | null;
  decided_at: Date | null;
}
const ADJ_SELECT = `select a.id, a.seq::text as seq, a.account_id, a.action, a.amount_microusd::text as amount, a.reason, a.review_id, a.proposed_by_user_id as proposed_by,
       a.created_at, a.expires_at, d.decision, d.decided_by_user_id as decided_by, d.reason as decision_reason, d.ledger_transaction_id, d.created_at as decided_at
  from operator_adjustments a left join operator_adjustment_decisions d on d.adjustment_id = a.id`;

const toAdjustment = (r: AdjRow, now: Date): Adjustment =>
  Adjustment.parse({
    id: r.id, accountId: r.account_id, action: r.action, amountMicrousd: r.amount, reason: r.reason, reviewId: r.review_id, proposedBy: r.proposed_by,
    status: adjustmentStatus(r.decision ? { decision: r.decision } : null, r.expires_at, now), decidedBy: r.decided_by, decisionReason: r.decision_reason,
    ledgerTransactionId: r.ledger_transaction_id, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null,
  });

interface ReviewRow {
  id: string;
  kind: PaymentReview["kind"];
  reason: string;
  status: "open" | "resolved";
  account_id: string | null;
  deposit_id: string | null;
  chain_event_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
  resolved_at: Date | null;
  resolution: string | null;
}
const REVIEW_COLS = "id, kind, reason, status, account_id, deposit_id, chain_event_id, details, created_at, resolved_at, resolution";
const toReview = (r: ReviewRow): PaymentReview =>
  PaymentReview.parse({
    id: r.id, kind: r.kind, reason: r.reason, status: r.status, accountId: r.account_id, depositId: r.deposit_id, chainEventId: r.chain_event_id, details: r.details,
    createdAt: r.created_at.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null, resolution: r.resolution,
  });

export function operatorRoutes({ db, config }: OperatorDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const op = requireOperator(db, config, { elevated: true });
  const opNoElevation = requireOperator(db, config, { elevated: false });

  const noStore = async (c: Ctx, next: () => Promise<void>): Promise<void> => {
    c.header("Cache-Control", "no-store");
    await next();
  };
  app.use("*", noStore);

  // ---------------------------------------------------------------- session / elevation
  async function sessionState(c: Ctx): Promise<OperatorSession> {
    const auth = c.get("auth");
    const operator = await isOperator(db, auth.userId);
    const [e] = operator ? await db.query<{ expires_at: Date }>("select expires_at from operator_elevations where session_id=$1 and user_id=$2 and expires_at > $3", [auth.sessionId, auth.userId, config.now()]) : [];
    return OperatorSession.parse({ isOperator: operator, elevated: Boolean(e), elevatedUntil: e?.expires_at.toISOString() ?? null });
  }
  app.get("/session", requireSession(db, config), async (c) => c.json(await sessionState(c)));

  app.post("/session", ...opNoElevation, async (c) => {
    const auth = c.get("auth");
    const now = config.now();
    // Stricter than the customer step-up window: the operator must have signed in (or stepped up) moments ago.
    if (now.getTime() - auth.authenticatedAt.getTime() > config.operator.stepUpWindowSeconds * 1000) throw new ApiError("STEP_UP_REQUIRED", `Sign in again: operator access needs authentication within the last ${config.operator.stepUpWindowSeconds} seconds`);
    const expires = new Date(now.getTime() + config.operator.elevationSeconds * 1000);
    await db.tx(async (q) => {
      await q.query(
        `insert into operator_elevations (session_id, user_id, verified_at, expires_at) values ($1,$2,$3,$4)
         on conflict (session_id) do update set verified_at=excluded.verified_at, expires_at=excluded.expires_at`,
        [auth.sessionId, auth.userId, now, expires],
      );
      await audit(q, { accountId: null, actorUserId: auth.userId, action: "operator.elevated", targetType: "session", targetId: auth.sessionId, requestId: c.get("requestId"), at: now });
    });
    return c.json(await sessionState(c));
  });

  app.delete("/session", ...opNoElevation, async (c) => {
    const auth = c.get("auth");
    await db.query("delete from operator_elevations where session_id=$1", [auth.sessionId]);
    await audit(db, { accountId: null, actorUserId: auth.userId, action: "operator.elevation_ended", targetType: "session", targetId: auth.sessionId, requestId: c.get("requestId"), at: config.now() });
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- reconciliation views
  app.get("/reconciliation", ...op, async (c) => {
    const now = config.now();
    const [n] = await db.query<{ reviews: string; alerts: string; pending: string }>(
      `select (select count(*) from payment_reviews where status='open')::text as reviews,
              (select count(*) from payment_alerts where resolved_at is null)::text as alerts,
              (select count(*) from operator_adjustments a where a.expires_at > $1 and not exists (select 1 from operator_adjustment_decisions d where d.adjustment_id = a.id))::text as pending`,
      [now],
    );
    const stuck = await findStuckReservations(db, now, config.operator.stuckReservationSeconds, 1000);
    const mismatches = await findLedgerMismatches(db, 1000);
    return c.json(ReconciliationSummary.parse({
      generatedAt: now.toISOString(), openReviews: Number(n?.reviews ?? 0), openAlerts: Number(n?.alerts ?? 0), stuckReservations: stuck.length,
      ledgerMismatches: mismatches.length, pendingAdjustments: Number(n?.pending ?? 0),
    }));
  });

  app.get("/payment-reviews", ...op, async (c) => {
    const q = parseWith(PaymentReviewQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<ReviewRow>(
      `select ${REVIEW_COLS} from payment_reviews where status=$1 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text)) order by created_at, id limit $4`,
      [q.status, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(PaymentReviewList.parse({ items: page.map(toReview), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }));
  });

  app.get("/payment-alerts", ...op, async (c) => {
    const q = parseWith(PaymentAlertQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<{ id: string; kind: string; severity: "info" | "warning" | "critical"; account_id: string | null; deposit_id: string | null; details: Record<string, unknown>; created_at: Date; resolved_at: Date | null }>(
      `select id, kind, severity, account_id, deposit_id, details, created_at, resolved_at from payment_alerts
        where (resolved_at is not null) = ($1 = 'true') and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text)) order by created_at, id limit $4`,
      [q.resolved, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const item = (r: (typeof rows)[number]) => ({ id: r.id, kind: r.kind, severity: r.severity, accountId: r.account_id, depositId: r.deposit_id, details: r.details, createdAt: r.created_at.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null });
    return c.json(PaymentAlertList.parse({ items: page.map(item), nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null }));
  });

  app.post("/payment-alerts/:id/resolve", ...op, async (c) => {
    const auth = c.get("auth");
    const body = await parseBody(c, ResolveAlertRequest);
    const now = config.now();
    const row = await db.tx(async (q) => {
      const [r] = await q.query<{ id: string; kind: string; severity: "info" | "warning" | "critical"; account_id: string | null; deposit_id: string | null; details: Record<string, unknown>; created_at: Date; resolved_at: Date | null }>(
        "update payment_alerts set resolved_at=$2 where id=$1 and resolved_at is null returning id, kind, severity, account_id, deposit_id, details, created_at, resolved_at",
        [c.req.param("id"), now],
      );
      if (!r) throw new ApiError("NOT_FOUND", "Open alert not found");
      await audit(q, { accountId: r.account_id, actorUserId: auth.userId, action: "operator.alert_resolved", targetType: "payment_alert", targetId: r.id, requestId: c.get("requestId"), at: now, metadata: { kind: r.kind, note: body.note } });
      return r;
    });
    return c.json(PaymentAlert.parse({ id: row.id, kind: row.kind, severity: row.severity, accountId: row.account_id, depositId: row.deposit_id, details: row.details, createdAt: row.created_at.toISOString(), resolvedAt: row.resolved_at?.toISOString() ?? null }));
  });

  app.get("/stuck-reservations", ...op, async (c) => {
    const rows = await findStuckReservations(db, config.now(), config.operator.stuckReservationSeconds, LIST_CAP + 1);
    return c.json(StuckReservationList.parse({ items: rows.slice(0, LIST_CAP).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), truncated: rows.length > LIST_CAP }));
  });

  app.get("/ledger-mismatches", ...op, async (c) => {
    const rows = await findLedgerMismatches(db, LIST_CAP + 1);
    return c.json(LedgerMismatchList.parse({ items: rows.slice(0, LIST_CAP), truncated: rows.length > LIST_CAP }));
  });

  // ---------------------------------------------------------------- adjustments (dual control)
  app.get("/adjustments", ...op, async (c) => {
    const q = parseWith(AdjustmentQuery, c.req.query());
    const now = config.now();
    const after = q.cursor ? decodeSeq(q.cursor) : "0";
    const rows = await db.query<AdjRow>(
      `${ADJ_SELECT} where a.seq > $1::bigint and ($2::text is null or a.account_id = $2)
         and ($3::text is null or (case when d.decision is not null then d.decision when a.expires_at <= $4 then 'expired' else 'pending' end) = $3)
       order by a.seq limit $5`,
      [after, q.accountId ?? null, q.status ?? null, now, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(AdjustmentList.parse({ items: page.map((r) => toAdjustment(r, now)), nextCursor: rows.length > q.limit && last ? encodeSeq(last.seq) : null }));
  });

  app.post("/adjustments", ...op, async (c) => {
    const auth = c.get("auth");
    const body = await parseBody(c, ProposeAdjustmentRequest);
    const now = config.now();
    const amount = body.amountMicrousd === undefined ? null : BigInt(body.amountMicrousd);

    let review: ReviewRow | undefined;
    if (body.reviewId !== undefined) {
      [review] = await db.query<ReviewRow>(`select ${REVIEW_COLS} from payment_reviews where id=$1`, [body.reviewId]);
      if (!review) throw new ApiError("NOT_FOUND", "Payment review not found");
      if (review.status !== "open") throw new ApiError("VERSION_CONFLICT", "That payment review is already resolved");
    }
    let accountId = body.accountId ?? null;
    if (body.action === "reject_review") {
      if (accountId !== null && accountId !== (review?.account_id ?? null)) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "accountId", message: "must be omitted or match the review's account" }]);
      accountId = review?.account_id ?? null;
    } else {
      if (accountId === null) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "accountId", message: "is required for credit and debit" }]);
      if (review && review.account_id !== accountId) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "reviewId", message: "the review belongs to a different account (or to none)" }]);
    }
    if (accountId !== null) {
      const [acct] = await db.query("select 1 as x from accounts where id=$1", [accountId]);
      if (!acct) throw new ApiError("NOT_FOUND", "Account not found");
    }
    const [member] = accountId ? await db.query("select 1 as x from memberships where account_id=$1 and user_id=$2", [accountId, auth.userId]) : [];
    const issues = validateProposal({ action: body.action, amountMicrousd: amount, reviewId: body.reviewId ?? null, proposerIsMember: Boolean(member) }, { maxMicrousd: config.operator.adjustmentMaxMicrousd, ttlSeconds: config.operator.adjustmentTtlSeconds });
    if (issues.length) throw new ApiError("VALIDATION_FAILED", "Request validation failed", issues);
    if (body.action === "credit" && review && amount !== null) {
      // A review credit is bounded by what the reviewed transfer is actually worth (same conversion the deposit path uses), never by what the operator types.
      const [v] = await db.query<{ amount_atomic: string; decimals: number; rate: string }>(
        `select e.amount_atomic::text as amount_atomic, i.decimals, i.microusd_per_token::text as rate
           from payment_reviews r join chain_events e on e.id = r.chain_event_id join deposit_intents i on i.id = r.deposit_id where r.id=$1`,
        [review.id],
      );
      if (!v) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "reviewId", message: "this review has no transfer value to credit; reject it instead" }]);
      const worth = microusdForAtomic(BigInt(v.amount_atomic), v.decimals, BigInt(v.rate));
      if (amount > worth) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "amountMicrousd", message: `must not exceed the reviewed transfer's value (${worth.toString()} micro-USD)` }]);
    }

    return runIdempotent(
      c,
      { db, config, accountId: auth.accountId, operation: "proposeAdjustment", hash: payloadHash(body) },
      async (q) => {
        if (body.reviewId) {
          const [locked] = await q.query<{ status: string }>("select status from payment_reviews where id=$1 for update", [body.reviewId]);
          if (locked?.status !== "open") throw new ApiError("VERSION_CONFLICT", "That payment review is already resolved");
          const [dup] = await q.query(
            "select 1 as x from operator_adjustments a where a.review_id=$1 and a.expires_at > $2 and not exists (select 1 from operator_adjustment_decisions d where d.adjustment_id = a.id)",
            [body.reviewId, now],
          );
          if (dup) throw new ApiError("VERSION_CONFLICT", "A proposal for this payment review is already pending");
        }
        const id = randomId("adj");
        const expires = new Date(now.getTime() + config.operator.adjustmentTtlSeconds * 1000);
        await q.query(
          `insert into operator_adjustments (id, account_id, action, amount_microusd, reason, review_id, proposed_by_user_id, created_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, accountId, body.action, (amount ?? 0n).toString(), body.reason, body.reviewId ?? null, auth.userId, now, expires],
        );
        await audit(q, {
          accountId, actorUserId: auth.userId, action: "operator.adjustment_proposed", targetType: "adjustment", targetId: id, requestId: c.get("requestId"), at: now,
          metadata: { adjustmentId: id, action: body.action, amountMicrousd: (amount ?? 0n).toString(), reason: body.reason, reviewId: body.reviewId ?? null },
        });
        const [row] = await q.query<AdjRow>(`${ADJ_SELECT} where a.id=$1`, [id]);
        return { status: 201, body: toAdjustment(row!, now), result: { adjustmentId: id } };
      },
      async (r) => {
        const [row] = await db.query<AdjRow>(`${ADJ_SELECT} where a.id=$1`, [String(r["adjustmentId"] ?? "")]);
        if (!row) throw new ApiError("NOT_FOUND", "The original proposal no longer exists");
        return { status: 201, body: toAdjustment(row, now) };
      },
    );
  });

  async function decide(c: Ctx, decision: "approved" | "rejected"): Promise<Response> {
    const auth = c.get("auth");
    const body = await parseBody(c, DecideAdjustmentRequest);
    const id = c.req.param("id") ?? "";
    const now = config.now();
    const out = await db.tx(async (q) => {
      const [a] = await q.query<AdjRow>(`${ADJ_SELECT} where a.id=$1`, [id]);
      if (!a) throw new ApiError("NOT_FOUND", "Adjustment not found");
      // Lock the deposit before its review, matching ingestion's order. Approval must not race a
      // replacement payment or another review of this same on-chain event.
      let linkedReview: ReviewRow | undefined;
      if (a.review_id) {
        [linkedReview] = await q.query<ReviewRow>(`select ${REVIEW_COLS} from payment_reviews where id=$1`, [a.review_id]);
        if (linkedReview?.deposit_id) await q.query("select id from deposit_intents where id=$1 for update", [linkedReview.deposit_id]);
        await q.query("select id from payment_reviews where id=$1 for update", [a.review_id]);
      }
      // Serialise decisions: the account row (credit/debit) or the review row (account-less reject) is the lock.
      if (a.account_id) {
        await q.query("select id from accounts where id=$1 for update", [a.account_id]);
        const [member] = await q.query("select 1 as x from memberships where account_id=$1 and user_id in ($2,$3)", [a.account_id, auth.userId, a.proposed_by]);
        if (member) throw new ApiError("FORBIDDEN", "Operators cannot decide adjustments on an account they belong to");
      }
      else if (a.review_id) await q.query("select id from payment_reviews where id=$1 for update", [a.review_id]);
      const [d] = await q.query("select 1 as x from operator_adjustment_decisions where adjustment_id=$1", [id]);
      const verdict = canDecide({ proposerUserId: a.proposed_by, deciderUserId: auth.userId, decided: Boolean(d), expiresAt: a.expires_at, now, deciderIsOperator: await isOperator(q, auth.userId) });
      if (!verdict.ok) {
        if (verdict.reason === "SELF_APPROVAL") throw new ApiError("FORBIDDEN", "A different operator must decide this adjustment: dual control forbids deciding your own proposal");
        if (verdict.reason === "NOT_OPERATOR") throw new ApiError("FORBIDDEN", "Operator access required");
        throw new ApiError("VERSION_CONFLICT", verdict.reason === "EXPIRED" ? "This proposal has expired; propose it again" : "This adjustment has already been decided");
      }

      let ledgerTx: string | null = null;
      if (decision === "approved") {
        if (a.action === "credit" && linkedReview?.chain_event_id) {
          const [credited] = await q.query(
            `select 1 as x from operator_adjustments a
             join operator_adjustment_decisions d on d.adjustment_id=a.id and d.decision='approved'
             join payment_reviews r on r.id=a.review_id
             where a.action='credit' and r.chain_event_id=$1 limit 1`,
            [linkedReview.chain_event_id],
          );
          if (credited) throw new ApiError("VERSION_CONFLICT", "This transfer has already been credited through a payment review");
        }
        const amount = BigInt(a.amount);
        if (amount > 0n) {
          // Aggregate ceiling over all approvals in the last 24 h. The decisions table is append-only and approvals are serialised per
          // account, so this is advisory across accounts (two simultaneous approvals on different accounts can overshoot by one amount).
          const [used] = await q.query<{ s: string }>(
            `select coalesce(sum(a2.amount_microusd),0)::text as s from operator_adjustment_decisions d join operator_adjustments a2 on a2.id = d.adjustment_id
              where d.decision='approved' and a2.action in ('credit','debit') and d.created_at > $1`,
            [new Date(now.getTime() - 86_400_000)],
          );
          if (BigInt(used?.s ?? "0") + amount > config.operator.dailyLimitMicrousd) throw new ApiError("RATE_LIMITED", "The 24-hour operator adjustment limit would be exceeded", undefined, { "Retry-After": "3600" });
        }
        if (a.action === "debit" && a.account_id) {
          const avail = availableFunds(await postedBalance(q, a.account_id), await activeHolds(q, a.account_id));
          if (avail < amount) throw new ApiError("INSUFFICIENT_FUNDS", `The account's available balance (${avail.toString()}) is below the debit`);
        }
        if (a.action !== "reject_review" && a.account_id) {
          const posted = await postTransaction(q, {
            id: randomId("ltx"), accountId: a.account_id, kind: "adjustment", sourceType: "adjustment", sourceId: a.id, priceVersion: null,
            reason: `operator ${a.action} ${a.id}`, at: now, postings: a.action === "credit" ? creditPostings(a.account_id, amount) : debitPostings(a.account_id, amount),
            newEntryId: () => randomId("le"),
          });
          ledgerTx = posted.transactionId;
        }
        if (a.review_id && a.action === "credit") {
          const [ev] = await q.query<{ removed: boolean }>("select e.removed from payment_reviews r join chain_events e on e.id = r.chain_event_id where r.id=$1", [a.review_id]);
          if (ev?.removed) throw new ApiError("VERSION_CONFLICT", "The reviewed transfer has left the canonical chain; it cannot be credited");
        }
        if (a.review_id) {
          const resolved = await q.query<Pick<ReviewRow, "kind" | "deposit_id" | "chain_event_id">>(
            "update payment_reviews set status='resolved', resolved_at=$2, resolution=$3 where id=$1 and status='open' returning kind, deposit_id, chain_event_id",
            [a.review_id, now, `${a.action === "credit" ? "credited" : "rejected"} by adjustment ${a.id}`],
          );
          if (!resolved.length) throw new ApiError("VERSION_CONFLICT", "The linked payment review is already resolved");
          const review = resolved[0]!;
          // Only the primary event's deposit review owns its state. Extra-transfer and reorg reviews must not
          // replace the original credit/reversal, nor may an old dust review overwrite a later valid payment.
          if (review.kind === "deposit" && review.deposit_id && review.chain_event_id) {
            await q.query(`update deposit_intents i set status=$2, review_reason=null, updated_at=$3,
                credited_microusd=case when $2='CREDITED' then $4::numeric else i.credited_microusd end,
                ledger_transaction_id=case when $2='CREDITED' then $5::text else i.ledger_transaction_id end
                where i.id=$1 and i.status='REVIEW_REQUIRED' and i.matched_event_key=(select event_key from chain_events where id=$6)`,
              [review.deposit_id, a.action === "credit" ? "CREDITED" : "EXPIRED", now, a.amount, ledgerTx, review.chain_event_id]);
          }
        }
      }
      await q.query("insert into operator_adjustment_decisions (adjustment_id, decision, decided_by_user_id, reason, ledger_transaction_id, created_at) values ($1,$2,$3,$4,$5,$6)", [id, decision, auth.userId, body.reason ?? null, ledgerTx, now]);
      await audit(q, {
        accountId: a.account_id, actorUserId: auth.userId, action: decision === "approved" ? "operator.adjustment_approved" : "operator.adjustment_rejected", targetType: "adjustment", targetId: id,
        requestId: c.get("requestId"), at: now, metadata: { adjustmentId: id, action: a.action, amountMicrousd: a.amount, ledgerTransactionId: ledgerTx, reviewId: a.review_id },
      });
      const [row] = await q.query<AdjRow>(`${ADJ_SELECT} where a.id=$1`, [id]);
      return toAdjustment(row!, now);
    });
    return c.json(out);
  }
  app.post("/adjustments/:id/approve", ...op, (c) => decide(c, "approved"));
  app.post("/adjustments/:id/reject", ...op, (c) => decide(c, "rejected"));

  return app;
}
