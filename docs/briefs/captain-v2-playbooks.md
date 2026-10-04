# Captain v2: sensors, playbooks, checked hand-offs and earned trust

Status: approved direction (owner, 2026-10-04: "make captain useful... industry defining"). It builds on the chief-of-staff model (`captain-chief-of-staff.md`, SPEC 5.18) and changes it where noted. The full audit and web research behind it are kept outside the repo, because they name the owner's clients.

## Vision: the captain runs the business

Owner, 2026-10-04: the captain works toward the owner's goals across the whole business, not only code: it joins hackathons, runs product launches, watches competitors, finds good deals, grants, opportunities and investment, runs social media, drafts replies to messages, runs A/B tests and data analysis, does legal and compliance reviews, and watches servers, going to work when a service goes down.

So no capability is a feature of its own. They all run on one engine:

**Goals, agenda, playbooks, outputs through one gate, outcomes, scorecard.**

- **Goals** per workspace or for the whole business ("$X monthly revenue", "launch on a product directory in November", "99.9% uptime for Acme"). Every playbook and finding ties to a goal; the scorecard reports progress per goal.
- **Playbook packs** the owner switches on, stored as data: Engineering (follow-ups, ship, project knowledge, security, UI, CI), Ops watch (service down: an incident task, read-only investigation, a fix as a merge request, restarts only through runbooks the owner approved), Growth (hackathons, launches, competitor watch, deals, grants and funding, investor pipeline), Social and inbox (drafted posts and replies), Analysis (A/B tests, data analysis), Legal and compliance review (findings and drafts that flag risk, marked as not legal advice).
- **Sensors and actions come through Connections** (majhi's MCP connections, per workspace): uptime and logs, mail and chat, social accounts, analytics, launch and hackathon sites, grant sources. A new capability is a connection plus a playbook, never a rewrite.
- **One gate for every output that leaves the machine**, set per channel: Draft (the owner approves each), Batch (approved in one click), Auto within limits. A channel moves up only after a track record and the owner's approval, and drops back to Draft after a mistake. Money is never moved, nothing is signed, and nothing is sent in the owner's name without the channel's setting allowing it.
- **Outcomes per goal** feed the scorecard: replies sent vs edited, applications made vs won, incidents caught vs missed, spend vs revenue.

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


## Essentials the business packs need (added 2026-10-04)

Built (2026-10-04): essentials 1 to 4 as the Business page and the `kb`, `voice`, `crm` and `deadlines` commands and tools (SPEC 5.19). Not yet: the captain proposing entries from shipped work and project cards, drafting contacts from mail, and deadlines in the daily agenda and Today.

1. **Company knowledge base**: the owner's bio, products, pricing, positioning, past wins, metrics, screenshots and decks, per workspace and for the business. Grant applications, launches, investor mail and replies draw on it.
2. **Voice profile**: how the owner writes, learned from sent mail and posts (with the owner's approval), with a voice per client where needed.
3. **Light CRM**: people and organisations (clients, leads, investors, hackathon and grant contacts) with last touch, next step and deadline.
4. **Deadlines and calendar**: hackathon, grant and launch dates and the owner's availability feed the agenda.
5. **Approve from the phone**: decisions and drafts pushed to a chat app or mobile push with Approve and Reject, so the business runs while the owner is away.
6. **Incident escalation**: an unanswered incident escalates after N minutes (louder alert, then a call).
7. **Injection defense for everything inbound** (mail, DMs, web pages, issue text): a dedicated screening pass, and inbound text is always data, never instructions. Required before the inbox and social packs go live.
8. **Platform rules and pacing**: posting caps and pacing per social platform, no impersonation, terms respected. Required before the social pack goes live.
9. **One cost ceiling and a P&L**: model tokens plus paid APIs under one ceiling, and what the captain cost against what it earned or saved.
10. **Backups and restore of majhi's data**: memory, CRM, knowledge base, goals and findings, not only the secrets key.
11. **majhi watches itself**: a stalled server or a dead host helper pages the owner like a client outage.

Order: 7 and 8 before the inbox and social packs; 1, 2 and 3 before the growth packs; 5, 6 and 11 with the ops watch pack; 9 with the scorecard; 10 before any pack stores business data.

## Rules that do not change

The never list, org isolation, nothing outbound without approval or an org policy that allows it, the Autonomous switch and budgets, owner approval for anything that loosens the captain's own authority. The captain may tighten its rows by itself, never loosen them.

## Build order

Each step ships on its own, with an end-to-end test that drives a real captain turn through the fake agent's script mode, and a browser check of any screen it changes.

1. Fake agent script mode, so captain turns are testable end to end.
2. Cut the noise wakes. The captain can message its leads (`tasks.tell`); resolving a merge conflict follows the Merge row. **Built (2026-10-04):** the driver keys the facts of each wake and sends only news (`autonomy/driver.ts`, `digest.ts` `factsKey`), explained stalls and the bare hourly check are dropped, a simulated busy hour went from 49 wakes to 12; `tasks.tell` and the Merge row for `tasks.resolveShip`; the lane's merges and repo registrations go through the chore's rules (`captain/lane-gate.ts`); lanes in Start = You workspaces are woken for findings, review and project cards and can only propose.
3. Findings store, and a follow-ups playbook that imports the memory follow-ups. **Built (2026-10-04):** `apps/server/src/findings`, migration 125, the `findings.*` commands and tools, the `followups` chore, and the Findings section and sheet on the Captain page.
4. Own work row with Propose, and batch approval in Decisions. **Built (2026-10-04):** the Own work row (You or Captain; Propose waits for the findings-as-proposals work in step 6) and `decisions.answerBatch` with the batch strip, ten-second undo and a virtualized queue. See SPEC 5.18, `captain/own-work.ts`, `inbox/service.ts`.
5. Project knowledge card per repo, refreshed on merge, with a readiness score. (Built 2026-10-04.)
6. Playbooks as data, with packs, goals and the per-channel outbound gate; the upkeep chores move onto them. This is the keystone. **Built (2026-10-04):** `apps/server/src/playbooks` (catalog and built-in packs as data, the scheduler, goals, the outbound gate, the uptime check), migration 132, the `playbooks.*`, `goals.*` and `outbound.*` commands and tools, the nine chores scheduled through their Upkeep playbooks, drafts and batches as Decisions, and the Playbooks page. Engineering playbooks are off and say "needs a sensor". No sender is connected to any channel yet.
6a. Ops watch pack: service health sensors through connections, incidents, read-only investigation, fixes as merge requests, approved runbooks.
7. Checked hand-off before ship decisions.
8. Outcomes, scorecard, trust ladder and auto-mute.
9. Sensors: CI status, lockfiles with OSV, end-of-life dates; security and dependency sweep and the tech radar as playbooks.
10. Daily agenda and the morning brief. **Built (2026-10-04):** `apps/server/src/agenda` (the ordered agenda cut at the owner's review time, the brief made once a day with a template fallback, the `agenda.*` commands), migration 134, the `brief` notification kind and the Today page (`/today`). Deadlines and CRM next steps are in the agenda. Not yet: the scorecard line in the brief (the port is there), sensors as agenda sources.
11. Client economics and client update drafts; the opportunities brief.
11a. Growth packs: hackathons and launches, competitor watch, deals, grants and funding, investor pipeline.
11b. Social and inbox packs, drafts first.
11c. Analysis and A/B testing; legal and compliance review.
12. The local model redesign (separate audit), routing the right questions to it.
