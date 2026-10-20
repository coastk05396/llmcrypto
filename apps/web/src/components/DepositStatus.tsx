import { useRef } from "react";
import type { Deposit } from "@llmcrypto/contracts";
import { REVIEW_REASON_TEXT, confirmationProgress, statusView } from "../lib/deposits";
import { formatAtomic, formatUtc } from "../lib/format";
import { formatUsdDisplay } from "../lib/keys";
import { CopyButton } from "./CopyButton";
import { Badge } from "./StatusBadge";

/**
 * One deposit intent with its state in words (icon + label + explanation + next action; color is never the only signal),
 * the receiving address with the network and asset it is bound to, and a wrong-network warning while payment is still expected.
 */
export function DepositStatus({ deposit: d, headingLevel = 3 }: { deposit: Deposit; headingLevel?: 2 | 3 }) {
  const v = statusView(d);
  const progress = confirmationProgress(d);
  const addr = useRef<HTMLElement>(null);
  const Heading = `h${headingLevel}` as "h2" | "h3";
  const awaiting = d.status === "CREATED";
  const asset = d.assetContract ? `${d.asset} (contract ${d.assetContract})` : `${d.asset} (native)`;

  return (
    <article className="deposit" aria-labelledby={`dep-${d.id}`} data-testid="deposit" data-status={d.status}>
      <div className="deposit__head">
        <Heading id={`dep-${d.id}`} className="deposit__title">
          {formatAtomic(d.amountAtomic, d.decimals)} {d.asset} on {d.network}
        </Heading>
        <Badge tone={v.tone}>{v.label}</Badge>
      </div>
      <p>{v.what} {v.next}</p>

      {d.status === "REVIEW_REQUIRED" && d.reviewReason && (
        <p className="banner banner--warning" role="note"><span className="banner__title">Why it is under review</span><span>{REVIEW_REASON_TEXT[d.reviewReason]} It was not credited automatically.</span></p>
      )}

      {progress && (
        <div>
          <p className="small" id={`conf-${d.id}`}>Confirmations {progress.now} of {progress.max}</p>
          <progress className="progress" value={progress.now} max={progress.max} aria-labelledby={`conf-${d.id}`} />
        </div>
      )}

      {awaiting && (
        <p className="banner banner--warning" role="note">
          <span className="banner__title">Send only {d.asset} on {d.network}</span>
          <span>Other assets or networks may not be credited. Check the network in your wallet before you send; transfers on a chain cannot be undone by us.</span>
        </p>
      )}

      <dl className="facts">
        <div className="facts__wide">
          <dt>Receiving address ({d.network}, {d.asset})</dt>
          <dd>
            <code ref={addr} className="address" data-testid="deposit-address">{d.address}</code>
            {d.status !== "EXPIRED" && d.status !== "CREDITED" && d.status !== "REVERSED" && <CopyButton text={d.address} what={`${d.network} ${d.asset} receiving address`} selectTarget={() => addr.current} />}
          </dd>
        </div>
        <div><dt>Network</dt><dd>{d.network}</dd></div>
        <div><dt>Asset</dt><dd>{asset}</dd></div>
        <div><dt>Expected amount</dt><dd className="mono">{formatAtomic(d.amountAtomic, d.decimals)} {d.asset}</dd></div>
        <div><dt>Credited</dt><dd className="mono">{d.creditedMicrousd === null ? "Not credited" : `${formatUsdDisplay(d.creditedMicrousd)} USD`}</dd></div>
        <div><dt>{d.status === "EXPIRED" ? "Expired at" : "Expires at"}</dt><dd><time dateTime={d.expiresAt}>{formatUtc(d.expiresAt)}</time></dd></div>
        <div><dt>Created</dt><dd><time dateTime={d.createdAt}>{formatUtc(d.createdAt)}</time></dd></div>
        <div className="facts__wide">
          <dt>Reference</dt>
          <dd><code>{d.id}</code> <CopyButton text={d.id} what="deposit reference ID" /></dd>
        </div>
        {d.ledgerTransactionId && <div className="facts__wide"><dt>Ledger transaction</dt><dd><code>{d.ledgerTransactionId}</code></dd></div>}
      </dl>
    </article>
  );
}
