# Captain v2: sensors, playbooks, checked hand-offs and earned trust

Status: approved direction (owner, 2026-10-04: "make captain useful... industry defining"). It builds on the chief-of-staff model (`captain-chief-of-staff.md`, SPEC 5.18) and changes it where noted. The full audit and web research behind it are kept outside the repo, because they name the owner's clients.

## Why the captain feels useless

- **It has no source of work.** It only reacts to events about tasks the owner created. With an empty backlog it records an empty plan and stops. Open follow-ups recorded in memory are never read.
- **Half its wakes are noise.** Most are false "no agent is working" alarms and restarts. Many of its messages say nothing changed.
- **It knows little about the projects.** Project briefs stay empty after days of work, and its digest carries no project facts, health, CI, follow-ups or record of its own results.
- **Judgment goes to the wrong place.** The small local model answers design questions; the big model checks false alarms.
- **It lacks the permissions a chief of staff needs.** It cannot message its own leads. Resolving a merge conflict waits for the owner even where the captain may merge.
- **Two rule sets act on the same work.** Chores with their own caps, and the lane with its own tools.
- **Workspaces where the owner decides starts get no captain thinking at all.**
- **Nothing is set up:** no schedules, triggers, connections or skills.
- **Its value is invisible.** The log shows janitorial noise; there is no scorecard.

## What the best tools do (research summary)

- A playbook is trigger, conditions, preflight, action, declared outputs, limits and memory.
- A cheap check runs before any tokens are spent.
- Writes go only through outputs the playbook declares; read-only by default.
- Work is verified before it bothers the human.
- Suggest first, apply by itself once proven, with the reasoning visible.
- Learn from the human's reactions: promote what helps, mute what is ignored.
- Memories cite code, are checked before use, and expire when unused.
- A repo knowledge card is refreshed on merge, with a readiness score that gates autonomy.
- Runs that find nothing are archived quietly.

Gaps no product covers: a portfolio view for one developer serving several isolated clients; the owner's review time as the scarce budget; per-client money (agent spend against what the client pays); a tech radar mapped to each repo's own lockfile and code; earned autonomy with promotion and demotion; proof of value the owner can show a client.

## The model

1. **Sensors** per workspace feed the captain facts it cannot see today: git, CI status, lockfiles (checked against OSV advisories), runtime end-of-life dates, tracker items, the follow-ups in memory, majhi's own health. Sensors are cheap code, not model turns.
2. **Playbooks** are the one unit of standing work, stored as data and run by the existing schedule and trigger engine: trigger, conditions, a preflight that must find something, an action (rule, the local model, one captain turn, or a worker task), the outputs it may produce, limits, and its own memory. The upkeep chores become playbooks. A run that finds nothing is archived quietly.
3. **Findings** are one deduplicated store for everything playbooks notice. Each finding becomes a proposed task, a decision, or is dismissed with a reason.
4. **Own work.** A seventh authority row: You, Propose, or Captain. Propose is the default for client workspaces: the captain files proposals and the owner approves a batch in one click in Decisions.
5. **Checked hand-off.** Before any ship decision reaches the owner: tests run, a second agent reviews the diff, a secret and security scan runs, screenshots are taken when the UI changed, and one risk line sums it up.
6. **Trust ladder and scorecard.** Every output records an outcome (accepted, undone, corrected, ignored). A weekly scorecard per workspace: hands-free ships, decisions the captain made correctly vs left to the owner, undo rate, estimated owner minutes saved, findings fixed, stuck time, cost per shipped task. Below 80% accuracy a row drops itself to Propose; above 95% over a track record the captain proposes more authority as a decision. Ignored playbooks mute themselves.
7. **Daily agenda and morning brief.** One planning turn per workspace fits playbooks, findings and backlog into the budget and the owner's review time. The morning brief leads with what needs the owner's minutes.
8. **Business layer, drafts only.** Per-client economics from rates the owner enters (spend against retainer, unbilled work), scope watch, client update and release note drafts, an opportunities brief, a tech radar per project. Anything sent to a client is an owner decision; majhi never invoices, pays or sends.

## Rules that do not change

The never list, org isolation, nothing outbound without approval or an org policy that allows it, the Autonomous switch and budgets, owner approval for anything that loosens the captain's own authority. The captain may tighten its rows by itself, never loosen them.

## Build order

Each step ships on its own, with an end-to-end test that drives a real captain turn through the fake agent's script mode, and a browser check of any screen it changes.

1. Fake agent script mode, so captain turns are testable end to end.
2. Cut the noise wakes. The captain can message its leads (`tasks.tell`); resolving a merge conflict follows the Merge row.
3. Findings store, and a follow-ups playbook that imports the memory follow-ups.
4. Own work row with Propose, and batch approval in Decisions.
5. Project knowledge card per repo, refreshed on merge, with a readiness score.
6. Playbooks as data; the upkeep chores move onto them.
7. Checked hand-off before ship decisions.
8. Outcomes, scorecard, trust ladder and auto-mute.
9. Sensors: CI status, lockfiles with OSV, end-of-life dates; security and dependency sweep and the tech radar as playbooks.
10. Daily agenda and the morning brief.
11. Client economics and client update drafts; the opportunities brief.
12. The local model redesign (separate audit), routing the right questions to it.
