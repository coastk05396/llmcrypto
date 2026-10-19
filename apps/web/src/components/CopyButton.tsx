import { useEffect, useRef, useState } from "react";
import { copyText, type CopyOutcome } from "../lib/catalog";
import { CheckIcon, CopyIcon, TriangleIcon } from "./Icons";

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

export function selectNodeText(node: HTMLElement | null) {
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

interface Props {
  /** Exact string placed on the clipboard. */
  text: string;
  /** What is being copied, used in the accessible name and announcement, for example "model ID alpha-small". */
  what: string;
  /** Visible button text; defaults to "Copy". */
  label?: string;
  /** Element whose text is selected when copying fails. */
  selectTarget?: () => HTMLElement | null;
}

export function CopyButton({ text, what, label = "Copy", selectTarget }: Props) {
  const [outcome, setOutcome] = useState<CopyOutcome | "idle">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onClick() {
    const result = await copyText(text, {
      ...(navigator.clipboard ? { writeText: (t: string) => navigator.clipboard.writeText(t) } : {}),
      legacyCopy,
    });
    if (result === "failed") selectNodeText(selectTarget?.() ?? null);
    setOutcome(result);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOutcome("idle"), result === "copied" ? 2000 : 6000);
  }

  const visible = outcome === "copied" ? "Copied" : outcome === "failed" ? "Copy failed, select the text manually" : label;
  const announce = outcome === "copied" ? `Copied ${what}` : outcome === "failed" ? `Copy failed for ${what}. Select the text manually.` : "";
  return (
    <>
      <button type="button" className="btn btn--small btn--secondary copy-btn" data-state={outcome} aria-label={`${label} ${what}`} onClick={() => void onClick()}>
        {outcome === "copied" ? <CheckIcon /> : outcome === "failed" ? <TriangleIcon /> : <CopyIcon />}
        <span>{visible}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">{announce}</span>
    </>
  );
}
