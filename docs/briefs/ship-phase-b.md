# Brief: phase B of "Ship without me" (ship rules on the authority rows, one merge path)

Branch `feat/ship-rules`, from main after phase A merged. The approved design is `docs/design/ship-without-me.md` section 2 and section 10; the approved mockup is `marketing-assets/ship-mockup/ship.html`, screen D ("Rows" and "By type"), with shots in `marketing-assets/ship-mockup/shots/` (D-rows, D-by-type) and the real Permissions sheet in `marketing-assets/ship-mockup/ref/current-permissions-*.png`.

## Read first

- `CLAUDE.md`, `docs/briefs/quality-bar.md`, `docs/design/task-lifecycle.md` (approved; steps G "policy table" and H "authority and capability on CommandDef" are not built yet: do not build them, and do not add anything that H would have to undo; leave command-level authority alone).
- The code survey of today's merge and push authority: `packages/shared/src/authority.ts` (rows), `apps/server/src/captain/levels.ts` (`authorityOf`, `effectiveAuthority`), `apps/server/src/autonomy/policy.ts` (155-180), `apps/server/src/captain/chores.ts` (ship chore 325-434, openMr 134-182), `apps/server/src/captain/world.ts` (shipCheck 228-244, 411-415), `apps/server/src/autonomy/limits.ts` (146-165), `apps/server/src/mrs/policy.ts` and `mrs/service.ts` (org merge policy never/approve/auto-if-green, poller 1654-1665), phase A's task type and trail.

## Rules

- One source of truth. The ship rules are the authority rows plus per-type overrides, stored in the existing autonomy settings. `orgs.<id>.merge` (never, approve, auto-if-green) folds into the Merge row with a migration that keeps today's behaviour; then the field and the code that read it go (migrate callers, then delete, same branch). No second switch survives.
- New rows: Deploy staging, Deploy production, Tell the client (Ask or Captain). They are stored and editable now; phase C acts on Deploy, and Tell has no sender until client chats. Their defaults are Ask.
- Overrides: an ordered list per workspace: `when { types, areas?, maxChangedLines?, projects? }` and a value per row. First match wins; otherwise the row. Types from phase A; areas and changed lines are derived on read (phase A's areas and the diff stat).
- Every existing guard still applies and no rule can switch it off: green hand-off for the exact head, secret scan, protected repos, branch allowlist, hours, freezes, presence, re-check before an irreversible step, idempotent ship keys.
- One merge path: "merge" is the project's own way, a local merge (and push if the Push row allows) or merging its open merge request on the host when the project works through merge requests. The captain's lane turn and the ship chore decide through the same function, so `limits.ts`'s "no merge with push in a turn" and the chore agree (pick the rule, record it).
- A step the rules leave to the owner becomes a typed hold of the lifecycle model with the step named, so the board's Needs you and the task page's trail show it. If the lifecycle has no hold kind that fits, stop and report rather than inventing a second waiting state.
- UI exactly as screen D: rows on the existing Permissions sheet with the same Captain/You cells and a "new" tag; a "By type" section with type chips, under N lines, area, the four step cells, add, reorder, delete; a plain preview sentence; a caution banner when production is Captain; the always-checked guards as chips. No hint lines.
- Tests where CLAUDE.md allows: the migration keeps today's behaviour for every combination of the old switch and rows; a rule never merges when a guard fails; first match wins and the row is the fallback; another workspace's rules never apply; the lane and the chore reach the same decision.
- No regex for decisions. Small commits, no AI mention, no Co-Authored-By. DECISIONS rows, SPEC lines, PROGRESS entry.
- Prove it on an isolated server: a bug under the line limit with green checks merges with no click under a Captain rule; a feature asks; a failing check never merges; the trail shows "waits for you" for a step the rules leave to the owner. Compare the Permissions sheet with the mockup shots side by side at 1440 and 1100, dark and light.
