# Brief: phase A of "Ship without me" (task types, origin, the tasks board, the task page)

Branch `feat/tasks-phase-a`. The approved design is `docs/design/ship-without-me.md` (sections 1, 5, 6, 7, 10). The approved mockup is `marketing-assets/ship-mockup/ship.html` with shots in `marketing-assets/ship-mockup/shots/` and screenshots of today's real app in `marketing-assets/ship-mockup/ref/current-*.png` (git-ignored; generic content). Read both before any code.

## Read first

- `CLAUDE.md`, `docs/briefs/quality-bar.md`.
- `docs/design/task-lifecycle.md` (approved and partly built: `packages/shared/src/lifecycle/` holds, the lift table, transitions; `apps/server/src/tasks/lifecycle/`; every status write goes through `apply()`). Build on it. Never add a second notion of "waiting" or "paused": the board's Needs you and Waiting columns come from the hold's lifter (owner or system) in that model. Do not edit the lifecycle module except to read it; if something is missing there, stop and say so.
- `docs/design/ship-without-me.md` section 7, "One source of truth": every new stored field has one home, and derived things are derived on read.

## Rules

- Reuse, never rebuild: the board and tree extend `apps/web/src/features/board/`; the task page extends `apps/web/src/features/task/`. Same components (rows, chips, ListDetail, the room, the dock).
- No regex or text matching for decisions (lifecycle section 3 and 10). Inference uses typed data (branch type inference that exists, finding source and severity, Laya's typed choice).
- Copy as in the mockup. No hint lines under headings. No em dashes. Generic names in tests and fixtures.
- Tests only where CLAUDE.md allows: data loss (migration, origin never lost), state (type set by the owner is never overwritten), isolation (a task's origin never points into another workspace).
- Typecheck and the touched files' tests while working; the full suite once at the end.
- Small commits, staging only your paths, no AI mention, no Co-Authored-By.
- Check every screen against the mockup shots side by side, at 1440 and 1100, dark and light, on an isolated server with seeded tasks (see how earlier work did it: `e2e/start-server.ts`, and the scratch seed in /private/tmp/claude-501/ship-real/ that produced the mockup's refs). Functional checks with assertions, not screenshots alone.

## Units

### A1. Data: type, origin, areas (server and shared)

- `TaskType` (bug, incident, feature, request, research, design, test, chore) and `typeBy` (owner, captain, intake) on the task: one migration (next free id), schema, store, summary, `tasks.create` and a `tasks.setType` command (owner any task, captain its workspace; the owner's choice is never overwritten by inference).
- `TaskOrigin` (owner, captain with reason, finding with source and severity, watch, schedule, parent) on the task, set at creation by each creator: the task box, the captain, `findings.toTask` (today it drops the source and severity; pass them), watch and schedule starts, child tasks. A finding's task, a parent's children and so on are found by querying origins; do not add a second link.
- Inference at creation: reuse `inferBranchType` and `taskKindOf` and the finding source as the first guess; when unsure, Laya's typed choice (the existing decisions provider). The branch type then follows from the task type, so there is one source.
- Areas: derived on read, never stored: the files a task changed (worktree diff against its start commit) mapped to the wiki's component folders and roles when the wiki is on for the workspace; nothing otherwise.
- Trail: derived on read from what exists: children and their states, the hand-off check, the merge request or local merge, `pendingShip`. Deploy steps and the client reply come in phases B and C; leave typed room for them.

### A2. The Tasks screen (web)

- Rename "Home" to "Tasks" (screens registry, sidebar, palette, route).
- Board view: Needs you, Running, Waiting, Shipping, Up next; Done and Ideas behind toggles; cards as in the mockup (type tile, workspace tile and project names with "+N", origin icon and name, one status line from the hold or the run, the trail strip on shipping and review cards, nested subtasks with progress, "Waits on" with the other task's live state). Filters: type, area, workspace, source. At 1100 the board scrolls sideways inside itself.
- Tree view: today's tree plus the new parts (type, projects, origin, status words, relation chips: waits on, blocks, follow-up of), as in shots 03, 04.
- List is removed; Board replaces it.
- Keyboard as today (j, k, Enter, number actions, x, /).

### A3. The task page (web)

- Compact A: crumbs line with workspace tile, projects, origin, then the type chip (icon and word, one-click change) and area chips; title row with the Brief button (folds the brief, hidden by default once work has started); the tabs row with the trail strip on the right (icon, short label, state mark; finished steps drop their label first when space runs short; the waiting step always keeps its label).
- Below about 1300 px the right column folds to a rail by default; one click opens it as an overlay.
- Everything else on the page stays as it is today.

## Done when

- Every new task has a type and an origin; the owner can change the type in one click and it sticks.
- The Tasks board and tree match the mockup shots side by side at 1440 and 1100, dark and light, with real seeded data, and every click path in the mockup works.
- The task page header is no taller than today's at 1440 and 1100, and the trail labels are never cut.
- Typecheck, biome, the full suite and the e2e run show no new failures against main.
