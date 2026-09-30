---
version: 1
slug: "apps-web-src-features-board"
primary_target: "apps/web/src/features/board"
related_targets: ["apps/web/src/components","apps/web/src/styles.css"]
---

# Board and app shell

Scope: the whole app's visual world, first surface the Board. Mode: operate. The owner runs agent teams across orgs all day on a desktop.

## Direction contract

THESIS: majhi is a flight director's console for agent work: one situation board you read at a glance, not a page you scroll. Refuses the flat gray card stack with Nothing here boxes.

OWN-WORLD: blue-black glass panels over a faint radar grid, cyan hairlines, round status lamps (cyan working, red needs you, magenta paused, green done), mono telemetry numbers. Light theme: pale instrument glass on cool gray grid. Accent is pickable.

STORY: the owner sees at once what runs, what needs them, what waits; clicks a lamp-lit card to act.

FIRST VIEWPORT: fixed shell, no page scroll. Glass sidebar left; top telemetry strip (open, working, needs you, tokens today); status columns with internal scroll; empty columns collapse to rails; agent roster with limit bars right.

FORM: Mission control, my top-ranked candidate (pick card); seed key d112d15c.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
