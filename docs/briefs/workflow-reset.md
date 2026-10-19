# Workflow reset

Status: approved by the owner on 2026-10-19. It changes SPEC 2, 3, 5.4, 5.4a, 5.15 (containers), 5.16, 5.17 and 5.18. Each step below is one branch. Where this note and an older section of SPEC.md disagree, this note wins until that step rewrites the section.

Every brief for a step includes `docs/briefs/quality-bar.md`.

## Why

On 2026-10-19 the owner said majhi is hard to use every day: too many screens, agents that create task after task with no way to see what is happening, a captain that cannot do most things and is a chore to manage, every task eating gigabytes, and task ids and branch names that say nothing. Measured that day:

| Complaint | Measured cause |
|---|---|
| Disk | Each task gets its own BuildKit builder (1.5 GB of state, empty cache, so every layer is rebuilt), its own stack and named volumes, and its own copy of `node_modules` (pnpm link count 1: the store and the worktree are different mounts in the runner, so pnpm copies). Unnamed volumes from compose and `docker run` carry no task label and are never removed (13 found, 240 to 310 MB each). The code a task needs is 27 to 40 MB. |
| Tasks after tasks | 12 paths create tasks (owner, agents' `create`, `split` and `start`, captain, findings, follow-ups, incidents, client chats, schedules, fix tasks). Each has its own gate and none counts the others. Agents create, split (20 children per call) and start under the default `auto` bookkeeping preset, with no cap on count or depth. Every child gets its own team, up to 5 review rounds and 12 handoffs. |
| No idea what is happening | No task-level "now / next / done when". The only live line is per agent (`AgentLive.nowDoing`), lives in the room and dies with the session. No notice when a task is created or started. |
| Too many screens | About 20 destinations. "Needs you" has 8 homes, conversation has 5, "what did agents do today" has none. A blocked task does not link to the page that fixes it. The approved one-home model (2026-10-08) never reached SPEC.md, so later work kept adding pages. |
| Captain | About 350 tool schemas every turn, 10 authority rows per workspace plus 33 saved per-task rules, wiki and memory only when it thinks to ask, read-only commands that refuse when Auto-pilot is off, and lane scoping that drops rows that only mention another workspace. |
| Names | The task prefix is per workspace, so all of the owner's own projects are `PRV-n`. Branches are slugs of long sentence titles (`fix/six-tests-fail-on-main-all-persist`). Folders are `<tasks_dir>/<id>/<repo>`. |

Other tools that run agents in parallel (Codex app, Cursor 3, Zed, Conductor, Copilot agent) were studied the same day. They are single-codebase agent runners. None handles what a freelancer with several clients juggles: their servers, incidents and client updates. That is where majhi is strong. The patterns worth copying: one list grouped by project with a status dot and an unread mark; a branch named after the work once the agent understands it; a worktree budget with safe deletion; archive on merge; 3 to 5 agents at once, because review is the limit.

## The model

1. **A task is one piece of work.** It has a short name, one agent by default, a plan inside it, and three lines the agent keeps current: Now, Next, Done when. Steps of the plan are not tasks.
2. **One gate.** Every path that creates or starts a task goes through one function. The owner's own tasks always pass. Others are capped.
3. **The environment belongs to the project, not the task.** A builder and a package store per workspace, one warm environment per project with a queue, and a task is a branch and a worktree.
4. **Three places.** Needs you, Work, Chat. Everything else is Settings.
5. **Names say what and where.** `project · Short name` everywhere the owner looks. The id is internal.
6. **The captain runs operations for a freelancer.** Incidents end to end, a morning brief and a weekly report per client, one authority level per workspace.

## Step 0: write it down (this branch)

- This note, a short governing section in SPEC.md, and one DECISIONS.md row.
- SPEC.md lines that already contradict the code (`task/<key>-<slug>` branches) are corrected.

## Step 1: the task model and names

### Gate

`apps/server/src/tasks/gate.ts`, one pure function used by every creator listed above:

```ts
type Origin = "owner" | "captain" | "agent" | "incident" | "client-chat" | "schedule" | "finding";
type Admission =
  | { kind: "start" }
  | { kind: "queue"; reason: "running-cap" | "project-busy" }
  | { kind: "idea"; reason: "open-cap" | "agent-made" };
function admit(input: { origin: Origin; org: OrgId; wantsStart: boolean; counts: GateCounts; limits: GateLimits }): Admission;
```

- `limits.tasks_running` (default 4) caps running tasks across all workspaces. Over it, a start waits in Up next with its place in line. An incident of severity 1 goes to the front of the line, never past the cap.
- `limits.open_by_others` (default 5 per workspace) caps tasks that are open and were not made by the owner. Over it, a new one is filed as an idea: it exists, shows under Ideas, and never starts until the owner starts it.
- `origin: "owner"` always gets `start` or `queue`, never `idea`.
- A task an agent makes is always an idea (`agent-made`). Agents no longer start other tasks: `lead_start` is removed, and `majhi-tasks.start` refuses anything but the agent's own task.
- `split` no longer makes child tasks. It writes plan steps into the task (`task_plans`). Existing child tasks keep working and are shown as before; no new ones are made by agents.
- The authority rows still decide whether the captain may start at all; the gate decides whether there is room.

### One agent per task

- The default team is one agent. A team (lead, builder, reviewer, or the review loop) is used only when the owner picks it on that task or names agents with `@`. The org's `team` setting and the decision provider's team pick are removed.

### Now, Next, Done when

- Three nullable text columns on `tasks` (`now`, `next`, `done_when`, each at most 120 characters), one migration.
- The task's agent sets them with `majhi-tasks.status({ now?, next?, doneWhen? })`. TASK.md tells the agent to set Done when in its first turn and Now and Next at every step.
- Until the agent sets Now, the card shows the latest `nowDoing` of the agent working.
- Shown on the card, in Needs you and as the first line of the task in Chat.
- A notice when a task the owner did not start begins: one line with its name and Done when.

### Names

- `tasks.name`: 2 to 4 words, at most 32 characters, set at create. The creator passes it (`name` is required for the captain and agents). For the owner's sentence, Laya proposes it; if Laya is off or unsure, the first four meaningful words of the title.
- Shown as `project · Name` on every surface that shows a task: card, header, drawer, chat, inline references in room text, notices, palette, Today, agent detail. With several repos, the first project. With none, the workspace name. The id stays in the address and in a tooltip (SPEC 3.4).
- Branch: `{type}/{name-slug}`, the existing collision rule (`-2`, `-3`). A project's `branchPattern` still wins.
- Folder for new tasks: `<tasks_dir>/<project>/<name-slug>/<repo>`, collision suffix as for branches. Existing tasks keep their folders. Every reader uses the stored `task.folder`; nothing rebuilds a folder from the id.
- The id stays the key in the database, Docker labels, hooks, MCP tools and URLs (DECISIONS rows 66 and 139 stand).

### Allowed tests

Gate admissions for every origin at and over each cap. Name to branch and folder: collisions across repos, path containment (no `..`, no absolute path, stays under `tasks_dir`). Migration of the three columns on a copy of a real-shaped database. Nothing else.

## Step 2: the environment per project

- **Builder per workspace:** `majhi-build-<org>` (docker-container driver, never the default builder, so majhi's own builds stay apart). The netguard before every build stays. Docker objects get a `majhi.org` label.
- **Package store per workspace, on the same mount as the worktrees:** `<tasks_dir>/.cache/<org>/` holds the pnpm store and the npm, yarn and pip caches, so pnpm hard-links instead of copying. Verify with link counts on a real project before building on it.
- **Project environment:** services, compose stacks and the preview are keyed by project (`majhi-<project>-...`), with named volumes per project. One task at a time holds a project's environment; others queue (owner's choice, 2026-10-19). A task that changes the database schema gets a copy (`CREATE DATABASE <task> TEMPLATE <dev>`) that is dropped when the task closes.
- **No unnamed volumes:** a volume with no source becomes a named, labelled project volume.
- **Worktree budget:** at most `limits.worktrees` (default 15) task folders. Over it, the oldest done or idle task folder is removed after its branch is saved; running, pinned and dirty folders are never removed (CLAUDE.md "never" list).
- **Archive on merge:** a merged task's folder is removed; its room, report and branch history stay.
- **Allowed tests:** no builder, store or volume is shared across workspaces; the queue hands the project environment to exactly one task; the budget never removes a dirty, running or pinned folder; the template copy is dropped on close.

## Step 3: three screens

Approved by the owner on 2026-10-19 after rounds on live data. The reference is `design/console.html` (sample data; open it and use the Data menu for the heavy, storm, all-clear and offline states). Build to match it pair by pair.

**Layout.** One console, no page switching: Needs you, Work and Chat side by side, landing on Needs you. Under 1240px wide, Chat slides in over the right when a task opens. Needs you with nothing in it collapses to a 44px rail and Work and Chat take the room.

**One row anatomy everywhere.** Status lamp, then `project · Name` with the project in its workspace colour (the workspace name when there is no project), then the reason or Now line, then a count, age or status word. Comfortable density (default) puts the reason on a second line; Compact keeps one line; Spacious adds room. The selected row expands in place: the full question or Next and Done when, then its actions. Unset fields are hidden, never "Not set".

**Attention.** Red only for incidents. Queue items get neutral dots; in Work, "your call" is a hollow red ring with a quiet word. Running is a static dot. No infinite animation, no glow; a new item pulses once. One filled primary button on screen, on the selected item, and it fits the state (Answer, Unblock, Start now, Run tests and ship); hover shows an outlined button. The panes not in focus dim and come back on hover. No native tooltips on rows that re-render.

**Names.** Workspaces show their names with a colour square, never the key (`PRV`, `GOA`). Workspace colours are identity, distinct from status colours, tuned per theme.

**Queue.** Incidents, then Decide, then Review, then Done by the captain. Repeats merge into one row with a count (5 tasks blocked by one closed task, 4 sign-ins, 47 alerts). Groups show 8 and "Show N more". Keys: J/K move, Tab next pane, A primary, 1 to 3 pick, Shift+A whole group, E later, U undo, Enter open, S stop, `.` start now, `[` fold, C write. Every action leaves an Undo toast for 5 seconds. Offline: a banner and dimmed actions; answers wait.

**Look.** Themes Graphite (default), Warm, Focus and Mission; mode Light, Dark or System (default); density Compact, Comfortable (default), Spacious. Switched from the sun button in the top bar and remembered. Graphite dark text is 11.7:1, readable text at least 4.5:1, names 14px and details 13px, flat panels with no grid, rings or blur. DESIGN.md is rewritten to these rules; Mission stays only as a theme.

- **Needs you:** one queue, ordered incidents, then approvals and questions, then reviews. Each item is answered in place. A blocked task links to its fix (sign in, raise budget). The bell, banner, Board section, Captain column, Today and Limits copies are deleted.
- **Work:** grouped by workspace, then project. Each row: status dot, unread mark, `project · Name`, Now and Next. Up next, Ideas, and Done today in time order, which is the answer to "what did agents do today".
- **Chat:** one list for the captain, task rooms and client chats. The Cmd J drawer and the floating dock become this one place.
- **Settings:** accounts, limits, usage, health, connections, skills, agents, memory, wiki, playbooks, audit, workspaces. A workspace badge is always visible.

## Step 4: incidents end to end

Detect (watch checks, server errors, tagged by workspace), merge repeats into one open incident per service, one Telegram ping, the agent investigates over the existing connection with logs and recent deploys and states the likely cause, opens a fix PR, the fix is merged and deployed, the client update is drafted and sent, the agent writes a short post-incident note. Design note before building.

Who does the merge, the deploy and the client update is the owner's choice per workspace (owner, 2026-10-19: "I want to have the choice to let captain handle these"). Two switches on the workspace's incident settings: **Fix: Ask me / Captain ships** (merge and deploy the fix after its checks pass) and **Client update: Ask me / Captain sends**. Default Ask me. With Captain, the captain acts and posts what it did in Needs you as a done item the owner can read, not a question. This is the org policy that CLAUDE.md allows for push, merge and outbound messages; it is set only by the owner, never by the captain.

## Step 5: the captain

**One captain, one account** (owner, 2026-10-19). One captain replaces the per-workspace captain chats (root plus one per workspace today): one conversation, one name, answering about every workspace. By default one AI account (the owner's pick, for example their personal Claude) runs it everywhere. Access stays per workspace: a step in a workspace gets only that workspace's git, SSH, connections and wiki, and nothing from one client's workspace goes into a step for another. Each workspace can override with "Captain uses this workspace's account" (for contracts that require it). A fallback account takes over at the main one's limit; a workspace that cannot run says so in Needs you. The per-workspace chats' history becomes searchable in the one conversation, filtered by workspace.

One authority level per workspace (Ask me, Routine, Full), tools matched to the three places, the owner's standing intent and the workspace wiki summary in every turn, read-only commands that work with Auto-pilot off, lane scoping by workspace id rather than by text. A morning brief per workspace and a weekly client report (what shipped, time and agent cost, incidents and uptime). Actions the CLAUDE.md "never" list reserves for the owner stay with the owner. Design note before building.

## Step 1b: permissions by risk (after step 1)

Owner, 2026-10-19: "for trivial things they ask permission. Then what is the use of an agentic system?" The live queue had 6 approval cards of 17: a `cd` into the task's own folder, the captain reading ship options, an official image pull, pushing the task's own branch. Cause: everything outside a short allow list is "unsettled" (captain/permission-rules.ts), and "Always" saves a rule per agent, command and task (admin/policy.ts), so 33 rules never generalise.

- **Inside the task sandbox nothing asks:** its worktree, its containers and network, reads and edits, commands, installs, tests, builds, majhi's read tools, official images and images the workspace already allowed. Each action is logged and shows in Done today.
- **One authority level per workspace, set only by the owner:** Ask me, Routine (default) or Full. Routine pushes the task's own branch and opens a draft PR without asking. Full also merges to main and deploys to staging. Production deploys and client messages ask unless the workspace's incident setting says Captain ships. Writes on client servers, deletes outside the sandbox, secrets and going over budget always ask. This level is the org policy CLAUDE.md requires for push, merge and outbound messages; the captain and agents can never change it.
- **"Always" saves one rule for the workspace and the kind of action**, never per task or per command line.
- **Allowed tests:** sandbox actions never produce a card; each level allows exactly its row and nothing more; only the owner can change a level; an Always rule applies to the next task of the same workspace and to no other workspace.

## Teams: Lead + workers only

Owner, 2026-10-19. One agent stays the default. The only multi-agent setup is **Lead + workers**, picked by the owner on a task (or proposed by the captain and confirmed). The lead writes a short plan; each step names the worker that owns it. Workers get work only from the plan, never by @mention; steps are plan steps, never tasks; at most 3 workers; a step sent back twice stops and goes to Needs you with the reason. The task shows one Now / Next / Done when, with each worker's line and cost underneath. Review is a workspace setting, "Review before it reaches me" (on or off); when on, the last step is a review on a cheaper model. Mention-driven waking, pipeline and review-loop modes go.

**The work goes on** (owner, 2026-10-19). Staffing is budget- and resource-aware: the lead sees each worker's account headroom, cost so far and machine load (the existing team facts), does small or short-budget steps itself, and adds workers only when the plan is worth it. A worker that goes down (usage limit, signed out, crash, offline) has its step moved to another worker or the lead, from its last checkpoint with a carry note. If the lead goes down, the worker with the most headroom is promoted to lead with the plan and progress, and the room says so in one line. If every agent is down, the task pauses at a checkpoint, Needs you names the exact fix or reset time, and the task resumes by itself when any account returns. One-agent tasks use the fallback account the same way. Reuse the existing account-limit hand-off, refusal-to-cheaper-model switch and team facts. Allowed tests: a downed worker's step completes on another agent; a downed lead is replaced by the worker with the most headroom; all down pauses and resumes on recovery without a duplicate run.
