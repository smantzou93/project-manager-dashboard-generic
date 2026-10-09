/**
 * Multi-project view: every project on one screen, ranked by where attention is
 * needed.
 *
 * Sorted by risk, never alphabetically. A portfolio view that has to be scanned
 * has failed at its job -- the top row should be the project a PM would have
 * raised in the meeting anyway. The risk weighting is documented in
 * `riskScore` in packages/db/src/queries/projects.ts.
 */

import { projectSummaries, triggers, wipSummary } from '@pmdash/db/queries';

import { HealthBadge, Panel, Progress, RiskBar, Tile, TriggerList } from '../components/ui';
import { fmtDate, getViewContext, plural } from '../lib/view-context';

// Metrics must never come from a cache: a stale number is worse than a slow one
// when someone is deciding what to escalate. Declared per page rather than on
// the root layout, because a force-dynamic layout also swallows the not-found
// boundary -- the custom 404 renders into the flight payload and never commits.
export const dynamic = 'force-dynamic';

export default async function MultiProjectPage() {
  const { asOf, labels } = await getViewContext();
  const [summaries, wip, fired] = await Promise.all([
    projectSummaries(asOf),
    wipSummary(asOf),
    triggers(asOf),
  ]);

  const atRisk = summaries.filter((s) => s.risk >= 60).length;
  const slipping = summaries.filter((s) => (s.forecastSlipDays ?? 0) > 0).length;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>{plural(labels.project)}</h1>
          <p>
            {summaries.length} {plural(labels.project).toLowerCase()}, ordered by risk — most
            exposed first.
          </p>
        </div>
        <span className="asof">as of {asOf.toISOString().slice(0, 16).replace('T', ' ')}Z</span>
      </div>

      <div className="tiles">
        <Tile label={plural(labels.project)} value={summaries.length} sub={`${atRisk} at risk`} />
        <Tile
          label="In flight"
          value={wip.inFlight}
          sub={`${labels.workItem.toLowerCase()}s started`}
        />
        <Tile label="Blocked" value={wip.blocked} sub="needs unblocking" />
        <Tile label="Completed" value={wip.done} sub="to date" />
        <Tile label="Forecast slipping" value={slipping} sub={`of ${summaries.length}`} />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <Panel
          title="What's holding us back"
          definition="Threshold rules evaluated across every project. Only rules that fired are shown, most severe first."
        >
          <TriggerList triggers={fired} />
        </Panel>
      </div>

      <section className="card">
        <h2>{plural(labels.project)} by risk</h2>
        <p className="defn">
          Risk combines forecast slip, blocked share of WIP, open {labels.impediment.toLowerCase()}
          s, stalled work and overdue status. 0–100, higher is worse.
        </p>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">{labels.project}</th>
                <th scope="col">{labels.portfolio}</th>
                <th scope="col">Health</th>
                <th scope="col">Progress</th>
                <th scope="col" className="num">
                  In flight
                </th>
                <th scope="col" className="num">
                  Blocked
                </th>
                <th scope="col">Target</th>
                <th scope="col">Forecast</th>
                <th scope="col">Risk</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`/projects/${s.key}`}>
                      <strong>{s.key}</strong>
                    </a>
                    <div className="muted truncate" title={s.name}>
                      {s.name}
                    </div>
                  </td>
                  <td className="muted">{s.portfolioName ?? '—'}</td>
                  <td>
                    <HealthBadge health={s.health} />
                  </td>
                  <td>
                    <Progress pct={s.percentComplete} />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {s.percentComplete}% of {s.total}
                    </span>
                  </td>
                  <td className="num">{s.inFlight}</td>
                  <td className="num">
                    {s.blocked > 0 ?
                      <span className="badge badge-bad">{s.blocked}</span>
                    : '—'}
                  </td>
                  <td className="muted">{fmtDate(s.targetDate)}</td>
                  <td>
                    {s.forecast.ok ?
                      <>
                        {fmtDate(s.forecast.completionDate)}
                        {s.forecastSlipDays !== null && s.forecastSlipDays > 0 ?
                          <div>
                            <span className="badge badge-bad">+{s.forecastSlipDays}d late</span>
                          </div>
                        : <div>
                            <span className="badge badge-ok">on track</span>
                          </div>
                        }
                      </>
                    : <span className="muted" title={s.forecast.reason}>
                        no forecast
                      </span>
                    }
                  </td>
                  <td>
                    <RiskBar risk={s.risk} />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {s.risk}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
