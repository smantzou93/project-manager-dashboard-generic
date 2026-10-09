/**
 * The charts view.
 *
 * Flamegraph deliberately absent: it answers a profiler's question, not a
 * project manager's. What is here is the set a PM acts on — throughput and
 * velocity for capacity, cumulative flow for where work piles up, aging WIP for
 * what to chase today, and a burnup with an honest forecast for the date.
 */

import { cycleTime, dashboardSnapshot } from '@pmdash/db/queries';

import {
  BurnupChart,
  CumulativeFlowChart,
  ThroughputChart,
  VelocityChart,
} from '../../components/charts';
import { AgingTable, Panel, Tile, TriggerList } from '../../components/ui';
import { fmtDays, getViewContext, plural } from '../../lib/view-context';

/** Percentage change, guarding division by zero and reporting 0 for no base. */
function pctChange(now: number, before: number): number {
  if (before === 0) return 0;
  return ((now - before) / before) * 100;
}

export default async function DashboardPage() {
  const { asOf, labels } = await getViewContext();
  const snap = await dashboardSnapshot(asOf);

  // Prior-period comparison for the tiles. Excludes the current partial week,
  // which is always lower and would otherwise show a decline every Monday.
  const weeks = snap.throughput.slice(0, -1);
  const recent = weeks.slice(-4);
  const previous = weeks.slice(-8, -4);
  const recentMean = recent.length ? recent.reduce((a, b) => a + b.completed, 0) / recent.length : 0;
  const prevMean = previous.length
    ? previous.reduce((a, b) => a + b.completed, 0) / previous.length
    : 0;

  // Cycle time over the last 60 days, to compare against the all-time figure.
  const recentCycle = await cycleTime(asOf, { from: new Date(asOf.getTime() - 60 * 864e5) });

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>
            Flow across every {labels.project.toLowerCase()}. Each panel states its own
            definition.
          </p>
        </div>
        <span className="asof">as of {asOf.toISOString().slice(0, 16).replace('T', ' ')}Z</span>
      </div>

      <div className="tiles">
        <Tile
          label="Throughput"
          value={recentMean.toFixed(1)}
          sub="per week, 4-week mean"
          delta={{ value: pctChange(recentMean, prevMean), goodWhen: 'up' }}
        />
        <Tile
          label="Cycle time"
          value={fmtDays(snap.cycle.medianDays)}
          sub={`median · p85 ${fmtDays(snap.cycle.p85Days)}`}
          delta={
            recentCycle.medianDays && snap.cycle.medianDays
              ? {
                  value: pctChange(recentCycle.medianDays, snap.cycle.medianDays),
                  goodWhen: 'down',
                }
              : null
          }
        />
        <Tile
          label="Lead time"
          value={fmtDays(snap.lead.medianDays)}
          sub={`median · p85 ${fmtDays(snap.lead.p85Days)}`}
        />
        <Tile label="In flight" value={snap.wip.inFlight} sub="started, not finished" />
        <Tile label="Blocked" value={snap.wip.blocked} sub="of those in flight" />
        <Tile label="Completed" value={snap.wip.done} sub="to date" />
      </div>

      <div className="grid" style={{ marginBottom: 16 }}>
        <Panel
          title="What's holding us back"
          definition="Rules over aging work, blockers and throughput trend. Thresholds live in app_settings and are editable per installation."
        >
          <TriggerList triggers={snap.triggers} />
        </Panel>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Panel
          title="Throughput"
          definition={`${labels.workItem}s completed per calendar week. Estimate-free, so it works whether or not the team sizes work. The current partial week is excluded.`}
        >
          <ThroughputChart data={snap.throughput} unit={`${labels.workItem.toLowerCase()}s`} />
        </Panel>

        <Panel
          title={`Velocity per ${labels.iteration.toLowerCase()}`}
          definition={`${labels.estimateUnit} completed in each closed ${labels.iteration.toLowerCase()}. In-flight ${labels.iteration.toLowerCase()}s are excluded — a partial one always looks like a collapse.`}
        >
          <VelocityChart
            data={snap.velocity}
            unit={labels.estimateUnit}
            iterationLabel={labels.iteration}
          />
        </Panel>

        <Panel
          title="Cumulative flow"
          definition="Items in each workflow category per day, reconstructed from transition history. Widening bands show where work accumulates."
        >
          <CumulativeFlowChart data={snap.flow} />
        </Panel>

        <Panel
          title="Burnup and forecast"
          definition="Completed against total scope. Two lines rather than a burndown so scope growth is distinguishable from stalled progress. The projection is a least-squares fit and is withheld when the data cannot support one."
        >
          <BurnupChart data={snap.burnup} forecast={snap.forecast} />
        </Panel>
      </div>

      <section className="card">
        <h2>Aging work in progress</h2>
        <p className="defn">
          Everything started and not finished, oldest first. The bar compares each item's age
          against the {snap.cycle.p85Days ?? '—'}-day 85th percentile cycle time; a full red bar is
          an outlier worth asking about.
        </p>
        <AgingTable
          items={snap.aging}
          median={snap.cycle.medianDays}
          p85={snap.cycle.p85Days}
          itemLabel={plural(labels.workItem)}
          limit={15}
        />
      </section>
    </main>
  );
}
