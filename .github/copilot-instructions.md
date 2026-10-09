# Copilot instructions

**Read [`../AGENTS.md`](../AGENTS.md).** It is the single source of truth for
this repository — layout, invariants, conventions and traps — and everything in
it applies.

The short version, for completions:

- Domain vocabulary (types, statuses, severities) lives in `taxonomy_terms`.
  Never add a `pgEnum` for it.
- Branch on `status_category`, never on a status label.
- `status_transitions` is append-only and must stay monotonic.
- Metrics take an explicit `asOf`; never call `now()` inside a query.
- Lead time measures from `source_created_at`, never `created_at`.
- Exclude group items from aggregates: `not ('group' = any(wi.labels))`.
- UI labels come from the active preset. Never hardcode "Sprint", "story",
  "ticket" or "bug".
- Relative imports inside workspace packages are extensionless.
- This repository is public: no secrets in code, config, logs or fixtures.
