import { useCallback, useId, useState } from "react";
import { PageRegion } from "../components/ToolKit";
import { listAudit } from "../lib/api-tools";
import { formatUtc } from "../lib/format";
import { usePaged } from "../lib/use-paged";

/** Customer audit view: what happened on this account. Operator steps appear as "operator" with no user id. */
export function Audit() {
  const uid = useId();
  const [source, setSource] = useState<"all" | "operator">("all");
  const fetchPage = useCallback((c: string | null, s: AbortSignal) => listAudit(source, c, s), [source]);
  const audit = usePaged(fetchPage);
  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">Audit log</h1>
      <p className="muted lead">Changes made on this account, newest first. Actions by gateway operators are labelled <strong>operator</strong> and never show a personal identity. Visible to owners, admins and billing.</p>
      <div className="field">
        <label htmlFor={uid}>Show</label>
        <select id={uid} value={source} onChange={(e) => setSource(e.target.value as "all" | "operator")}>
          <option value="all">All events</option>
          <option value="operator">Operator actions only</option>
        </select>
      </div>
      <PageRegion state={audit.state} what="audit events" reload={audit.reload} more={audit.loadMore}>
        <div className="table-wrap" role="region" aria-label="Audit events region" tabIndex={0}>
          <table className="data-table" data-testid="audit-table">
            <caption className="sr-only">Audit events, newest first</caption>
            <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th></tr></thead>
            <tbody>
              {audit.state.status === "ready" && audit.state.items.map((e) => (
                <tr key={e.id}>
                  <th scope="row"><time dateTime={e.createdAt}>{formatUtc(e.createdAt)}</time></th>
                  <td>{e.actor}{e.actorUserId ? <> <code>{e.actorUserId}</code></> : null}</td>
                  <td><code>{e.action}</code></td>
                  <td>{e.targetType ? <>{e.targetType} <code>{e.targetId ?? ""}</code></> : ""}</td>
                  <td>{Object.entries(e.details).map(([k, v]) => `${k}: ${v === null ? "none" : String(v)}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageRegion>
    </div>
  );
}
