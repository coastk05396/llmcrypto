import { useEffect, useId, useState } from "react";
import type { Adjustment } from "@llmcrypto/contracts";
import { Failure, LoadRegion, PageRegion, useAttemptKey, useToolAction } from "../components/ToolKit";
import { StepUpPanel } from "../components/StepUpPanel";
import { decideAdjustment, elevateOperator, endElevation, getMismatches, getOperatorSession, getReconciliation, getStuck, listAdjustments, listAlerts, listReviews, proposeAdjustment, resolveAlert } from "../lib/api-tools";
import { formatSignedUsd } from "../lib/format";
import { useLoad } from "../lib/use-load";
import { usePaged } from "../lib/use-paged";
import { useSession } from "../lib/session";

function AdjustmentDecision({ item, onChanged }: { item: Adjustment; onChanged(): void }) {
  const { state } = useSession();
  const mine = state.status === "signed-in" && state.session.user.id === item.proposedBy;
  const [reason, setReason] = useState(""); const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const action = useToolAction(); const uid = useId();
  return <li className="key-row"><h3>{item.action} · ${formatSignedUsd(item.amountMicrousd, false)} · {item.status}</h3><p>Proposal <code>{item.id}</code> · Account <code>{item.accountId ?? "unmatched review"}</code></p><p>{item.reason}</p><p>Expires: {item.expiresAt}{item.reviewId ? ` · Review: ${item.reviewId}` : ""}</p>
    {item.ledgerTransactionId && <p>Ledger transaction: <code>{item.ledgerTransactionId}</code></p>}
    {item.decisionReason && <p>Decision: {item.decisionReason}</p>}
    {item.status === "pending" && (mine ? <p>A different operator must approve or reject your proposal.</p> : <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (!decision) return; void action.run(() => decideAdjustment(item.id, decision, reason), () => { setDecision(null); onChanged(); }); }}>
      <div className="field"><label htmlFor={uid}>Decision reason for {item.id}</label><input id={uid} required minLength={3} maxLength={1000} value={reason} onChange={(e) => { setReason(e.target.value); setDecision(null); }} /></div>
      <Failure failure={action.failure} /><div className="actions"><button type="button" className="btn btn--secondary" disabled={action.busy} onClick={() => setDecision("approve")}>Approve {item.id}</button><button type="button" className="btn btn--secondary" disabled={action.busy} onClick={() => setDecision("reject")}>Reject {item.id}</button></div>
      {decision && <><p role="status">Confirm {decision} of this immutable proposal. Approval may post a ledger transaction.</p><button className="btn btn--danger" disabled={action.busy}>Confirm {decision}</button></>}
    </form>)}
  </li>;
}

function AlertResolution({ id, onChanged }: { id: string; onChanged(): void }) {
  const [note, setNote] = useState(""); const action = useToolAction(); const uid = useId();
  return <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void action.run(() => resolveAlert(id, note), onChanged); }}><div className="field"><label htmlFor={uid}>Resolution note for {id}</label><input id={uid} required minLength={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></div><Failure failure={action.failure} /><button className="btn btn--secondary" disabled={action.busy}>Resolve alert {id}</button></form>;
}

function Reconciliation() {
  const [summary, reloadSummary] = useLoad(getReconciliation);
  const [stuck, reloadStuck] = useLoad(getStuck); const [mismatches, reloadMismatches] = useLoad(getMismatches);
  const reviews = usePaged(listReviews); const alerts = usePaged(listAlerts); const adjustments = usePaged(listAdjustments);
  const [account, setAccount] = useState(""); const [review, setReview] = useState(""); const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"credit" | "debit" | "reject_review">("credit"); const [confirm, setConfirm] = useState(false);
  const action = useToolAction(); const attempt = useAttemptKey(); const uid = useId();
  const reload = () => { reloadSummary(); reloadStuck(); reloadMismatches(); reviews.reload(); alerts.reload(); adjustments.reload(); };
  return <>
    <button className="btn btn--secondary" onClick={reload}>Refresh reconciliation</button>
    <section className="section--ruled"><h2 className="section-title">Reconciliation</h2><LoadRegion state={summary} what="reconciliation" reload={reloadSummary}>{summary.status === "ready" && <><p>Generated: {summary.data.generatedAt}</p><dl className="evidence-list">{Object.entries(summary.data).filter(([k]) => k !== "generatedAt").map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></>}</LoadRegion></section>
    <section className="section--ruled"><h2 className="section-title">Open payment reviews</h2><PageRegion state={reviews.state} what="payment reviews" reload={reviews.reload} more={reviews.loadMore}><ul className="key-list">{reviews.state.status === "ready" && reviews.state.items.map((r) => <li className="key-row" key={r.id}><h3>{r.kind}: {r.reason}</h3><p>Review <code>{r.id}</code> · Account <code>{r.accountId ?? "unmatched"}</code></p><pre className="pre-block">{JSON.stringify(r.details, null, 2)}</pre><p>Resolve through a credit or reject_review proposal below, with approval by another operator.</p><button className="btn btn--secondary" onClick={() => { setReview(r.id); setAccount(r.accountId ?? ""); setKind("reject_review"); setConfirm(false); }}>Use review {r.id}</button></li>)}</ul></PageRegion></section>
    <section className="section--ruled"><h2 className="section-title">Open payment alerts</h2><PageRegion state={alerts.state} what="payment alerts" reload={alerts.reload} more={alerts.loadMore}><ul className="key-list">{alerts.state.status === "ready" && alerts.state.items.map((a) => <li className="key-row" key={a.id}><h3>{a.severity}: {a.kind}</h3><pre className="pre-block">{JSON.stringify(a.details, null, 2)}</pre><AlertResolution id={a.id} onChanged={reload} /></li>)}</ul></PageRegion></section>
    <section className="section--ruled"><h2 className="section-title">Stuck reservations</h2><LoadRegion state={stuck} what="stuck reservations" reload={reloadStuck}>{stuck.status === "ready" && <>{stuck.data.items.length === 0 && <p>No stuck reservations.</p>}<ul>{stuck.data.items.map((r) => <li key={r.reservationId}><code>{r.requestId}</code>: {r.reason}, age {r.ageSeconds}s, ${formatSignedUsd(r.amountMicrousd, false)} held for {r.accountId}.</li>)}</ul>{stuck.data.truncated && <p role="status">Results truncated. Additional reservations may exist.</p>}</>}</LoadRegion></section>
    <section className="section--ruled"><h2 className="section-title">Ledger mismatches</h2><LoadRegion state={mismatches} what="ledger mismatches" reload={reloadMismatches}>{mismatches.status === "ready" && <>{mismatches.data.items.length === 0 && <p>No ledger mismatches.</p>}<ul>{mismatches.data.items.map((m, i) => <li key={i}>{m.kind} · <code>{m.refId}</code>: {m.detail}; expected {m.expectedMicrousd ?? "unknown"}, actual {m.actualMicrousd ?? "unknown"} micro-USD.</li>)}</ul>{mismatches.data.truncated && <p role="status">Results truncated. Additional mismatches may exist.</p>}</>}</LoadRegion></section>
    <section className="section--ruled"><h2 className="section-title">Propose adjustment</h2><p>Amounts use integer micro-USD (1,000,000 = $1). A second operator must decide; proposals and decisions cannot be edited. You cannot adjust your own account.</p>
      <form className="form-stack" onChange={() => setConfirm(false)} onSubmit={(e) => { e.preventDefault(); if (!confirm) { setConfirm(true); return; } const body = { action: kind, reason, ...(account ? { accountId: account } : {}), ...(review ? { reviewId: review } : {}), ...(kind === "reject_review" ? {} : { amountMicrousd: amount }) }; void action.run(() => proposeAdjustment(body, attempt.for(JSON.stringify(body))), () => { attempt.clear(); setReason(""); setAmount(""); setConfirm(false); reload(); }); }}>
        <div className="field"><label htmlFor={`${uid}-kind`}>Adjustment action</label><select id={`${uid}-kind`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="credit">Credit</option><option value="debit">Debit</option><option value="reject_review">Reject review</option></select></div>
        <div className="field"><label htmlFor={`${uid}-account`}>Account ID</label><input id={`${uid}-account`} required={kind !== "reject_review"} value={account} onChange={(e) => setAccount(e.target.value)} /></div>
        <div className="field"><label htmlFor={`${uid}-review`}>Review ID</label><input id={`${uid}-review`} required={kind === "reject_review"} value={review} onChange={(e) => setReview(e.target.value)} /></div>
        {kind !== "reject_review" && <div className="field"><label htmlFor={`${uid}-amount`}>Amount in micro-USD</label><input id={`${uid}-amount`} inputMode="numeric" pattern="[1-9][0-9]*" required value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}
        <div className="field"><label htmlFor={`${uid}-reason`}>Proposal reason</label><textarea id={`${uid}-reason`} minLength={10} maxLength={1000} required value={reason} onChange={(e) => setReason(e.target.value)} /></div><Failure failure={action.failure} />
        {confirm && <p role="status">Confirm {kind} proposal for {account || "the unmatched review"}{kind !== "reject_review" ? `: ${amount} micro-USD` : ""}. Another operator must approve it.</p>}<button className="btn btn--primary" disabled={action.busy}>{confirm ? "Confirm proposal" : "Review proposal"}</button>
      </form>
    </section>
    <section className="section--ruled"><h2 className="section-title">Adjustment history</h2><PageRegion state={adjustments.state} what="adjustments" reload={adjustments.reload} more={adjustments.loadMore}><ul className="key-list">{adjustments.state.status === "ready" && adjustments.state.items.map((a) => <AdjustmentDecision key={a.id} item={a} onChanged={reload} />)}</ul></PageRegion></section>
  </>;
}

export function Operations() {
  const [session, reload] = useLoad(getOperatorSession); const action = useToolAction();
  const until = session.status === "ready" && session.data.elevated ? session.data.elevatedUntil : null;
  useEffect(() => { if (!until) return; const t = window.setTimeout(reload, Math.max(0, Date.parse(until) - Date.now())); return () => window.clearTimeout(t); }, [until, reload]);
  return <div className="page-body console-page"><p className="eyebrow">Operator</p><h1 className="page-title">Operations</h1><p className="lead muted">Reconcile payments and review immutable adjustments with dual control.</p><LoadRegion state={session} what="operator access" reload={reload}>{session.status === "ready" && (!session.data.isOperator ? <p role="status" className="banner banner--info">Operator access unavailable. Customer roles and wallets do not grant operator privileges.</p> : <>
    <Failure failure={action.failure} />{action.failure?.kind === "http" && action.failure.code === "STEP_UP_REQUIRED" && <StepUpPanel onDone={reload} />}
    {!session.data.elevated ? <><p>Elevation requires authentication within the last five minutes and lasts fifteen minutes for this session.</p><button className="btn btn--primary" disabled={action.busy} onClick={() => void action.run(elevateOperator, reload)}>Elevate operator session</button></> : <><p role="status">Operator session elevated until {session.data.elevatedUntil}.</p><button className="btn btn--secondary" disabled={action.busy} onClick={() => void action.run(endElevation, reload)}>End operator elevation</button><Reconciliation /></>}
  </>)}</LoadRegion></div>;
}
