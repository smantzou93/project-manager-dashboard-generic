/**
 * Single project view: the screen a PM opens when someone asks "how is this
 * going".
 *
 * Deliberately usable with no estimates anywhere. Plenty of teams, and most
 * non-software PMs, never size work; every panel here falls back to counts, so
 * the view stays informative when `estimate` is null throughout.
 */

import { notFound } from 'next/navigation';

import {
  agingWip,
  burnup,
  cumulativeFlow,
  cycleTime,
  forecastFromBurnup,
  getProject,
  leadTime,
  openImpediments,
  projectMilestones,
  throughput,
  triggers,
  wipSummary,
} from '@pmdash/db/queries';

import { BurnupChart, CumulativeFlowChart, ThroughputChart } from '../../../components/charts';
import {
  AgingTable,
  HealthBadge,
  Panel,
  Progress,
  Tile,
  TriggerList,
} from '../../../components/ui';
import { fmtDate, fmtDays, getViewContext, plural } from '../../../lib/view-context';
import { withRequest } from '../../../lib/request';

// Metrics must never come from a cache: a stale number is worse than a slow one
// when someone is deciding what to escalate. Declared per page rather than on
// the root layout, because a force-dynamic layout also swallows the not-found
// boundary -- the custom 404 renders into the flight payload and never commits.
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { asOf, labels } = await getViewContext();

  const project = await getProject(key.toUpperCase());
  if (!project) notFound();

  const scope = { projectId: project.id };
  const [wip, cycle, lead, tput, flow, aging, burn, miles, imps, fired] = await withRequest(
    `/projects/${key}`,
    () =>
      Promise.all([
        wipSummary(asOf, scope),
        cycleTime(asOf, scope),
        leadTime(asOf, scope),
        throughput(asOf, scope),
        cumulativeFlow(asOf, scope),
        agingWip(asOf, scope),
        burnup(asOf, scope),
        projectMilestones(asOf, project.id),
        openImpediments(asOf, scope),
        triggers(asOf, scope),
      ]),
  );

  const forecast = forecastFromBurnup(burn);
  const total = wip.done + wip.inFlight + wip.todo + wip.blocked;
  const pct = total === 0 ? 0 : Math.round((wip.done / total) * 100);

  // The one-line answer to "will this land on time", stated plainly rather than
  // left for the reader to infer from a chart.
  // No initialiser: the branches below are exhaustive, so any default here
  // would be dead code that quietly masks a missing case later.
  let verdict: string;
  let verdictTone = '';
  if (forecast.ok && project.targetDate) {
    const slip = Math.round(
      (new Date(`${forecast.completionDate}T00:00:00Z`).getTime() -
        new Date(`${project.targetDate}T00:00:00Z`).getTime()) /
        864e5,
    );
    verdict =
      slip > 0 ?
        `Tracking ${slip} days past the ${fmtDate(project.targetDate)} target, at the current rate.`
      : `Tracking ${Math.abs(slip)} days inside the ${fmtDate(project.targetDate)} target.`;
    verdictTone = slip > 0 ? 'badge-bad' : 'badge-ok';
  } else if (forecast.ok) {
    verdict = `Projected to finish ${fmtDate(forecast.completionDate)}. No target date set.`;
  } else {
    verdict = `No forecast: ${forecast.reason}.`;
  }

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>
            {project.key} · {project.name}
          </h1>
          <p>
            {project.portfolioName ? `${labels.portfolio}: ${project.portfolioName} · ` : ''}
            Owner: {project.owner ?? 'unassigned'} · <HealthBadge health={project.health} />{' '}
            <span className="badge">{project.status ?? 'unknown'}</span>
          </p>
        </div>
        <span className="asof">as of {asOf.toISOString().slice(0, 16).replace('T', ' ')}Z</span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Will it land on time?</h2>
        <p style={{ margin: '4px 0 0', fontSize: 16 }}>
          <span className={`badge ${verdictTone}`}>{verdict}</span>
        </p>
      </div>

      <div className="tiles">
        <Tile label="Complete" value={`${pct}%`} sub={`${wip.done} of ${total}`} />
        <Tile label="In flight" value={wip.inFlight} sub="started, not finished" />
        <Tile label="Blocked" value={wip.blocked} sub="needs unblocking" />
        <Tile
          label="Cycle time"
          value={fmtDays(cycle.medianDays)}
          sub={`p85 ${fmtDays(cycle.p85Days)}`}
        />
        <Tile
          label="Lead time"
          value={fmtDays(lead.medianDays)}
          sub={`p85 ${fmtDays(lead.p85Days)}`}
        />
        <Tile label={plural(labels.impediment)} value={imps.length} sub="open" />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <Panel
          title="What's holding us back"
          definition={`Rules evaluated for this ${labels.project.toLowerCase()} only.`}
        >
          <TriggerList triggers={fired} />
        </Panel>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Panel
          title="Burnup and forecast"
          definition="Completed against total scope. The projection is withheld when throughput is too erratic to extrapolate honestly."
        >
          <BurnupChart data={burn} forecast={forecast} targetDate={project.targetDate} />
        </Panel>
        <Panel
          title="Throughput"
          definition={`${labels.workItem}s completed per week. The current partial week is excluded.`}
        >
          <ThroughputChart data={tput} unit={`${labels.workItem.toLowerCase()}s`} />
        </Panel>
        <Panel
          title="Cumulative flow"
          definition="Where work sits, day by day, from transition history."
        >
          <CumulativeFlowChart data={flow} />
        </Panel>
        <Panel
          title={plural(labels.milestone)}
          definition={`Completion of each ${labels.milestone.toLowerCase()} against its due date.`}
        >
          {miles.length === 0 ?
            <p className="muted">None defined.</p>
          : <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">{labels.milestone}</th>
                    <th scope="col">Due</th>
                    <th scope="col">Progress</th>
                    <th scope="col" className="num">
                      Items
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {miles.map((m) => {
                    const mp = m.total === 0 ? 0 : Math.round((m.done / m.total) * 100);
                    const overdue =
                      m.dueDate && !m.completedAt && new Date(`${m.dueDate}T00:00:00Z`) < asOf;
                    return (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td className="muted">
                          {fmtDate(m.dueDate)}
                          {overdue ?
                            <>
                              {' '}
                              <span className="badge badge-bad">overdue</span>
                            </>
                          : null}
                        </td>
                        <td>
                          <Progress pct={mp} />
                          <span className="muted" style={{ fontSize: 12 }}>
                            {mp}%
                          </span>
                        </td>
                        <td className="num">
                          {m.done}/{m.total}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          }
        </Panel>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Aging work in progress</h2>
          <p className="defn">
            Started and unfinished, oldest first. The earliest signal that a date is at risk.
          </p>
          <AgingTable
            items={aging}
            median={cycle.medianDays}
            p85={cycle.p85Days}
            itemLabel={plural(labels.workItem)}
          />
        </section>

        <section className="card">
          <h2>Open {plural(labels.impediment).toLowerCase()}</h2>
          <p className="defn">Unresolved, oldest first.</p>
          {imps.length === 0 ?
            <p className="muted">None open.</p>
          : <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Owner</th>
                    <th scope="col" className="num">
                      Age
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {imps.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="truncate" title={i.title}>
                          {i.title}
                        </div>
                      </td>
                      <td className="muted">{i.kind ?? '—'}</td>
                      <td>
                        <span className="badge">{i.severity ?? '—'}</span>
                      </td>
                      <td className="muted">{i.owner ?? '—'}</td>
                      <td className="num">{i.ageDays.toFixed(0)}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          }
        </section>
      </div>
    </main>
  );
}
