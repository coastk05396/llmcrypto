import { CodeBlock } from "../components/CodeBlock";
import { GuideStatusBadge } from "../components/StatusBadge";
import { GUIDES, GUIDE_STATUS_LABEL } from "../lib/snippets";

export function Setup() {
  const origin = window.location.origin;
  return (
    <div className="container page-body">
      <p className="eyebrow">Setup guides</p>
      <h1 className="page-title">Connect your tools</h1>
      <p className="lead">Each guide shows what to configure and an example you can copy. Status labels say how far a guide has been verified.</p>

      <div className="banner banner--info" role="note">
        <span className="banner__title">Honest status</span>
        <span>Every guide below is <strong>{GUIDE_STATUS_LABEL["docs-only"]}</strong>: written from public tool documentation and not yet run against a working instance of this service. A guide moves to “API format checked” or “Tested with our service” only after that check is recorded. There are no downloadable setup scripts yet.</span>
      </div>

      <nav aria-label="Guides on this page" className="toc">
        <ul>{GUIDES.map((g) => <li key={g.id}><a href={`#${g.id}`}>{g.title}</a></li>)}</ul>
      </nav>

      {GUIDES.map((g) => {
        const ex = g.example(origin);
        return (
          <section key={g.id} id={g.id} tabIndex={-1} className="guide" aria-labelledby={`${g.id}-h`}>
            <div className="guide__head">
              <h2 id={`${g.id}-h`}>{g.title}</h2>
              <GuideStatusBadge status={g.status} />
            </div>
            <p>{g.summary}</p>
            <dl className="facts">
              <div><dt>Endpoint</dt><dd><code>{g.endpoint(origin)}</code></dd></div>
              <div><dt>Prerequisites</dt><dd><ul>{g.prerequisites.map((p) => <li key={p}>{p}</li>)}</ul></dd></div>
              <div><dt>Environment variables</dt><dd><ul>{g.env(origin).map((e) => <li key={e}><code>{e}</code></li>)}</ul></dd></div>
            </dl>
            <CodeBlock code={ex.code} label={`${g.title} example`} what={`${g.title} example`} />
            <p className="muted small">{g.caveat}</p>
          </section>
        );
      })}
    </div>
  );
}
