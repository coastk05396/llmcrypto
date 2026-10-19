import type { ReactNode } from "react";
import { describeFailure, type ApiFailure } from "../lib/api";
import type { Copy } from "../lib/auth-copy";

export function CopyBanner({ copy, children }: { copy: Copy; children?: ReactNode }) {
  return (
    <div className={`banner banner--${copy.tone}`} role="alert">
      <span className="banner__title">{copy.title}</span>
      <span>{copy.body}</span>
      {children}
    </div>
  );
}

/** Region-level load failure with a retry; request id is shown for support when the API sent one. */
export function LoadError({ what, failure, onRetry }: { what: string; failure: ApiFailure; onRetry(): void }) {
  const forbidden = failure.kind === "http" && failure.status === 403;
  if (failure.kind === "http" && failure.code === "FEATURE_DISABLED") {
    return <p className="banner banner--info" role="status" data-testid="feature-disabled"><span className="banner__title">Unavailable on this deployment</span><span>This beta feature is switched off here. Unavailable does not mean complete.</span></p>;
  }
  return (
    <div className="banner banner--danger" role="alert">
      <span className="banner__title">Could not load {what}</span>
      <span>
        {forbidden ? "Your role or session cannot view this." : describeFailure(failure)}
        {failure.kind === "http" && failure.requestId ? ` Reference ${failure.requestId}.` : ""}
      </span>
      {!forbidden && <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Skeleton({ label }: { label: string }) {
  return <div className="skeleton" role="status" aria-label={label}><span /><span /></div>;
}

/** Polite status line; always rendered so screen readers register the live region before text changes. */
export function StatusLine({ children }: { children?: ReactNode }) {
  return <div role="status" aria-live="polite" className="status-line">{children}</div>;
}
