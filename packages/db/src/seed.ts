/**
 * Seeds demo data so every chart has something real to render on first boot.
 *
 *   npm run db:seed                  # uses the software preset
 *   npm run db:seed -- construction  # or any file in packages/db/presets/
 *
 * The preset supplies both the vocabulary (taxonomy terms) and the demo
 * nouns, so seeding with `construction` produces RFIs and failed inspections
 * rather than stories and bugs. Nothing here hardcodes a domain.
 *
 * Three properties this script is careful about:
 *
 *  - Deterministic. The RNG is seeded, so repeated runs produce identical data.
 *    A dashboard that reshuffles on every seed makes it impossible to tell a
 *    code change from noise when verifying a chart.
 *
 *  - Internally consistent. An item's createdAt <= startedAt <= completedAt by
 *    construction, and `status_transitions` is generated from the very same
 *    timeline, so the history always agrees with the item's own columns.
 *
 *  - Workflow-agnostic. The stage path is derived from the active preset's
 *    workflow_status terms, so a preset with no review column still seeds
 *    cleanly.
 *
 * Destructive: it truncates the tables it owns, and refuses to run against a
 * non-local DATABASE_URL.
 */

import { config as loadEnv } from 'dotenv';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { applyPreset, loadPreset, setSetting, type Preset } from './presets';
import { ensureBuiltinViews } from './queries/views';
import * as s from './schema';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run ./scripts/preflight.sh first.');
  process.exit(1);
}

// Seeding truncates tables, so refuse anything that looks remote. A local-only
// guard is cheap; an accidental production truncate is not.
if (!/@(127\.0\.0\.1|localhost|db)[:/]/.test(url) && !process.env.PMDASH_ALLOW_REMOTE_SEED) {
  console.error(
    'Refusing to seed a non-local DATABASE_URL.\n' +
      'Set PMDASH_ALLOW_REMOTE_SEED=1 if you really mean it.',
  );
  process.exit(1);
}

const presetName =
  process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.env.PMDASH_PRESET ?? 'software';

const client = postgres(url, { max: 4 });
const db = drizzle(client, { schema: s });

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and identical across runs for a given seed. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260407);
const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (p: number) => rng() < p;

const DAY_MS = 86_400_000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const addHours = (d: Date, n: number) => new Date(d.getTime() + n * 3_600_000);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Everything is relative to "now" so the data never looks stale.
 *
 * PMDASH_SEED_NOW pins that reference point to a fixed instant. The RNG is
 * already seeded, but without pinning the clock the *dates* still move: seed
 * today and every age, week bucket and burndown slope differs from yesterday's
 * run. That makes visual regression testing impossible -- every screenshot
 * would differ on every run whether or not any code changed. The visual test
 * suite sets this; normal development leaves it unset and gets fresh-looking
 * data.
 */
const NOW = (() => {
  const pinned = process.env.PMDASH_SEED_NOW;
  if (!pinned) return new Date();
  const d = new Date(pinned);
  if (Number.isNaN(d.getTime())) {
    console.error(`PMDASH_SEED_NOW is not a parseable date: ${pinned}`);
    process.exit(1);
  }
  return d;
})();
const HISTORY_DAYS = 180;
const EPOCH = addDays(NOW, -HISTORY_DAYS);

const FIRST_NAMES = [
  'Ada',
  'Mateo',
  'Priya',
  'Jonas',
  'Wen',
  'Sofia',
  'Kwame',
  'Hannah',
  'Dmitri',
  'Leila',
];
const LAST_NAMES = [
  'Okafor',
  'Rivera',
  'Raman',
  'Lindqvist',
  'Zhao',
  'Marchetti',
  'Asante',
  'Boyle',
  'Volkov',
  'Haddad',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TermRow = {
  id: string;
  slug: string;
  label: string;
  sortOrder: number;
  statusCategory: (typeof s.statusCategoryEnum.enumValues)[number] | null;
};

/** All terms in a taxonomy, in display order. */
async function loadTerms(key: string): Promise<TermRow[]> {
  return db
    .select({
      id: s.taxonomyTerms.id,
      slug: s.taxonomyTerms.slug,
      label: s.taxonomyTerms.label,
      sortOrder: s.taxonomyTerms.sortOrder,
      statusCategory: s.taxonomyTerms.statusCategory,
    })
    .from(s.taxonomyTerms)
    .innerJoin(s.taxonomies, eq(s.taxonomies.id, s.taxonomyTerms.taxonomyId))
    .where(eq(s.taxonomies.key, key))
    .orderBy(s.taxonomyTerms.sortOrder);
}

const byId = (terms: TermRow[], slug: string) => terms.find((t) => t.slug === slug)?.id ?? null;

/**
 * Derives the linear path an item walks through, from the preset's own statuses.
 *
 * Picks at most two `todo` columns, then the first in_progress, in_review and
 * done. Consecutive duplicates are dropped, so a preset with no review stage
 * yields a shorter path instead of a self-transition.
 */
function buildStagePath(statusTerms: TermRow[]): TermRow[] {
  const ofCategory = (c: string) => statusTerms.filter((t) => t.statusCategory === c);
  const todo = ofCategory('todo');
  const candidates = [
    todo[0],
    todo[1],
    ofCategory('in_progress')[0],
    ofCategory('in_review')[0],
    ofCategory('done')[0],
  ];

  const path: TermRow[] = [];
  for (const term of candidates) {
    if (term && path[path.length - 1]?.id !== term.id) path.push(term);
  }
  if (path.length < 2) {
    throw new Error(
      'The active preset needs at least a todo status and a done status to seed a workflow.',
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function clear() {
  // One statement so FK order doesn't matter; RESTART IDENTITY resets bigserials.
  // Taxonomies are included because the preset is re-applied immediately after.
  await db.execute(drizzleSql`
    truncate table
      ${s.statusTransitions}, ${s.ingestionRejects}, ${s.ingestionRuns},
      ${s.metricSnapshots}, ${s.impediments}, ${s.workItems}, ${s.iterations},
      ${s.milestones}, ${s.projects}, ${s.portfolios}, ${s.people},
      ${s.dataSources}, ${s.savedViews}, ${s.taxonomyTerms}, ${s.taxonomies},
      ${s.appSettings}
    restart identity cascade
  `);
}

async function seed(preset: Preset) {
  console.log(`clearing existing rows...`);
  await clear();

  console.log(`applying preset "${preset.key}"...`);
  const applied = await applyPreset(db, preset);
  console.log(`  ${applied.taxonomies} taxonomies, ${applied.terms} terms`);

  // --- resolve vocabulary --------------------------------------------------
  const typeTerms = await loadTerms('work_item_type');
  const statusTerms = await loadTerms('workflow_status');
  const projectStatusTerms = await loadTerms('project_status');
  const healthTerms = await loadTerms('health');
  const priorityTerms = await loadTerms('priority');
  const severityTerms = await loadTerms('severity');
  const kindTerms = await loadTerms('impediment_kind');
  const categoryTerms = await loadTerms('impediment_category');

  const path = buildStagePath(statusTerms);
  const DONE_INDEX = path.length - 1;
  // Where "work actually began" sits on the path; -1 when the preset has no
  // in_progress column at all, in which case nothing gets a startedAt.
  const START_INDEX = path.findIndex((t) => t.statusCategory === 'in_progress');
  const blockedTerm = statusTerms.find((t) => t.statusCategory === 'blocked');

  console.log(`  workflow path: ${path.map((t) => t.label).join(' -> ')}`);

  const demo = preset.demo ?? {};
  const roles = demo.roles ?? ['Project Manager', 'Lead', 'Contributor'];
  const titleVerbs = demo.titleVerbs ?? ['Complete', 'Review', 'Prepare'];
  const titleNouns = demo.titleNouns ?? ['the next deliverable', 'the status report'];
  const milestoneNames = demo.milestones ?? ['Kick-off', 'Midpoint', 'Delivery'];
  const epicNames = demo.epics ?? ['Phase one', 'Phase two'];
  const impedimentTitles = demo.impedimentTitles ?? {};
  const portfolioSpecs = demo.portfolios ?? [{ key: 'MAIN', name: 'Main portfolio' }];
  const projectSpecs = demo.projects ?? [
    {
      key: 'DEMO',
      name: 'Demo project',
      portfolio: portfolioSpecs[0]!.key,
      status: 'active',
      health: 'on_track',
      items: 100,
    },
  ];

  // --- people --------------------------------------------------------------
  const insertedPeople = await db
    .insert(s.people)
    .values(
      FIRST_NAMES.map((first, i) => {
        const displayName = `${first} ${LAST_NAMES[i]}`;
        return {
          displayName,
          role: roles[i % roles.length]!,
          email: `${displayName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
          source: 'manual' as const,
          externalId: `person-${displayName.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        };
      }),
    )
    .returning();
  console.log(`  people: ${insertedPeople.length}`);

  // --- portfolios ----------------------------------------------------------
  const insertedPortfolios = await db
    .insert(s.portfolios)
    .values(
      portfolioSpecs.map((p) => ({ key: p.key, name: p.name, description: p.description ?? null })),
    )
    .returning();
  const portfolioByKey = new Map(insertedPortfolios.map((p) => [p.key, p]));

  // --- a CSV data source, so the ingestion UI has context ------------------
  await db.insert(s.dataSources).values({
    name: 'Manual CSV uploads',
    kind: 'csv',
    config: { note: 'Default target for files uploaded through the web UI.' },
  });

  let totalItems = 0;
  let totalTransitions = 0;
  let totalImpediments = 0;

  for (const spec of projectSpecs) {
    const portfolio = portfolioByKey.get(spec.portfolio) ?? insertedPortfolios[0]!;
    const projectStart = addDays(EPOCH, randInt(0, 14));
    const isComplete = spec.status === 'completed';

    const [project] = await db
      .insert(s.projects)
      .values({
        portfolioId: portfolio.id,
        key: spec.key,
        name: spec.name,
        description: `${spec.name} — seeded demo project.`,
        statusTermId: byId(projectStatusTerms, spec.status),
        healthTermId: byId(healthTerms, spec.health),
        ownerId: pick(insertedPeople).id,
        startDate: isoDate(projectStart),
        targetDate: isoDate(addDays(projectStart, randInt(150, 260))),
        actualEndDate: isComplete ? isoDate(addDays(NOW, -randInt(5, 25))) : null,
        source: 'manual',
        externalId: `project-${spec.key.toLowerCase()}`,
      })
      .returning();

    // `returning()` is typed as an array, so under noUncheckedIndexedAccess the
    // destructured row is possibly-undefined. A single-row insert that returns
    // nothing means the insert silently did not happen, which would otherwise
    // surface a hundred lines later as a null project_id.
    if (!project) throw new Error(`failed to insert project ${spec.key}`);

    // --- milestones --------------------------------------------------------
    const insertedMilestones = await db
      .insert(s.milestones)
      .values(
        milestoneNames.map((name, i) => {
          const due = addDays(projectStart, Math.round((180 / milestoneNames.length) * (i + 1)));
          // Past-due milestones are only sometimes complete; that gap is what
          // makes the at-risk indicators on the dashboard non-trivial.
          const isPast = due < NOW;
          return {
            projectId: project.id,
            name,
            description: `${name} for ${spec.name}`,
            dueDate: isoDate(due),
            completedAt: isPast && chance(0.7) ? addDays(due, randInt(-6, 10)) : null,
            sortOrder: i,
            source: 'manual' as const,
            externalId: `milestone-${spec.key.toLowerCase()}-${i}`,
          };
        }),
      )
      .returning();

    // --- iterations --------------------------------------------------------
    const iterationLabel = preset.labels?.iteration ?? 'Cycle';
    const insertedIterations = await db
      .insert(s.iterations)
      .values(
        Array.from({ length: 12 }, (_, i) => {
          const start = addDays(projectStart, i * 14);
          const end = addDays(start, 13);
          const state =
            end < NOW ? ('closed' as const)
            : start <= NOW ? ('active' as const)
            : ('future' as const);
          return {
            projectId: project.id,
            name: `${spec.key} ${iterationLabel} ${i + 1}`,
            goal: `${iterationLabel} ${i + 1} goals for ${spec.name}`,
            startDate: isoDate(start),
            endDate: isoDate(end),
            state,
            committedPoints: String(randInt(18, 42)),
            source: 'manual' as const,
            externalId: `iteration-${spec.key.toLowerCase()}-${i + 1}`,
          };
        }),
      )
      .returning();

    // --- parent items (epics / work packages / phases) ---------------------
    const groupTypeId =
      byId(typeTerms, 'epic') ??
      byId(typeTerms, 'work_package') ??
      byId(typeTerms, 'phase') ??
      byId(typeTerms, 'group') ??
      typeTerms[0]?.id ??
      null;

    const parentRows = await db
      .insert(s.workItems)
      .values(
        epicNames.map((name, i) => ({
          projectId: project.id,
          milestoneId: insertedMilestones[i]?.id ?? null,
          typeTermId: groupTypeId,
          key: `${spec.key}-G${i + 1}`,
          title: name,
          statusTermId: path[Math.min(START_INDEX < 0 ? 0 : START_INDEX, DONE_INDEX)]!.id,
          statusRaw: path[Math.min(START_INDEX < 0 ? 0 : START_INDEX, DONE_INDEX)]!.label,
          // Both branches need the literal type; annotating only one widens the
          // ternary to `string` and Drizzle rejects it against the enum.
          statusCategory: START_INDEX < 0 ? ('todo' as const) : ('in_progress' as const),
          sourceCreatedAt: projectStart,
          startedAt: projectStart,
          source: 'manual' as const,
          externalId: `group-${spec.key.toLowerCase()}-${i + 1}`,
          labels: ['group'],
        })),
      )
      .returning();

    // Leaf item types only -- a story shouldn't be typed as an epic.
    const leafTypes = typeTerms.filter((t) => t.id !== groupTypeId);
    const leafTypePool = leafTypes.length ? leafTypes : typeTerms;

    // --- work items --------------------------------------------------------
    const itemValues: (typeof s.workItems.$inferInsert)[] = [];
    // Plans keep each item's stage timeline so transitions can be built from
    // exactly the same timestamps once the generated ids come back. Deriving
    // both from one source guarantees the history agrees with the item.
    const plans: {
      externalId: string;
      stageTimes: Date[];
      finalIndex: number;
      blockedAt: Date | null;
    }[] = [];

    for (let i = 0; i < spec.items; i++) {
      // Decide the outcome before the date, because the two are correlated in
      // real projects and independent draws produce a caricature.
      //
      // Drawing createdAt uniformly across 180 days and *then* deciding that a
      // third of items never finish leaves a third of six months of work still
      // in progress -- a demo where 180 items are in flight, most of them
      // several months old. No real project looks like that: old work either
      // ships or gets abandoned, so in-flight work is overwhelmingly recent.
      // It also made the aging-WIP trigger fire on 85% of the board, which is
      // noise rather than signal.
      //
      // So unfinished items are drawn from the recent past instead, with a
      // deliberate thin tail of genuinely stalled work for the trigger to find.
      const roll = rng();
      const willFinish = roll < 0.66;
      const stalled = !willFinish && chance(0.08);

      const createdAt =
        willFinish ? addDays(EPOCH, randInt(0, HISTORY_DAYS - 3))
        : stalled ? addDays(EPOCH, randInt(0, HISTORY_DAYS - 40))
        : addDays(NOW, -randInt(1, 24));

      const iteration = insertedIterations.find(
        (it) =>
          it.startDate &&
          it.endDate &&
          isoDate(createdAt) >= it.startDate &&
          isoDate(createdAt) <= it.endDate,
      );

      // Long-tail cycle times: most items are quick, a few drag for weeks.
      const cycleHours = chance(0.18) ? randInt(24 * 8, 24 * 26) : randInt(3, 24 * 7);

      // Build the whole candidate timeline first, each stage derived from the
      // previous, so the sequence is strictly increasing by construction.
      const stageTimes: Date[] = [createdAt];
      const postStart = Math.max(1, DONE_INDEX - Math.max(START_INDEX, 0));
      for (let stage = 1; stage <= DONE_INDEX; stage++) {
        const prev = stageTimes[stage - 1]!;
        if (START_INDEX >= 0 && stage < START_INDEX) {
          stageTimes[stage] = addHours(prev, randInt(1, 72)); // queueing
        } else if (START_INDEX >= 0 && stage === START_INDEX) {
          stageTimes[stage] = addHours(prev, randInt(1, 24 * 7)); // picked up
        } else {
          // Spread the working time across the remaining stages.
          stageTimes[stage] = addHours(prev, Math.max(1, Math.round(cycleHours / postStart)));
        }
      }

      // How far it would have got, weighted so most history is done with a
      // realistic tail of live work in each column. `roll` was drawn above,
      // where it also chose the creation date.
      let finalIndex =
        roll < 0.66 ? DONE_INDEX
        : roll < 0.78 ? DONE_INDEX - 1
        : roll < 0.9 ? DONE_INDEX - 2
        : roll < 0.96 ? DONE_INDEX - 3
        : 0;
      finalIndex = Math.max(0, finalIndex);

      // An item cannot already have reached a stage whose timestamp is in the
      // future, so walk the target back until the timeline fits. Truncating
      // here (rather than clamping one timestamp) is what keeps
      // createdAt <= startedAt <= completedAt from ever inverting.
      while (finalIndex > 0 && stageTimes[finalIndex]! > NOW) finalIndex--;

      const reachedStart = START_INDEX >= 0 && finalIndex >= START_INDEX;
      const startedAt = reachedStart ? stageTimes[START_INDEX]! : null;
      const completedAt = finalIndex >= DONE_INDEX ? stageTimes[DONE_INDEX]! : null;

      const stageTerm = path[finalIndex]!;
      // Blocked is an overlay on in-flight work, not a stage on the path.
      const blocked = !!blockedTerm && finalIndex > 0 && finalIndex < DONE_INDEX && chance(0.12);
      const shownTerm = blocked ? blockedTerm : stageTerm;
      // Moving into the blocked column is itself a transition, and it has to be
      // recorded. Without it the item reads "On hold" while its history stops at
      // "In progress", so the cumulative flow diagram -- which is built from
      // transitions -- disagrees with the blocked-count tile, which is read off
      // work_items. Two numbers on one dashboard that contradict each other.
      const blockedAt =
        blocked ?
          new Date(
            Math.min(NOW.getTime(), stageTimes[finalIndex]!.getTime() + randInt(1, 72) * 3_600_000),
          )
        : null;
      const externalId = `item-${spec.key.toLowerCase()}-${i + 1}`;

      itemValues.push({
        projectId: project.id,
        iterationId: iteration?.id ?? null,
        milestoneId: pick(insertedMilestones).id,
        parentId: pick(parentRows).id,
        typeTermId: pick(leafTypePool).id,
        key: `${spec.key}-${i + 1}`,
        title: `${pick(titleVerbs)} ${pick(titleNouns)}`,
        statusTermId: shownTerm.id,
        statusRaw: shownTerm.label,
        statusCategory: blocked ? 'blocked' : stageTerm.statusCategory!,
        priorityTermId: pick(priorityTerms).id,
        estimate: String(pick([1, 2, 3, 5, 8, 13])),
        timeSpentHours: startedAt ? String(randInt(1, 40)) : null,
        assigneeId: finalIndex > 0 ? pick(insertedPeople).id : null,
        reporterId: pick(insertedPeople).id,
        sourceCreatedAt: createdAt,
        startedAt,
        completedAt,
        dueDate: chance(0.35) ? isoDate(addDays(createdAt, randInt(7, 45))) : null,
        labels: chance(0.4) ? [pick(['internal', 'external', 'priority', 'review', 'rework'])] : [],
        isBlocked: blocked,
        blockedReason: blocked ? pick(categoryTerms).label : null,
        source: 'manual',
        externalId,
      });

      plans.push({ externalId, stageTimes, finalIndex, blockedAt });
    }

    const insertedItems = await db.insert(s.workItems).values(itemValues).returning({
      id: s.workItems.id,
      externalId: s.workItems.externalId,
    });
    const idByExternal = new Map(insertedItems.map((r) => [r.externalId, r.id]));
    totalItems += insertedItems.length;

    // --- status transitions ------------------------------------------------
    // One row per column the item actually moved through, read straight off the
    // stage timeline that produced its timestamps.
    const transitionValues: (typeof s.statusTransitions.$inferInsert)[] = [];

    for (const plan of plans) {
      const itemId = idByExternal.get(plan.externalId);
      if (!itemId) continue;

      for (let stage = 1; stage <= plan.finalIndex; stage++) {
        const from = path[stage - 1]!;
        const to = path[stage]!;
        const at = plan.stageTimes[stage]!;
        const prevAt = plan.stageTimes[stage - 1]!;
        transitionValues.push({
          workItemId: itemId,
          projectId: project.id,
          fromTermId: from.id,
          toTermId: to.id,
          fromStatus: from.label,
          toStatus: to.label,
          fromCategory: from.statusCategory,
          toCategory: to.statusCategory!,
          occurredAt: at,
          durationInFromSeconds: Math.round((at.getTime() - prevAt.getTime()) / 1000),
          actorId: pick(insertedPeople).id,
        });
      }

      // ...and the overlay move, last, so the item's final status term always
      // equals the last transition's destination.
      if (plan.blockedAt && blockedTerm) {
        const from = path[plan.finalIndex]!;
        const prevAt = plan.stageTimes[plan.finalIndex]!;
        transitionValues.push({
          workItemId: itemId,
          projectId: project.id,
          fromTermId: from.id,
          toTermId: blockedTerm.id,
          fromStatus: from.label,
          toStatus: blockedTerm.label,
          fromCategory: from.statusCategory,
          toCategory: blockedTerm.statusCategory!,
          occurredAt: plan.blockedAt,
          durationInFromSeconds: Math.round((plan.blockedAt.getTime() - prevAt.getTime()) / 1000),
          actorId: pick(insertedPeople).id,
        });
      }
    }

    // Chunked because a single multi-thousand-row insert can exceed the bind
    // parameter limit Postgres allows per statement.
    for (let i = 0; i < transitionValues.length; i += 500) {
      await db.insert(s.statusTransitions).values(transitionValues.slice(i, i + 500));
    }
    totalTransitions += transitionValues.length;

    // --- impediments -------------------------------------------------------
    const impedimentCount =
      spec.health === 'off_track' ? 8
      : spec.health === 'at_risk' ? 5
      : 2;
    const impedimentValues = Array.from({ length: impedimentCount }, (_, i) => {
      const category = pick(categoryTerms);
      const openedAt = addDays(NOW, -randInt(1, 70));
      const resolved = chance(0.45);
      const titles = impedimentTitles[category.slug] ?? [`${category.label} issue`];
      return {
        projectId: project.id,
        kindTermId: pick(kindTerms).id,
        severityTermId: pick(severityTerms).id,
        title: pick(titles),
        description: `Raised during ${spec.name} delivery.`,
        category: category.slug,
        ownerId: pick(insertedPeople).id,
        openedAt,
        resolvedAt: resolved ? addDays(openedAt, randInt(1, 20)) : null,
        source: 'manual' as const,
        externalId: `impediment-${spec.key.toLowerCase()}-${i + 1}`,
      };
    });
    await db.insert(s.impediments).values(impedimentValues);
    totalImpediments += impedimentValues.length;

    console.log(
      `  ${spec.key}: ${spec.items} items, ${transitionValues.length} transitions, ${impedimentCount} impediments`,
    );
  }

  // --- saved views ---------------------------------------------------------
  // Seeded from BUILTIN_VIEWS rather than written inline, so they are valid
  // against the API's saved-view schema by construction.
  //
  // They were inline once, and had drifted: `panels` where the contract says
  // `charts`, a `sort` value outside the enum, and a `health` filter search
  // does not support. The contract tests caught it, which is the argument for
  // having one definition rather than two.
  const builtins = await ensureBuiltinViews();
  console.log(`  saved views: ${builtins}`);

  console.log('');
  console.log(
    `seeded "${preset.key}": ${projectSpecs.length} projects, ${totalItems} items, ` +
      `${totalTransitions} transitions, ${totalImpediments} impediments`,
  );
  // State the clock explicitly: a pinned run and a live run produce different
  // data, and that difference is invisible in the counts above.
  console.log(
    process.env.PMDASH_SEED_NOW ?
      `clock: PINNED at ${NOW.toISOString()} (reproducible; used by visual tests)`
    : `clock: live (${NOW.toISOString()}) -- set PMDASH_SEED_NOW to reproduce exactly`,
  );
}

/**
 * Records how this database was generated.
 *
 * The integration and visual suites assert against exact numbers, which are
 * only valid for a specific preset seeded at a specific instant. Writing both
 * down lets those suites fail with "reseed with this command" instead of a wall
 * of off-by-a-few assertion diffs that look like a code regression.
 */
async function recordSeedProvenance(preset: Preset) {
  await setSetting(db, 'seed_clock', NOW.toISOString());
  await setSetting(db, 'seed_clock_pinned', Boolean(process.env.PMDASH_SEED_NOW));
  await setSetting(db, 'seed_preset', preset.key);
}

try {
  const preset = await loadPreset(presetName);
  await seed(preset);
  await recordSeedProvenance(preset);
  await client.end();
  process.exit(0);
} catch (error) {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  await client.end({ timeout: 5 });
  process.exit(1);
}
