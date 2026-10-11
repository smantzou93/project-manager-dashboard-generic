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

Two different things, often confused, with very different value here.

### Functional browser tests — run by default

```bash
npm run test:visual
```

Real assertions in a real browser: KPI values, the risk ordering, that no
preset-specific noun leaks into the UI, that the page does not scroll
sideways at phone width, that a 404 actually renders. **These need no
baselines** and are unaffected by changing the preset or editing the UI.

Every bug this suite has caught came from one of these, not from an image:

| Bug                                          | Caught by                             |
| -------------------------------------------- | ------------------------------------- |
| Page scrolled sideways on mobile             | `scrollWidth - clientWidth` assertion |
| 404 body never rendering                     | `getByRole('heading')` assertion      |
| React never hydrating at all                 | the hydration probe                   |
| "Sprint" leaking into a construction install | text-content assertion                |

### Pixel comparison — opt-in

```bash
npm run test:pixel          # compare
npm run test:pixel:update   # accept the current rendering
```

**Baselines are not committed**, and neither are they generated in CI.

This repository exists to be cloned and re-pointed at another industry. The
first thing a clone does is change the preset — which changes every label and
every number on every screen. Any baseline shipped here would be stale on
arrival, and the new owner's first job would be deleting 1.2MB of someone
else's screenshots.

So Playwright writes them on first run, locally, for whoever is running it.
They are gitignored.

**Your first `npm run test:pixel` will fail.** That is Playwright's normal
behaviour for a missing snapshot: it writes the baseline and reports the test
as failed. Run it again and it passes. Verified: first run 5 failed, second
run 5 passed.

Being honest about the value: in this project, pixel diffs have caught **zero**
bugs. Every failure has been an intended change. They are kept because they
are cheap to run and occasionally catch a layout regression that no assertion
anticipated — but they are not load-bearing, and CI does not run them.

### If you do want pixel regression in CI

Font rasterisation differs between macOS and Linux, so a baseline captured on
a laptop can never match a Linux runner. `scripts/baselines-linux.sh` runs the
browser in a Linux container with the app and database still on your machine:

```bash
npm run baselines:linux            # generate
npm run baselines:linux -- --check # compare, as CI would
```

Commit `tests/visual/__baselines__/linux/` (you would need to un-ignore it),
and add `npm run test:pixel` to the CI job.

**One caveat, learned the hard way.** The container matches CI's _platform_,
not its _fonts_: CI installs Chromium with `--with-deps` on `ubuntu-latest`,
which brings a different font set than the Playwright image ships. A page that
measured zero overflow on macOS and zero in the container overflowed by 35px
on a runner. So the container will get you close, and it is the right tool for
a Linux-only layout bug, but it is not pixel-identical to this CI. If you want
that, run the browser the same way CI does rather than from the image.

Worth it for a product; probably not worth it for a template.

### Documentation screenshots

Separate from all of the above, and these _are_ committed — they are the
images in the README, and showing a reader what the app looks like is worth
1.2MB.

```bash
npm run screenshots
```

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
