import { useEffect, useRef, useState } from "react";
import type { LinkedIdentity, SessionView, WalletProtocol } from "@llmcrypto/contracts";
import { createWalletSession, linkWalletIdentity, requestWalletChallenge } from "../lib/api";
import {
  WalletFlowError, browserWalletEnv, runWalletFlow, walletErrorCopy,
  type WalletApi, type WalletErrorCode, type WalletPurpose, type WalletStage,
} from "../lib/wallet";

const loginApi: WalletApi<SessionView> = {
  challenge: (body, signal) => requestWalletChallenge(body, signal),
  complete: (body, signal) => createWalletSession(body, signal),
};
const linkApi: WalletApi<LinkedIdentity> = {
  challenge: (body, signal) => requestWalletChallenge(body, signal),
  complete: (body, signal) => linkWalletIdentity(body, signal),
};

type View =
  | { phase: "idle" }
  | { phase: "busy"; protocol: WalletProtocol; stage: WalletStage }
  | { phase: "error"; protocol: WalletProtocol; code: WalletErrorCode; retryAfter: number | null };

interface Props<T> {
  purpose: WalletPurpose;
  api: WalletApi<T>;
  onDone(result: T): void;
  labels: Record<WalletProtocol, string>;
}

function WalletButtons<T>({ purpose, api, onDone, labels }: Props<T>) {
  const [view, setView] = useState<View>({ phase: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function start(protocol: WalletProtocol) {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setView({ phase: "busy", protocol, stage: { stage: "connecting" } });
    try {
      const result = await runWalletFlow<T>({
        protocol, purpose, api, env: browserWalletEnv(), signal: ac.signal,
        onStage: (stage) => { if (!ac.signal.aborted) setView({ phase: "busy", protocol, stage }); },
      });
      if (abort.current === ac) onDone(result);
    } catch (e) {
      if (abort.current !== ac) return; // superseded or unmounted
      const err = e instanceof WalletFlowError ? e : new WalletFlowError("failed");
      setView({ phase: "error", protocol, code: err.code, retryAfter: err.retryAfterSeconds });
    }
  }

  const busy = view.phase === "busy";
  const error = view.phase === "error" ? walletErrorCopy(view.code, view.protocol, view.retryAfter) : null;
  return (
    <div className="wallet-login">
      <div className="actions wallet-login__actions">
        {(["evm", "tron"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`btn ${p === "evm" ? "btn--primary" : "btn--secondary"}`}
            disabled={busy}
            aria-busy={busy && view.protocol === p}
            onClick={() => void start(p)}
          >
            {busy && view.protocol === p ? "Waiting for wallet" : labels[p]}
          </button>
        ))}
        {busy && (
          <button type="button" className="btn btn--secondary" onClick={() => abort.current?.abort()}>Cancel</button>
        )}
      </div>

      <div role="status" aria-live="polite" className="status-line">
        {view.phase === "busy" && (view.stage.stage === "connecting" ? "Connecting to your wallet" : "Confirm the signature in your wallet")}
      </div>

      {view.phase === "busy" && view.stage.stage === "awaiting-signature" && (
        <dl className="facts facts--grid wallet-login__challenge" aria-label="What you are signing">
          <div><dt>Domain</dt><dd><code>{view.stage.domain}</code></dd></div>
          <div><dt>{view.protocol === "evm" ? "Chain ID" : "Network"}</dt><dd><code>{view.stage.chain}</code></dd></div>
          <div><dt>Address</dt><dd><code>{view.stage.address}</code></dd></div>
        </dl>
      )}

      {error && (
        <div className={`banner banner--${error.tone}`} role="alert">
          <span className="banner__title">{error.title}</span>
          <span>{error.body}</span>
        </div>
      )}
    </div>
  );
}

export function WalletSignIn({ onDone }: { onDone(s: SessionView): void }) {
  return <WalletButtons purpose="login" api={loginApi} onDone={onDone} labels={{ evm: "Sign in with an EVM wallet", tron: "Sign in with a TRON wallet" }} />;
}

export function WalletLink({ onDone }: { onDone(i: LinkedIdentity): void }) {
  return <WalletButtons purpose="link" api={linkApi} onDone={onDone} labels={{ evm: "Link an EVM wallet", tron: "Link a TRON wallet" }} />;
}
