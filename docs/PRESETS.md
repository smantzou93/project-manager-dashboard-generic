# Presets

A preset is the starting vocabulary for an installation: one JSON file, no
migration, no code change.

```bash
cp packages/db/presets/generic.json packages/db/presets/legal.json
# edit it
npm run db:preset -- legal
```

Four ship with the repo: `software`, `construction`, `interior-design`,
`generic`.

## The format

```jsonc
{
  "key": "construction",
  "label": "Construction",
  "description": "Site works, trades and inspections",

  // What the UI calls things. Every visible noun comes from here.
  "labels": {
    "portfolio": "Programme",
    "project": "Project",
    "iteration": "Phase",
    "workItem": "Work item",
    "milestone": "Milestone",
    "estimateUnit": "days",
    "impediment": "Issue",
  },

  "taxonomies": [
    {
      "key": "workflow_status",
      "label": "Status",
      "terms": [
        {
          "slug": "not_started",
          "label": "Not started",
          "statusCategory": "todo",
          "isDefault": true,
        },
        { "slug": "scheduled", "label": "Scheduled", "statusCategory": "todo" },
        { "slug": "in_progress", "label": "In progress", "statusCategory": "in_progress" },
        {
          "slug": "awaiting_inspection",
          "label": "Awaiting inspection",
          "statusCategory": "in_review",
        },
        { "slug": "on_hold", "label": "On hold", "statusCategory": "blocked" },
        { "slug": "complete", "label": "Complete", "statusCategory": "done" },
      ],
    },
    // ... the other seven system taxonomies
  ],

  // Optional. Vocabulary the seed uses to invent plausible demo rows.
  "demo": {
    "roles": ["Site manager", "Quantity surveyor"],
    "portfolios": [{ "key": "INFRA", "name": "Infrastructure" }],
    "projects": [
      {
        "key": "RIVER",
        "name": "Riverside Tower",
        "portfolio": "INFRA",
        "status": "in_progress",
        "health": "at_risk",
        "items": 140,
      },
    ],
    "milestones": ["Groundworks complete", "Structure topped out"],
    "epics": ["Substructure", "Envelope", "Fit-out"],
    "titleVerbs": ["Pour", "Install", "Inspect", "Procure"],
    "titleNouns": ["level 2 slab", "curtain wall panels", "fire doors"],
    "impedimentTitles": { "supplier": ["Steel delivery delayed"] },
  },
}
```

## Required

All eight system taxonomies must be present: `work_item_type`,
`workflow_status`, `project_status`, `health`, `priority`, `severity`,
`impediment_kind`, `impediment_category`.

`workflow_status` has extra rules, because the metrics depend on it:

- every term needs a `statusCategory`
- at least one `todo` term and one `done` term

A preset failing validation is rejected whole rather than half-applied.

## Term fields

| Field                 |                                                          |
| --------------------- | -------------------------------------------------------- |
| `slug`                | Machine name, unique within the taxonomy. The upsert key |
| `label`               | What a human sees                                        |
| `statusCategory`      | Required for `workflow_status`, ignored elsewhere        |
| `isDefault`           | Applied when a source or form supplies nothing           |
| `color`               | A design-token name, not a hex value                     |
| `description`, `icon` | Optional                                                 |

## Applying

Idempotent and additive. Terms match on `(taxonomy key, slug)`, so re-applying
updates labels, colours and ordering in place, un-archives terms the preset
defines, and never touches a term the user added themselves.

Applying a _different_ preset over a live installation adds its vocabulary
rather than replacing yours. To genuinely start over:

```bash
./scripts/db-reset.sh --volume --preset legal
```

## Writing one for a new domain

1. Copy `generic.json`.
2. Set `key`, `label` and the `labels` block — this is most of the work, and
   most of the value.
3. Replace the terms in each taxonomy with your vocabulary.
4. Map each workflow status onto a `status_category`. Be deliberate: this is
   what makes every chart work.
5. Optionally fill `demo` so a fresh clone seeds something recognisable rather
   than generic filler.
6. `npm run db:preset -- yourdomain`

If you write one for a domain not covered here, a pull request is welcome —
the whole point is that this works outside software.
