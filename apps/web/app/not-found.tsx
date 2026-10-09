/**
 * The 404 page.
 *
 * Deleted once, on a wrong conclusion: a custom not-found appeared never to
 * render, and the cause looked like a React boundary defect. It was actually
 * the dev-origin block that stopped React hydrating at all (see
 * `allowedDevOrigins` in next.config.mjs) — the body streams into the flight
 * payload and commits on the client, which cannot happen when the dev client
 * is blocked.
 *
 * Worth knowing: this content is NOT in the server-rendered HTML. Checking
 * with curl will suggest it is broken. Check in a browser.
 */
export default function NotFound() {
  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Not found</h1>
          <p className="muted">That project key does not exist in this installation.</p>
        </div>
      </div>
      <p>
        <a href="/">← Back to all projects</a>
      </p>
    </main>
  );
}
