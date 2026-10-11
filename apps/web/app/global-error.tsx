'use client';

/**
 * Last-resort error boundary.
 *
 * Shows the digest, not the stack. The digest is what correlates this screen
 * with the server log line that has the full detail -- the repo is public and
 * the logs are not, so a stack trace must never reach the browser (see #23).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '48px',
          maxWidth: '60ch',
          margin: '0 auto',
          lineHeight: 1.5,
        }}
      >
        <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
        <p>
          The dashboard could not render. The most common cause is that the database is not running
          or has no data yet.
        </p>
        <pre
          style={{
            background: '#f4f5f8',
            padding: 12,
            borderRadius: 8,
            overflowX: 'auto',
            fontSize: 13,
          }}
        >
          ./scripts/dev.sh
        </pre>
        {error.digest ?
          <p style={{ color: '#5c6470', fontSize: 13 }}>
            Reference <code>{error.digest}</code> — quote this when searching the logs or filing an
            issue. See docs/TRIAGE.md.
          </p>
        : null}
      </body>
    </html>
  );
}
