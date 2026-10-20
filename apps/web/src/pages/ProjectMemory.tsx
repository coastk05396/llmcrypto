import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import type { Memory, MemorySettings, Project } from "@llmcrypto/contracts";
import { CopyBanner, LoadError, Skeleton, StatusLine } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { Badge } from "../components/StatusBadge";
import { describeFailure, type ApiFailure } from "../lib/api";
import {
  createMemory, createProject, deleteMemory, exportMemories, getMemory, getMemorySettings, listMemories, listMemoryUsage, listProjects, updateMemory, updateMemorySettings,
} from "../lib/api-product";
import { forbiddenCopy, isCode, isStatus, isVersionConflict, type Copy } from "../lib/auth-copy";
import { formatUtc } from "../lib/format";
import { useSession } from "../lib/session";
import { useLoad } from "../lib/use-load";
import { usePaged } from "../lib/use-paged";

const failText = (f: ApiFailure, what: string) => forbiddenCopy(f, what) ?? describeFailure(f);

// ---------------------------------------------------------------- notes

/** The API allows inject=true only for owner/admin (injected notes go to the model provider). */
function useMayInject(): boolean {
  const { state } = useSession();
  return state.status === "signed-in" && (state.session.membership.role === "owner" || state.session.membership.role === "admin");
}

function NoteForm({ projectId, onCreated }: { projectId: string; onCreated(m: Memory): void }) {
  const uid = useId();
  const { handleFailure } = useSession();
  const [text, setText] = useState("");
  const [inject, setInject] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const mayInject = useMayInject();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!text.trim() || !consent) { setShowMissing(true); return; }
    setShowMissing(false);
    setBusy(true);
    setError(null);
    const r = await createMemory(projectId, { text, storageConsent: true, inject: inject && mayInject });
    setBusy(false);
    if (r.ok) { setText(""); setInject(false); setConsent(false); return onCreated(r.data); }
    if (handleFailure(r.error)) return;
    setError(r.error.kind === "http" && r.error.status === 422 ? "The note was not accepted: it needs text (up to 10,000 characters) and your storage consent, or the project already holds 200 notes." : failText(r.error, "project's notes"));
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="form-stack" aria-busy={busy}>
      {error && <p className="banner banner--danger" role="alert"><span className="banner__title">Note not saved</span><span>{error}</span></p>}
      <div className="field">
        <label htmlFor={`${uid}-t`}>New note</label>
        <textarea id={`${uid}-t`} value={text} maxLength={10000} aria-invalid={showMissing && !text.trim() ? true : undefined} onChange={(e) => setText(e.target.value)} aria-describedby={`${uid}-th`} />
        <p id={`${uid}-th`} className={showMissing && !text.trim() ? "field__error" : "small muted"}>{showMissing && !text.trim() ? "Write the note text." : `${text.length} of 10,000 characters. Only what you type here is stored; requests and responses are never saved as notes.`}</p>
      </div>
      <label className="check"><input type="checkbox" checked={inject && mayInject} disabled={!mayInject} onChange={(e) => setInject(e.target.checked)} /><span>Allow this note to be added to requests for this project (inject). Also needs Project context turned on in Context steering.{!mayInject ? " Only owners and admins can turn this on." : ""}</span></label>
      <div className="consent">
        <label className="check"><input type="checkbox" checked={consent} aria-invalid={showMissing && !consent ? true : undefined} onChange={(e) => setConsent(e.target.checked)} /><span>I consent to storing this text until I delete it or the retention period removes it. I will not store secrets.</span></label>
        {showMissing && !consent && <p className="field__error">Storage consent is required.</p>}
      </div>
      <div className="actions"><button type="submit" className="btn btn--primary" aria-disabled={busy}>{busy ? "Saving" : "Save note"}</button></div>
    </form>
  );
}

type Conflict = { latest: Memory } | { gone: true };

function EditDialog({ projectId, note, onClose, onSaved }: { projectId: string; note: Memory | null; onClose(): void; onSaved(m: Memory): void }) {
  const { handleFailure } = useSession();
  const [text, setText] = useState("");
  const [inject, setInject] = useState(false);
  const [consent, setConsent] = useState(false);
  const [base, setBase] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const uid = useId();
  const mayInject = useMayInject();
  useEffect(() => {
    if (note) { setText(note.text); setInject(note.inject); setConsent(false); setBase(note.version); setError(null); setConflict(null); }
  }, [note]);

  async function save() {
    if (!note || busy) return;
    if (!text.trim() || !consent) { setError("Write the text and tick the storage consent to save."); return; }
    setBusy(true);
    setError(null);
    const r = await updateMemory(projectId, note.id, { text, expectedVersion: base, storageConsent: true, inject });
    if (r.ok) { setBusy(false); return onSaved(r.data); }
    if (handleFailure(r.error)) { setBusy(false); return; }
    if (isVersionConflict(r.error)) {
      const latest = await getMemory(projectId, note.id);
      setBusy(false);
      if (latest.ok) setConflict({ latest: latest.data });
      else if (isStatus(latest.error, 404)) setConflict({ gone: true });
      else setError(failText(latest.error, "note"));
      return;
    }
    setBusy(false);
    setError(isStatus(r.error, 404) ? "This note no longer exists." : failText(r.error, "note"));
  }

  return (
    <Modal open={note !== null} title="Edit note" onRequestClose={() => { if (!busy) onClose(); }}>
      {note && (
        <div className="form-stack">
          {conflict && "gone" in conflict && (
            <div className="banner banner--warning" role="alert" data-testid="version-conflict">
              <span className="banner__title">This note was deleted elsewhere</span><span>Your edit was not saved. Close this dialog; the list will refresh.</span>
              <button type="button" className="btn btn--secondary btn--small" onClick={() => onSaved({ ...note, version: -1 })}>Close and refresh</button>
            </div>
          )}
          {conflict && "latest" in conflict && (
            <div className="banner banner--warning" role="alert" data-testid="version-conflict">
              <span className="banner__title">This note changed elsewhere</span>
              <span>It is now at version {conflict.latest.version}; you started from version {base}. Nothing was overwritten. Compare, then choose.</span>
              <div className="diff-pair">
                <div><p className="small"><strong>Current stored text (version {conflict.latest.version})</strong></p><pre className="pre-block" data-testid="theirs">{conflict.latest.text}</pre></div>
                <div><p className="small"><strong>Your text</strong></p><pre className="pre-block" data-testid="yours">{text}</pre></div>
              </div>
              <div className="actions">
                <button type="button" className="btn btn--primary btn--small" onClick={() => { setBase(conflict.latest.version); setConflict(null); setInject(conflict.latest.inject); }}>Keep my text and save over version {conflict.latest.version}</button>
                <button type="button" className="btn btn--secondary btn--small" onClick={() => { setText(conflict.latest.text); setInject(conflict.latest.inject); setBase(conflict.latest.version); setConflict(null); }}>Use the current text instead</button>
              </div>
            </div>
          )}
          {error && <p className="banner banner--danger" role="alert"><span className="banner__title">Not saved</span><span>{error}</span></p>}
          <div className="field">
            <label htmlFor={`${uid}-t`}>Note text</label>
            <textarea id={`${uid}-t`} value={text} maxLength={10000} onChange={(e) => setText(e.target.value)} />
            <p className="small muted">Editing replaces the text. Editing from version {base}; if someone else saved first you will see a conflict, not a silent overwrite.</p>
          </div>
          <label className="check"><input type="checkbox" checked={inject} disabled={!mayInject && !note.inject} onChange={(e) => setInject(e.target.checked)} /><span>Allow this note to be added to requests (inject){!mayInject ? ". Only owners and admins can turn this on." : ""}</span></label>
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I consent to storing this text. Retention restarts from this edit.</span></label>
          <div className="actions">
            <button type="button" className="btn btn--primary" aria-disabled={busy || conflict !== null} onClick={() => void save()}>{busy ? "Saving" : "Save changes"}</button>
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function DeleteDialog({ projectId, note, onClose, onDeleted }: { projectId: string; note: Memory | null; onClose(): void; onDeleted(m: Memory): void }) {
  const { handleFailure } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { setBusy(false); setError(null); }, [note]);
  async function confirm() {
    if (!note || busy) return;
    setBusy(true);
    const r = await deleteMemory(projectId, note.id);
    setBusy(false);
    if (r.ok || isStatus(r.error, 404)) return onDeleted(note);
    if (handleFailure(r.error)) return;
    setError(failText(r.error, "note"));
  }
  return (
    <Modal open={note !== null} title="Delete this note?" onRequestClose={() => { if (!busy) onClose(); }} initialFocus={cancel}>
      {note && (
        <div className="form-stack">
          <p>Delete the note starting <q>{note.text.slice(0, 80)}{note.text.length > 80 ? "…" : ""}</q>? It is removed for good and no longer added to requests. Usage evidence keeps only its id and version, never its text.</p>
          {error && <p className="banner banner--danger" role="alert"><span className="banner__title">Not deleted</span><span>{error}</span></p>}
          <div className="actions">
            <button ref={cancel} type="button" className="btn btn--secondary" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn--danger" aria-disabled={busy} onClick={() => void confirm()}>{busy ? "Deleting" : "Delete note"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- retention, export, evidence

function Retention({ projectId }: { projectId: string }) {
  const fetchSettings = useCallback((s: AbortSignal) => getMemorySettings(projectId, s), [projectId]);
  const [settings, reload] = useLoad<MemorySettings>(fetchSettings);
  const { handleFailure } = useSession();
  const uid = useId();
  const [days, setDays] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Copy | null>(null);
  useEffect(() => {
    if (settings.status === "ready") { setKeep(settings.data.retentionDays === null); setDays(settings.data.retentionDays === null ? "" : String(settings.data.retentionDays)); }
  }, [settings]);

  async function save() {
    if (settings.status !== "ready" || busy) return;
    const n = Number(days);
    if (!keep && !(Number.isInteger(n) && n >= 1 && n <= 365)) { setMsg({ title: "Check the days", body: "Enter a whole number from 1 to 365, or keep notes until deleted.", tone: "danger" }); return; }
    setBusy(true);
    setMsg(null);
    const r = await updateMemorySettings(projectId, { retentionDays: keep ? null : n, expectedVersion: settings.data.version });
    setBusy(false);
    if (r.ok) { setMsg({ title: "Retention saved", body: keep ? "Notes are kept until you delete them." : `Notes expire ${n} days after their last edit. Notes already older than that are removed from view and from future requests.`, tone: "info" }); reload(); return; }
    if (handleFailure(r.error)) return;
    if (isVersionConflict(r.error)) { setMsg({ title: "Settings changed elsewhere", body: "Reloaded the latest value. Check it and save again if you still want to change it.", tone: "warning" }); reload(); return; }
    setMsg({ title: "Retention not saved", body: failText(r.error, "retention setting"), tone: "danger" });
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="section--ruled">
      <h2 id={`${uid}-h`} className="section-title">Retention</h2>
      {settings.status === "loading" && <Skeleton label="Loading retention" />}
      {settings.status === "error" && <LoadError what="retention settings" failure={settings.failure} onRetry={reload} />}
      {settings.status === "ready" && (
        <div className="form-stack">
          <p className="muted">A note expires this many days after its last edit. Expired notes are hidden, left out of exports and requests, and deleted by a background job.</p>
          <label className="check"><input type="radio" name={`${uid}-r`} checked={keep} onChange={() => setKeep(true)} /><span>Keep notes until I delete them</span></label>
          <label className="check"><input type="radio" name={`${uid}-r`} checked={!keep} onChange={() => setKeep(false)} /><span>Delete notes after a number of days</span></label>
          {!keep && (
            <div className="field">
              <label htmlFor={`${uid}-d`}>Days after last edit (1 to 365)</label>
              <input id={`${uid}-d`} type="number" inputMode="numeric" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          )}
          {msg && <CopyBanner copy={msg} />}
          <div className="actions"><button type="button" className="btn btn--secondary" aria-disabled={busy} onClick={() => void save()}>{busy ? "Saving" : "Save retention"}</button></div>
        </div>
      )}
    </section>
  );
}

function ExportBox({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { handleFailure } = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Copy | null>(null);
  async function run() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await exportMemories(projectId);
    setBusy(false);
    if (!r.ok) {
      if (handleFailure(r.error)) return;
      return setMsg({ title: "Export failed", body: failText(r.error, "export"), tone: "danger" });
    }
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `project-memory-${projectName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || projectId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMsg({ title: "Export downloaded", body: `${r.data.noteCount} notes, retention setting and ${r.data.usage.length} usage rows${r.data.usageTruncated ? " (usage truncated at the newest 1,000)" : ""}. The file contains your note text; store it carefully.`, tone: "info" });
  }
  return (
    <section aria-labelledby="export-head" className="section--ruled">
      <h2 id="export-head" className="section-title">Export</h2>
      <p className="muted">Download every stored note, the retention setting and usage evidence of this project as one JSON file.</p>
      {msg && <CopyBanner copy={msg} />}
      <div className="actions"><button type="button" className="btn btn--secondary" aria-disabled={busy} onClick={() => void run()}>{busy ? "Preparing" : "Export JSON"}</button></div>
    </section>
  );
}

function UsageEvidence({ projectId }: { projectId: string }) {
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => {
    const q = new URLSearchParams({ limit: "50" });
    if (cursor) q.set("cursor", cursor);
    return listMemoryUsage(projectId, q.toString(), signal);
  }, [projectId]);
  const u = usePaged(fetchPage);
  return (
    <section aria-labelledby="usage-head" className="section--ruled">
      <h2 id="usage-head" className="section-title">Where notes were used</h2>
      <p className="muted">Evidence that a note was added to a request, or skipped and why. It stores ids and versions only, so it stays after a note is deleted.</p>
      {u.state.status === "loading" && <Skeleton label="Loading usage evidence" />}
      {u.state.status === "error" && <LoadError what="usage evidence" failure={u.state.failure} onRetry={u.reload} />}
      {u.state.status === "ready" && u.state.items.length === 0 && <div className="empty"><h3>No uses yet</h3><p className="muted">A note appears here when a request is served with project context on and the note is eligible.</p></div>}
      {u.state.status === "ready" && u.state.items.length > 0 && (
        <>
          <ul className="evidence-list" aria-label="Memory usage evidence" data-testid="memory-usage">
            {u.state.items.map((e) => (
              <li key={e.id}>
                <span>Note <code>{e.memoryId}</code> version {e.version} {e.status === "injected" ? "used in" : "skipped for"} request <Link to={`/app/usage/${encodeURIComponent(e.requestId)}`}><code>{e.requestId}</code></Link></span>{" "}
                <Badge tone={e.status === "injected" ? "success" : "neutral"}>{e.status}</Badge>
                {e.reason ? <span className="small muted"> {e.reason}</span> : null}
                <span className="small muted"> <time dateTime={e.createdAt}>{formatUtc(e.createdAt)}</time></span>
              </li>
            ))}
          </ul>
          {u.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={u.state.loadingMore} onClick={u.loadMore}>{u.state.loadingMore ? "Loading" : "Load more"}</button>}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- project panel and page

function ProjectPanel({ project }: { project: Project }) {
  const fetchNotes = useCallback((s: AbortSignal) => listMemories(project.id, s), [project.id]);
  const [notes, reload] = useLoad(fetchNotes);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [notice, setNotice] = useState("");
  return (
    <>
      <StatusLine>{notice}</StatusLine>
      <section aria-labelledby="notes-head">
        <h2 id="notes-head" className="section-title">Notes in {project.name}</h2>
        {notes.status === "loading" && <Skeleton label="Loading notes" />}
        {notes.status === "error" && <LoadError what="notes" failure={notes.failure} onRetry={reload} />}
        {notes.status === "ready" && notes.data.items.length === 0 && <div className="empty"><h3>No notes in this project</h3><p className="muted">Nothing is stored until you add a note below.</p></div>}
        {notes.status === "ready" && notes.data.items.length > 0 && (
          <ul className="key-list" aria-label="Notes">
            {notes.data.items.map((n) => (
              <li key={n.id} className="key-row" data-testid="note">
                <div className="key-row__main">
                  <h3 className="key-row__name">Version {n.version}</h3>
                  {n.inject ? <Badge tone="info">Inject on</Badge> : <Badge tone="neutral">Not injected</Badge>}
                </div>
                <pre className="pre-block">{n.text}</pre>
                <dl className="key-row__facts">
                  <div><dt>Updated</dt><dd>{formatUtc(n.updatedAt)}</dd></div>
                  <div><dt>Expires</dt><dd>{n.expiresAt ? formatUtc(n.expiresAt) : "When deleted"}</dd></div>
                </dl>
                <div className="key-row__actions">
                  <button type="button" className="btn btn--secondary btn--small" aria-label={`Edit note version ${n.version}: ${n.text.slice(0, 30)}`} onClick={() => setEditing(n)}>Edit</button>
                  <button type="button" className="btn btn--secondary btn--small" aria-label={`Delete note version ${n.version}: ${n.text.slice(0, 30)}`} onClick={() => setDeleting(n)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {notes.status === "ready" && <p className="small muted">{notes.data.items.length} of 200 notes.</p>}
      </section>
      <section aria-labelledby="add-head" className="section--ruled">
        <h2 id="add-head" className="section-title">Add a note</h2>
        <NoteForm projectId={project.id} onCreated={() => { setNotice("Note saved"); reload(); }} />
      </section>
      <Retention projectId={project.id} />
      <ExportBox projectId={project.id} projectName={project.name} />
      <UsageEvidence projectId={project.id} />
      <EditDialog projectId={project.id} note={editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); setNotice(m.version < 0 ? "Note refreshed" : `Note saved as version ${m.version}`); reload(); }} />
      <DeleteDialog projectId={project.id} note={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); setNotice("Note deleted"); reload(); }} />
    </>
  );
}

function CreateProject({ onCreated }: { onCreated(p: Project): void }) {
  const uid = useId();
  const { handleFailure } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError("Enter a project name."); return; }
    setBusy(true);
    setError(null);
    const r = await createProject(name.trim());
    setBusy(false);
    if (r.ok) { setName(""); return onCreated(r.data); }
    if (handleFailure(r.error)) return;
    setError(isStatus(r.error, 422) || isCode(r.error, "VALIDATION_FAILED") ? "That name is empty, too long, or already used by another project (names are not case sensitive)." : failText(r.error, "projects (owners and admins create projects)"));
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="form-stack" aria-busy={busy}>
      <div className="field">
        <label htmlFor={`${uid}-n`}>New project name</label>
        <input id={`${uid}-n`} type="text" maxLength={100} value={name} autoComplete="off" aria-invalid={error ? true : undefined} aria-describedby={error ? `${uid}-e` : undefined} onChange={(e) => setName(e.target.value)} />
        {error && <p id={`${uid}-e`} className="field__error" role="alert">{error}</p>}
      </div>
      <div className="actions"><button type="submit" className="btn btn--secondary" aria-disabled={busy}>{busy ? "Creating" : "Create project"}</button></div>
    </form>
  );
}

export function ProjectMemory() {
  const [projects, reload] = useLoad(listProjects);
  const [params, setParams] = useSearchParams();
  const items = projects.status === "ready" ? projects.data.items : [];
  const wanted = params.get("project");
  const selected = items.find((p) => p.id === wanted) ?? items[0] ?? null;
  const uid = useId();
  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">Project memory</h1>
      <p className="muted lead">Notes you choose to store for a project. Nothing is saved automatically: prompts and answers are never kept as notes. A note is added to requests only if you also turn on Project context in <Link to="/app/context">Context steering</Link> and set the note&apos;s inject flag.</p>

      {projects.status === "loading" && <Skeleton label="Loading projects" />}
      {projects.status === "error" && <LoadError what="projects" failure={projects.failure} onRetry={reload} />}
      {projects.status === "ready" && (
        <section aria-labelledby={`${uid}-ph`}>
          <h2 id={`${uid}-ph`} className="section-title">Project</h2>
          {items.length === 0 ? (
            <div className="empty"><h3>No projects yet</h3><p className="muted">Create a project to start storing notes.</p></div>
          ) : (
            <div className="field">
              <label htmlFor={`${uid}-sel`}>Project</label>
              <select id={`${uid}-sel`} value={selected?.id ?? ""} onChange={(e) => setParams({ project: e.target.value })}>
                {items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <CreateProject onCreated={(p) => { setParams({ project: p.id }); reload(); }} />
        </section>
      )}
      {selected && <ProjectPanel key={selected.id} project={selected} />}
    </div>
  );
}
