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

Mockup on live data first, for each screen, and an explicit yes before building (owner rule).

- **Needs you:** one queue, ordered incidents, then approvals and questions, then reviews. Each item is answered in place. A blocked task links to its fix (sign in, raise budget). The bell, banner, Board section, Captain column, Today and Limits copies are deleted.
- **Work:** grouped by workspace, then project. Each row: status dot, unread mark, `project · Name`, Now and Next. Up next, Ideas, and Done today in time order, which is the answer to "what did agents do today".
- **Chat:** one list for the captain, task rooms and client chats. The Cmd J drawer and the floating dock become this one place.
- **Settings:** accounts, limits, usage, health, connections, skills, agents, memory, wiki, playbooks, audit, workspaces. A workspace badge is always visible.

## Step 4: incidents end to end

Detect (watch checks, server errors, tagged by workspace), merge repeats into one open incident per service, one Telegram ping, the agent investigates over the existing connection with logs and recent deploys and states the likely cause, opens a fix PR, the owner approves the merge and deploy, the agent drafts the client update and the owner approves it, the agent writes a short post-incident note. Design note before building.

## Step 5: the captain

One authority level per workspace (Ask me, Routine, Full), tools matched to the three places, the owner's standing intent and the workspace wiki summary in every turn, read-only commands that work with Auto-pilot off, lane scoping by workspace id rather than by text. A morning brief per workspace and a weekly client report (what shipped, time and agent cost, incidents and uptime). Actions the CLAUDE.md "never" list reserves for the owner stay with the owner. Design note before building.
