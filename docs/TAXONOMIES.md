# Taxonomies

How to make this app speak your industry's language.

## The short version

Every category you see — item types, statuses, priorities, severities, health
labels — is a row you can edit, reorder, add to or archive. None of it is
baked into the code.

```bash
npm run db:preset -- construction   # apply a preset's vocabulary
```

## Why rows and not enums

Postgres can add a value to an enum (`ALTER TYPE ... ADD VALUE`) but has **no
way to remove one**. An app that promises "delete the categories you don't
want" cannot be built on them.

And the vocabulary is not universal. "Story" and "bug" mean nothing to a
construction PM, whose work items are RFIs, submittals, inspections and punch
items. An interior designer has specifications, orders and installations.
Requiring a migration to add one would make the app useless to them.

So they are rows. What stays an enum is anything with _behaviour_ attached,
where an unknown value means a code path that does not exist — see
`docs/DATA_MODEL.md`.

## The one column that makes it work

Every workflow status term points at a `status_category`:

```
todo · in_progress · blocked · in_review · done · cancelled
```

That is the bridge between free-form vocabulary and fixed metric maths. Create
"Awaiting inspection", point it at `in_review`, and every flow chart,
percentile and trigger keeps working without knowing the word exists.

**This is the only part you cannot skip.** A workflow status with no category
is rejected on write, because an item in it could never count as started or
finished and would silently fall out of every metric.

A valid workflow needs at least one `todo` term and one `done` term. Without
both ends of the funnel there is no cycle time and no velocity.

Terms do not have to form a line. `On hold` (blocked) and `Void` (cancelled)
sit outside the main path — an item can enter them from anywhere. The seed
derives a linear path for generating plausible history, but nothing in the
metrics requires one.

## The eight system taxonomies

| Key                   | What it names     | Terms (construction)                                                              |
| --------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `work_item_type`      | Kinds of work     | RFI, Submittal, Inspection, Punch item…                                           |
| `workflow_status`     | Board columns     | Not started, Scheduled, In progress, Awaiting inspection, On hold, Complete, Void |
| `project_status`      | Project lifecycle | Planning, In progress, On hold, Complete…                                         |
| `health`              | RAG status        | On track, At risk, Off track                                                      |
| `priority`            | Urgency           | Low, Medium, High, Critical                                                       |
| `severity`            | Impact            | Minor, Moderate, Major, Critical                                                  |
| `impediment_kind`     | Blocker types     | Dependency, Resource, Decision                                                    |
| `impediment_category` | Blocker causes    | Supplier, Weather, Approval…                                                      |

System taxonomies may be **edited but not deleted** — the UI has dedicated
screens reading them, and removing the row leaves those screens with nothing.
Their terms are entirely yours.

You can add taxonomies of your own; that is an insert, not a migration.

## Editing

### Add a term

Add it to your preset file and re-apply. Applying is idempotent and additive —
terms match on `(taxonomy key, slug)`, so re-running updates labels, colours
and ordering in place and never duplicates or drops anything history
references.

```bash
npm run db:preset -- construction
```

### Remove a term

**Archive it.** A term in use is referenced by thousands of historical rows.
Hard-deleting would either fail on the foreign key or rewrite history, and
neither is what "remove this category" should mean.

An archived term:

- disappears from pickers, so nothing new can be given it
- still renders on existing records
- still resolves on import, because historical rows legitimately reference it

Hard delete is only allowed when nothing references the term at all.

### Rename a term

Rename freely. `status_transitions` stores the label alongside the term id, so
history stays readable after a rename rather than retroactively changing what
it says happened.

### Change the nouns

The UI's words come from `app_settings.labels`:

```json
{
  "portfolio": "Programme",
  "project": "Project",
  "iteration": "Phase",
  "workItem": "Work item",
  "milestone": "Milestone",
  "estimateUnit": "days",
  "impediment": "Issue"
}
```

Seeding `construction` instead of `software` re-labels the entire app without
a single component changing. There is a test asserting `/dashboard` renders
zero occurrences of "Sprint" under the construction preset.

## Colours

`taxonomy_terms.color` holds a **design-token name**, not a hex value, so
light and dark themes both stay legible. Chart category colours are defined
per theme — blocked has to read as a problem in both.

## A domain with no preset

Copy the closest one and edit it. `docs/PRESETS.md` covers the format.

```bash
cp packages/db/presets/generic.json packages/db/presets/legal.json
npm run db:preset -- legal
```

## Validation

A preset is rejected before anything is applied if it:

- omits a system taxonomy
- has a `workflow_status` term with no `status_category`
- has a workflow with no `todo` or no `done`
- repeats a slug within one taxonomy
- has a taxonomy with no terms

Half-applying a broken preset produces a workflow whose items can never count
as done, which is a confusing thing to debug from the charts.
