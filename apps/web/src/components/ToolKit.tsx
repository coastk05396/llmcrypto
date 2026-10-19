import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { FeatureFlags } from "@llmcrypto/contracts";
import { describeFailure, type ApiFailure, type ApiResult } from "../lib/api";
import { listProjects } from "../lib/api-product";
import { getFeatures } from "../lib/api-tools";
import { useLoad, type Load } from "../lib/use-load";
import { useSession } from "../lib/session";
import type { PagedState } from "../lib/use-paged";
import { LoadError, Skeleton } from "./Feedback";

export function FeatureGate({ feature, children }: { feature: keyof FeatureFlags; children: ReactNode }) {
  const [flags, reload] = useLoad(getFeatures);
  return <LoadRegion state={flags} what="feature availability" reload={reload}>{flags.status === "ready" && (flags.data[feature] ? children : <p className="banner banner--info" role="status">Unavailable on this deployment. This beta feature is disabled.</p>)}</LoadRegion>;
}

export function ProjectPicker({ children }: { children(project: string): ReactNode }) {
  const [projects, reload] = useLoad(listProjects);
  const [params, setParams] = useSearchParams();
  const uid = useId();
  const items = projects.status === "ready" ? projects.data.items : [];
  const wanted = params.get("project");
  const selected = wanted ? items.find((p) => p.id === wanted) : items[0];
  return <LoadRegion state={projects} what="projects" reload={reload}>
    {projects.status === "ready" && <>
      {items.length > 0 && <div className="field"><label htmlFor={uid}>Project</label><select id={uid} value={selected?.id ?? ""} onChange={(e) => setParams({ project: e.target.value })}><option value="" disabled>Select a project</option>{items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
      {!selected && <p className="empty">{wanted ? "This project is unavailable. Choose an accessible project." : "No projects yet."} <Link to="/app/memory">Manage projects in Project memory</Link>.</p>}
      {selected && <div key={selected.id}>{children(selected.id)}</div>}
    </>}
  </LoadRegion>;
}

export function LoadRegion<T>({ state, what, reload, children }: { state: Load<T>; what: string; reload(): void; children: ReactNode }) {
  if (state.status === "loading") return <Skeleton label={`Loading ${what}`} />;
  if (state.status === "error") return <LoadError what={what} failure={state.failure} onRetry={reload} />;
  return <>{children}</>;
}
export function PageRegion<T>({ state, what, reload, more, children }: { state: PagedState<T>; what: string; reload(): void; more(): void; children: ReactNode }) {
  if (state.status === "loading") return <Skeleton label={`Loading ${what}`} />;
  if (state.status === "error") return <LoadError what={what} failure={state.failure} onRetry={reload} />;
  return <>{state.items.length === 0 ? <p className="empty">No {what}.</p> : children}{state.moreError && <LoadError what={`more ${what}`} failure={state.moreError} onRetry={more} />}{state.nextCursor && <button className="btn btn--secondary" disabled={state.loadingMore} onClick={more}>Load more {what}</button>}</>;
}
export function Failure({ failure }: { failure: ApiFailure | null }) {
  return failure && <p className="banner banner--danger" role="alert">{describeFailure(failure)} {failure.kind === "http" && failure.code === "VERSION_CONFLICT" ? "Reload the latest version before trying again." : ""}{failure.kind === "http" && failure.code === "STEP_UP_REQUIRED" ? "A recent sign-in is required." : ""}{failure.kind === "http" && failure.fieldErrors.map((f) => `${f.field}: ${f.message}`).join(" ")}</p>;
}
export function useToolAction() {
  const { handleFailure } = useSession();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  async function run<T>(action: () => Promise<ApiResult<T>>, done: (data: T) => void) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setFailure(null);
    try {
      const r = await action();
      if (r.ok) done(r.data);
      else if (!handleFailure(r.error)) setFailure(r.error);
    } finally { locked.current = false; setBusy(false); }
  }
  return { busy, failure, run };
}
/** A failed response may still have committed. Reuse the key only for an identical logical request. */
export function useAttemptKey() {
  const ref = useRef({ payload: "", key: "" });
  return { for: (payload: string) => { if (ref.current.payload !== payload || !ref.current.key) ref.current = { payload, key: crypto.randomUUID() }; return ref.current.key; }, clear: () => { ref.current = { payload: "", key: "" }; } };
}
export function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
