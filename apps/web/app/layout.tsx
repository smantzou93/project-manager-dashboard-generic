import type { Metadata } from 'next';

import { getLabels } from '@pmdash/db/queries';

import './globals.css';
import { plural } from '../lib/view-context';

export const metadata: Metadata = {
  title: 'Project dashboard',
  description: 'Cloneable, agent-editable project management dashboard',
};

// Metrics must never be served from a cache; a stale number is worse than a
// slow one when someone is deciding what to escalate.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nav labels come from the active preset, so this bar says "Programmes" for a
  // construction install and "Portfolios" for a software one.
  const labels = await getLabels();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="brand">
            Project dashboard
            <small>{plural(labels.portfolio)} · {plural(labels.project)}</small>
          </span>
          <nav className="nav" aria-label="Main">
            <a href="/">{plural(labels.project)}</a>
            <a href="/dashboard">Dashboard</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
