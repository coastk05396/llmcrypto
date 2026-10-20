import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Modal } from "../components/Modal";
import { downloadJson, Failure, FeatureGate, LoadRegion, PageRegion, ProjectPicker, useAttemptKey, useToolAction } from "../components/ToolKit";
import { deleteImport, exportRepository, getGraph, getImport, listImports, listRepositoryEdges, listRepositoryFiles, uploadImport } from "../lib/api-tools";
import { useLoad } from "../lib/use-load";
import { usePaged } from "../lib/use-paged";

function GraphEvidence({ project, id }: { project: string; id: string }) {
  const [depth, setDepth] = useState(2);
  const graphFetch = useCallback((s: AbortSignal) => getGraph(project, id, depth, s), [project, id, depth]);
  const [graph, reload] = useLoad(graphFetch);
  const fileFetch = useCallback((c: string | null, s: AbortSignal) => listRepositoryFiles(project, id, c, s), [project, id]);
  const edgeFetch = useCallback((c: string | null, s: AbortSignal) => listRepositoryEdges(project, id, c, s), [project, id]);
  const files = usePaged(fileFetch); const edges = usePaged(edgeFetch);
  const uid = useId();
  return <>
    <h3>Architecture rollup</h3><p className="muted">Derived by static analysis; not executed, not verified. JS/TS, Python and Go imports only. Unresolved imports and excluded files are reported separately.</p>
    <div className="field"><label htmlFor={uid}>Directory depth</label><select id={uid} value={depth} onChange={(e) => setDepth(Number(e.target.value))}>{[1, 2, 3, 4].map((v) => <option key={v}>{v}</option>)}</select></div>
    <LoadRegion state={graph} what="architecture graph" reload={reload}>{graph.status === "ready" && <>
      <div className="table-wrap" role="region" aria-label="Graph nodes region" tabIndex={0}><table className="data-table" aria-label="Graph nodes"><caption className="sr-only">Directories at the chosen depth</caption><thead><tr><th scope="col">Directory</th><th scope="col" className="num">Files</th><th scope="col">Languages</th></tr></thead><tbody>{graph.data.nodes.map((n) => <tr key={n.path}><th scope="row"><code>{n.path}</code></th><td className="num">{n.files}</td><td>{Object.entries(n.languages).map(([l, c]) => `${l} ${c}`).join(", ")}</td></tr>)}</tbody></table></div>
      {graph.data.edges.length === 0 ? <p>No internal directory connections found.</p> : <div className="table-wrap" role="region" aria-label="Graph connections region" tabIndex={0}><table className="data-table" aria-label="Graph connections"><caption className="sr-only">Connections between directories, with the file and line of up to three import statements behind each</caption><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" className="num">Imports</th><th scope="col">Evidence (file:line)</th></tr></thead><tbody>{graph.data.edges.map((e) => <tr key={`${e.from}:${e.to}`}><th scope="row"><code>{e.from}</code></th><td><code>{e.to}</code></td><td className="num">{e.count}</td><td>{e.evidence.map((v) => `${v.path}:${v.line}`).join(", ")}</td></tr>)}</tbody></table></div>}
      <h4>External packages</h4>{graph.data.external.length === 0 ? <p>None found.</p> : <ul>{graph.data.external.map((e) => <li key={e.name}><code>{e.name}</code>: {e.count}</li>)}</ul>}
    </>}</LoadRegion>
    <h3>Files</h3><PageRegion state={files.state} what="files" reload={files.reload} more={files.loadMore}><div className="table-wrap" role="region" aria-label="Files region" tabIndex={0}><table className="data-table" aria-label="Files"><caption className="sr-only">Analyzed files</caption><thead><tr><th scope="col">Path</th><th scope="col">Language</th><th scope="col" className="num">Lines</th><th scope="col" className="num">Imports out</th><th scope="col" className="num">Imported by</th></tr></thead><tbody>{files.state.status === "ready" && files.state.items.map((f) => <tr key={f.path}><th scope="row"><code>{f.path}</code></th><td>{f.language ?? "unknown"}</td><td className="num">{f.lineCount}</td><td className="num">{f.outgoing}</td><td className="num">{f.incoming}</td></tr>)}</tbody></table></div></PageRegion>
    <h3>Import evidence</h3><PageRegion state={edges.state} what="import statements" reload={edges.reload} more={edges.loadMore}><div className="table-wrap" role="region" aria-label="Import evidence region" tabIndex={0}><table className="data-table" aria-label="Import evidence"><caption className="sr-only">Each import with the file, 1-based line number and the source line</caption><thead><tr><th scope="col">Source (file:line)</th><th scope="col">Imports</th><th scope="col">Kind</th><th scope="col">Source line</th></tr></thead><tbody>{edges.state.status === "ready" && edges.state.items.map((e) => <tr key={e.id}><th scope="row"><code>{e.from}:{e.line}</code></th><td><code>{e.to.path ?? e.to.name ?? e.specifier}</code></td><td>{e.to.kind}</td><td><code>{e.snippet}</code></td></tr>)}</tbody></table></div></PageRegion>
  </>;
}

function ImportDetail({ project, id, onDeleted }: { project: string; id: string; onDeleted(): void }) {
  const fetcher = useCallback((s: AbortSignal) => getImport(project, id, s), [project, id]);
  const [item, reload] = useLoad(fetcher);
  const action = useToolAction(); const [confirm, setConfirm] = useState(false); const cancel = useRef<HTMLButtonElement>(null);
  const running = item.status === "ready" && ["queued", "running"].includes(item.data.status);
  useEffect(() => { if (!running) return; const t = window.setInterval(reload, 2000); return () => window.clearInterval(t); }, [running, reload]);
  return <section className="section--ruled"><LoadRegion state={item} what="repository import" reload={reload}>{item.status === "ready" && <>
    <h2 className="section-title">{item.data.name}</h2><p role="status">Status: {item.data.status}</p>
    {running && <p>Waiting for the import worker. You can leave this page and return later.</p>}
    {item.data.error && <p className="banner banner--danger" role="alert">{item.data.error.code}: {item.data.error.message}</p>}
    {item.data.stats && <><p>{item.data.stats.files} files · {item.data.stats.edges} edges · {item.data.stats.skipped} skipped · {item.data.stats.unresolvedImports} unresolved imports{item.data.stats.edgesTruncated ? " · Edge limit reached; graph is incomplete" : ""}</p><h3>Exclusions</h3><ul>{Object.entries(item.data.stats.skippedByReason).map(([reason, n]) => <li key={reason}>{reason}: {n}</li>)}</ul><p className="small muted">Export JSON includes the excluded paths and reasons.</p></>}
    <Failure failure={action.failure} /><div className="actions"><button className="btn btn--secondary" onClick={reload}>Refresh import</button><button className="btn btn--secondary" disabled={action.busy || item.data.status !== "succeeded"} onClick={() => void action.run(() => exportRepository(project, id), (data) => downloadJson(data, `repository-${id}.json`))}>Export repository JSON</button><button className="btn btn--danger" disabled={action.busy} onClick={() => setConfirm(true)}>Delete import</button></div>
    {item.data.status === "succeeded" && <GraphEvidence project={project} id={id} />}
  </>}</LoadRegion>
    <Modal open={confirm} title="Delete this repository import?" initialFocus={cancel} onRequestClose={() => { if (!action.busy) setConfirm(false); }}><p>Delete this import, graph, paths and evidence permanently?</p><Failure failure={action.failure} /><div className="actions"><button ref={cancel} className="btn btn--secondary" disabled={action.busy} onClick={() => setConfirm(false)}>Cancel</button><button className="btn btn--danger" disabled={action.busy} onClick={() => void action.run(() => deleteImport(project, id), onDeleted)}>Confirm delete import</button></div></Modal>
  </section>;
}

function RepositoryProject({ project }: { project: string }) {
  const fetcher = useCallback((c: string | null, s: AbortSignal) => listImports(project, c, s), [project]);
  const imports = usePaged(fetcher); const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null); const [consent, setConsent] = useState(false); const [invalid, setInvalid] = useState("");
  const action = useToolAction(); const key = useAttemptKey(); const uid = useId(); const input = useRef<HTMLInputElement>(null);
  async function upload() {
    if (!file || !consent) { setInvalid("Choose an archive and consent to processing it."); return; }
    if (!/\.(zip|tar\.gz)$/i.test(file.name) || file.size > 25 * 1024 * 1024 || file.size === 0) { setInvalid("Choose a nonempty ZIP or tar.gz archive up to 25 MiB."); return; }
    setInvalid("");
    await action.run(() => uploadImport(project, file, key.for("upload")), (data) => { key.clear(); setSelected(data.importId); setFile(null); setConsent(false); if (input.current) input.current.value = ""; imports.reload(); });
  }
  return <>
    <section className="section--ruled"><h2 className="section-title">Import repository archive</h2><p className="muted">Upload ZIP or tar.gz, up to 25 MiB compressed and 100 MiB expanded. Remove credentials and private material first. The server applies additional file, depth and expansion limits; it never executes code. Archives are deleted after processing; paths and redacted evidence remain until you delete the import.</p>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void upload(); }}><div className="field"><label htmlFor={uid}>Repository archive</label><input ref={input} id={uid} type="file" accept=".zip,.tar.gz" disabled={action.busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); key.clear(); }} /></div><label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I am authorized to upload and store derived repository data for this project.</span></label>{invalid && <p role="alert" className="field__error">{invalid}</p>}<Failure failure={action.failure} /><button className="btn btn--primary" disabled={action.busy}>Upload archive</button></form>
    </section>
    <section className="section--ruled"><h2 className="section-title">Repository imports</h2><button className="btn btn--secondary" onClick={imports.reload}>Refresh imports</button><PageRegion state={imports.state} what="repository imports" reload={imports.reload} more={imports.loadMore}><ul className="key-list">{imports.state.status === "ready" && imports.state.items.map((i) => <li key={i.id} className="key-row"><button className="btn btn--secondary" aria-pressed={selected === i.id} onClick={() => setSelected(i.id)}>{i.name}</button><p>Status: {i.status}</p></li>)}</ul></PageRegion></section>
    {selected && <ImportDetail key={selected} project={project} id={selected} onDeleted={() => { setSelected(null); imports.reload(); }} />}
  </>;
}
export function RepositoryGraph() {
  return <div className="page-body console-page"><p className="eyebrow">Beta</p><h1 className="page-title">Repository graph</h1><p className="lead muted">Inspect repository structure and the source evidence behind each connection.</p><FeatureGate feature="repositoryGraph"><ProjectPicker>{(project) => <RepositoryProject key={project} project={project} />}</ProjectPicker></FeatureGate></div>;
}
