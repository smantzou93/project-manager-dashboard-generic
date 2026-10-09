/**
 * Charts, as server-rendered inline SVG.
 *
 * No charting library and no client-side rendering, for three reasons that all
 * matter here:
 *
 *  1. **Deterministic screenshots.** A library that animates on mount, measures
 *     the container, or picks tick counts from available width produces a
 *     different image on every run. These render identically every time, which
 *     is what makes visual regression able to detect a real change.
 *  2. **No hydration cost.** The dashboard is read-only; shipping a charting
 *     runtime to draw static bars is pure overhead.
 *  3. **Prints and pastes.** These views end up in decks and status emails.
 *
 * Accessibility rules applied throughout, per issue #27:
 *  - colour is never the only encoding (every series is directly labelled)
 *  - each chart is role="img" with a <title> and a text summary in <desc>
 *  - the underlying numbers are reachable as a real <table>, visually hidden
 *    but present for screen readers and for copy-paste
 */

import type {
  BurnupPoint,
  FlowDay,
  Forecast,
  ThroughputBucket,
  VelocityBucket,
} from '@pmdash/db/queries';

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

const PAD = { top: 16, right: 16, bottom: 28, left: 40 };

/** Maps a value in [min,max] onto a pixel range, guarding a zero-width domain. */
function scaler(min: number, max: number, from: number, to: number) {
  const span = max - min || 1;
  return (v: number) => from + ((v - min) / span) * (to - from);
}

/** Numbers in SVG paths, trimmed — keeps rendered markup byte-identical. */
const n = (v: number) => Math.round(v * 100) / 100;

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ label, hint }: { label: string; hint: string }) {
  // Designed, not blank. A fresh clone with one week of data must look
  // deliberate rather than broken -- issue #27.
  return (
    <div className="chart-empty">
      <strong>{label}</strong>
      <span>{hint}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bars with a rolling average
// ---------------------------------------------------------------------------

export function ThroughputChart({ data, unit = 'items' }: { data: ThroughputBucket[]; unit?: string }) {
  const W = 560;
  const H = 180;
  const pts = data.filter((_, i) => i < data.length - 1); // drop the partial week

  if (pts.length < 2) {
    return <Empty label="Not enough history yet" hint="Throughput needs at least two complete weeks." />;
  }

  const max = Math.max(...pts.map((p) => p.completed), 1);
  const x = scaler(0, pts.length - 1, PAD.left, W - PAD.right);
  const y = scaler(0, max, H - PAD.bottom, PAD.top);
  const bw = Math.max(4, ((W - PAD.left - PAD.right) / pts.length) * 0.62);

  // 4-week trailing mean. Stated in the legend so nobody has to guess.
  const roll = pts.map((_, i) => {
    const win = pts.slice(Math.max(0, i - 3), i + 1);
    return win.reduce((a, b) => a + b.completed, 0) / win.length;
  });

  const summary = `${pts.length} weeks, ${pts.reduce((a, b) => a + b.completed, 0)} ${unit} completed, peak ${max} in a week.`;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Throughput. ${summary}`}>
        <title>Throughput per week</title>
        <desc>{summary}</desc>

        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} className="axis" />
        {[0, Math.round(max / 2), max].map((t) => (
          <g key={t}>
            <line x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} className="grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="tick" textAnchor="end">
              {t}
            </text>
          </g>
        ))}

        {pts.map((p, i) => (
          <rect
            key={p.weekStart}
            x={n(x(i) - bw / 2)}
            y={n(y(p.completed))}
            width={n(bw)}
            height={n(y(0) - y(p.completed))}
            className="bar"
            rx="2"
          />
        ))}

        <polyline
          className="trend"
          points={roll.map((v, i) => `${n(x(i))},${n(y(v))}`).join(' ')}
          fill="none"
        />

        {pts.map((p, i) =>
          i % Math.ceil(pts.length / 6) === 0 ? (
            <text key={p.weekStart} x={n(x(i))} y={H - 8} className="tick" textAnchor="middle">
              {p.weekStart.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption>
        <span className="key key-bar" /> {unit} completed per week
        <span className="key key-trend" /> 4-week rolling mean
      </figcaption>
      <DataTable
        caption="Throughput per week"
        head={['Week starting', unit]}
        rows={pts.map((p) => [p.weekStart, p.completed])}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

export function VelocityChart({
  data,
  unit,
  iterationLabel,
}: {
  data: VelocityBucket[];
  unit: string;
  iterationLabel: string;
}) {
  const W = 560;
  const H = 180;

  if (data.length < 2) {
    return (
      <Empty
        label="Not enough closed cycles"
        hint={`Velocity needs at least two completed ${iterationLabel.toLowerCase()}s.`}
      />
    );
  }

  // Teams that do not estimate get zero points everywhere; fall back to counts
  // so the chart is still useful rather than a flat line at zero.
  const usePoints = data.some((d) => d.completedPoints > 0);
  const value = (d: VelocityBucket) => (usePoints ? d.completedPoints : d.completedCount);
  const label = usePoints ? unit : 'items';

  const max = Math.max(...data.map((d) => Math.max(value(d), d.committedPoints ?? 0)), 1);
  const x = scaler(0, data.length - 1, PAD.left, W - PAD.right);
  const y = scaler(0, max, H - PAD.bottom, PAD.top);
  const bw = Math.max(6, ((W - PAD.left - PAD.right) / data.length) * 0.55);

  const mean = data.reduce((a, d) => a + value(d), 0) / data.length;
  const summary = `${data.length} closed ${iterationLabel.toLowerCase()}s, mean ${mean.toFixed(1)} ${label}.`;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Velocity. ${summary}`}>
        <title>{`Velocity per ${iterationLabel.toLowerCase()}`}</title>
        <desc>{summary}</desc>

        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} className="axis" />
        {[0, Math.round(max / 2), max].map((t) => (
          <g key={t}>
            <line x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} className="grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="tick" textAnchor="end">
              {t}
            </text>
          </g>
        ))}

        {data.map((d, i) => (
          <g key={d.iterationId}>
            {usePoints && d.committedPoints ? (
              <rect
                x={n(x(i) - bw / 2)}
                y={n(y(d.committedPoints))}
                width={n(bw)}
                height={n(y(0) - y(d.committedPoints))}
                className="bar-ghost"
                rx="2"
              />
            ) : null}
            <rect
              x={n(x(i) - bw / 2)}
              y={n(y(value(d)))}
              width={n(bw)}
              height={n(y(0) - y(value(d)))}
              className="bar"
              rx="2"
            />
          </g>
        ))}

        <line
          x1={PAD.left}
          y1={n(y(mean))}
          x2={W - PAD.right}
          y2={n(y(mean))}
          className="mean-line"
        />
        <text x={W - PAD.right} y={n(y(mean)) - 5} className="tick" textAnchor="end">
          mean {mean.toFixed(1)}
        </text>
      </svg>
      <figcaption>
        <span className="key key-bar" /> {label} completed
        {usePoints ? (
          <>
            <span className="key key-ghost" /> committed
          </>
        ) : null}
      </figcaption>
      <DataTable
        caption={`Velocity per ${iterationLabel.toLowerCase()}`}
        head={[iterationLabel, 'Committed', `Completed (${label})`]}
        rows={data.map((d) => [d.name, d.committedPoints ?? '—', value(d)])}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Cumulative flow
// ---------------------------------------------------------------------------

const FLOW_ORDER = ['todo', 'in_progress', 'blocked', 'in_review', 'done'] as const;
const FLOW_LABEL: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function CumulativeFlowChart({ data }: { data: FlowDay[] }) {
  const W = 560;
  const H = 220;

  const days = [...new Set(data.map((d) => d.day))].sort();
  if (days.length < 2) return <Empty label="Not enough history" hint="Needs at least two days of transitions." />;

  const byDay = new Map<string, Map<string, number>>();
  for (const d of data) {
    if (!byDay.has(d.day)) byDay.set(d.day, new Map());
    byDay.get(d.day)!.set(d.category, d.count);
  }

  const totals = days.map((d) =>
    FLOW_ORDER.reduce((a, c) => a + (byDay.get(d)?.get(c) ?? 0), 0),
  );
  const max = Math.max(...totals, 1);
  const x = scaler(0, days.length - 1, PAD.left, W - PAD.right);
  const y = scaler(0, max, H - PAD.bottom, PAD.top);

  // Stack bottom-up in workflow order, so the bands read in the same direction
  // as the board itself.
  const running = new Array(days.length).fill(0) as number[];
  const bands = FLOW_ORDER.map((cat) => {
    const lower = [...running];
    days.forEach((d, i) => {
      running[i] = (running[i] ?? 0) + (byDay.get(d)?.get(cat) ?? 0);
    });
    const upper = [...running];
    const path = [
      ...days.map((_, i) => `${i === 0 ? 'M' : 'L'}${n(x(i))},${n(y(upper[i]!))}`),
      ...days
        .map((_, i) => days.length - 1 - i)
        .map((i) => `L${n(x(i))},${n(y(lower[i]!))}`),
      'Z',
    ].join(' ');
    return { cat, path, final: (byDay.get(days.at(-1)!)?.get(cat) ?? 0) };
  });

  const summary = `${days.length} days. Today: ${bands
    .filter((b) => b.final > 0)
    .map((b) => `${b.final} ${FLOW_LABEL[b.cat]}`)
    .join(', ')}.`;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cumulative flow. ${summary}`}>
        <title>Cumulative flow</title>
        <desc>{summary}</desc>
        {[0, Math.round(max / 2), max].map((t) => (
          <g key={t}>
            <line x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} className="grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="tick" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {bands.map((b) => (
          <path key={b.cat} d={b.path} className={`flow flow-${b.cat}`} />
        ))}
        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} className="axis" />
        <text x={PAD.left} y={H - 8} className="tick">
          {days[0]!.slice(5)}
        </text>
        <text x={W - PAD.right} y={H - 8} className="tick" textAnchor="end">
          {days.at(-1)!.slice(5)}
        </text>
      </svg>
      <figcaption>
        {FLOW_ORDER.map((c) => (
          <span key={c} className="legend-item">
            <span className={`key key-flow flow-${c}`} /> {FLOW_LABEL[c]}
          </span>
        ))}
      </figcaption>
      <DataTable
        caption="Cumulative flow by day"
        head={['Day', ...FLOW_ORDER.map((c) => FLOW_LABEL[c]!)]}
        rows={days.map((d) => [d, ...FLOW_ORDER.map((c) => byDay.get(d)?.get(c) ?? 0)])}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Burnup with forecast
// ---------------------------------------------------------------------------

export function BurnupChart({
  data,
  forecast,
  targetDate,
}: {
  data: BurnupPoint[];
  forecast: Forecast;
  targetDate?: string | null;
}) {
  const W = 560;
  const H = 200;

  if (data.length < 2) return <Empty label="Not enough history" hint="Burnup needs at least two days." />;

  // Reserve horizontal room for the projection so the forecast is visible
  // rather than clipped at the right edge.
  const future = forecast.ok ? forecast.daysRemaining : 0;
  const total = data.length + future;
  const max = Math.max(...data.map((d) => d.scope), 1);
  const x = scaler(0, Math.max(total - 1, 1), PAD.left, W - PAD.right);
  const y = scaler(0, max, H - PAD.bottom, PAD.top);

  const line = (key: 'completed' | 'scope') =>
    data.map((d, i) => `${n(x(i))},${n(y(d[key]))}`).join(' ');

  const last = data.at(-1)!;
  const summary = `${last.completed} of ${last.scope} complete. ${
    forecast.ok ? `Forecast completion ${forecast.completionDate}.` : `No forecast: ${forecast.reason}.`
  }`;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Burnup. ${summary}`}>
        <title>Burnup with forecast</title>
        <desc>{summary}</desc>

        {[0, Math.round(max / 2), max].map((t) => (
          <g key={t}>
            <line x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} className="grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="tick" textAnchor="end">
              {t}
            </text>
          </g>
        ))}

        <polyline points={line('scope')} className="line-scope" fill="none" />
        <polyline points={line('completed')} className="line-done" fill="none" />

        {forecast.ok ? (
          <>
            <line
              x1={n(x(data.length - 1))}
              y1={n(y(last.completed))}
              x2={n(x(total - 1))}
              y2={n(y(last.scope))}
              className="line-forecast"
            />
            <text x={n(x(total - 1))} y={n(y(last.scope)) - 8} className="tick" textAnchor="end">
              {forecast.completionDate}
            </text>
          </>
        ) : null}

        {targetDate ? (
          <text x={W - PAD.right} y={PAD.top} className="tick" textAnchor="end">
            target {targetDate}
          </text>
        ) : null}

        <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} className="axis" />
      </svg>
      <figcaption>
        <span className="key key-done" /> completed
        <span className="key key-scope" /> total scope
        {forecast.ok ? (
          <>
            <span className="key key-forecast" /> projection (r²&nbsp;{forecast.r2})
          </>
        ) : (
          <em className="muted">no projection — {forecast.reason}</em>
        )}
      </figcaption>
      <DataTable
        caption="Burnup"
        head={['Day', 'Completed', 'Scope']}
        rows={data.map((d) => [d.day, d.completed, d.scope])}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

/**
 * Horizontal bar showing where a value sits against the median and p85.
 * Used for aging items: it makes "this one is unusual" legible at a glance in a
 * way a raw day count is not.
 */
export function AgeBar({ days, median, p85 }: { days: number; median: number; p85: number }) {
  const ceiling = Math.max(p85 * 2, days, 1);
  const pct = (v: number) => `${Math.min(100, (v / ceiling) * 100)}%`;
  const state = days > p85 ? 'over' : days > median ? 'warn' : 'ok';
  return (
    <span
      className={`agebar agebar-${state}`}
      role="img"
      aria-label={`${days.toFixed(1)} days; median ${median}, 85th percentile ${p85}`}
    >
      <span className="agebar-fill" style={{ width: pct(days) }} />
      <span className="agebar-mark" style={{ left: pct(p85) }} />
    </span>
  );
}
