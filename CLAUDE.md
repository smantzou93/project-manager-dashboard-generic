# CLAUDE.md

**Read [`AGENTS.md`](AGENTS.md) first.** It is the single source of truth for
this repository: layout, invariants, conventions, traps and how to verify a
change. Everything there applies here.

This file adds only what is specific to Claude Code.

## Before you start

`docs/TRIAGE.md` has a symptom-to-cause table where every row cost real time
at least once. When something is broken, read that before reading the code.

## Skills

- `/triage-issue` — diagnose a failure from a correlation id, a symptom or an
  issue number. Read-only; it proposes destructive commands rather than
  running them.
- `/run-ingestion` — walk a CSV import through inspect, dry-run and confirm.

## Verifying

```bash
npm run lint && npm run typecheck && npm test   # ~5s
```

The pre-commit hook runs these plus a secret scan. The slow suites
(integration, visual, Python) are in CI — see `docs/TESTING.md` for why.

## Things to be careful about here

- **The repository is public.** Never commit `.env`, and never put a secret in
  `data_sources.config`.
- **Do not run `db-reset.sh --volume` without asking.** It destroys the local
  database. Propose it; let the user run it.
- **Re-seed after an import if you touched the pinned fixture**, or the
  integration suite will fail with changed counts.
- Branch `feature/<issue>-<slug>` off the milestone branch, not `main`.
