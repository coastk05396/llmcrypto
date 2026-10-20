import { useId, useRef } from "react";
import { CopyButton } from "./CopyButton";

/** Focusable, scrollable code region with a Copy button that copies exactly the displayed text. */
export function CodeBlock({ code, label, what }: { code: string; label: string; what: string }) {
  const id = useId();
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="code">
      <div className="code__bar">
        <span id={id} className="code__label">{label}</span>
        <CopyButton text={code} what={what} selectTarget={() => pre.current} />
      </div>
      <pre ref={pre} tabIndex={0} role="region" aria-labelledby={id}><code>{code}</code></pre>
    </div>
  );
}
