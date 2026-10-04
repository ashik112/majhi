# Delete first, then model the task lifecycle

Status: approved by the owner 2026-10-05, with the decisions in section 11. Nothing here changes product code yet.
Date: 2026-10-05. Inputs: four code audits (holds, loops and limits, captain authority, transitions and schema), three history audits (captain features, loops, peripheral features), all spot-checked against `main` at bbbff1a9. File:line references may drift by a few lines.

## 1. Problem

The question "why is this task not moving, and who may move it?" is answered in about 10 places: `tasks.status`, `paused_reason`, `paused_by`, `autonomy_tasks.held / held_scope / resumed_at`, the `autonomy_state.holds` JSON (also in memory, recomputed each minute), the queue's `waitFor / readyAt`, in-memory `run.paused / run.held`, `budget_alerts.resumed_at`, `start_when_ready`, and nine free-text start checks that are never stored. About 22 loops decide on tasks, slots and wakes, with no lock shared by the four that overlap. About 80 policy numbers are hard-coded and tuned one commit at a time (ship 40 actions and 45 minutes, tell limit 3 in 10 minutes, tasks-at-once 1). The captain's rules live in two hand-written prompt files (about 30 rules) that drift from the code gates ("six rows" in the prompt, seven in code). The only writer of status, `store.tasks.setStatus`, validates nothing and has 14 call sites. Each bug is fixed by one more branch, so `git log` reads as a list of special cases.

Root cause: the core state was never modeled, so every guarantee was bought with a patch on the captain's behaviour. A policy table of 80 knobs is still 80 special cases, and a nicer home for a special case is still a special case. So this document first removes what a structure can make unnecessary (section 2), then models the lifecycle that gives those structures (section 4), one scheduler (section 5), and generated instructions (section 7).

## 2. What to delete first

### 2.1 Stance

The captain runs the workspace on its own. That is the product (SPEC section 1: "One control plane, and the captain runs it", "No manual work outside majhi"). The owner is removed from the loop, not turned into an approver of every step.

The captain is bounded by a small set of principled boundaries that come from the SPEC, and these stay:

1. Authority rows per workspace (start, questions, approvals, upkeep, merge, push, own).
2. "Nothing leaves the machine without approval": org merge policy plus the Merge and Push rows (both default to Ask; the owner may hand them to the captain).
3. Budget (one model, section 2.2 row 10).
4. The org boundary (a lane reads and writes only its own workspace; no cross-org credentials).
5. Hard limits: no force push, no deleting a dirty worktree, no secrets in text.

Everything else exists to patch one LLM misbehaviour: per-chore daily action caps, tell limits, nudge counts, stuck thresholds, question-loop similarity, run action and minute caps, wake gates, duplicate heartbeats, retry-after-update special cases. Each of these is a delete candidate if, and only if, a structural guarantee makes it unnecessary. The four guarantees this design builds:

| Guarantee | Where it comes from | What it makes unnecessary |
|---|---|---|
| G1 Idempotent actions keyed by state | Every captain action carries a key of the state it acts on (ship: task, head commit, base; answer: card id; tell: task plus the lead's last turn). A repeat with the same key is a no-op, not a second action | Daily action caps, tell rate limit, question-loop similarity, "not shipped twice" bookkeeping, echo guards |
| G2 One scheduler, one lock | Every decision about starting, resuming, shipping and waking goes through one tick under one lock (section 5) | Duplicate heartbeats, overlapping sweeps (A1, A5, A8, A17), stop-flag races, retry-after-update special cases |
| G3 Typed holds | Every "not moving" cause is one `Hold` kind with a derived lifter (section 4). The captain cannot misread who paused a task | `waitsForOwner`, resume refusals, "owner's, leave it" prose, the waits queue |
| G4 Structured signals and generated instructions | Decisions read typed events and error codes, never messages (section 3). The prompt's rules and numbers are generated from the command registry and the policy table (section 7) | Text heuristics, hand-written prompt rules that drift |

For each candidate the table names the guarantee that replaces it. Where no guarantee exists, the item stays as a policy entry and says why.

Two honest limits on the evidence:

- The repo is 7 days old (first commit 2026-09-29, 1163 commits, 445 on 2026-10-04). The captain layer is 3 days old (Autonomous merged 2026-10-02, 75dce4cd; chores from 2026-10-03, ffb59c00). Most guards were written with their feature, not after an incident. Only five incidents are documented: 15 identical answers in 4 minutes spent the daily question cap (ad603503), ship cap 5 reached by normal work and a slow test suite ending a run (4207cc99), a 10-minute keep-out after any owner command (replaced in 46c7d480), model-decided permission prompts (9f934cfa), a running turn that overshot a cap (CAP_MARGIN, DECISIONS 431). I use fix-commit share and import graphs as the usage proxy.
- I cannot read the live database. Real use of Today, Business, Watch and Playbooks can only come from the owner.

### 2.2 Captain and Auto-pilot features

Verdicts: DELETE, MERGE (into the named thing), KEEP (reason).

| # | Feature | What it does | Why it exists (commit, incident) | Verdict and the guarantee that replaces it | Owner loses |
|---|---|---|---|---|---|
| 1 | Daily chore caps: 13 keys, 22 numbers (`packages/shared/src/chores.ts:38-52`), `REACHED` texts, per-chore Limits UI | Max items per chore per day (ship 40, cards 40, questions 20, memory 4 runs, ...) | ffb59c00 10-03 (ship 5), ad08912e 10-04 (settings), 4207cc99 10-04 (ship 5 to 40, run 10 to 45 min: normal work hit the cap) | DELETE. G1: each ship is keyed by (task, head, base), each answer by card id, so repeats are no-ops and the cap has nothing left to count. Spend is bounded by the budget (row 10) and one pass bound (row 3) | A per-chore ceiling. Runaway spend is still stopped by the budget |
| 2 | Cap-ask flow: `captain_cap_asks` (migration 119), RAISE_FACTOR 2 | "Raise the cap for today?" card | Exists only because of 1 | DELETE with 1. Budget raise requests stay (boundary 3) | Nothing |
| 3 | Run bounds: RUN_CAPS 20 actions / 60k tokens / 10 min, RUN_ACTIONS memory 100, RUN_MINUTES ship 45, MAX_PASSES 3, MEMORY_WAITING 10 (`captain/rules.ts`, `runner.ts:130`) | Stops a runaway chore pass | ffb59c00; RUN_MINUTES from 4207cc99 (slow test suite ended a run). Rest preventive, no incident | MERGE to one policy pair: a pass ends at 15 min or 60k tokens. KEEP FAILURES_OFF 2 (a chore that fails twice turns itself off). No structural guarantee ends an LLM turn that keeps going, so these stay as two policy entries | Per-chore run limits |
| 4 | Tell limit 3 per task per 10 min (`captain/tell.ts:16`, in memory, lost on restart) | Rate limit on captain notes to a lead | 7c5e6756 10-04, "keep two agents from looping". No incident | DELETE the count. G1: a tell is keyed by (task, lead's last turn): a second tell with no new lead turn since is refused as a repeat. G3: a task with a hold refuses tells with its sentence. KEEP the actor and workspace check (boundary 4) | Nothing: the same flood is blocked by state, not by a clock |
| 5 | Question loop guard (`captain/question-loop.ts`, 102 lines; second copy in `autonomy.answer`): same question within 10 min, third within 5 min, 80% word overlap | Stops the captain answering the same agent question forever | ad603503 10-04. Incident: 15 identical answers in 4 minutes spent the daily cap | DELETE the word-overlap rule (text matching, section 3). G1: one answer per card id. Replacement for the loop itself: after N answers to one task with no progress in between (a commit, a status change), the task gets a `loop-guard` hold (G3). N is one policy entry, `loopGuard.answersWithoutProgress` (default 3). It stays a number because "no progress" has no structural proof | Same protection, counted by progress rather than by wording |
| 6 | Typing wait (`events/typing.ts`, TYPING_FRESH_MS 15 s) | Captain waits while the owner types in the room | 46c7d480 10-04, replaced the stored 10-minute keep-out (`captain_presence`, dropped in migration 123) | KEEP as one policy entry. No structural guarantee: the owner talking beats the captain, and nothing in state says they are mid-sentence. It is already small | n/a |
| 7 | Laya wake gate (`autonomy/wake-gate.ts`, 181 lines): an LLM call that decides whether to make an LLM call; one skip in ten taken anyway | Saves captain turns on soft wakes | 8a6b0d5e 10-04. Partly an eval feeder | DELETE. G2: one tick, one lock, so a wake is not double-sent. Keep the pure `factsKey` compare and 20 s debounce in the driver (unchanged facts do not wake) | A few saved turns |
| 8 | Driver hourly heartbeat (`autonomy/driver.ts:29`) and `HOURLY_MS` (`captain/service.ts:47`) | "Look once an hour" | 75dce4cd; 7c5e6756 already says a bare hourly check no longer wakes | DELETE the driver heartbeat. G2: the tick is the one clock, with one hourly cadence | A look when nothing happened |
| 9 | Stuck detector (`autonomy/stuck.ts`: 2 h idle, 4 h waiting, 3 failures, 4 repeats) and the `stuck` chore | Dashboard list; chore wakes a lead | cb1b0caa 10-04, display only, no incident. Three notions of stuck exist (this, the chore, idle-watch) | MERGE into `rooms/idle-watch.ts` with one definition: quiet N hours and no hold. DELETE the failures and repeats rules and the repeated-line grouping (text matching). G3: a task that fails or loops has a hold, which is what the dashboard lists. Two policy numbers stay (`quiet.idleHours`, `waitingHours`): quiet time has no structural proof | A separate Stuck list |
| 10 | Money caps in nine places: weekly org budget, weekly account budget, Auto-pilot day cap, org caps, account floors, CAP_MARGIN mid-turn stop, monthly ceiling, lane budget check before each question, RUN_CAPS tokens. Plus `budget-asks.ts` | Stops spending | Budgets 10-01 (b9c85f24). Autonomy caps 75dce4cd 10-02. CAP_MARGIN after a turn overshot (DECISIONS 431) | MERGE into one budget model (boundary 3): a limit has a scope (org, account, all) and a period (day, week, month), plus a per-account reserve (the floor: what the captain leaves for the owner). One enforcement point: the run checks its budget at each tool call and a breach sets one `budget-limit` hold. DELETE the second system (Auto-pilot day, org, floor), CAP_MARGIN, the lane budget check, and RUN_CAPS tokens as a money cap. Hold kinds `autopilot-cap` and `account-floor` fold into `budget-limit` | Finer-grained but duplicate money limits |
| 11 | Daily summary twice (`autonomy/summary.ts` and `captain/summary.ts`), `rollup-post.ts` (227 lines, root-chat post every 3 h or batched), `agenda/` morning brief | Status posts | Built in (75dce4cd, 28bb6698, b130e952). No incident | MERGE the two summaries into the one brief. DELETE rollup-post: a fourth status surface, no structure replaces a surface, it is just duplicate (Decisions shows what waits, the brief shows what happened) | A periodic root-chat line |
| 12 | Own-work approval (`captain/own-work.ts` 636 lines, `own-work-second.ts` 126, authority row `own`) | Captain approves routine permission prompts inside a task worktree; a second Laya opinion for the unknown middle | e1dc18ae and 025882fd 10-04. 9f934cfa 10-04 had just taken permission decisions away from the model | KEEP the rule-based decision (it is how the owner is removed from the loop and the `own` row is a SPEC boundary). DELETE `own-work-second` (a model deciding a permission, which 9f934cfa removed). G4: replace the command-text rules with tool-kind rules (section 3 row 6) | Nothing visible |
| 13 | Permission deny list (`captain/permission-rules.ts`, 85 lines) | Reject destructive commands | 9f934cfa 10-04 | KEEP (hard limits). Change signal: tool kind and structured input, not command text | n/a |
| 14 | Safety rules: `autonomy/limits.ts` hard limits, `captain/lane-scope.ts`, lane-gate readiness (secret scan, protected repo), the Push row, `captain/undo.ts` | Isolation and "never push unasked" | CLAUDE.md "never happen" list | KEEP. Reason: these are the boundaries. Delete only the daily ship cap and per-key log inside lane-gate (G1 replaces them) | n/a |
| 15 | Authority rows: 7 (start, questions, approvals, upkeep, merge, push, own), `levels.ts`, full-access exceptions | Per-workspace Captain decides / Ask me | 7b1a725f 10-04 replaced three levels; `own` added within hours | KEEP all 7 (SPEC boundary). Fix the drift: G4 generates the prompt's row list and the code's gates from one source (section 7) | n/a |
| 16 | Tasks-at-once (d1c85f58) with `workspaceFull`, `noRoomFor` | One captain-started task at a time per workspace | 10-05, owner's choice, no incident | KEEP as one policy entry on the Start row (the owner chose it). DELETE the duplicate gate copies in `autonomy/service.ts`: G2 puts it in one gate in `blockerOf` | Nothing |
| 17 | Waits queue (`autonomy/waits.ts`): `waitFor` account state, `readyAt` | A queued item restarts when an account signs in | 6dad28e3 10-04: a captain belief outlived the fact | DELETE. G3: "waits for an account" is the hold `signed-out` or `account-limit`, cleared by the tick when the account is healthy | Nothing: one mechanism instead of two |
| 18 | Chores (13, `captain/chores.ts` 919 lines): ship, cards, questions, memory, projects, triage, cleanup, stuck, followups, discover, tidy, health, checklist | Housekeeping and routine decisions, autonomously within authority rows | ffb59c00 (8), 25e43de7 10-04 (5) | KEEP all, run by the one tick. DELETE the `stuck` chore (row 9). MERGE ship, cards, questions into one "what is ready" pass. Caps gone (row 1) | Nothing |
| 19 | Upkeep: `upkeep-world.ts` (7 thresholds), `DAILY_CHORES` (`rules.ts:113`, now unused outside its definition), `playbooks/builtin/upkeep.ts` repeating the 13 chores with cadence and its own `RUN_TOKENS 60_000` | Same chores registered twice | 25e43de7, bad571e6 | MERGE: the playbook registry is the one list (G2). DELETE `DAILY_CHORES` and the copy of `RUN_TOKENS`. Thresholds stay as playbook settings | Nothing |
| 20 | `autonomy/service.ts`: 3002 lines, about 112 methods | Holds, caps, pick, queue, resume, dashboard, summary | Grew from 75dce4cd | SHRINKS as 1 to 19 go (estimate under 1,600 lines) | Nothing |
| 21 | Autonomous switch with `stopping` mode, finish-step, STOPPED_NOW (SPEC 5.18) | One switch; Off pauses what the captain started | 75dce4cd | KEEP (SPEC). It becomes one hold kind, `autopilot-off`, with `now` or `step`. The flags `finishing` and `stoppingNow` become state read by the tick (G2). Mode `paused` (unreachable) goes | n/a |

### 2.3 Loops

51 timers and loops audited (22 decision loops A1 to A22, 22 housekeeping, 7 missed by the first list, 4 of them in the host helper).

| Loop | Verdict | Guarantee or reason |
|---|---|---|
| A1 autonomy sweep 60 s (noteCaps, refreshHolds, maybeFinishStop, resumeWaiting, checkWaits, dailySummary) | MERGE into the one tick | G2. `noteCaps` and `refreshHolds` go with row 10. `resumeWaiting` and `checkWaits` become hold auto-clears and a `start`/`lift` action. `dailySummary` merges into the brief |
| A2 driver watch (1 s debounce) | KEEP as event input | Not a timer |
| A3 per-lane debounce, one digest tick (20 s) | KEEP | The captain's wake path; it feeds the tick |
| A4 hourly heartbeat | DELETE | Row 8 |
| A5 captain sweep 60 s (chores, playbooks, summary, rollup) | MERGE into the tick | The playbook scheduler (A22) becomes the one clock |
| A6 captain event trigger, CAUSED_MS echo drop | KEEP the event, DELETE the echo guard | G1 and G2: the captain's own action changes state, the tick sees no new key, nothing retriggers |
| A7 rollup post | DELETE | Row 11 |
| A8 orchestrator advance and recheck timers | MERGE into the tick | G2. Plan and dependency waits are `blockerOf` reasons re-read each tick; the per-wait timers go |
| A9 slot queue | KEEP | The single capacity authority. Delete the copies in autonomy |
| A10 to A13 per-run timers and the network probe | KEEP | Run mechanics and sensors |
| A14 sign-in check 30 s | KEEP | Delete the `checkWaits` copy of the same fact |
| A15 resume drip (20 s gap) | KEEP | Restart pacing |
| A16 idle-watch (5 s one-shot) | KEEP | Absorbs the stuck definition (row 9) |
| A17 MR poller 60 s | KEEP the refresh timer. Auto-merge and ship become `ship` actions in the tick | G2: removes the race with the ship chore. G1: ship keyed by (task, head, base) |
| A18 machine sensor 45 s | KEEP | Read once per tick instead of 4 times |
| A19 handoff capacity | KEEP | Not a loop |
| A20 usage windows 10 min | KEEP | |
| A21 `budgets.lift` 60 s | MERGE into the tick | Week-reset lift is data hygiene, kept |
| A22 playbooks sweep | KEEP as THE tick | Absorbs A1, A5, A7, A8, A21 |
| Housekeeping: chatMemory 60 s, projectcard 60 s, ops looks 60 s | MERGE into the tick | Same 60 s clock |
| Housekeeping: agenda 60 s | MERGE into the tick | Today stays (owner uses it) |
| Housekeeping: outcomes 5 min, trackers 60 s, e2e 60 s | DELETE with their features (2.4) | |
| Housekeeping kept as timers: update watch 30 s, prune 24 h, uploads 1 h, ops wire 30 s, ops/self 5 min, backup 1 h, connect 60 s, notify batching, events watcher, host link, Laya idle, host intervals (4) | KEEP | Not decisions about tasks. Check: prune must not touch the Docker build cache (owner rule) |
| Duplicates: 12 separate 60 s constants, two hourly heartbeats, two daily-chore registries, `dailySummary` twice, budgets vs autonomy caps | COLLAPSE to `tickSec` | |

Result: decision loops 8 (A1 to A8) become 2 (the tick and the event driver). Server interval-style loops go from about 22 to about 12.

### 2.4 Peripheral features with little or no evidence of use

Built on 2026-10-04 in one wave from the "captain runs the business" brief. Direction was asked for, not each feature. These cuts do not depend on the stance. Fix-commit share is the usage proxy: zero fixes means perfect or never used. Real e2e specs exist only for phase 1 to 2c; `playwright.*.config.ts` files run screenshot scripts, not assertions.

| Feature | Non-test lines [tests], files | Evidence | Verdict | Owner loses |
|---|---|---|---|---|
| e2e background runner (`e2e/`) | 825 [433], 3 + web panel | 0abf8c33 turned every background mode off by default; owner runs the suite at phase end | DELETE | A runner nobody enables |
| trackers (Jira, ClickUp, GitHub Issues) | 1295 [1112], 9 + web 478 | 15 commits, 0 fixes, only fake-fetch tests; owner works through GitLab, GitHub, DigitalOcean | DELETE (question 3) | Pulling tracker items in |
| growth (feeds, opportunities, client updates) | 1603 [1232], 9 | Off by default, no UI of its own, leaf module | DELETE | Hackathon and grant feeds |
| economics (client minutes and spend roll-up) | 514 [309], 4 | Leaf once growth goes; minutes are estimates | DELETE | A scorecard table |
| sensors (CI, osv.dev, EOL, radar) | 2832 [1357], 13 | No UI, 8 commits, one day old; hand-off secret scan and Watch overlap | DELETE | Dependency and EOL alerts |
| outcomes: scorecard, trust ladder, auto-mute | about 1,200 of 1841 [975], 8 | 50% fix share on a day-old feature, no history to score | DELETE; KEEP the monthly ceiling (`money.ts`, `spend.ts`) inside the budget model | A scorecard on the Captain page |
| agenda and Today (`/today`) | 1158 [968], 8 + web 892 | Not in the sidebar, overlaps Decisions | KEEP: the owner uses Today (2026-10-05). The two daily summaries merge into its brief | n/a |
| business: KB, voice, CRM, deadlines | 1894 [1290], 8 + web 2790 | 3 commits, 0 fixes. Deadlines (web 591) move into Needs you | DELETE (question 2) | A Business page |
| Small trims: `decisions/jev.ts` ("stays off"), `layaDocker.ts` (Linux and Windows only), `ops/anything/{db-drivers,html,fixes}.ts` (low confidence) | about 1,100 | Speculative | DELETE after a quick check | Little |

KEEP, with reason: memory (core, 10+ importers), ops core and Watch (real use in PROGRESS), decisions and Laya (owner-specified), connect and gitConnect (MR opening, real connections), playbooks (the one scheduler), findings (12 importers), handoff (real checks in PROGRESS), projectcard (hand-off and digest read it), backup (data loss), usage, health, inbox, notify, scan, host.

### 2.5 Before and after

Estimates from the audits, not exact. Non-test lines now: server 122,269 in 552 files, web 76,233 in 461, shared 20,739 in 69, acp 2,942 in 22.

| | Now | After | Note |
|---|---|---|---|
| Peripheral features removed (2.4) | | about 13,400 non-test lines, about 9,000 test lines (Today kept) | steps D1 to D8 |
| Captain and autonomy dirs | 14,400 non-test lines, 9,500 test lines in 41 files | about 10,500 non-test, about 7,500 test | `autonomy/service.ts` 3002 to under 1,600 |
| Non-test lines overall | about 222,000 | about 205,000 (8% fewer) | Lines are not the main win |
| Decision loops (A1 to A8) | 8 | 2 | tick and event driver |
| Interval-style server loops | about 22 | about 12 | |
| Policy numbers | about 80 | about 25 | section 6 |
| Hold causes | 15 | 12 | section 4 |
| Places that answer "why isn't it moving" | about 10 | 1 (`hold`) plus 1 derived (`blockerOf`) | |
| Money-cap enforcement places | 9 | 1 model, 1 enforcement point | |
| Authority rows | 7 | 7 | kept, generated |
| Captain prompt rules kept in sync by hand | about 30 | under 10 | section 7 |

The main win is that independent decision paths drop by more than half, and every remaining guard is either a boundary, a structure, or a named policy entry.

## 3. Text matching that decides behaviour today

Rule for the new design: no decision reads a message. Hold kinds, blockers and refusals come from typed events, error codes and enums. Free-text fields on a hold (`error`, `why`) are display only and are never read back by code. Where an agent CLI gives no structured signal, the item is marked open.

Found with the AST (regular-expression literals and `new RegExp` in non-test server, shared, acp and host source: 249 files, mostly input parsing, which is fine) and by reading. Only sites that drive a task, run, captain or security decision are listed.

| # | Where | What text it matches | Decision it drives | Structured signal that replaces it |
|---|---|---|---|---|
| 1 | `packages/acp/src/limit-failure.ts` plus per-CLI `limitShapes` in `packages/acp/src/tools/{claude,codex}.ts`; reset time read from the message | CLI error prose ("usage limit", "resets at ...") | Account usage limit hold, and when to resume | OPEN. Look for a typed rate-limit signal in the ACP error `code`/`data` or the adapter's result events. If none: an unknown failure becomes an `error` hold, and resume comes from the usage poll (A20, structured window data), not from parsing "resets at" |
| 2 | `packages/acp/src/auth-failure.ts` (20 shapes; `isAuthRequired` already reads an ACP error code first) | "failed to authenticate", "refresh token expired" | Signed-out hold | The ACP auth-required code, plus the 30 s sign-in check (A14) as the source of truth. Delete the prose list. OPEN if a CLI fails auth without the code |
| 3 | `runs/network.ts:48-59`: ENOTFOUND, ECONNRESET, 429, 5xx words in `message` | Offline vs overload vs rate limit | Offline hold, backoff | Node error `.code` and `.cause.code`, numeric HTTP status, and the 15 s network probe (A13) for offline |
| 4 | `rooms/coordinate.ts:211-221` `verdictOf`: "LGTM", "changes needed", "not approved" in a reviewer's prose | Review verdict | Approved or back to changes | The reviewer ends its turn with a structured tool call (an MCP tool `majhi_review_verdict({verdict})`). Prose is a message only |
| 5 | `rooms/coordinate.ts:289-322` "needs the owner" detection ("let me know", "please confirm", trailing question marks) and `rooms/choices.ts` extracting options from prose | Whether an agent is asking, and the options | Raises a decision card | Agents ask through the ACP ask-question or an MCP `ask` tool with typed options. OPEN: confirm both adapters expose a structured ask |
| 6 | `captain/permission-rules.ts` DANGEROUS list and `captain/own-work.ts` DANGER list (command text: `rm -rf`, `git push --force`, `sudo`, ...) | Whether a prompt is safe | Auto-deny, auto-allow | The ACP permission request carries a tool kind (read, edit, delete, move, execute, fetch) and structured raw input. Rule: read-kind tools in the task worktree, edits inside the worktree, and majhi's own tools may be auto-allowed under the `own` row; execute, delete, move and fetch kinds go through the hard-limit table by kind and path (a path-containment check on structured input, not command parsing) or to the owner. The container sandbox and credentials stay the real guard |
| 7 | `runs/permissions.ts:77-82` `mcp__majhi-*` matched on the prompt title | Which tool a prompt is for | Recognise majhi's own tools | Tool name from the structured tool-call data (the Claude adapter's `_meta`). OPEN: confirm the field exists in both adapters |
| 8 | `mrs/service.ts:1149` ("couldn't find remote ref") and `:1626` ("non-fast-forward", "[rejected]") on git stderr | Why a fetch or push failed | Branch missing vs refused push | Git exit status, `git push --porcelain` (per-ref status flags), `git ls-remote --exit-code`, `git merge-base --is-ancestor` before pushing. Stderr is display text |
| 9 | `autonomy/stuck.ts:52-54` groups events by identical `text` | "Same step 4 times" | Stuck list | Deleted (row 9). Loops are caught by the progress counter (row 5) |
| 10 | `captain/question-loop.ts:44-62` word-overlap similarity 0.8 | Same question again | Loop guard | Deleted (row 5) |
| 11 | `autonomy/service.ts:394` `stallExplained` returns prose and callers branch on it being defined | Why a task is not moving | Skip a wake | `blockerOf` and `hold`, typed |
| 12 | `captain/world.ts:231,396` strips "Checked: " and "Refused: " prefixes from result strings | Reads prose back out of a result | Display | Result types carry `{ok, code, text}`; text is display only |
| 13 | `tasks/planning.ts:36-41` extracts file paths from task text to plan overlap between tasks | Which tasks touch the same files | Serialises or parallelises tasks | OPEN. An explicit `touches` list on the task (set by the planner through a tool or by the owner), or drop overlap planning and rely on worktrees plus merge conflict handling |
| 14 | `decisions/uses/injection.ts` `injectionHints` (phrases only an attack would use) | Prompt-injection flag | Warning fence and flag | DELETE the phrase rules: they give false safety. The data fence and "outside text is data" rule stay. The Laya yes/no stays (a model call, not text matching) |
| 15 | `connections/gate.ts` with `connections/shell.ts` (a shell tokenizer, not a regex) classifying `kubectl` and similar as read or write | Ask or run | Connection reads vs writes | Keep: it parses a grammar and its fallback is "unreadable counts as write". The least-privilege credential is the real guard (SPEC 5.14) |
| 16 | `handoff/secret-scan.ts` and `packages/shared/src/secrets-detect.ts` | Secret shapes in a diff | Blocks a ship | Keep. No structured signal exists for "is this a secret". It fails closed. The one allowed exception to the rule |
| 17 | Grammars: `@mention` routing (`rooms/mentions.ts`), task ids, `task-parse.ts`, schedule times, branch names | Input syntax written on purpose | Routing | Keep. A grammar the user writes is an interface, not a heuristic. Wrong input is refused, not guessed |

A guard against new text-matching decisions is in section 9.

## 4. The lifecycle model, for what remains

### 4.1 Status is pure lifecycle, "not moving" is one `hold`

```ts
// packages/shared/src/lifecycle/state.ts
export const TaskStatusSchema = z.enum(["inbox", "ready", "running", "review", "mr", "done"]); // "paused" removed

export interface TaskState {
  id: TaskId;
  status: TaskStatus;
  hold: Hold | undefined;      // at most one: the cause that keeps it from moving
  startWhenReady: boolean;     // the owner's wish only
  hasLiveRun: boolean;         // filled by apply(), read-only for the core
  unmetDeps: TaskId[];
}
```

A paused running task is `status: "running"` plus a hold. A paused review task is `status: "review"` plus a hold. The task keeps its lane, so the board column is honest and "resume" never guesses where to return to.

Alternative: keep `paused` as a status plus a cause field. It loses: `paused` hides three lanes today (running, review, never-started `blocked`), `resumedByRuns` and `start()` each guess the lane to return to, and two fields can disagree, which is the bug class we are removing.

Checked in code: `pausedByRuns` fires only from running or review (T:2862), `stop()` from running, paused or review (T:980), `pauseForUnmerged` and `afterRemoval` pause never-run inbox or ready tasks (T:2437, T:2518). No path needs `paused` as a lane, only as a reason.

### 4.2 `Hold`

A hold is a persisted cause with a lifter. Anything that is only a function of the world now (machine busy, no free slot, dependency not met) is a blocker (section 5), computed and never stored.

```ts
// packages/shared/src/lifecycle/hold.ts
const At = z.string().datetime();

export const HoldSchema = z.discriminatedUnion("cause", [
  z.object({ cause: z.literal("owner-stop"), at: At }),
  z.object({ cause: z.literal("captain-stop"), at: At, why: z.string().optional() }),   // why: display only
  // the Autonomous switch: `now` paused at once, `step` lets the run finish its step
  z.object({ cause: z.literal("autopilot-off"), at: At, mode: z.enum(["now", "step"]) }),
  // one budget model: scope x period, plus the per-account reserve
  z.object({ cause: z.literal("budget-limit"), at: At, scope: z.enum(["task", "org", "account", "all", "reserve"]), period: z.enum(["day", "week", "month"]), until: At.optional(), alertId: z.string().optional() }),
  z.object({ cause: z.literal("account-limit"), at: At, account: AccountIdSchema, until: At.optional() }),
  z.object({ cause: z.literal("offline"), at: At }),
  z.object({ cause: z.literal("signed-out"), at: At, account: AccountIdSchema }),
  z.object({ cause: z.literal("error"), at: At, phase: z.enum(["start", "turn", "restart"]), error: z.string().max(2000) }), // error: display only
  z.object({ cause: z.literal("loop-guard"), at: At, why: z.string() }),
  z.object({ cause: z.literal("idle"), at: At, why: z.string() }),     // nobody left to wake
  z.object({ cause: z.literal("dependency-closed"), at: At, on: z.array(TaskIdSchema).min(1) }),
  z.object({ cause: z.literal("dependency-removed"), at: At, on: z.array(TaskIdSchema).min(1) }),
]);
export type Hold = z.infer<typeof HoldSchema>;
export type HoldCause = Hold["cause"];
```

Twelve kinds, down from fifteen: the three money causes (`autopilot-cap`, `account-floor`, budget `limit`) are one `budget-limit`, and the Auto-pilot switch causes are one `autopilot-off`.

**Updated after D1 to D10 (2026-10-05), to match the code on `main` at acd08080.** The list stays at twelve kinds. What changed against the first draft above:

- `loop-guard` is the D10 progress counter (`captain/loop-guard.ts`: three captain answers to one task with no progress between them), not the question-loop similarity rule, the stuck chore or the repeated-line rule. Those are deleted, so no hold is raised from message text. The hold carries only a display `why`.
- `signed-out` is raised only when the lead's hand-off found nobody. A signed-out lead hands the step to a fallback or a teammate first (`runs/manager.ts`, `takeOverFor`, the same `resume.handoff` switch as a limit); the task pauses `signed-out` only when neither works. The same holds for `account-limit`. So both are rarer than the table below suggested, and neither is raised by a chore any more.
- `budget-limit` is the one money hold (Auto-pilot day and org caps and floors fold into it, as the design said). Its shape gained `scopeId`, the org or account the scope names. The run gate's cap hold stores that org in `autonomy_tasks.held_scope`, and without a field it would be lost on the way into the new model. `alertId` is set when a budget alert fired it; a plain `limit` pause migrated with no known alert gets `alertId = "legacy"`, which keeps it apart from a run-gate cap hold in the old fields.
- `idle` lists majhi as a lifter (it auto-clears on activity, so someone with a condition has to be allowed to lift it). The first draft listed only O and C.
- Auto-pilot "leave paused" is not a hold with narrower lifters (lifters are derived from the cause, never stored). Turning Auto-pilot on without resume turns `autopilot-off(now)` into `owner-stop`, so only the owner can lift it. Contradiction 2 is solved by a new cause, not a stored lifter list.
- `autopilot-off(step)` has an old-field form (`autonomy_tasks.held = owner`, no scope, the task still `running`); `autopilot-off(now)` is `paused` plus `paused_by = autonomy-off` plus `held = owner` at scope `stop-now`.
- Not holds, unchanged: dependency waits, machine busy, slots, tasks-at-once (blockers, section 5).

Built in step B at `packages/shared/src/lifecycle/` (exported as `lifecycle` from `@majhi/shared`): `hold.ts` (the schema and the one table, `HOLD_TABLE`, typed over every cause), `transition.ts` (`transition`, events, effects, refusals), `stored.ts` (old fields to and from the model). Where the build made a choice the design left open, section 4.4 says so.

What the shape fixes:

- `owner-stop` and `captain-stop` are separate kinds. Today the difference is a second column that is null for owner stops and for the Auto-pilot run gate (contradiction 1).
- `limit` splits into the two kinds that matter, `budget-limit` and `account-limit`, each carrying what its clearer needs, so after a restart they are distinguishable (contradiction 4).
- `error` absorbs start failures, turn-limit strikes and "restart with auto resume off".
- The "resumed by hand" exemptions (`autonomy_tasks.resumed_at`, `budget_alerts.resumed_at`) become one boolean on the task row, `exemptUntilRunEnds`, set when the owner lifts a budget hold. One store instead of two.
- `dependency-wait` is not a hold. It is derived from `task_links` and shown as the blocker `dependency`. `startWhenReady` is only the owner's wish.

### 4.3 One table: who may lift, what clears it, what the owner reads

"Who may lift" is derived from `cause`, never stored. This table is the source for `liftersOf`, `autoClears` and `sentenceOf`. It replaces `waitsForOwner`, `resumeRefusal`, `pausedLabel`, the five web text maps (board/model.ts:56, task/model.ts:78 and :89, tasks/model.ts:16 and :27, captain/dashboard/model.ts:106, shell/model.ts:183-230) and three server maps (autonomy/driver.ts:569, autonomy/resume.ts:72, the refusals).

Lifters: O owner, C captain (while Autonomous is On and the workspace's Start row says Captain decides, as SPEC 5.18 says today), M majhi.

| cause | lifters | clears by itself when | owner-facing sentence |
|---|---|---|---|
| owner-stop | O | never | "You stopped it. Continue when you are ready." |
| captain-stop | O, C | never | "The captain paused it: {why}." |
| autopilot-off (now) | O, C | never. Turning Autonomous on resumes it unless the owner ticks "leave paused" | "Paused when Auto-pilot was turned off." |
| autopilot-off (step) | O, M | the run reaches its next step, or Autonomous is turned on | "Auto-pilot is stopping. It stops at the end of this step." |
| budget-limit | O, M | the limit is raised or the period rolls over (the tick) | "{scope} budget for the {period} is used up. Raise it or wait until {until}." |
| account-limit | M, O | the account's usage window resets or the account reads available | "{account} hit its usage limit. It resumes by itself." |
| offline | M, O | the network probe succeeds | "No network. It resumes when you are back online." |
| signed-out | M, O | the account reads signed in | "{account} is signed out. Sign in again and it resumes." |
| error | O, C | never | "It stopped with an error: {error}." |
| loop-guard | O | never | "It was going in circles and was stopped. Say what to change." |
| idle | O, C | an agent speaks or a message arrives | "Nothing is moving and nobody is left to wake. {why}." |
| dependency-closed | O | never (candidate: clears when the dependencies merge, question 4) | "{on} was closed without merging. Merge it or remove the link." |
| dependency-removed | O | never | "A task it waited for was removed. Start it or remove the link." |

Consequences:

- An owner-only hold cannot be resumed by the captain, a sweep or a run gate. The refusal text is the hold's sentence (contradiction 1). A release of Autonomous without resume leaves `autopilot-off` in place with lifters O only (contradiction 2).
- "Waits for an account" (the deleted queue, row 17) is `signed-out` or `account-limit`, cleared by the tick when the account is healthy.
- Auto-clearing is evaluated by the tick, not by per-reason pollers. The sensors (network probe, sign-in check, usage windows) stay and fill the world reading.

### 4.4 Transitions

```ts
// packages/shared/src/lifecycle/transition.ts
export type Lifter = "owner" | "captain" | "majhi";

export type LifecycleEvent =
  | { type: "create"; status: "inbox" | "ready"; startWhenReady?: boolean }
  | { type: "wishStart" }                                  // start when dependencies are met
  | { type: "start"; by: Lifter }                          // inbox | ready -> running
  | { type: "sendBack"; by: Lifter }                       // review -> running
  | { type: "ownerStop" } | { type: "captainStop"; why?: string }
  | { type: "autopilotOff"; mode: "now" | "step" } | { type: "autopilotOn"; resume: boolean }
  | { type: "runPaused"; hold: Hold }                      // a run reports; the reason is a typed hold
  | { type: "runResumed" }
  | { type: "holdPlaced"; hold: Hold }                     // majhi-side: budget
  | { type: "holdCleared"; by: Lifter }
  | { type: "agentsIdle" } | { type: "processEnded" } | { type: "changeAndReview" }
  | { type: "mrOpened" } | { type: "mrClosedUnmerged" }
  | { type: "close" } | { type: "reopen"; to: "review" | "inbox" }
  | { type: "dependencyChanged"; change: "closed-unmerged" | "removed" | "met"; on: TaskId[] }
  | { type: "runLost" };                                   // restart: running, no live run

export type Effect =
  | { kind: "card"; card: "paused" | "settle" | "review" | "mr" | "done"; text?: string }
  | { kind: "runs.stop" } | { kind: "runs.start"; ownBrief?: boolean }
  | { kind: "containers"; op: "stop" | "runAgain" }
  | { kind: "processes.stop" } | { kind: "terminals.stop" } | { kind: "parkServices" }
  | { kind: "dropPendingShip"; why: string } | { kind: "ensureWorktrees" }
  | { kind: "startWhenReady"; set: boolean }
  | { kind: "budgets.exempt" }
  | { kind: "publishTask" } | { kind: "statusChanged" };

export interface Refusal { refused: true; code: RefusalCode; text: string; next?: string }

export function transition(
  task: TaskState,
  event: LifecycleEvent,
): { next: TaskState; effects: Effect[] } | Refusal;
```

R4 n is the transition number in the transitions audit. Every current writer is listed.

| event | from | to | hold change | effects | replaces |
|---|---|---|---|---|---|
| create | none | inbox or ready | none | publishTask | R4 1, T:487 |
| create (split child) | none | ready | none | publishTask | R4 4, T:1453 |
| wishStart | inbox, ready | ready | none; `startWhenReady = true` | startWhenReady, publishTask | R4 3, T:861 (mutates then throws 409 today) |
| start | inbox, ready | running | none. Refused if a hold exists or `unmetDeps` is non-empty | runs.start, ensureWorktrees, publishTask, statusChanged | R4 2, T:829 |
| start (already running, no hold) | running | running | none | none (no-op, G1) | R4 2 |
| sendBack | review | running | none | runs.start, publishTask | R4 2 from review |
| ownerStop | running, review | same | set owner-stop | runs.stop, containers stop, processes.stop, terminals.stop, dropPendingShip, card paused, publishTask | R4 5, T:980 |
| captainStop | running, review | same | set captain-stop | same | R4 5 with `pausedBy` |
| autopilotOff now | running, review (tasks the captain started) | same | set autopilot-off(now) | as ownerStop | autonomy/service.ts:556-586 |
| autopilotOff step | running, review | same | set autopilot-off(step) | none until the run reaches its step, then as ownerStop | R4 6 gate, T:2865 |
| autopilotOn | same | same | clear autopilot-off if `resume` | runs.start if no live run, containers runAgain, card settle | autonomy turn-on |
| runPaused | running, review | same | set the hold. If one exists, keep the one with fewer lifters (O-only beats M-liftable) | dropPendingShip (error only), parkServices, card paused, publishTask, statusChanged | R4 6, T:2865 |
| runResumed | running, review | same | clear only if M is in `liftersOf(hold)` | containers runAgain, ensureWorktrees, runs.start if no live run, card settle | R4 7, T:2877 (today skips ensureWorktrees and startTask) |
| holdPlaced | running, review, inbox, ready | same | set hold | as runPaused | budgets/limit-action.ts:25 |
| holdCleared | any with a hold | same | clear if `by` is in `liftersOf`, else Refusal (the hold's sentence) | runs.start if no live run, budgets.exempt (owner on budget-limit), card settle | R4 2 resume branch, T:833-836, `forgetHold` commands/handlers.ts:614 |
| agentsIdle | running | review | none. Refused if a hold is set | card review, publishTask | R4 9, T:2782 |
| processEnded | review | running | none | publishTask | R4 8, T:2836 |
| changeAndReview | inbox | review | none | card review | R4 10, T:1642 |
| mrOpened | inbox, ready, running, review | mr | none | card mr | R4 11, mrs/service.ts:452 |
| mrClosedUnmerged | mr | review | none | card review | new, explicit |
| close | any but done | done | clears hold | runs.stop, containers stop, processes.stop, card done | R4 12, T:1594 |
| reopen | done | review or inbox | none | card review | R4 13, T:2019 |
| dependencyChanged closed-unmerged | inbox, ready | same | set dependency-closed | card paused, publishTask | R4 14, T:2437 |
| dependencyChanged removed | inbox, ready, running, review with a dependency hold | same | set dependency-removed | same | R4 15, T:2518 |
| dependencyChanged met | inbox, ready | same | none (blocker disappears) | none | orchestrator advance |
| runLost | running | running | none, or set error(restart) if auto resume is off | runs.start through the resume drip | recover, Resilience.startup |

Choices made when step B built `transition` (the design left them open):

- `transition(task | undefined, event)`: `create` is the only event for no task. Time comes in on the event (`at`), never from a clock.
- A held task does not move. `start`, `sendBack`, `agentsIdle` and `processEnded` refuse with the hold's sentence (code `held`). World events (`mrOpened`, `changeAndReview`) are accepted and keep the hold. Only a lift, a stop, `close` or a dependency event changes a hold.
- `holdCleared` by majhi carries a `ClearReading` and is refused (`condition-not-met`) unless the hold's typed condition holds in it. By the owner or the captain it needs only that they are in `liftersOf`. Whether the captain is currently allowed to act (Autonomous on, Start row) stays an authority gate outside the core.
- Two holds on one task: the same cause refreshes the data and runs no effects again (a repeated stop is a no-op, G1). Otherwise the hold fewer parties can lift stays. A tie keeps the existing one. Exceptions: `autopilot-off` `now` beats `step`, and `dependency-removed` replaces `dependency-closed`.
- The wish to start (`startWhenReady`) is cleared whenever a task leaves inbox or ready.
- `runLost` is accepted from `running` only (this table); the section 4.6 reconciler text says "running or review". A review task normally has no live run, so `runLost` there would fire for every task. Left as `running` only.
- Owner lifting a `budget-limit` sets `exemptUntilRunEnds` on the task state and emits `budgets.exempt`. Majhi lifting one does not.

Illegal today, refused in the new core:

| today | where | new |
|---|---|---|
| mr to running through `start()` | `tellAgent` T:3056, scheduler, captainTell | `start` from `mr` is a Refusal. An MR task returns through `mrClosedUnmerged` then `sendBack`. Step B first pins with a characterization test what `tellAgent` does on an `mr` task, so the intended behaviour is kept |
| `checkStartable` mutates (inbox to ready, `startWhenReady`) then throws 409 | T:861 | `wishStart` is its own event. `start` is pure and refuses without writing |
| `pausedByRuns` silently returns for other statuses | T:2862 | A logged Refusal |
| paused written 5 ways, running 3, review 3, with different side effects | 14 sites | One event each, fixed effects |
| a run pauses while the task still says running (async window) | services.ts:741 | `runPaused` is the only way the task learns. `run.paused` is derived from the task hold |

### 4.5 Pure core and one impure `apply()`

```ts
// apps/server/src/tasks/lifecycle/apply.ts, the only module that may write status or hold
async function apply(id: TaskId, event: LifecycleEvent): Promise<Task | Refusal> {
  return lock.run(id, async () => {            // one lock per task
    const state = loadState(id);                // store, live runs, task_links
    const out = transition(state, event);
    if ("refused" in out) return out;           // nothing was written
    store.tasks.setLifecycle(id, out.next, now());   // status and hold in one UPDATE
    for (const e of out.effects) await runEffect(id, e);
    return get(id);
  });
}
```

- `store.tasks.setStatus` becomes private to this module. The type system is the guard: once the 14 callers are routed, `setStatus` is no longer exported and `tsc` fails on any new call.
- `transition` has no I/O, no clock, no store. The table above is its test.
- Effects run after the write, each idempotent (G1), so a crash between persist and effect is repaired by the reconciler.
- Captain actions use the same shape one level up: each carries a state key, and `apply` of a repeated key returns the first result.

### 4.6 Run versus task

A run is a process, a task is a lifecycle. Today the run keeps its own `paused`, `held`, `interrupted` in memory (45 and 21 references to `AgentRun.paused` and `.held` per the census) and the two drift.

- Runs report by two events: `runPaused(hold)` and `runResumed`. A run keeps no pause reason of its own: `run.paused` is a getter on the task's hold. `PauseReason`, `PausedReason` and the third copy in `resilience.ts:16` collapse into `HoldCause`.
- One reconciler rule at startup and once per tick: a task in running or review with no live run and no hold gets `runLost`. The resume drip starts these. If auto resume is off, `runLost` sets `error(restart)`. Budget and account holds with no live run are re-evaluated by `autoClears` from the world reading, so a hold cannot outlive its cause after a restart.
- A run waiting for a slot is not running for the tasks-at-once count (contradiction 17).

### 4.7 The 17 contradictions in research 1

| # | Contradiction | Outcome |
|---|---|---|
| 1 | Owner pause and autonomy-gate pause are one row | Gone: `owner-stop` vs `autopilot-off`, one lifters table |
| 2 | Three encodings of autonomy-off | Gone: one kind `autopilot-off`; mode `paused` removed |
| 3 | `limit` means four things, four clearers, two resumed-by-hand stores | Gone: `budget-limit` and `account-limit`, one `exemptUntilRunEnds` |
| 4 | Budget vs account limit indistinguishable after restart | Gone: the kind is persisted |
| 5 | `blocked` on never-run tasks and for idle-watch | Gone: `dependency-*` and `idle` |
| 6 | Three encodings of going in circles | Gone: stuck chore and repeated-line rule deleted; `loop-guard` and `error(turn)` are holds; one idle-watch definition |
| 7 | Three pause-reason enums | Gone: `HoldCause` |
| 8, 9 | Auto-resume differs per reason; `error` counted as majhi-resumable | Gone: `autoClears` and `liftersOf` per kind |
| 10 | Mode `paused` unreachable | Removed with the DB migration |
| 11 | Nine start checks, none persisted | Gone by section 5: `blockerOf` |
| 12 | `start_when_ready` has two meanings | Gone: owner's wish only |
| 15 | `run.held` after restart has no task counterpart | Gone: `runLost` |
| 16 | Reason text in 5 web maps and 3 server maps | Gone: one table, exhaustive by type |
| 17 | Slot-queued run counts against tasks-at-once | Gone |
| 13, 14 | Not in the condensed research | Re-check against the full audit before step B |

## 5. One scheduler

Guarantee G2. The stance keeps the captain acting on its own, so the scheduler stays, but smaller than first drafted: the day, org and floor caps and the waits queue are gone, so the gate list is short.

```ts
// packages/shared/src/lifecycle/schedule.ts
export interface WorldSnapshot {
  now: string;
  mode: "off" | "on" | "stopping";
  machine: { memFreePct: number; load: number; cores: number; diskFreeGb: number };
  slots: { running: number; queued: number; max: number; perAccount: Record<AccountId, { running: number; max: number }> };
  accounts: Record<AccountId, { signedIn: boolean; limitedUntil?: string }>;
  online: boolean;
  budgets: BudgetReading;                   // one model: scope x period, reserve
  workspaces: Record<OrgId, { tasksAtOnce: number; running: TaskId[]; authority: AuthorityRows; repoRule?: RepoRule }>;
  tasks: TaskState[];                       // every non-done task
}

export type Action =
  | { do: "start"; task: TaskId; by: "captain" | "majhi"; key: string }
  | { do: "lift"; task: TaskId; by: "majhi"; key: string }         // autoClears is true
  | { do: "hold"; task: TaskId; hold: Hold; key: string }          // a budget limit tripped
  | { do: "wake"; lane: OrgId | "root"; why: string; key: string }
  | { do: "ship"; task: TaskId; key: string };                     // key = task + head + base (G1)

export function schedule(world: WorldSnapshot, policy: Policy): Action[];

export type Blocker =
  | { gate: "mode"; mode: "off" | "stopping" }
  | { gate: "hold"; hold: Hold }
  | { gate: "dependency"; on: TaskId[] }
  | { gate: "authority"; row: "start" | "own"; why: "size" | "no-autonomy" | "provider" | "ask" }
  | { gate: "machine"; why: "memory" | "load" | "disk" }
  | { gate: "slots"; scope: "total" | "account"; account?: AccountId }
  | { gate: "tasks-at-once"; org: OrgId; running: number; max: number }
  | { gate: "repo-rule"; rule: string }
  | { gate: "budget"; scope: BudgetScope; period: BudgetPeriod };

export function blockerOf(task: TaskState, world: WorldSnapshot, policy: Policy): Blocker | undefined;
```

`blockerOf` evaluates the gates in one ordered array and returns the first that fails. `schedule` calls it for each ready task and emits `start` for those with none, in priority order, up to the free capacity. Every action carries its state key, so a repeated tick or a restart cannot act twice (G1).

| order | gate | replaces |
|---|---|---|
| 1 | mode | `blockedStart` autonomy/service.ts:1487 |
| 2 | hold | `heldStart` :1500, `paused` checks |
| 3 | dependency | orchestrator.ts:61-119 |
| 4 | authority (size, no-autonomy, provider whitelist, ask) | pick.ts:48, service.ts:1381-1393 |
| 5 | machine busy | machine/busy.ts:30 |
| 6 | slots | runs/limits.ts:279 |
| 7 | tasks-at-once | service.ts:948-961 |
| 8 | repo rule | autonomy/repo-rule.ts |
| 9 | budget | outcomes/service.ts:701 ceiling, autonomy/spend.ts caps and floors (merged) |

Nine gates, down from twelve in the first draft (the room-wait gate goes with the waits queue, caps and floors fold into `budget`). The blocker is shown on the task (card, task page, digest): "Waiting: Acme has 1 task running (tasks at once is 1)". A ready task never shows no reason. If `blockerOf` returns nothing and nothing started, the tick logs it: that is a model gap.

The world is filled in `apps/server/src/scheduler/world.ts` from the sensors that stay (A13, A14, A18, A20, slots, spend). Nothing is read twice per tick.

One tick, one lock. Triggers: any lifecycle event (1 s debounce), a sensor change, a policy change, and the 60 s heartbeat. The tick absorbs A1, A5, A7, A8, A21, A22 and the four 60 s housekeeping loops (2.3), and `schedule()` is the only place that decides to start, resume, ship or wake. The MR poller keeps only the refresh.

## 6. Policy table: what survives

An 80-knob table is not built. After the cuts about 25 numbers remain, nearly all already in Settings. The step is to put them in one `PolicySchema`, defaults equal to today's values, and delete the code constants. Each remaining entry is a policy entry because no structure replaces it, with the reason in the last column.

```ts
export const PolicySchema = z.object({
  capacity: z.object({ agentsMax: z.number().default(6), runsTotal: z.number().default(0 /* auto */), perAccount: z.number().default(2), perTask: z.number().default(3), idleTimeoutMin: z.number().default(3), runnerCpus: z.number().default(1) }),
  machine: z.object({ memoryFreeMinPct: z.number().default(10), diskFreeMinGb: z.number().default(10), loadOverCores: z.boolean().default(true) }),
  captain: z.object({ passMinutes: z.number().default(15), passTokens: z.number().default(60_000), failuresOff: z.number().default(2), tasksAtOnce: z.number().default(1), typingFreshSec: z.number().default(15) }),
  loopGuard: z.object({ answersWithoutProgress: z.number().default(3) }),
  budgets: BudgetPolicySchema,                 // scope x period limits and the per-account reserve; existing settings
  quiet: z.object({ idleHours: z.number().default(2), waitingHours: z.number().default(4) }),
  accounts: z.object({ highPct: z.number().default(80), usagePollMin: z.number().default(10) }),
  tickSec: z.number().default(60),
});
```

| Group | Keys | Why it stays a number |
|---|---|---|
| capacity | 6 | The machine's real limits; no structure can infer them |
| machine | 3 | Same |
| captain | 5 | An LLM turn that keeps going needs a bound (pass, failures); tasks-at-once and typing are owner choices |
| loopGuard | 1 | "No progress" has no structural proof |
| budgets | the existing scope x period entries | Boundary 3 |
| quiet | 2 | Quiet time has no structural proof |
| accounts | 2 | Display and poll cadence |
| tick | 1 | Replaces about 12 separate 60 s constants |

Deleted with the cuts: 22 chore-cap numbers, RUN_ACTIONS, RUN_MINUTES, RAISE_FACTOR, MAX_PASSES, tell limit, question loop (4 numbers), nudges (2), day cap, org caps, CAP_MARGIN, stuck failures 3 and repeats 4. Duplicates removed: `RUN_TOKENS` vs `RUN_CAPS.tokens`, `BACKUP_STALE_DAYS 2` vs `BACKUP_STALE_MS 36 h`, `VERIFY_STALE_DAYS 14` vs `VERIFY_STALE_MS 10 d` (they disagree today), 80% in three places, two hourly clocks, two daily-chore registries.

Owner edits: Settings > Control > Limits (existing page, `features/limits`). The per-chore caps section there (`chore-caps.tsx`) is deleted. Retry and backoff shapes (`OVERLOAD`, handoff `RETRY 6h`) stay in code until a fix needs to tune them, and then move into this table first.

## 7. Authority and capabilities from the registry

`CommandDef` (packages/shared/src/commands.ts:446, about 358 commands) has `risk`, `summary`, `input`, `output`. It lacks who may run it. That fact lives in at least six hand-kept sets: `AGENT_BLOCKED_COMMANDS` (approval-groups.ts:12), the OWNER sets in `autonomy/policy.ts:57-83`, `SHIP_ROW`/`MERGE_COMMANDS`/`PUSH_COMMANDS` in `captain/levels.ts`, `SHIP_COMMANDS` in `lane-gate.ts:19`, `startsWork`, `OWNER_ONLY_INPUTS` in `admin/tools.ts:34`.

```ts
export interface CommandDef<I, O> {
  risk: RiskClass; summary: string; input: I; output: O;
  authority: {
    who: ReadonlyArray<"owner" | "captain" | "agent">;          // [] is not allowed
    row?: "start" | "questions" | "approvals" | "upkeep" | "merge" | "push" | "own";
    gates: ReadonlyArray<Gate>;                                  // "hardLimit" | "lane" | "pick" | "ship" | "budget" | "machine" | "sensitiveFields"
    lane: "any" | "own-workspace" | "root-only";
    refusal?: Partial<Record<Gate, { text: string; next?: string }>>;
  };
  /** What the captain may tell the owner this command lets it do, for the capability list. */
  capability?: string;
}
```

Hand-adding capabilities to `ADMIN_PREAMBLE` in `admin/boss.ts` (the capability list at :46) is itself a drift source: a command is added with its refusal string first and the prompt is patched later or never (117 captain/instructions commits; ab1319ad, d34e5306, bc98929b, fd33c17a are prompt-only patches, d1c85f58 is code-only). The generated section replaces that practice: the capability list, the row list, "who may do what" and every number come from `authority`, `capability` and `Policy`.

- The prompt's rules section and capability list are generated, the way `SCREEN_MAP` is (8e02498d). Numbers come from `Policy`, so a changed bound changes the prompt.
- The gate chain in `autonomy/service.ts:1214-1250` is built from `gates` and a typed map `GATES: Record<Gate, GateFn>`; a command that names a gate with no function does not compile.
- A coverage test: every command has `authority`; every `row` is one of the 7 rows (so the "six rows" drift cannot recur); every gate has a function; the old six sets are gone; the generated section is a reviewed snapshot.

What becomes what, from research 3:

| generated | code gate (told through a generated line) | hand-written judgment guidance |
|---|---|---|
| Tool list, who may call it, capability list (replaces hand edits to `ADMIN_PREAMBLE`) | Tasks-at-once, typing wait, permission rules by tool kind | Be brief and cheap in model choice |
| The 7 rows and their meaning | Own-work scope, deleteAfter, push-on-merge, forced markMerged, orgMerge never | Do not edit the brief to steer a task |
| Run bound, loop guard, tasks-at-once (from `Policy`) | Provider and branch whitelists | Answer only when the question is settled |
| Full-access exceptions (`FULL_ACCESS_KEEPS`) | Budget holds, stopping and off refusals, automations owner-only | Use the decision inbox, never ask in chat |
| Hold sentences and resume rules (from section 4.3) | OWNER_REACH, OWNER_SETTINGS, sensitive org fields, cross-workspace credentials | Never say "cannot", offer the next step |
| Ship rules (keyed once per task, head, base) | "Read account state, not memory": the digest carries it | Do not start a task only to read code |

The hand-written list stays under ten lines.

## 8. SPEC edits for the owner to approve

The hold design and the deletions change what SPEC says. Proposed edits, none made yet:

| SPEC place | Today | Edit |
|---|---|---|
| Section 2, task statuses (line 68) | `inbox → ready → running ⇄ paused → review → mr → done` | `inbox → ready → running → review → mr → done`. A task that is not moving carries a hold |
| Section 2, line 70 | "`paused` always carries a reason: limit, offline, error, or owner, plus the checkpoint" | "A task with a hold carries its cause (owner-stop, captain-stop, autopilot-off, budget-limit, account-limit, offline, signed-out, error, loop-guard, idle, dependency-closed, dependency-removed) and, for a run, the checkpoint to resume from" |
| Section 2, line 72 (list groups: Needs you = review, paused, mr) | Groups by status | Needs you = review, mr, and held tasks whose hold lists the owner as a lifter. Held tasks stay in their own lane |
| Line 384, loop guards ("pause with reason `owner`") | A reason of `owner` for a loop | A `loop-guard` hold |
| Lines 441 to 442, usage limit and offline | "pause with reason `limit`", "reason `offline`" | The `account-limit` and `offline` holds, auto-cleared by the tick |
| Line 450, agent status (working, paused, at limit, idle, error) | Agent status | Unchanged: it is run state, not task state. Say so |
| Line 609, cleanup ("leaves running (review, paused, stopped)") | "paused" as a leaving state | "leaves running or is held" |
| Lines 644 to 648 (Autonomous: pauses, resumes, "Paused by Captain") | Text about pausing tasks | The same behaviour as the `autopilot-off` and `captain-stop` holds; the sentences come from the hold table |
| Line 674, decision kinds (question, approval, ship, budget, cap, paused, sign-in, secret) | `cap`, `paused` as kinds | `cap` folds into `budget`; `paused` becomes one kind "held" whose text is the hold sentence |
| Line 841, budgets ("runs pause with reason `limit`") | One reason `limit` | A `budget-limit` hold with scope and period; Auto-pilot day and org caps and floors are the same model |
| Section 5.18, caps and floors; chore caps | Per-chore caps, org caps, floors | Removed (row 1, row 10). The authority rows, push-always-asks and the hard limits stay |
| Lines 734, 761 to 763 and the 5.19 business, growth, sensors, economics, trackers, agenda sections | Features | Removed or reduced per section 2.4 once the owner approves each |

## 9. Migration plan

Order: deletions first (each a small mergeable step), then the lifecycle, then the scheduler, policy and authority. Deleting first means fewer holds, writers and readers to migrate. In every deletion step the code goes, database tables and columns stay (dropped only in step E2), tests for removed code go, the remaining tests stay green, typecheck passes.

### 9.1 Census: the progress meter and the type-level guard

`scripts/census-lifecycle.ts` resolves symbols with the TypeScript compiler, not text. It uses the native TS 7.0.2 API already in the repo (`typescript/unstable/sync`, nothing installed), finds each tracked declaration by its AST name, asks the checker for every reference across the server and web programs, and drops test files. Run: `pnpm exec tsx scripts/census-lifecycle.ts` (`--files` per-file rows, `--json`, `--write <file>`, `--check <file>`). `scripts/census-baseline.json` is the checked-in baseline; a symbol's count rising above it fails `--check`. The API is marked unstable, so a TypeScript bump means rerunning it once.

Limit: the compiler sees code only. Raw SQL strings (`db.prepare("UPDATE autonomy_tasks SET held ...")` in `autonomy/repo.ts`) are not references. Step C moves those statements onto the typed drizzle tables first; after that `tsc` catches them. Comparisons with the `"paused"` status literal are not counted yet; once `paused` leaves the enum, `tsc` lists them all.

Baseline refreshed on `main` at acd08080 after D1 to D10 (`Task.pausedReason` 44 to 41, total 208 sites in 31 files; the rest unchanged). `apps/server/src/tasks/census-guard.test.ts` runs `--check` and fails when any count rises; after a drop, refresh with `--write scripts/census-baseline.json`. The original baseline, on `main` at bbbff1a9, 2026-10-05, references outside the lifecycle module (declarations included):

```
symbol                                sites
AgentRun.paused                          45
Task.pausedReason                        44
AgentRun.held                            21
Task.pausedBy                            18
status writes: TaskRepo.setStatus        15
QueueItem.waitFor                        11
waitsForOwner()                           9
autonomy task held                        9
resumeRefusal()                           5
AutonomyState.holds                       5
QueueItem.readyAt                         5
autonomy task heldScope                   4
autonomy task resumedAt                   4
tasks.paused_reason column                3
tasks.paused_by column                    3
pausedLabel()                             3
tasks.start_when_ready column             2
budget alert resumedAt()                  2
autonomy_tasks.held / held_scope / resumed_at columns   1 each

outside the lifecycle module: 211 sites in 33 files
inside the lifecycle module:  0 sites
```

Largest: `runs/manager.ts` (44 plus 20 on `AgentRun.paused / held`), `tasks/service.ts` (13 status writes), `autonomy/service.ts`, `autonomy/driver.ts`, `store/tasks.ts`, `web/features/{shell,board,task}/model.ts`. Target: zero outside `apps/server/src/tasks/lifecycle/` and `packages/shared/src/lifecycle/`, plus the migration and its test.

### 9.2 Part 1: deletions (each its own branch)

| step | what goes | verified by | undo cost |
|---|---|---|---|
| D1 | e2e background runner (server, web panel, setup row) | typecheck; commands registry and screens map lose the entries | Low |
| D2 | trackers (owner: delete) | typecheck; the one label in `decisions` detached | Low |
| D3, D4 | growth, then economics | typecheck | Low |
| D5 | sensors; Growth, sensor and CI packs out of playbooks | typecheck; `playbooks/*.test.ts` | Low |
| D6 | outcomes scorecard, ladder, auto-mute; monthly ceiling moved into the budget model | typecheck; `budgets/*.test.ts` | Medium |
| D7 | Today stays; the two daily summaries become its one brief; rollup-post goes | typecheck; autonomy summary tests | Medium |
| D8 | business KB, voice, CRM (owner: delete); deadlines move to Needs you | typecheck | Medium |
| D9 | G1 first: state keys on ship, answer, tell (new idempotency tests: same key twice is one action). Then delete chore caps (22 numbers), cap-ask flow, per-chore Limits UI, the tell rate limit; one pass bound | new key tests; `captain/{desk,tell-ship}.test.ts` stay green | Medium. The keys land before the caps go, so there is never a window without a guard |
| D10 | Question loop word-overlap, stuck repeated-line rule, `stuck` chore, Laya wake gate, driver heartbeat, rollup-post, `own-work-second`, echo guard. Add the progress counter (`loop-guard` after N answers with no progress) before removing the similarity rule | `autonomy/driver.test.ts`, `captain/desk.test.ts`, new progress-counter test | Medium |
| D11 | Money caps from nine places to one model: Auto-pilot day and org caps, floors into the reserve, CAP_MARGIN, budget-asks, lane budget check | `autonomy/{spend,cap}.test.ts` ported to the budget model, `budgets/limit.test.ts` green | Medium |
| D12 | Duplicates: `DAILY_CHORES`, `HOURLY_MS`, `dailySummary` copy, `workspaceFull` and `noRoomFor`, `checkWaits` copy, the waits queue | typecheck; `autonomy/waits.test.ts` goes with it | Medium |
| D13 | Loops merged into the one tick (A1, A5, A7, A8, A21, chatMemory, projectcard, ops looks), one per PR, old loop behind a flag for one release. Needs the lock from step C so it lands after C | `autonomy/service.test.ts`, `captain/*.test.ts` | Medium |

### 9.3 Part 2: lifecycle, scheduler, policy, authority

| step | what | verified by | undo cost |
|---|---|---|---|
| A | The census and baseline (done, refreshed after D1 to D10). `apps/server/src/tasks/census-guard.test.ts` runs `census-lifecycle.ts --check` and fails when a count rises | The test itself | Trivial |
| B | `Hold` schema, `transition()`, `liftersOf`, `autoClears`, `sentenceOf` in `packages/shared/src/lifecycle/`, no callers. First a characterization test for the illegal list (especially `tellAgent` on an `mr` task). Table-driven tests: every event x every status, asserting next state, effects and Refusals; exhaustiveness: every `HoldCause` has lifters, auto-clear and sentence. Also confirm the open structured signals of section 3 | New `lifecycle/transition.test.ts`, `hold.test.ts`; no existing test changes | Trivial |
| C | `apply()` in `apps/server/src/tasks/lifecycle/` with the per-task lock. Route the 14 `setStatus` sites through it. Dual-write `paused_reason` and `paused_by` from the hold; `paused` stays in the enum and DB. Move raw SQL on `autonomy_tasks` onto drizzle. `setStatus` becomes private | Stay green: `tasks/*.test.ts`, `mrs/flow.test.ts`, `runs/{resume,start-failure,limit,limits,queue,resume-drip,fair-slots,captain-slot}.test.ts`, `budgets/limit.test.ts`, `autonomy/{driver,resume,service,pick,slots}.test.ts`, `captain/{desk,tell-ship,sign-in}.test.ts`, `rooms/idle-watch.test.ts`, `processes/tasks.test.ts`, `store/*.test.ts`. Census: status writes 15 to 1 | Medium: old columns still hold the truth, so revert is a code revert |
| D | Readers: server then web read `hold`. One text table replaces the 5 web and 3 server maps. Remove `paused` from `TaskStatus`; `tsc` lists every compare. `AgentRun.paused` becomes a getter. SPEC edits (section 8) land with this step | Typecheck. Table test: every `HoldCause` has a sentence. Census near zero | Medium: the enum change touches about 100 files |
| E1 | DB migration, id 151 or higher in `store/migrations.ts` style (comment above, own transaction, `MigrationConflict` on id reuse), mirrored in `store/schema.ts`. Adds `tasks.hold` TEXT (JSON, zod-parsed on read). Backfill from `paused_reason`, `paused_by`, `autonomy_tasks.held / held_scope / resumed_at`: owner with no `paused_by` and no `held` becomes `owner-stop`; `captain` becomes `captain-stop`; owner with `paused_by = autonomy-off`, or `held = owner` with scope `stop-now`, becomes `autopilot-off(now)`; limit with `held = limit` and scope `day` or an org becomes `budget-limit`(scope org or all, period day); limit otherwise becomes `budget-limit` (the tick reclassifies from the account cache on first run); offline, signed-out, error, loop and blocked map straight (blocked on a never-run task becomes `dependency-closed`; from idle-watch, `idle`). Paused rows return to their lane. Test `store/lifecycle-hold-migration.test.ts` in the style of `paused-by-migration.test.ts` | The migration test, `store/store.test.ts`, no-op rerun | Medium |
| E2 | A later migration, one release after E1: drop `paused_reason`, `paused_by`, `autonomy_tasks.held / held_scope / resumed_at`, `autonomy_state.holds` and `queue`, the `paused` mode value, and the tables of deleted features (trackers, growth, business, outcomes, agenda, economics) | Migration test | High: dropped data cannot come back. Back up first |
| F | `WorldSnapshot`, `schedule`, `blockerOf` in shared; `scheduler/world.ts`; the one tick takes over the merged loops (D13 completes). Blockers on cards and the task page. Replaces `stallExplained`, `blockedStart`, `heldStart`, `noRoom` | Table tests: each gate alone, gate order, `schedule` never starts when `blockerOf` says blocked, repeated key is a no-op, never a ready task without a reason | High: loops removed for good; each fold its own PR |
| G | `PolicySchema` with the 25 numbers; default-equality test (old constant equals default, then delete the constant); Limits page sections | Default-equality test; typecheck | Low |
| H | `authority` and `capability` on `CommandDef`, generated prompt section replacing hand edits to `ADMIN_PREAMBLE`, six hand-kept sets deleted, coverage test | Coverage test; snapshot of the generated section reviewed once | Medium: large diff in commands.ts, do it per command group |

Expensive to undo: E2 (dropped data), D (enum change), F (removed loops). Each has a two-release path. Owner-only check, one line: after E1, open the board on a real backup copy restored through majhi's restore (never the live `~/.majhi`) and see held tasks in the right lanes.

## 10. Process rule going forward

1. A fix names the transition, hold kind, gate or policy entry it changes. If none fits, the model changes first (a new hold kind with its table row and test, a new gate, a new policy key), then the fix is one line. A fix that adds an `if` to a service or a constant beside the code does not merge.
2. Owner complaints are batched into one list per phase and handled together, not fixed one at a time the same day. The list is read as a set: several complaints that share one missing rule are one model change, not four patches.
3. A new guard on the captain needs a named structural guarantee (G1 to G4) or a boundary from section 2.1. If neither applies it is a policy entry with the reason it cannot be structural.
4. No new decision reads text. A new `RegExp` or message `includes` that drives behaviour needs a line in section 3 naming the structured signal, or an open question.

How to encode it, so it is not a sentence that drifts:

- The census guard test (step A). After step D, `tsc` is the guard: the old writers are private and the old fields are gone.
- A second test using the same compiler API: no call to `RegExp.test`, `String.match` or `includes` on a value typed as a hold, blocker, error `message` or event `text`. The scan runs on the syntax tree and resolved types, not on source text.
- The coverage test of section 7 stops a rule living only in the prompt.
- One line in the repo `CLAUDE.md` (Code standards) pointing here, added with step A. Every fix commit and DECISIONS entry names its hold kind, transition, gate or policy key. The census total goes in `docs/PROGRESS.md` at each phase end.

## 11. Owner decisions (2026-10-05)

1. SPEC edits in section 8: approved. `paused` is no longer a status; one typed `hold` explains every pause. Auto-pilot day and org caps and floors fold into one budget model (scope, period, reserve).
2. Today: keep. Business (KB, voice, CRM): delete; deadlines move into Needs you.
3. Trackers (Jira, ClickUp, GitHub Issues): delete. Sensors, growth and economics: delete.
4. Dependency-closed holds: today's behaviour stays (waits for the owner). Not asked; revisit only if it bites.
5. No structured CLI signal for a limit or a failed sign-in: plain fallback. An unknown failure becomes an `error` hold and the account usage poll decides when to resume. No text parsing of CLI errors (section 3 rows 1 and 2).
6. Text matching exceptions allowed: the secret scan (row 16) and input grammars the owner types on purpose (row 17). Nothing else.
