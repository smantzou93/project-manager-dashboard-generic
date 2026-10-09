# Testing

Four suites, split by what they need to run. The split is the important part:
each one is in the place where it can afford to take the time it needs.

| Suite       | Command                                       | Needs                     | Time | Runs in        |
| ----------- | --------------------------------------------- | ------------------------- | ---- | -------------- |
| Unit        | `npm test`                                    | nothing                   | <1s  | pre-commit, CI |
| Integration | `npm run test:integration`                    | Postgres + pinned fixture | ~1s  | CI             |
| Visual      | `npm run test:visual`                         | Postgres + app + browser  | ~30s | CI             |
| Gates       | `npm run lint` / `typecheck` / `format:check` | nothing                   | ~5s  | pre-commit, CI |

## The pinned clock

This is the thing to understand before changing anything here.

Every date in the fixture is generated relative to a reference instant, and
every metric is computed "as of" one. Both are injected:

- **`PMDASH_SEED_NOW`** fixes the instant the seed generates dates from.
- **`PMDASH_AS_OF`** fixes the instant the app renders as of.

Both are set to `2026-10-01T12:00:00Z`, declared once in
[`tests/fixtures.ts`](../tests/fixtures.ts).

A seeded RNG is not enough on its own. The generator was already deterministic,
so the _shape_ of the data never varied — but the _dates_ did. Seed on Tuesday
and seed on Wednesday and you get different ages, different week buckets and a
different burndown slope. Under that, every screenshot differs from its
baseline every single day, and a real regression becomes indistinguishable from
the calendar moving.

Pinning only the seed is also not enough. If the app still calls `now()`
internally, the pinned fixture ages by a day every day and you are back where
you started. That is why `asOf` is a parameter on every metric query rather
than something a query reads for itself. It pays for itself twice: the metric
becomes testable, and "what did this board look like at the end of Q2" costs no
extra code.

The seed records what it used (`seed_clock`, `seed_clock_pinned`,
`seed_preset`), and the integration suite checks those before running. If the
fixture is wrong it fails with the command to fix it rather than asserting
against shifted data and producing a wall of confusing diffs.

**The suite never reseeds its own fixture.** A suite that reshapes its inputs
until the assertions pass has stopped being a test.

## Running them

```bash
# Unit — pure computation, no services. This is what pre-commit runs.
npm test

# Integration — needs the pinned fixture:
./scripts/dev.sh --pinned --preset construction --seed-only
npm run test:integration

# Visual — starts the app itself and prepares the fixture:
npm run test:visual
```

## Screenshots

Two sets, for two purposes.

**Baselines** live in `tests/visual/__baselines__/<platform>/` and exist to
catch regressions. **Documentation screenshots** live in `docs/screenshots/`
and are what the README and the docs display.

Both come from the same capture, so the image in the README is the one the
suite asserts against and the two cannot quietly drift apart.

```bash
npm run test:visual           # compare against baselines
npm run test:visual:update    # accept the current rendering as the baseline
npm run screenshots           # also refresh the documentation set
```

### Why baselines are per platform

Font rasterisation differs between macOS and Linux. The antialiasing on text
alone accounts for a few hundred differing pixels on a chart-heavy page, so a
baseline captured on a laptop can never match a Linux CI runner.

Rather than pretend otherwise, each platform keeps its own directory and **CI
(Linux) is authoritative**. A macOS baseline is a local convenience; if the two
disagree, the Linux one is right.

**Bootstrapping the Linux set.** They cannot be produced on a laptop, so the
first CI run writes them and fails. Download the `playwright-report` artifact
from that run, commit `tests/visual/__baselines__/linux/`, and every run after
that compares against them. The workflow prints a notice saying exactly this
when it happens.

### What makes a capture reproducible

Beyond the clock, the config pins everything that would otherwise vary:

- fixed viewport and `deviceScaleFactor: 1` — a fractional ratio resamples text
  differently per machine
- `reducedMotion`, `animations: 'disabled'`, `caret: 'hide'`
- `timezoneId: 'UTC'`, `locale: 'en-GB'`, explicit `colorScheme`
- a wait on `document.fonts.ready` — `networkidle` is not enough, because web
  fonts swap in after first paint and reflow every label
- charts are hand-written inline SVG rather than a charting library, because a
  library that animates on mount or derives tick counts from measured width
  renders differently on every run

`maxDiffPixelRatio` is `0.002`. A couple of stray antialiased pixels are not a
regression; a changed chart is thousands.

## Why screenshots are not in pre-commit

They need Docker, Postgres and a browser, which is minutes rather than seconds.
A hook that takes minutes gets bypassed with `--no-verify` inside a day — and
at that point the _fast_ checks stop running too, which is a worse outcome than
not having the slow ones in the hook at all.

Committing binary PNGs on every commit also bloats the history permanently.

So pre-commit runs only what is instant and needs nothing: format, lint,
typecheck, unit tests, and a secret scan. CI runs everything, and on a pull
request it comments with the before/after images so a reviewer sees what
changed without checking the branch out.

## Writing a visual test

Pair every pixel comparison with functional assertions.

A screenshot test on its own tells you _that_ something changed and never
_what_ broke: you get a red diff and still have to go looking. The assertions
name the failure, the image shows it. Every spec in `tests/visual/` does both.

```ts
test('renders the KPI tiles from the pinned fixture', async ({ page }) => {
  expect(await tileValue(page, 'In flight')).toContain(String(M.wip.inFlight));
});

test('visual', async ({ page }) => {
  await capture(page, 'dashboard');
});
```

## Known gaps

- `npm run build` fails prerendering Next's internal `/_global-error`
  ([#39](https://github.com/smantzou93/project-manager-dashboard-generic/issues/39)).
  The visual suite therefore targets `next dev`.
- No 404 body renders under Next 16.4 / React 19.3
  ([#44](https://github.com/smantzou93/project-manager-dashboard-generic/issues/44)),
  so the 404 test asserts the status code only — which is the contract that
  actually matters, and which is correct.
