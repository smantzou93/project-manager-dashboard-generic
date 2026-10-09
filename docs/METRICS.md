# Metrics

The exact definition of every number on the dashboard. Each is stated in the
code it is computed by, asserted by a test against a fixed fixture, and
repeated here for people who are not going to read the code.

A changed definition should **break a test**. If one does not, that metric was
not covered.

All of them live in [`packages/db/src/queries/metrics.ts`](../packages/db/src/queries/metrics.ts).

## Two rules that apply to everything

**Every metric takes an explicit `asOf`.** No query reads the clock itself.
A metric that does cannot be tested — its answer changes daily — and cannot
answer "what did this look like at the end of Q2".

**Group items are excluded from every aggregate.** Parent containers are in
flight for a whole project by design; counted as work they inflate WIP and
dominate aging.

---

## Throughput

> Work items completed per calendar week.

ISO weeks, Monday start. Gap-filled, so a zero week renders as zero rather
than vanishing and making the line misleadingly smooth. **The current partial
week is excluded** — it is always lower and would otherwise show a decline
every Monday.

Deliberately estimate-free. Velocity needs story points, which plenty of teams
and most non-software PMs never record. Throughput works everywhere and
answers the same planning question.

## Velocity

> Estimate units completed per **closed** iteration.

Only closed iterations, and an iteration ending _today_ does not count — it
has not finished, and counting it reports a partial result as if it were
final.

Returns zero points for teams that do not estimate; the chart falls back to
item counts so it stays useful rather than flat-lining at zero.

## Cycle time

> `completed_at − started_at`. Team working time.

**Reported as median and 85th percentile. Never a mean.**

Cycle-time distributions have a long right tail — a handful of items that
dragged for weeks. The mean sits above most of the data, so it simultaneously
overstates the typical case and understates the tail. The median says what
usually happens; the p85 is the number you quote when committing to a date.

Below about eight completed items the percentiles are noise. The query returns
`n` so a caller can say so.

## Lead time

> `completed_at − source_created_at`. The wait as the requester experienced
> it, including time queued before anyone picked the work up.

**Measured from `source_created_at`, never `created_at`.** `created_at` is row
bookkeeping — when this database first saw the row. For imported data the two
differ by months, so lead time from `created_at` reports the import lag rather
than a real wait.

Lead time is always ≥ cycle time. There is a test asserting that; if it ever
inverts, one of the two is reading the wrong column.

## Cumulative flow

> How many items sat in each status category on each day.

Reconstructed from `status_transitions`, which is the only way to answer it.
Each transition opens an interval the next one closes; an item's state on a
day is the interval covering it.

**State is sampled at one instant per day** — the last microsecond. Comparing
one bound against end-of-day and the other against start-of-day looks
equivalent and is not: it counts an item twice on any day it moved. That bug
shipped briefly and was caught by asserting the stack sums to the number of
items that exist.

Items imported without date columns have no history and appear nowhere here.
That is honest rather than invented; the import summary says how many.

## Work in progress

> Started, not completed, not cancelled.

## Aging WIP

> Everything in flight, oldest first, aged from `started_at`.

**The most actionable table on the dashboard.** A burndown tells you that you
are behind; aging WIP tells you which item to go ask about — and it does so
earlier than any trend line, because work stops moving long before a chart
bends.

Aged from `started_at` rather than creation, so it is time spent working and
directly comparable against cycle time. The bar beside each item compares its
age against the p85.

## Burnup

> Cumulative completed against cumulative total scope, per day.

Preferred over a burndown because the two lines separate scope change from
progress. A burndown that flattens looks identical whether the team stopped
delivering or the work grew underneath them. A burnup shows which.

Both lines are monotonic; there are tests for that, because a non-monotonic
cumulative series means the window or a boundary comparison is wrong.

## Forecast

> Least-squares fit on the burnup's completed line, extrapolated to current
> scope.

**It refuses rather than guessing.** A confident line through three points
gets screenshotted into a status deck and then defended, which is worse than
no line at all. It declines when:

| Condition              | Default                                                       |
| ---------------------- | ------------------------------------------------------------- |
| Too few observations   | fewer than 14 days                                            |
| Flat or negative slope | nothing is being completed, so no date exists                 |
| Poor fit               | r² below 0.5 — throughput too erratic to extrapolate honestly |
| Scope already complete | nothing left to forecast                                      |

A refusal carries a reason, and the UI shows it instead of a date.

## Risk score

> 0–100, higher is worse. Orders the multi-project view.

The weighting is a judgement call, stated plainly so it can be argued with:

| Signal                              | Up to     |
| ----------------------------------- | --------- |
| Forecast past the target date       | 40        |
| Past target and unfinished          | 20 (flat) |
| Blocked share of in-flight work     | 25        |
| Open impediments (4 each)           | 20        |
| Oldest in-flight item, past 14 days | 15        |
| No forecast available at all        | 5         |

The ordering principle: **things that are already true outrank things that are
predicted**, and a forecast slip is the strongest single signal because it is
the only one that speaks directly to the date. Blocked and stalled work rank
next because they cause slips. Raw volume ranks nowhere — a big project is not
a troubled one.

Blocked work is scaled by _share_ of WIP, not absolute count: 5 blocked of 10
is a worse situation than 5 of 100.

The multi-project view sorts by this. A portfolio view that has to be scanned
has failed at its job.

## Triggers

> Threshold rules over the metrics above. Only rules that fired are shown,
> most severe first.

| Rule                   | Fires when                                                  |
| ---------------------- | ----------------------------------------------------------- |
| `aging-wip`            | an item exceeds 1.5× the p85 cycle time                     |
| `blocked-items`        | anything in flight is blocked                               |
| `stale-impediment`     | an impediment is open past 14 days                          |
| `wip-limit`            | in-flight count exceeds a configured limit (off by default) |
| `declining-throughput` | throughput falls 3 weeks running                            |

Thresholds live in `app_settings`, editable per installation — a one-week
sprint and a two-week construction phase do not share them.

Every message carries the number that fired it, so the panel reads as
statements rather than warnings. Rules read `status_category`, never status
labels, so they fire on "Awaiting inspection" without knowing the word exists.

**A trigger that fires on most of the board is noise.** An early fixture made
`aging-wip` flag 153 of 180 in-flight items; the fixture was wrong, not the
threshold. There is a test asserting the count stays actionable.

---

## Verifying

```bash
npm run test:integration
```

Asserts exact values against the `construction` fixture at a pinned instant,
plus the invariants: lead ≥ cycle, p85 > median, buckets gap-filled, the
cumulative flow stack summing to the number of items that exist, and both
burnup lines monotonic.

The exact values are in [`tests/fixtures.ts`](../tests/fixtures.ts).
