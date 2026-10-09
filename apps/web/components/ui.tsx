/**
 * Shared presentation pieces.
 *
 * Nothing here hardcodes a domain noun. Every label comes from the active
 * preset, so seeding `construction` instead of `software` re-labels the whole
 * app without a component changing -- which is the genericity guarantee the
 * whole data model exists to support.
 */

import type { AgingItem, Trigger } from '@pmdash/db/queries';

import { AgeBar } from './charts';

export function Tile({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string | number;
  sub?: string;
  delta?: { value: number; goodWhen: 'up' | 'down' } | null;
}) {
  let deltaEl = null;
  if (delta && delta.value !== 0) {
    const good = delta.goodWhen === 'up' ? delta.value > 0 : delta.value < 0;
    deltaEl = (
      <span className={`delta ${good ? 'delta-up' : 'delta-down'}`}>
        {delta.value > 0 ? '▲' : '▼'} {Math.abs(delta.value).toFixed(0)}%
      </span>
    );
  }
  return (
    <dl className="tile">
      <dt>{label}</dt>
      <dd>
        {value} {deltaEl}
        {sub ? <div className="sub">{sub}</div> : null}
      </dd>
    </dl>
  );
}

/**
 * Every chart card states its own definition inline.
 *
 * Not decoration: a number a viewer cannot interrogate gets mistrusted, and
 * "velocity" means four different things across four teams. Putting the
 * definition next to the chart is what stops the meeting becoming an argument
 * about the metric instead of the work.
 */
export function Panel({
  title,
  definition,
  children,
}: {
  title: string;
  definition: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="defn">{definition}</p>
      {children}
    </section>
  );
}

export function TriggerList({ triggers }: { triggers: Trigger[] }) {
  if (triggers.length === 0) {
    return (
      <div className="all-clear">
        <span aria-hidden>✓</span>
        <span>Nothing is flagged. No rule fired against the current thresholds.</span>
      </div>
    );
  }
  return (
    <ul className="triggers">
      {triggers.map((t) => (
        <li key={t.rule} className={`trigger trigger-${t.severity}`}>
          <div>
            <span className="rule">
              {t.severity} · {t.rule}
            </span>
            <p>{t.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AgingTable({
  items,
  median,
  p85,
  itemLabel,
  limit = 12,
}: {
  items: AgingItem[];
  median: number | null;
  p85: number | null;
  itemLabel: string;
  limit?: number;
}) {
  if (items.length === 0) {
    return <p className="muted">Nothing is in flight.</p>;
  }
  const shown = items.slice(0, limit);
  return (
    <>
      <table className="data">
        <caption className="visually-hidden">
          {itemLabel}s in flight, oldest first
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Owner</th>
            <th scope="col" className="num">
              Age
            </th>
            <th scope="col">vs p85</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((i) => (
            <tr key={i.id}>
              <td className="key-cell">{i.key}</td>
              <td>
                <div className="truncate" title={i.title}>
                  {i.title}
                </div>
              </td>
              <td>
                <span className={`badge ${i.isBlocked ? 'badge-bad' : ''}`}>
                  {i.isBlocked ? 'blocked' : i.status}
                </span>
              </td>
              <td className="muted">{i.assignee ?? '—'}</td>
              <td className="num">{i.ageDays.toFixed(1)}d</td>
              <td>
                {median !== null && p85 !== null ? (
                  <AgeBar days={i.ageDays} median={median} p85={p85} />
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > limit ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          Showing the {limit} oldest of {items.length} in flight.
        </p>
      ) : null}
    </>
  );
}

export function RiskBar({ risk }: { risk: number }) {
  const band = risk >= 60 ? 'high' : risk >= 30 ? 'med' : 'low';
  return (
    <span
      className={`riskbar risk-${band}`}
      role="img"
      aria-label={`Risk score ${risk} of 100 (${band})`}
    >
      <i style={{ width: `${risk}%` }} />
    </span>
  );
}

export function Progress({ pct }: { pct: number }) {
  return (
    <span className="progress" role="img" aria-label={`${pct}% complete`}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

export function HealthBadge({ health }: { health: string | null }) {
  if (!health) return <span className="badge">unknown</span>;
  // Map by meaning, not by exact string, so a preset's own vocabulary works.
  const l = health.toLowerCase();
  const tone =
    /green|good|on track|healthy/.test(l) ? 'ok'
    : /red|critical|at risk|blocked/.test(l) ? 'bad'
    : /amber|yellow|watch|caution/.test(l) ? 'warn'
    : '';
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{health}</span>;
}
