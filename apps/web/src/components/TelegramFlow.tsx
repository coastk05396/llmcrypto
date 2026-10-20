import { useEffect, useRef, useState } from "react";
import type { TelegramCode, TelegramCodePurpose } from "@llmcrypto/contracts";
import type { ApiResult } from "../lib/api";
import { issueTelegramCode } from "../lib/api-auth";
import { isStepUpRequired, telegramCopy, type Copy } from "../lib/auth-copy";
import { useSession } from "../lib/session";
import { CopyBanner } from "./Feedback";
import { CopyButton } from "./CopyButton";

interface Props<T> {
  purpose: TelegramCodePurpose;
  /** Exchanges the claimed code for the result (session, identity, step-up). */
  verify(codeId: string): Promise<ApiResult<T>>;
  onDone(result: T): void;
  startLabel: string;
  verifyLabel: string;
  /** Called when the API asks for a recent sign-in first, so the page can show its step-up panel. */
  onStepUp?(): void;
}

/**
 * Telegram one-time code: the server issues a code, the user sends it to the bot from Telegram, then verifies.
 * The code is shown here only (never stored). A 503 means the deployment has no bot.
 */
export function TelegramFlow<T>({ purpose, verify, onDone, startLabel, verifyLabel, onStepUp }: Props<T>) {
  const { handleFailure } = useSession();
  const [code, setCode] = useState<TelegramCode | null>(null);
  const [busy, setBusy] = useState<"issue" | "verify" | null>(null);
  const [copy, setCopy] = useState<Copy | null>(null);
  const verifyBtn = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function issue() {
    setBusy("issue");
    setCopy(null);
    const r = await issueTelegramCode(purpose);
    if (!mounted.current) return;
    setBusy(null);
    if (r.ok) {
      setCode(r.data);
      requestAnimationFrame(() => verifyBtn.current?.focus());
      return;
    }
    if (purpose !== "login" && handleFailure(r.error)) return;
    if (isStepUpRequired(r.error)) onStepUp?.();
    setCopy(telegramCopy(r.error));
  }

  async function check() {
    if (!code) return;
    setBusy("verify");
    setCopy(null);
    const r = await verify(code.codeId);
    if (!mounted.current) return;
    setBusy(null);
    if (r.ok) {
      setCode(null);
      onDone(r.data);
      return;
    }
    if (purpose !== "login" && handleFailure(r.error)) return;
    if (isStepUpRequired(r.error)) onStepUp?.();
    setCopy(telegramCopy(r.error));
  }

  return (
    <div className="form-stack">
      {!code && (
        <div className="actions">
          <button type="button" className="btn btn--secondary" aria-disabled={busy !== null} onClick={() => { if (!busy) void issue(); }}>
            {busy === "issue" ? "Getting a code" : startLabel}
          </button>
        </div>
      )}
      {code && (
        <>
          <p>Send this code to the Telegram bot from the Telegram account you want to use, then press <strong>{verifyLabel}</strong>.</p>
          <p>
            <span className="big-code" data-testid="telegram-code" aria-label={`Code ${code.code.split("").join(" ")}`}>{code.code}</span>{" "}
            <CopyButton text={code.code} what="Telegram code" />
          </p>
          <p className="small muted">Expires {new Date(code.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}. It is shown only here. Whoever sends it to the bot first claims it, so do not share your screen while it is visible.</p>
          <div className="actions">
            <button ref={verifyBtn} type="button" className="btn btn--primary" aria-disabled={busy !== null} onClick={() => { if (!busy) void check(); }}>
              {busy === "verify" ? "Checking" : verifyLabel}
            </button>
            <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => { setCode(null); setCopy(null); }}>Get a new code</button>
          </div>
        </>
      )}
      {copy && <CopyBanner copy={copy} />}
    </div>
  );
}
