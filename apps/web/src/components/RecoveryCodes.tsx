import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";

interface Props {
  codes: string[];
  expiresAt: string;
  /** Enabled only after the user confirms they stored the codes. */
  onDone(): void;
  doneLabel?: string;
}

/** Plaintext recovery codes exist only in this component's props while it is mounted: shown once, never persisted. */
export function RecoveryCodesPanel({ codes, expiresAt, onDone, doneLabel = "Done" }: Props) {
  const [stored, setStored] = useState(false);
  const region = useRef<HTMLUListElement>(null);
  useEffect(() => setStored(false), [codes]);
  const all = codes.join("\n");
  return (
    <div className="form-stack" data-testid="recovery-codes">
      <p className="banner banner--warning">
        <span className="banner__title">Save these recovery codes now, they are shown once</span>
        <span>
          Each code works one time and resets your password if you lose it. They expire on {new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.
          We keep only a one-way digest, so we cannot show them again. Making new codes cancels these.
        </span>
      </p>
      <ul className="recovery-list" ref={region} tabIndex={0} aria-label="Recovery codes">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div className="actions">
        <CopyButton text={all} what="all recovery codes" label="Copy all codes" selectTarget={() => region.current} />
      </div>
      <label className="check">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        <span>I have stored these recovery codes</span>
      </label>
      <div className="actions">
        <button type="button" className="btn btn--primary" disabled={!stored} onClick={onDone}>{doneLabel}</button>
      </div>
    </div>
  );
}
