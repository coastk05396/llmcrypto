import { Link } from "react-router";
import { useMoreNav } from "../components/ConsoleLayout";

/** Narrow-screen destination for everything that is not in the bottom bar. */
export function More() {
  const moreNav = useMoreNav();
  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">More</h1>
      <ul className="key-list" aria-label="More pages">
        {moreNav.map((i) => (
          <li key={i.to} className="key-row">
            <h2 className="key-row__name"><Link to={i.to}>{i.label}</Link></h2>
            <p className="muted small">{i.blurb}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
