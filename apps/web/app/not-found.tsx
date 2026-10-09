export default function NotFound() {
  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Not found</h1>
          <p className="muted">
            That project key does not exist in this installation.
          </p>
        </div>
      </div>
      <p>
        <a href="/">← Back to all projects</a>
      </p>
    </main>
  );
}
