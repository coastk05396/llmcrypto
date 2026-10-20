import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { Deposit, LedgerKind, PaymentNetwork } from "@llmcrypto/contracts";
import { DepositStatus } from "../components/DepositStatus";
import { Modal } from "../components/Modal";
import { createDeposit, describeFailure, getBalance, getDeposit, getPaymentNetworks, listDeposits, listLedger, type ApiFailure } from "../lib/api";
import { describeDepositFailure, isOpen, type DepositFailureView } from "../lib/deposits";
import { decimalToAtomic, formatAtomic, formatSignedUsd, formatUtc } from "../lib/format";
import { AttemptKeys, formatUsdDisplay } from "../lib/keys";
import { useSession } from "../lib/session";
import { usePaged } from "../lib/use-paged";
import { useLoad } from "../lib/use-load";
import { toQuery } from "../lib/usage-view";

const POLL_MS = 10_000;

function Skeleton({ label }: { label: string }) {
  return <div className="skeleton" role="status" aria-label={label}><span /></div>;
}

const LEDGER_KINDS: { value: "" | LedgerKind; label: string }[] = [
  { value: "", label: "All entries" },
  { value: "deposit", label: "Deposits" },
  { value: "spend", label: "Spend" },
  { value: "adjustment", label: "Adjustments" },
  { value: "reversal", label: "Reversals" },
];
const KIND_LABEL: Record<LedgerKind, string> = { deposit: "Deposit", spend: "Spend", adjustment: "Adjustment", reversal: "Reversal" };
const SOURCE_LABEL = { request: "Request", deposit: "Deposit", adjustment: "Adjustment" } as const;

function FailureBanner({ what, failure, onRetry }: { what: string; failure: ApiFailure; onRetry(): void }) {
  const forbidden = failure.kind === "http" && failure.code === "FORBIDDEN";
  return (
    <div className="banner banner--danger" role="alert">
      <span className="banner__title">Could not load {what}</span>
      <span>{forbidden ? "Your role cannot view this. Credits are visible to owners and billing managers." : describeFailure(failure)}{failure.kind === "http" && failure.requestId ? ` Reference ${failure.requestId}.` : ""}</span>
      {!forbidden && <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ add credit */

type Networks = { kind: "loading" } | { kind: "none" } | { kind: "error"; failure: ApiFailure } | { kind: "ready"; items: PaymentNetwork[] };

const pairId = (n: PaymentNetwork) => `${n.network}|${n.asset}`;

function AddCreditDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(d: Deposit): void }) {
  const uid = useId();
  const { handleFailure } = useSession();
  const [networks, setNetworks] = useState<Networks>({ kind: "loading" });
  const [pair, setPair] = useState("");
  const [amount, setAmount] = useState("");
  const [fieldIssue, setFieldIssue] = useState<string | null>(null);
  const [failure, setFailure] = useState<DepositFailureView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attempts = useRef(new AttemptKeys());
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setFieldIssue(null);
    setFailure(null);
    setAmount("");
    attempts.current.reset();
    setNetworks({ kind: "loading" });
    const ac = new AbortController();
    void getPaymentNetworks(ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      if (r.ok) {
        setNetworks(r.data.items.length ? { kind: "ready", items: r.data.items } : { kind: "none" });
        setPair((p) => p || (r.data.items[0] ? pairId(r.data.items[0]) : ""));
      } else if (r.error.kind === "http" && r.error.status === 503) setNetworks({ kind: "none" });
      else if (!handleFailure(r.error)) setNetworks({ kind: "error", failure: r.error });
    });
    return () => ac.abort();
  }, [open, handleFailure]);

  const selected = networks.kind === "ready" ? networks.items.find((n) => pairId(n) === pair) : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || !selected) return;
    const atomic = decimalToAtomic(amount, selected.decimals);
    const min = BigInt(selected.minAmountAtomic);
    const max = selected.maxAmountAtomic === null ? null : BigInt(selected.maxAmountAtomic);
    let issue: string | null = null;
    if (atomic === null) issue = `Enter an amount above zero with at most ${selected.decimals} decimal places.`;
    else if (BigInt(atomic) < min) issue = `The minimum is ${formatAtomic(selected.minAmountAtomic, selected.decimals)} ${selected.asset}.`;
    else if (max !== null && BigInt(atomic) > max) issue = `The maximum is ${formatAtomic(selected.maxAmountAtomic as string, selected.decimals)} ${selected.asset}.`;
    setFieldIssue(issue);
    setFailure(null);
    if (issue || atomic === null) {
      requestAnimationFrame(() => document.getElementById(`${uid}-amount`)?.focus());
      return;
    }
    const body = { asset: selected.asset, network: selected.network, amountAtomic: atomic };
    setSubmitting(true);
    const r = await createDeposit(body, attempts.current.keyFor(body));
    setSubmitting(false);
    if (r.ok) {
      attempts.current.reset();
      onCreated(r.data);
      return;
    }
    if (handleFailure(r.error)) return;
    const view = describeDepositFailure(r.error);
    if (!view.retrySafe) attempts.current.reset();
    setFailure(view);
    requestAnimationFrame(() => summary.current?.focus());
  }

  const errCount = (fieldIssue ? 1 : 0) + (failure ? 1 : 0);
  return (
    <Modal open={open} title="Add credit" onRequestClose={() => { if (!submitting) onClose(); }}>
      {networks.kind === "loading" && <Skeleton label="Loading payment networks" />}
      {networks.kind === "none" && (
        <div className="form-stack" data-testid="no-networks">
          <p className="banner banner--info" role="status"><span className="banner__title">No payment networks configured</span><span>Deposits are not available yet, so credit cannot be added from here. Nothing was charged and no address was created.</span></p>
          <div className="actions"><button type="button" className="btn btn--primary" onClick={onClose}>Close</button></div>
        </div>
      )}
      {networks.kind === "error" && (
        <div className="form-stack">
          <FailureBanner what="payment networks" failure={networks.failure} onRetry={() => { setNetworks({ kind: "loading" }); void getPaymentNetworks().then((r) => setNetworks(r.ok ? (r.data.items.length ? { kind: "ready", items: r.data.items } : { kind: "none" }) : r.error.kind === "http" && r.error.status === 503 ? { kind: "none" } : { kind: "error", failure: r.error })); }} />
          <div className="actions"><button type="button" className="btn btn--secondary" onClick={onClose}>Close</button></div>
        </div>
      )}
      {networks.kind === "ready" && (
        <form onSubmit={(e) => void onSubmit(e)} noValidate aria-busy={submitting} className="form-stack">
          <div ref={summary} tabIndex={-1} role={errCount ? "alert" : undefined} className={errCount ? "banner banner--danger" : "sr-only"}>
            {fieldIssue && <><span className="banner__title">Fix this field to continue</span><a href={`#${uid}-amount`} onClick={(ev) => { ev.preventDefault(); document.getElementById(`${uid}-amount`)?.focus(); }}>{fieldIssue}</a></>}
            {failure && (
              <>
                <span className="banner__title">Deposit not created</span>
                <span>{failure.message}</span>
                {failure.fields.length > 0 && <ul>{failure.fields.map((f, i) => <li key={i}>{f.field}: {f.message}</li>)}</ul>}
              </>
            )}
          </div>
          <fieldset className="field fieldset">
            <legend>Asset and network</legend>
            {networks.items.map((n) => (
              <label key={pairId(n)} className="check">
                <input type="radio" name={`${uid}-pair`} value={pairId(n)} checked={pair === pairId(n)} onChange={() => { setPair(pairId(n)); attempts.current.reset(); setFieldIssue(null); }} />
                <span><strong>{n.asset}</strong> on <strong>{n.network}</strong> <span className="muted small">chain {n.chainId}, {n.requiredConfirmations} confirmation{n.requiredConfirmations === 1 ? "" : "s"}{n.assetContract ? `, contract ${n.assetContract}` : ", native asset"}</span></span>
              </label>
            ))}
          </fieldset>
          {selected && (
            <div className="field">
              <label htmlFor={`${uid}-amount`}>Amount to send in {selected.asset}</label>
              <input id={`${uid}-amount`} type="text" inputMode="decimal" autoComplete="off" value={amount} aria-invalid={fieldIssue ? true : undefined}
                aria-describedby={`${uid}-amount-help${fieldIssue ? ` ${uid}-amount-err` : ""}`} onChange={(e) => { setAmount(e.target.value); setFieldIssue(null); }} />
              <p id={`${uid}-amount-help`} className="small muted">
                Minimum {formatAtomic(selected.minAmountAtomic, selected.decimals)} {selected.asset}
                {selected.maxAmountAtomic !== null ? `, maximum ${formatAtomic(selected.maxAmountAtomic, selected.decimals)} ${selected.asset}` : ", no maximum"}.
                You will get an address for {selected.asset} on {selected.network} only.
              </p>
              {fieldIssue && <p id={`${uid}-amount-err`} className="field__error">{fieldIssue}</p>}
            </div>
          )}
          <div className="actions">
            <button type="submit" className="btn btn--primary" aria-disabled={submitting} onClick={(e) => { if (submitting) e.preventDefault(); }}>{submitting ? "Creating" : "Create deposit address"}</button>
            <button type="button" className="btn btn--secondary" disabled={submitting} onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ page */

export function Credits() {
  const [balance, reloadBalance] = useLoad(getBalance);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<"" | LedgerKind>("");
  const { handleFailure } = useSession();

  const fetchDeposits = useCallback((cursor: string | null, signal: AbortSignal) => listDeposits(toQuery({}, cursor, 20), signal), []);
  const deposits = usePaged<Deposit>(fetchDeposits);
  const fetchLedger = useCallback((cursor: string | null, signal: AbortSignal) => listLedger(toQuery({ kind: kind || undefined }, cursor, 25), signal), [kind]);
  const ledger = usePaged(fetchLedger);

  // Open deposits move on their own (detected, confirming, credited): poll each one, and refresh money views when one is credited.
  const openIds = useMemo(() => (deposits.state.status === "ready" ? deposits.state.items.filter((d) => isOpen(d.status)).map((d) => d.id) : []), [deposits.state]);
  const openKey = openIds.join(",");
  // Last status seen per deposit, so a transition to CREDITED is detected outside React's state updater.
  const known = useRef(new Map<string, Deposit["status"]>());
  if (deposits.state.status === "ready") for (const d of deposits.state.items) known.current.set(d.id, known.current.get(d.id) ?? d.status);
  const { patch } = deposits;
  const reloadLedger = ledger.reload;
  useEffect(() => {
    if (!openKey) return;
    const t = window.setInterval(() => {
      for (const id of openKey.split(",")) {
        void getDeposit(id).then((r) => {
          if (!r.ok) { handleFailure(r.error); return; }
          const before = known.current.get(id);
          known.current.set(id, r.data.status);
          patch((items) => items.map((d) => (d.id === id ? r.data : d)));
          if (before !== undefined && before !== r.data.status && r.data.status === "CREDITED") { reloadBalance(); reloadLedger(); setNotice(`Deposit credited: ${formatAtomic(r.data.amountAtomic, r.data.decimals)} ${r.data.asset} on ${r.data.network}`); }
        });
      }
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [openKey, patch, handleFailure, reloadBalance, reloadLedger]);

  const created = useRef<string | null>(null);
  const onCreated = (d: Deposit) => {
    setAdding(false);
    created.current = d.id;
    setNotice(`Deposit address created for ${d.asset} on ${d.network}`);
    deposits.reload();
  };
  useEffect(() => {
    if (deposits.state.status !== "ready" || !created.current) return;
    const el = document.getElementById(`dep-${created.current}`);
    if (el) { el.tabIndex = -1; el.focus(); created.current = null; }
  }, [deposits.state]);

  return (
    <div className="page-body console-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Console</p>
          <h1 className="page-title">Credits</h1>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>Add credit</button>
      </div>

      <section aria-labelledby="bal-head" aria-busy={balance.status === "loading"}>
        <h2 id="bal-head" className="sr-only">Balance</h2>
        <dl className="ledger-header ledger-header--three">
          <div className="ledger-header__cell ledger-header__cell--lead">
            <dt>Available credit</dt>
            <dd>
              {balance.status === "loading" && <Skeleton label="Loading balance" />}
              {balance.status === "ready" && <span className="amount" data-testid="available">{formatUsdDisplay(balance.data.availableMicrousd)} <span className="unit">USD</span></span>}
              {balance.status === "error" && <span className="amount amount--na">Balance unavailable</span>}
            </dd>
          </div>
          <div className="ledger-header__cell">
            <dt>Held for in-flight requests</dt>
            <dd>{balance.status === "ready" ? <span className="amount amount--small" data-testid="held">{formatUsdDisplay(balance.data.heldMicrousd)} <span className="unit">USD</span></span> : balance.status === "loading" ? <Skeleton label="Loading held balance" /> : <span className="muted">Unavailable</span>}</dd>
          </div>
          <div className="ledger-header__cell">
            <dt>Posted balance</dt>
            <dd>{balance.status === "ready" ? <span className="amount amount--small" data-testid="posted">{formatUsdDisplay(balance.data.postedMicrousd)} <span className="unit">USD</span></span> : balance.status === "loading" ? <Skeleton label="Loading posted balance" /> : <span className="muted">Unavailable</span>}</dd>
          </div>
        </dl>
        {balance.status === "ready" && <p className="small muted">Available = posted minus held. As of <time dateTime={balance.data.asOf}>{formatUtc(balance.data.asOf)}</time>. <button type="button" className="link-button" onClick={reloadBalance}>Refresh</button></p>}
        {balance.status === "error" && <FailureBanner what="balance" failure={balance.failure} onRetry={reloadBalance} />}
      </section>

      <div role="status" aria-live="polite" className="status-line">{notice}</div>

      <section aria-labelledby="dep-head" className="section--ruled">
        <h2 id="dep-head" className="section-title">Deposits</h2>
        {deposits.state.status === "loading" && <Skeleton label="Loading deposits" />}
        {deposits.state.status === "error" && <FailureBanner what="deposits" failure={deposits.state.failure} onRetry={deposits.reload} />}
        {deposits.state.status === "ready" && deposits.state.items.length === 0 && (
          <div className="empty">
            <h3>No deposits yet</h3>
            <p className="muted">Add credit to get a receiving address. Your balance changes only after the transfer is confirmed on its network.</p>
            <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>Add credit</button>
          </div>
        )}
        {deposits.state.status === "ready" && deposits.state.items.length > 0 && (
          <>
            <ul className="deposit-list" aria-label="Deposits">
              {deposits.state.items.map((d) => <li key={d.id}><DepositStatus deposit={d} /></li>)}
            </ul>
            {deposits.state.moreError && <p className="banner banner--danger" role="alert"><span>Could not load more. {describeFailure(deposits.state.moreError)}</span></p>}
            {deposits.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={deposits.state.loadingMore} onClick={deposits.loadMore}>{deposits.state.loadingMore ? "Loading" : "Load more deposits"}</button>}
          </>
        )}
      </section>

      <section aria-labelledby="led-head" className="section--ruled">
        <h2 id="led-head" className="section-title">Ledger</h2>
        <div className="field field--inline">
          <label htmlFor="ledger-kind">Show</label>
          <select id="ledger-kind" value={kind} onChange={(e) => setKind(e.target.value as "" | LedgerKind)}>
            {LEDGER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        {ledger.state.status === "loading" && <Skeleton label="Loading ledger" />}
        {ledger.state.status === "error" && <FailureBanner what="the ledger" failure={ledger.state.failure} onRetry={ledger.reload} />}
        {ledger.state.status === "ready" && ledger.state.items.length === 0 && (
          <div className="empty"><h3>No ledger entries{kind ? " of this kind" : " yet"}</h3><p className="muted">Credits and spend appear here once they are posted.</p></div>
        )}
        {ledger.state.status === "ready" && ledger.state.items.length > 0 && (
          <>
            <div className="table-wrap" role="region" aria-label="Ledger table" tabIndex={0}>
              <table className="data-table" data-testid="ledger-table">
                <caption className="sr-only">Ledger entries, newest first. Amounts are in USD; credits are positive and spend is negative.</caption>
                <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Kind</th><th scope="col">Source</th><th scope="col" className="num">Amount (USD)</th><th scope="col">Price version</th></tr></thead>
                <tbody>
                  {ledger.state.items.map((e) => (
                    <tr key={e.id}>
                      <th scope="row"><time dateTime={e.createdAt}>{formatUtc(e.createdAt)}</time></th>
                      <td>{KIND_LABEL[e.kind]}</td>
                      <td>{e.source.type === "request" ? <Link to={`/app/usage/${encodeURIComponent(e.source.id)}`}>{SOURCE_LABEL[e.source.type]} <code>{e.source.id}</code></Link> : <>{SOURCE_LABEL[e.source.type]} <code>{e.source.id}</code></>}</td>
                      <td className="num">{formatSignedUsd(e.amountMicrousd)}</td>
                      <td>{e.priceVersion ? <code>{e.priceVersion}</code> : "None"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ledger.state.moreError && <p className="banner banner--danger" role="alert"><span>Could not load more. {describeFailure(ledger.state.moreError)}</span></p>}
            <p className="small muted" data-testid="ledger-count">{ledger.state.items.length} entr{ledger.state.items.length === 1 ? "y" : "ies"} loaded{ledger.state.nextCursor ? ", more available" : ", end of ledger"}.</p>
            {ledger.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={ledger.state.loadingMore} onClick={ledger.loadMore}>{ledger.state.loadingMore ? "Loading" : "Load more entries"}</button>}
          </>
        )}
      </section>

      <AddCreditDialog open={adding} onClose={() => setAdding(false)} onCreated={onCreated} />
    </div>
  );
}
