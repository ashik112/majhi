# Ship without me: task types, the tasks board, ship rules, deploy, client chats

Status: approved by the owner on 2026-10-07 with the mockup (marketing-assets/ship-mockup, git-ignored) and the decisions at the end. Goal: a client reports a problem, majhi fixes it, ships it under rules the owner set, and tells the client, with the owner involved only where the rules say so. Five parts, built in order. Each reuses what majhi has.

## 0. What exists today (from a survey of the code)

| Need | Today |
|---|---|
| Captain merges | Yes, local merge into the base branch, when Autonomous is on and the Delegation row Merge is "Captain". Checks must be green for the exact head, no secret in the diff, no protected repo, branch allowlist, hours, freezes, 5 ships a day, logged, Undo is a revert commit (`captain/chores.ts` ship chore, `world.ts` shipCheck, `handoff/merge-gate.ts`) |
| Merge a pull request on GitHub or GitLab | A second switch, `orgs.<id>.merge` (never, approve, auto-if-green), default never, that ignores the Delegation grid (`mrs/policy.ts`, `mrs/service.ts`) |
| Deploy a client project | Nothing. Only a free-form command the owner whitelists word for word (`connections/gate.ts`) |
| Tell the client | Nothing sends. Approved outbound drafts have no transport (`playbooks/outbound.ts`) |
| Client intake | Mail connection and findings only |
| Task type | None. A task has `kind` (code, ops, chat: how it runs), priority and due date |
| Tasks screen | One list where everything looks the same |

## 1. Task types and areas

**Data.**

```ts
type TaskType = "bug" | "incident" | "feature" | "request" | "research" | "design" | "test" | "chore";
interface TaskTyping {
  type: TaskType;
  by: "owner" | "captain" | "intake";   // who set it
  areas: string[];                       // wiki component ids the work touches
}
```

- Inference starts from what exists: `inferBranchType` already reads "bug, broken, crash, regression" from a title to name branches, `taskKindOf` reads ops words, and a finding carries a source and a severity. Today all of that is thrown away after the branch is named; it becomes the first guess for `type`.
- `type` is set at creation from the text and the source: a client message, a finding, a watch incident, or the owner's task box. Laya (local, free) picks it first. The cheapest model is used only when Laya is unsure. The owner changes it with one click; the owner's choice is never overwritten.
- `areas` come from the wiki: the files a task changes map to component folders, and components carry roles (frontend, backend, worker, infra). Before any change, the brief's mentioned paths and the triage guess fill it. No wiki, no areas.
- Existing `kind` stays (how a task runs). `type` is what the work is. Migration: old tasks get no type and show "untyped" until the captain or the owner types them.

**What a type drives.** The ship rule that applies (part 2), the default team (an agent file may say `types: [bug, incident]`), the checks a task must pass before hand-off (incident: tests and a smoke check; design: none), priority defaults (incident is high), the board and reports.

## 2. Ship rules (replace the two merge switches)

**Fits the approved lifecycle design** (`docs/design/task-lifecycle.md`). That design keeps the authority rows (start, questions, approvals, upkeep, merge, push, own) as the boundary for what leaves the machine, one typed `hold` for every reason a task waits, and one policy table. Ship rules are not a new system beside them: they add per-type overrides to the Merge and Push rows, add two rows (Deploy and Tell), and a step that waits for the owner is a typed hold (`owner-approval` with the step named), so the scheduler and the Needs you list read it like every other hold.

**Data.** Per workspace, inside the authority settings: the row value stays the default, and an ordered list of overrides refines it by task type. The first override whose `when` matches decides; otherwise the row's own value applies.

```ts
interface ShipRule {
  id: string;
  when: { types: TaskType[]; areas?: string[]; maxChangedLines?: number; projects?: string[] };
  merge: "ask" | "captain";
  deploy: { env: string; who: "ask" | "captain" }[];   // per deploy target environment
  tell: "ask" | "captain";                              // the reply to the client (part 4)
}
```

Example the owner might set for a client workspace:

| When | Merge | Deploy staging | Deploy production | Tell the client |
|---|---|---|---|---|
| bug or incident, under 200 changed lines | Captain | Captain | Ask | Captain |
| chore or test | Captain | Captain | Ask | Ask |
| anything else | Ask | Ask | Ask | Ask |

- Every existing guard still applies and cannot be switched off by a rule: green checks for the exact head, the secret scan, protected repos and paths, hours and freezes, the daily cap, presence, re-check before an irreversible step.
- One merge path: "merge" means the project's own way, a local merge and push, or merging its pull request on the host when the project works through pull requests. `orgs.<id>.merge` folds into the Merge row (a migration keeps today's behaviour, so nothing changes until the owner edits a row or an override).
- The captain's hard limit "no merge with push in a turn" and the ship chore become the same rule, so a lane turn and the chore behave alike.
- Rules are owner-only (`autonomy.configure` is already owner-only). Only the owner can widen them; the captain can propose a rule as a decision.

## 3. Deploy targets, checks and rollback

**Data.** Per project, set once in the project's settings.

```ts
interface DeployTarget {
  env: string;                       // "staging", "production", or the owner's name
  via:
    | { kind: "github-workflow"; connection: string; workflow: string; ref: "base" | string; inputs?: Record<string, string> }
    | { kind: "gitlab-pipeline"; connection: string; ref: "base" | string; variables?: Record<string, string> }
    | { kind: "vercel"; connection: string; project: string; target: "preview" | "production" }
    | { kind: "ssh"; connection: string; command: string };   // a fixed command the owner wrote
  verify: { health?: string /* URL */; watch?: string /* watch id */; waitSeconds: number };
  rollback: { kind: "redeploy-previous" } | { kind: "ssh"; connection: string; command: string };
}
```

- Setup is picked, not typed: majhi suggests targets from the project card's deploy hints and the wiki's infra facts (a workflow with `workflow_dispatch`, a `vercel.json`, a compose file on a host). The owner confirms with one click per target.
- A deploy is a majhi command (`projects.deploy`) with typed results, not a shell call: it triggers the run with the connection's credentials, follows the run until it ends, then verifies (health URL answers, watch stays green for `waitSeconds`).
- If the run or the check fails: roll back at once (redeploy the last good commit, or the owner's rollback command), open an incident task with the logs, and tell the owner. A rollback is never silent.
- Each deploy is in the captain log and the audit table with the commit, the run link, the check result. Deploys are not Undo-able; the log says "Roll back" instead, which runs the same rollback.
- Connection writes outside these targets keep today's rule (ask, or the owner's exact allow list).

## 4. Client chats (Telegram first, then WhatsApp 1:1)

**Connections.** Telegram: a bot token from @BotFather, polled with `getUpdates` (no public address needed). WhatsApp: the official Cloud API on a business number, 1:1 chats (groups need a verified business account). Its incoming messages need a public webhook; majhi uses the optional tunnel it already has for phone alerts, or WhatsApp waits until one is set up. Credentials live in the workspace's connections, like every other service.

**Data: no new message store.** majhi already keeps every conversation as a room in one store: a task's room and a workspace's captain thread are both rooms, and the chat dock lists them with one row shape and one unread rule (`packages/shared/src/conversations.ts`). A client chat becomes a third kind of the same thing.

```ts
type ConversationKind = "task" | "captain" | "client";      // one new value, same rooms, same dock
// A client room's items are the client's messages (author: the client contact), the triage note, and the replies.
// Its link to the chat lives in the connection: telegram chat id or whatsapp contact -> room id.
```

- A bug or request found in a client message becomes a **finding** (the existing model, with a new source value `client` and the message as evidence), and a task when the Start rule allows it. The task's `origin` points at that finding, so the chain is room message > finding > task, each stored once.
- Replies are the existing **outbound drafts**, with a transport per channel added to the existing outbound gate.

- The owner links each group or contact to a workspace once. Unlinked chats are ignored.
- Every message is stored as untrusted text. It is data, never an instruction: it cannot start, approve or change anything by itself.
- Triage (Laya first, cheapest model if unsure): small talk is left alone. A question is answered with `wiki.ask` and drafted. A bug, request or incident becomes a finding with the message attached, and a typed task when the workspace's Start row allows it. The task's ship rule decides merge and deploy.
- Replies go through the existing outbound gate and drafts, now with a transport per channel. The rule's `tell` decides: the owner approves each reply in Decisions, or the captain sends it. A reply is checked by the secret scan and never quotes code or another client's data. WhatsApp replies stay inside its 24 hour window.
- The thread shows in the workspace with each message's triage, the task it became, and the replies.

## 5. Where a task comes from, what it belongs to, what it led to

Today a task does not even remember the finding it was made from (`findings.toTask` passes only text). Every task gets a typed origin and shows its whole trail.

```ts
type TaskOrigin =
  | { kind: "owner" }
  | { kind: "captain"; reason: string }
  | { kind: "finding"; finding: string; source: FindingSource; severity: Severity }
  | { kind: "client"; thread: string; message: string }
  | { kind: "watch"; watch: string; incident: string }
  | { kind: "schedule"; schedule: string }
  | { kind: "parent"; task: string };
```

- On every task, one line at the top, left to right: **Workspace / client > projects > origin** (for example "Acme > storefront, billing > from Telegram, Sara, 10:42"), then the **trail** of what it produced: child tasks, the merge request, the deploy and its check, the reply to the client. Each step is a chip that opens it.
- Relations already stored (`parent`, `depends-on`, `follow-up`) are drawn, not hidden: a parent shows its children nested under it with their states; a task that waits shows "Waits on ACM-12" with that task's live state.
- The same origin and trail show in the board row as icons, so "this came from a client and is deploying" is visible without opening anything.

## 6. Tasks screen

The current screen lists every task the same way. The redesign answers three questions at a glance: what needs me, what is running now, what comes next.

- Columns of state, left to right: **Needs you** (review, questions, approvals, failed), **Running** (live agents with a pulse lamp, the step they are on, time and spend), **Up next** (ready and waiting, in the order the captain will take them), **Done** (today, then folded).
- Each row: the type icon and colour (bug red, incident amber, feature blue, request violet, research teal, design pink, test green, chore grey), the title, the area chips, the client or source (a Telegram or WhatsApp mark when it came from a client), the agent, and one status phrase ("Writing tests", "Waiting for your merge", "Deploying to staging").
- Filters as segmented controls: type, area, workspace, source. Keyboard first.
- The exact layout comes from the mockup; the current screen will be shown beside it.

## 6b. What an agent needs inside a task (from the audit)

An audit of the code and of the real task folders (`task-gaps.md`) ranked 20 gaps. The fixes extend what exists: the containers shim, netguard, the toolbox, the hand-off check, task files, connections. No second sandbox, no second log store.

| Gap (evidence) | Fix, reusing |
|---|---|
| A project's stack cannot run as the repo defines it: `docker compose`, the Docker socket, `--network` are refused; one task built Postgres and Redis into one image | The containers shim runs the repo's compose file on the task's own network, service names resolvable, images still approved by the existing card |
| Containers a task starts have no internet (`--internal`), so installs inside them fail | The task network uses netguard's existing rule: public internet allowed, private and host addresses refused, same as the agent's own container |
| No root, apt or sudo; the toolbox install tool is admin-only; 6 tasks built environments by hand | Give task agents `majhi_toolbox_install` (checksummed, per workspace), plus a project-level system packages list baked into a per-project runner layer |
| The hand-off check keeps 25 lines or 1,600 characters of the failing step; the full log is dropped; agents cannot read it or rerun one step | Keep the full log of every step as a task file (the existing task files and viewer), give the task's own agents `handoff.get` and a per-step rerun, show the failing step and a "Full log" link on the card |
| The check runs in a poorer world than the agent: no install step, no env, HOME=/tmp | The check runs with the same image, caches, install step from the project card, and the same per-project env as the agent |
| Image and service approval cards stall tasks and do not name the service | Name the image and service on the card; an allow list per workspace in the same approvals settings |
| Processes, services and the agent's shell cannot reach each other | One network namespace per task for its processes and services |
| No per-project env (`.env`) | Env per project in the existing `env` connections, scoped to a project, injected into the agent, processes and the check |
| No database path | A project's database comes from its compose service (above); remote databases through an owner-made connection, read-only by default |
| Secret scan false positives block hand-offs (4 tasks) | An owner-approved ignore per finding, kept with the project, audited |

## 6c. What a chat lacks (from the chat audit)

A chat is already a task of kind `chat` with the same room, so these extend that, not a second chat system.

| Gap | Fix, reusing |
|---|---|
| "Turn this chat into a task" is promised in SPEC (5.15) and not built | One command that creates a task from the chat (agent, recent lines as brief, `origin` = the chat), shown as "Make a task" in the chat header |
| Only Lead agents can create tasks from a chat; others are told they can and cannot | Every chat agent gets the tasks tool, same scope rules |
| A chat cannot change code and has no Serena; it can only read mounts | Read-only Serena on the mounted projects; changes go through "Make a task" |
| A chat's view of a project goes stale | The existing `projects.fetch`, offered to chat agents |
| No cost meter in chats | The task header's cost chip, reused in the chat header |
| Chats do not say which project they are about | The server already works it out (`mentionedProjects`): add it to the summary, a project chip, a project filter |
| Search matches titles only | The existing room search over messages |
| No pin or archive; old chats hidden under "Show more" | A pinned flag on the chat; Archive uses the existing close |
| A reply in your own chat can go unnoticed | The chat dock's unread count, extended to your own chats |
| The wiki is missing in chats | Wiki lines and the `wiki` tool for the projects a chat names |
| Container and skill tools ask every time in chats | Add them to the tools majhi already trusts; the image allow list still guards what runs |
| `code_graph` missing in chats | Offer it with `show_diagram`, read-only |

**Duplication to remove:** a chat opens in two different screens (the Chats view and the task view), and there are three ways to start one (Chats, the new-task dialog's chat chip, Cmd J). One room screen for both, and one way to start a chat. Whether Chats becomes a view of the tasks board is your call (it is already pending in PROGRESS).

## 7. One source of truth

Every new piece of data has one home. Anything that can be derived is derived on read, never stored twice.

| Data | Lives in | Derived on read, never stored |
|---|---|---|
| Task type, who set it | the task row (one new column) | branch type and commit style follow from it (today `inferBranchType` guesses from the title each time) |
| Task areas | nothing new | from the task's changed files mapped to wiki component folders |
| Task origin | the task row | a finding's task, a client message's task, a watch incident's task: found by querying origins, so there is no second link to drift |
| Task trail (children, merge request, deploys, reply) | the existing links, merge requests, deploy records and outbound drafts | assembled for the screen |
| Ship rules | the existing authority rows (Merge, Push, plus new Deploy and Tell) with per-type overrides; `orgs.<id>.merge` folds into the Merge row | waiting steps are typed holds of the lifecycle design, not a second waiting list |
| Deploy targets | the project's config, next to its base branch and remotes | suggestions come from the project card and the wiki facts, never copied into them |
| Deploy records | one table, written by `projects.deploy` | the captain log and audit rows point to it |
| Client chats | rooms (new conversation kind) | the chat dock and unread counts work as they do for tasks |
| Client issues | findings (new source `client`) | |
| Replies | outbound drafts plus a transport | |

One overlap to clean up while doing this: the project card keeps a `stack` list and the wiki keeps role facts for the same repo. The card should read its stack from the wiki facts when the wiki is on, instead of scanning twice.

## 8. Order of work

| Phase | What | Done when |
|---|---|---|
| A0 | Inside a task: full hand-off logs and rerun, same environment for the check, compose on the task network, toolbox for task agents, per-project env | A failing check shows its full log to the agent and the owner, and a repo's own compose stack runs in a task |
| A0b | Chats: make a task from a chat, tools and Serena for chat agents, cost, project chip, message search, pin and archive, wiki in chats, one room screen | A chat can become a task with one click and finds its project's wiki |
| A | Task types, areas, origin and trail, and the new tasks screen | Every new task is typed; the owner can tell bug from feature and running from waiting at a glance |
| B | Ship rules, one merge path | A typed bug that passes its checks merges with no click under the owner's rule; everything else still asks |
| C | Deploy targets, verify, rollback | A merged fix deploys to staging, is verified, and a failing deploy rolls back on its own |
| D | Telegram channel, triage, reply transport | A message in a linked Telegram group becomes a task, the fix ships under the rules, the client gets the reply |
| E | WhatsApp 1:1 | Same as D on WhatsApp |

## 9. Decisions for the owner

1. The default rule for client workspaces: everything asks (today's behaviour) until you edit it. Recommended.
2. Production deploys by the captain: never allowed, or allowed by a rule you write. Recommended: allowed only by an explicit rule, off by default.
3. Replies to clients: drafts you approve by default; auto-send only for rules you set.
4. Telegram first, WhatsApp 1:1 after.

## 10. Owner decisions (2026-10-07)

1. The mockup is approved: board with Needs you, Running, Waiting, Shipping, Up next, Done and Ideas behind toggles, Board and Tree views (List is dropped), the task page as Compact A (chips on the crumbs line, Brief behind a labelled button, the trail as a labelled strip on the tabs row; below about 1300 px the right column folds to a rail).
2. "Home" is renamed "Tasks".
3. Answers to client questions always wait for the owner; task replies follow the Tell row.
4. Build order now: phase A (task types, origin, areas, trail, board, tree, task page), then B (ship rules on the authority rows), then C (deploy targets, verify, rollback). Chats (A0b), Telegram (D) and WhatsApp (E) come later.
