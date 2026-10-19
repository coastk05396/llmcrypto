import { Link } from "react-router";

export function NotFound() {
  return (
    <div className="container page-body">
      <p className="eyebrow">404</p>
      <h1 className="page-title">Page not found</h1>
      <p className="lead">There is no page at this address.</p>
      <div className="actions">
        <Link to="/" className="btn btn--primary">Go to the home page</Link>
        <Link to="/setup" className="btn btn--secondary">Setup guides</Link>
      </div>
    </div>
  );
}
