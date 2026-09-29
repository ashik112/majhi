# majhi: Build Spec

Version 1.0 · owner: Ashik · status: approved for build

This spec is the source of truth. If something here is unclear or wrong, stop and ask the owner. Do not guess. Record every decision you make that this spec does not cover in `docs/DECISIONS.md`.

---

## 1. What this is

majhi is a local, dockerized workspace where one developer runs AI coding agents across many companies at once. It replaces opening separate CLIs (Claude Code, Codex) by hand. It is the owner's main daily tool, so speed, clarity and reliability matter more than feature count. The UI must be polished and fast enough to be a developer's daily driver: keyboard-first, dense where it helps, calm everywhere else.

The owner works for several companies (orgs). Each org gives official Claude and Codex accounts, usually CLI subscriptions, sometimes API keys. An org can have several accounts of the same tool. More tools (OpenCode, Cursor, others) may be added later. Projects live under one or more workspace roots that the owner picks (for example `~/Work` and `~/personal`). Repos are on GitHub, GitLab and Bitbucket, and the owner has SSH access to all of them. Trackers vary (Jira, ClickUp, GitHub Issues), but most tasks are local and never touch a tracker.

### Goals

1. Create a task in one sentence, with repos, base branch, agents, images, docs and links, and have a team of agents do it in isolated git worktrees.
2. One task can span several repos. Each repo gets its own worktree, branch and MR.
3. Agents coordinate in a task room by @mentioning each other. The owner can talk to the room at any time.
4. Agents, accounts, models, skills and memory are fast to add, swap and configure. Models can be set by hand or picked per task by the decision provider. The owner has final say on every setting.
5. Work survives network loss and usage limits: runs pause at a checkpoint and resume, or hand off to another agent.
6. Token use is visible and minimized.
7. `docker compose up` gets it running in minutes.

### Non-goals (v1)

- Multi-user or team use. This is single-user.
- Cloud hosting. Local only.
- Replacing the git hosts' review UIs. majhi opens MRs and shows diffs, humans can still review on the host.
- Building our own agent. We drive existing agents over ACP.

### Principles

- **Own the core, reuse the parts.** majhi (orchestration, UI, data model) is ours. Protocols, CLIs and proven libraries are reused (section 4).
- **Files are the source of truth for config.** Agents, skills, org and project config live as plain files in `~/.majhi`, editable by hand and versionable. The database indexes and caches them.
- **Org boundary by default, owner override always.** An org's agents only see that org's work unless the owner explicitly allows otherwise. Root agents work anywhere, and can organize projects and create tasks, with owner approval for every change.
- **Nothing leaves the machine without approval.** No push, MR or merge unless the owner approves or the org's policy allows it.
- **Measure tokens.** Every run records token use. Optimizations are kept only if the numbers show they help.
- **One control plane, and the boss runs it.** Every change in majhi is a typed command. The UI, the palette and the boss agent all use the same commands, so the owner can set up and run everything just by talking to the boss (5.16). Everything is configurable at runtime, and every change can be undone.
- **Light on resources.** Agent processes and models start when needed and stop when idle. Limits keep memory, CPU and tokens bounded (5.17).

---

## 2. Core concepts

| Concept | Meaning |
|---|---|
| **Org** | A company. Has accounts, agents, projects, a default team, a default base branch, a merge policy, a tracker (optional), and a git commit identity. |
| **Account** | One login for one tool (Claude Code or Codex in v1), owned by an org or marked personal. Signs in either with the tool's own login (subscription) or with an API key. Has its own isolated config home. Usage limits belong to accounts. |
| **Agent** | A configured worker: role, account, model, instructions, skills, MCP tools, permissions, where it can work, and a fallback agent. Several agents can share one account. |
| **Root agent** | An agent with scope "anywhere", usually on a personal account. Examples: Dispatcher (routes new tasks), Housekeeper (curates memory, cleans worktrees), Setup (scans the machine, drafts config, organizes projects). Root agents can create tasks and edit config, always with owner approval. |
| **Workspace root** | A folder the owner picks that holds projects, like `~/Work`. There can be several. majhi scans them for repos and mounts each one into the containers. |
| **Project** | A git repo under one of the workspace roots, belonging to one org. Has aliases used for parsing ("api", "web"), remotes, the remote used for MRs, and links to other projects. |
| **Task** | A unit of work. Local by default, optionally mirrored to a tracker. Has a kind (`code`, `ops` or `chat`, see 5.15), a brief, attachments, zero or more task repos, a team, a coordination mode and a status. |
| **Task repo** | One repo inside a task: base branch, working branch, worktree path, MR, merge order. |
| **Room** | The task's conversation: owner messages, agent messages, and system events. |
| **Run** | One agent's ACP session working on a task. Has checkpoints and token usage. |
| **Memory** | Short facts with a scope (global, org, project) and provenance. Recalled into tasks. Curated with owner approval. |
| **Skill** | A folder with a SKILL.md in the Agent Skills format. Enabled per agent. |
| **Connection** | Access to an outside system: a Kubernetes cluster, New Relic, a mailbox, a server over SSH, a cloud CLI, any MCP server. Owned by an org. Org agents use their org's connections; root agents can use all of them. See 5.14. |
| **Tool** | A kind of agent CLI majhi can drive over ACP (Claude Code, Codex). Each tool is one entry in a registry, so new tools are added without touching the rest of majhi. |
| **Decision provider** | An optional fast model that answers small typed questions (pick one, score, true or false) instead of writing text. Used for routing and model picking. See 5.12. |
| **Boss** | The one root agent the owner talks to for everything: setup, orgs, repos, agents, accounts, limits, tasks, debugging, stopping other agents. Which agent is the boss is itself a setting. See 5.16. |

### Task statuses

`inbox` → `ready` → `running` ⇄ `paused` → `review` → `mr` → `done`

- `paused` always carries a reason: `limit`, `offline`, `error`, or `owner`, plus the checkpoint to resume from.
- `review` means the team finished and the reviewer agent approved. The owner decides next.
- The task list groups these as: **Needs you** (review, paused, mr), **Working** (running), **Up next** (inbox, ready), **Done**.

---

## 3. User experience

The UI reference is `design/ui-demo.dc.html`. It is a prototype written in a canvas component format, not production code. Reimplement it in React. Read its markup for layout and its `renderVals()` script for behavior and sample data. Where the prototype and this spec disagree (for example pause behavior or MCP tool names), this spec wins.

### 3.1 Main screen (one screen, three columns)

**Top bar:** app name, a command button that opens the palette (Cmd K), status pills (online state, teams working, accounts at limit, each clickable), and a Studio button.

**Left column: task box and task list**
- Task box: a multiline input. While typing, it parses the text live and shows chips for what it understood:
  - repos, matched by project aliases
  - base branch: phrases like `from develop`, `base: main`, `off release/2.1`
  - working branch: phrases like `on feature/x` or `branch fix/y` (must contain a slash to count)
  - @mentioned agents (these become the team instead of the org default)
  - links (fetched and given to the team)
  - attached files and pasted images
  - warnings: no repo found, or repos span more than one org
- Buttons: Attach, Save for later (status `inbox`), Start (creates worktrees and starts the team).
- Task list grouped as in section 2. Each row: org color, key, status, title, repos, team avatars.

**Middle column: task room**
- Header: key, org, status, title, repo chips (`repo: branch from base`), team avatars, and one primary action that changes with status:
  - review: "Approve, open N MRs" (plus "Send back")
  - mr: "Merge in order" or, if the org never lets majhi merge, "I merged it"
  - paused (limit): "Hand off to @fallback" (plus "Wait for reset")
  - running: "Pause"
  - inbox/ready: "Start team"
- Messages: owner messages right, agent messages left with agent handle plus account and model, system events centered. Attachments render as chips with type and a note about how they were used.
- Composer: attach, text input, send. Pasting an image or link attaches it. @mentioning an agent not in the team adds it to the room.

**Right column: tabs**
- Changes: per repo: diff stat, branch and base, worktree path, changed files, MR state. For multi-repo tasks, show merge order.
- Context: attachments given to the team, token receipt (brief size at start, recalled memory size, total in, cache hit rate, out), skills in play.
- Memory: facts learned in this task waiting for approval (Keep, Keep and add to AGENTS.md, Discard), and facts recalled for this task.
- Report (ops tasks): the task's `REPORT.md`, rendered, updating live as the agent writes it, with Copy and Send by mail (asks first).

### 3.2 Command palette (Cmd K)
Search tasks and memory, and run commands: new task, add account, new agent, install skill from link, search memory, swap an agent in the current task, resume paused runs, go to task, manage workspace roots. Keyboard-first.

### 3.3 Studio (one overlay, five tabs)
- **Agents:** list grouped by scope (Root, then each org), each with a status dot. Editor: role, where it can work, account (shows usage), model and effort (both read live from the account's agent over ACP, plus `auto`, which lets the decision provider pick), instructions, skills, permissions (edit files, run shell, push, open MRs, merge), MCP tools, fallback agent. Actions: New (per scope), Duplicate, Health check. Changes save to the agent's file immediately.
- **Accounts:** the one place to see every AI account and where it is used. Table with tool, org, "Used by" (the agents on the account, boss marked; from Phase 2 also the tasks running on it), current-window usage with reset time, weekly usage, status (healthy, running high, at limit, re-login soon, unreachable). API-key accounts show tokens and cost instead of windows. Add account flow: pick tool, pick org or personal, name is suggested (`claude-acme-2`), then either sign in through a device-code flow in an embedded terminal or paste an API key, then one click to create an agent on it. Selecting an account opens its details: status, last health check, usage, and "Used by" grouped by scope with each agent's role, model and effort. Agents that point at a missing account are listed so the broken reference is visible.
- **Memory:** search, scope filters (All, Global, each org, Needs review), rows with text, scope, source (task and agent), use count, and actions (Pin, To AGENTS.md, Forget).
- **Skills:** install from a GitHub link, skills registry name, zip, or local folder. Rows show source, which agents use it, and Enable for all / Remove from all.
- **Connections:** grouped by org. Each row: name, type, access (read or write), which agents use it, last test result. Add flow: pick org, pick type, fill the fields, paste secrets (stored encrypted, never shown again), then Test. For write access, Studio asks whether the credential itself is limited and says plainly what agents will be able to change.

### 3.4 UX rules
- Every destructive or outbound action (push, open MR, merge, forget memory, move or rename a project, any write through a connection, sending mail) is explicit.
- Everything the Setup agent drafts is editable, and shows "Drafted by Setup" until the owner edits it.
- Keyboard shortcuts for the palette, new task, send, next/previous task, approve.
- Fast: task switching under 100 ms, room updates stream live.
- Dark theme first. IBM Plex Sans and IBM Plex Mono, as in the demo.

### 3.5 Workspace roots
Set during onboarding (3.6) and changed later from the palette or by the boss. The owner never types a path: a folder browser lists folders on the host (via the host helper, 4.2), marks git repos, and suggests likely roots (folders under home that hold repos, with their repo counts). Typing a path stays possible for keyboard users. Container mounts are fixed at start, so when a new root is saved, the host helper regenerates the mounts and restarts majhi on its own; the UI shows "Restarting to mount ~/X" and comes back with the new repos. Only when no host helper is connected does majhi show the `make up` command.

### 3.6 Onboarding
The first run is a short guided flow. Nothing else shows until it is done, and it can be reopened later from the palette.

1. **Workspace roots:** pick the folders that hold projects (3.5), from suggestions or the folder browser. majhi mounts them, scans them and shows what it found.
2. **First account:** add a Claude Code or Codex account, personal or for an org, by signing in through the embedded terminal or pasting an API key.
3. **Choose the boss:** pick the account, model and effort for the boss (5.16), or keep the suggested defaults. It is created as a root agent file the owner can edit later.
4. **Hand-off to the boss:** the boss opens its chat and finishes the setup as a conversation. It proposes orgs from the repos it found (remotes, folder names), asks one question at a time, adds more accounts and agents, sets limits, and registers projects. Everything it does follows the approval policy and can be undone.

Each step is one entry in a step list, so later phases add steps without redesigning the flow. The owner can skip ahead after step 3 and continue the setup with the boss at any time.

---

## 4. Architecture

### 4.1 Reused parts (do not rebuild these)

| Need | Use |
|---|---|
| Driving agents | **Agent Client Protocol (ACP)** over stdio, JSON-RPC. Use the official ACP TypeScript library (check the current package name at agentclientprotocol.com). |
| Claude | `@agentclientprotocol/claude-agent-acp` (the old `@zed-industries/claude-agent-acp` is deprecated) |
| Codex | `@agentclientprotocol/codex-acp` (replaces `@zed-industries/codex-acp`) |
| More agents later | The **ACP Registry** (agentclientprotocol.com/get-started/registry) lists ACP agents such as Cursor, OpenCode and Cline with install info. New tools are added from it. |
| Decision models | **Laya** (open weights, Apache 2.0, `pip install laya`), run locally. **TypeSafe Jev** (hosted API, needs a key), optional. An ACP agent can stand in for either. See 5.12. |
| Skills | Agent Skills format (SKILL.md). Install with the open `skills` CLI (`npx skills add ...`). |
| Semantic code tools | **Serena** MCP server (LSP-based symbol lookup and editing) |
| GitHub | `gh` CLI |
| GitLab | `glab` CLI |
| Bitbucket | Bitbucket Cloud REST API |
| Jira, ClickUp | Their REST APIs (or official MCP servers if they cover what we need) |
| Git worktrees | `git worktree` via a thin wrapper |
| Web terminal for logins | `xterm.js` + `node-pty` |
| Command palette | `cmdk` |
| Diff view | `@git-diff-view/react` or Monaco diff editor, pick one in Phase 5 and log it |

Verify each package name and version before installing. Several of these moved fast in 2026.

### 4.2 Services

```
docker compose
├── server     TypeScript backend (Node 22), HTTP + WebSocket, SQLite
│              owns: config, tasks, rooms, routing, memory, MCP server for agents
├── web        React app (Vite build, served by the server in production)
├── runner     image with agent CLIs + ACP adapters + gh + glab + git + Serena
│              + language servers + kubectl and other connection CLIs;
│              the server spawns agent processes here
└── laya       local Laya decision model (Python), behind a compose profile
               that is on by default; see 5.12

host helper   `apps/host`, a small Node process on the owner's machine (not in
              Docker), installed by `make up` as a login item (macOS LaunchAgent).
              It opens no port: it long-polls the server over the published
              127.0.0.1 port with a token from `~/.majhi/host.token`, and does
              only fixed jobs: list host folders, suggest roots, remount roots.
              Later it is also where MAJHI_RUNNER=native spawns agents.

v1 can merge `server` and `runner` into one container if that is simpler. Keep the process-spawning code behind an interface so agents can later run in their own container per run.

### 4.3 Stack

- Monorepo: pnpm workspaces. Packages: `apps/server`, `apps/web`, `packages/shared` (types, zod schemas), `packages/acp` (ACP client wrapper), `packages/mcp` (majhi's MCP tools for agents).
- Backend: Node 22, TypeScript strict, Hono, `ws` for WebSocket, Drizzle ORM over `better-sqlite3` (WAL mode). No Redis. A persisted jobs table handles background work.
- Frontend: React 19, Vite, TanStack Router and Query, Tailwind, shadcn/ui, Zustand for local UI state.
- Validation: zod everywhere at boundaries.
- Tests: Vitest (unit, integration), Playwright (end to end).
- Lint/format: Biome.

### 4.4 Files on disk

```
~/.majhi/
├── majhi.yaml                 workspace roots, orgs, accounts, projects, aliases, links, policies, defaults
├── agents/<id>.md           one agent per file: YAML frontmatter + instructions body
├── skills/<name>/SKILL.md   installed skills (Agent Skills format)
├── accounts/<id>/           each account's own CLI config home (login credentials live here)
├── agent-homes/<id>/        per-agent config home (see 5.2)
├── memory/memory.db         memory store
├── majhi.db                   tasks, rooms, runs, usage, index of the files above
├── secrets.age              tracker tokens and API keys, encrypted with age
└── .git/                    config history: every change is a commit, so it can be undone (5.16)

<tasks_dir>/<task-id>/       one folder per task (default: <first workspace root>/.majhi)
├── TASK.md                  generated brief (see 5.4)
├── AGENTS.md, CLAUDE.md     generated, point to TASK.md
├── attachments/             images, docs, fetched link content
└── <repo-short>/            one git worktree per task repo

Agent file example:

```markdown
---
id: globex-builder-2
scope: globex            # org id, or "root"
role: Builder            # Lead | Builder | Reviewer | Tester | Root
account: claude-globex-2
model: claude-sonnet     # an id from the account's ACP model list, or "auto"
effort: medium           # an id from the account's ACP effort list, or "auto"
models: [claude-haiku, claude-sonnet]   # allowed ids for "auto" (optional)
where: [globex]          # or [anywhere]
perms: [edit, shell, push]
tools: [serena, majhi-memory, majhi-room]
connections: [globex-k8s-prod, globex-newrelic]   # org connections this agent may use
skills: [nextjs-app-router, write-tests]
fallback: globex-builder
context: { compact_at: 0.8 }   # optional, overrides the org default (see 5.13)
origin: setup            # setup | owner
---
Frontend builder. Match attached designs exactly and reuse existing components.
```

`majhi.yaml` example:

```yaml
workspaces: [~/Work, ~/personal]   # one or more roots, owner picks them
tasks_dir: ~/Work/.majhi             # default: <first root>/.majhi
decisions: { provider: laya, fallback: acp, acp_agent: dispatcher }   # laya | jev | acp | rules
context: { compact_at: 0.8, compact_target: 0.4, max_turns: 40 }   # default for every org (5.13)
boss: majhi-boss                  # which root agent is the boss (5.16)
limits: { agents_max: 6, idle_timeout: 10m, per_account: 2 }   # see 5.17
accounts:
  claude-globex-2: { tool: claude, org: globex, auth: login }
  claude-api:      { tool: claude, org: personal, auth: api-key, key: secret:anthropic-personal }
orgs:
  globex:
    name: Globex
    color: "#8AB8F5"
    base: develop
    team: [globex-lead, globex-builder, globex-reviewer]
    merge: approve            # never | approve | auto-if-green
    identity: { name: "[name]", email: "[Globex work email]" }
    tracker: { type: jira, site: "[site].atlassian.net", token: secret:jira-globex }
    connections:
      globex-k8s-prod: { type: kubectl, kubeconfig: file:globex-k8s-prod.yaml, context: prod, namespace: api, access: read }
      globex-newrelic: { type: mcp, url: https://mcp.newrelic.com/mcp, auth: secret:newrelic-globex, access: read }
      globex-mail:     { type: mail, imap: "[host]", smtp: "[host]", user: "[work email]", password: secret:mail-globex, access: write }
projects:
  globex-api:
    org: globex
    path: ~/Work/Globex/api
    aliases: [api, backend]
    remotes: { origin: { host: github, ssh: github-globex, mr: true } }
    links: [{ to: globex-web, type: depends-on }]
```

### 4.5 Docker details

- Bind mount each workspace root at the **same absolute path** inside the containers, so paths match between host, agents and the owner's editor. `docker compose` cannot loop over a list, so majhi generates `docker-compose.override.yml` with one mount per root from `majhi.yaml`. The host helper regenerates it and recreates the server container whenever roots change; `make up` does the same on first start. Only roots are mounted, never the whole home folder, so agents cannot reach other credentials in it.
- Mount `~/.ssh/config` and `known_hosts` read-only. Forward the host SSH agent (Docker Desktop: `/run/host-services/ssh-auth.sock`; OrbStack exposes its own socket). Private keys never enter the container.
- Mount `~/.majhi` read-write.
- The macOS Keychain is not reachable from Linux containers. Login credentials live in each account's config home under `~/.majhi/accounts/<id>/`. Tracker tokens and API keys live in `secrets.age`, decrypted at startup with a key passed as a Docker secret.
- Provide a `MAJHI_RUNNER=native` option that spawns agents directly on the host instead of in the runner container, for when bind-mount performance hurts (large test suites on macOS). UI and services stay in Docker either way.
- Ship `docker-compose.yml`, a `.env.example`, and a `Makefile` or `justfile` with `up`, `down`, `logs`, `login <account>`, `doctor`.
- Healthchecks on every service. `doctor` checks: SSH agent reachable, each workspace root mounted, each account's auth, CLIs present with versions, git identity per org, disk space for worktrees.

---

## 5. Key mechanisms

### 5.1 Agent runtime (ACP)

- majhi spawns one ACP agent process per run with an explicit environment built from scratch: PATH, HOME, TMPDIR, locale, the agent's config home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), the account's API key variable if it is an API-key account (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), git identity for the org, and the SSH agent socket. Never pass majhi's own environment through.
- Tools live in a registry (`packages/acp/tools/`). Each entry declares: the ACP launch command, the config home variable, the API key variable, how login works, and how to detect limit errors. v1 ships Claude Code and Codex. Adding Cursor, OpenCode or another agent from the ACP Registry means adding one entry with its tests.
- **Models and effort levels are never hardcoded.** majhi reads them from the agent's ACP session config options (categories `model` and `thought_level`, plus `model_config`), caches them per account, and refreshes them when a session starts. If an agent's saved model or effort is no longer offered, majhi warns in Studio and the room and uses the agent's own default until the owner picks again.
- Working directory: the task folder `<tasks_dir>/<task-id>/`, so the agent sees every repo in the task.
- majhi is the ACP client: it creates sessions, sends prompts, streams updates to the room, and answers permission requests according to the agent's permissions (auto-allow what is permitted, ask the owner otherwise).
- Model and effort per run, highest priority first: the owner's override for this task, then the agent's fixed `model` and `effort`, then, for `auto`, the decision provider's pick (5.12): a model from the agent's `models` list (or every model the account offers if the list is empty) and an effort level. If the pick has low confidence or no provider answers, use the agent's ACP default. majhi applies the choice with `session/set_config_option`. The chosen model and effort, and why, are posted as a room event and recorded on the run.
- Attach MCP servers per agent from its `tools` list: `serena`, `majhi-memory`, `majhi-room`, `majhi-tasks`, `majhi-projects`, `majhi-connections`, `majhi-decide` (on by default for every agent, 5.12), plus any others the owner adds.

### 5.2 Accounts, per-agent homes and skills

- A login account has one config home holding its credentials. Login runs the tool's own login inside the runner, shown in an embedded terminal (device-code or browser flow). An API-key account needs no login: its key is stored in `secrets.age` and injected only into runs on that account.
- Several agents can share an account but need different skills. So each agent gets its own config home in `~/.majhi/agent-homes/<id>/` that links to the account's credential file and contains only that agent's enabled skills.
- **Verify early (Phase 1):** that each CLI works with a linked credential file, and that token refresh does not break when two agents on the same account run at once. If it breaks, fall back to one shared home per account and give per-agent skills through the prompt instead. Log the result.

### 5.3 Rooms and coordination

- Every agent turn's final message is posted to the room. majhi parses @mentions in it.
- A mention wakes the mentioned agent with a **handoff prompt**, not the whole chat: the message that mentioned it, the task brief pointer (TASK.md), a short summary of room state, and the current diff stat. Agents can read the full room through the `majhi-room` MCP tool if they need to.
- Agents can also post and mention through the `majhi-room` MCP tool (`post`, `mention`, `read_recent`).
- Owner messages go to the mentioned agent, or to the team's lead if nobody is mentioned. Mentioning an agent not in the team adds it (if its `where` allows this org, or it is a root agent). Otherwise majhi asks the owner.
- Coordination modes per task:
  - **Lead delegates** (default): the lead plans and assigns by mention, and hands to the owner when the reviewer approves.
  - **Pipeline:** each role runs once in order: lead, builders, reviewer, tester.
  - **Build and review loop:** builder and reviewer alternate until approval, max 5 rounds.
- Loop guards: max 12 agent-to-agent turns without an owner message, then pause with reason `owner` and ask. Configurable per org.
- Parallel builders on different repos of the same task are allowed. Two agents never edit the same worktree at the same time: majhi holds a lock per worktree.

### 5.4 Tasks, briefs, branches, attachments

- Parsing rules from 3.1 run on the server too (shared code in `packages/shared`).
- Defaults: base branch from the org, working branch `task/<task-id>-<slug>`. If the owner names an existing branch, check it out in the worktree instead of creating one.
- Create one worktree per repo with `git worktree add`. Fetch first. Fail loudly on conflicts or a dirty base.
- Generate `TASK.md` at the task root: brief, repos with branches and paths, team with roles, attachment list with summaries, recalled memory, org rules (merge policy, commit identity). Keep it short. Regenerate when the team or repos change.
- Attachments: images are passed to agents that support images, and noted in TASK.md. Documents are converted to text once and summarized once, and the summary goes in TASK.md with the full file available on disk. Links are fetched once, stored as markdown in `attachments/`, and summarized the same way.

### 5.5 Multi-repo MRs and merging

- On approval, push each repo's branch through its SSH alias and open one MR per repo.
- Each MR description lists the task, the brief summary, and links to the sibling MRs.
- Merge order comes from project links (a repo that others depend on merges first), overridable by the owner.
- Merge policy per org: `never` (the owner merges on the host, then clicks "I merged it"), `approve` (majhi merges after the owner clicks), `auto-if-green` (majhi merges when CI passes).
- After merge: remove worktrees, update the tracker if linked, run the Housekeeper.

### 5.6 Memory

Two layers:

1. **Repo memory:** `AGENTS.md` in each repo. Human-readable, versioned with the code. Only curated facts get promoted there, by owner approval.
2. **majhi memory:** a local fact store in `~/.majhi/memory/memory.db`.
   - SQLite with FTS5 for keyword search and `sqlite-vec` for vector search. Embeddings run locally with a small open embedding model (for example through transformers.js). No external API calls.
   - Each fact: text, scope (global, org, or project), source task, source agent, status (pending, active, retired), pinned, promoted, use count, created and valid-from/valid-to timestamps (so facts can be retired when they stop being true).
   - Exposed to agents as the `majhi-memory` MCP server: `recall(query, scope)`, `propose(text, scope)`, `list_recent(scope)`. Agents can only **propose**. Only the owner or the Housekeeper, with owner approval, makes a fact active.
   - At task start, majhi recalls the top facts for the task's org and repos (hybrid search, capped at about 500 tokens) and puts them in TASK.md.
   - After a task, the Housekeeper reads the room and proposes new facts, duplicates to merge, and facts to retire. They show in the task's Memory tab and in Studio under Needs review.
- Why not Mem0 or Graphiti: they call a model through an API key to extract facts. Most of the owner's accounts are CLI subscriptions, and the store should work offline and cost nothing either way. Here the thinking happens inside an agent running over ACP, and the store never calls a model.

### 5.7 Resilience: checkpoints, limits, offline

- **Checkpoint** after every agent turn: record the ACP session id, the room position, and a WIP commit on the task branch in each touched worktree (`wip(<task-id>): checkpoint N`). On final approval, majhi squashes or rewrites WIP commits per org preference.
- **Resume:** use ACP session loading if the agent supports it. Otherwise start a new session with a handoff prompt built from TASK.md, the room summary and the diff since the last checkpoint.
- **Usage limit:** detect limit errors from each tool (collect the exact error shapes per tool and auth type in its registry entry, with tests). For API-key accounts, rate-limit and quota errors count as limits. Mark the account at limit, with the reset time if the error gives one. Then:
  - if the agent has a fallback whose account is not limited and the org policy allows auto-handoff, hand off and resume from the checkpoint
  - otherwise pause with reason `limit`, and auto-resume at the reset time if enabled
- **Offline:** detect network failure (failed agent requests plus a periodic connectivity probe). Pause all running tasks with reason `offline`. When the connection returns, resume them from checkpoints, or wait for the owner if auto-resume is off.
- **Crash:** if majhi restarts, it reloads running tasks as paused with reason `error` and offers resume.

### 5.8 Health, usage and status

- Agent status: working (on which task), paused, at limit, idle, error.
- Account health: auth valid, current-window usage, weekly usage, reset time, re-login warning. For API-key accounts: tokens and cost per day and week, and rate-limit errors.
- Where each CLI exposes usage or auth status through a command or ACP, use it. Where it does not, estimate from majhi's own token counts per account and label the number as estimated in the UI. Record per CLI in `docs/DECISIONS.md` what is measured and what is estimated.
- Health check button per agent: verify the CLI starts, auth is valid, and the model is available. If a real call is needed, use the cheapest model and rate-limit checks to once an hour per account.

### 5.9 Token optimization

Build these in, and record their effect in token receipts:

1. Handoff prompts instead of full chat history (5.3).
2. A short TASK.md brief with capped memory recall (5.4, 5.6).
3. Documents and links summarized once, full text only on demand (5.4).
4. Skills load only name and description until an agent uses one (Agent Skills behavior).
5. MCP tools gated per role: attach only the tools in the agent's `tools` list.
6. Serena for symbol-level reads and edits instead of whole files.
7. Stable prompt prefixes (system prompt, instructions, TASK.md header) so provider caching works.
8. Cheap models for routing, summaries and housekeeping by default, and the decision provider (5.12) for small typed decisions that would otherwise cost an LLM call.
9. A context budget per agent session with compaction at 80% (5.13), so no session grows until the window is full.

Token receipt per task: brief size at start, recalled memory size, total input, cache hit rate if reported, output, and per-agent split.

### 5.10 Root agents shipped by default

- **Setup:** scans the workspace roots, `~/.ssh/config`, git remotes and existing CLI config homes. Drafts `majhi.yaml`, accounts and agents, asks the owner one question at a time, and never writes without confirmation. Reads config files and public keys only, never private keys or token values.
- **Dispatcher:** turns new tasks (local or tracker) into rooms: detects repos, branch and org, proposes a team.
- **Housekeeper:** curates memory (5.6), removes worktrees after merge, keeps AGENTS.md short.

All three are normal agent files the owner can edit, swap or delete. One root agent is the boss (5.16); it can hand work to the others.

Root agents can also:

- **Organize projects:** edit `majhi.yaml` (orgs, projects, aliases, links) and move or rename project folders. Every change is shown to the owner as a proposal (a diff for `majhi.yaml`, a from and to path for moves) and applied only after approval. A project with active task worktrees cannot be moved. After a move, majhi runs `git worktree repair` and updates `majhi.yaml` in the same step.
- **Create tasks:** through the `majhi-tasks` MCP tool (`create`, `list`, `update`). New tasks land in Up next and do not start without the owner, unless the org's policy allows it.
- **Use MCP tools:** any MCP server the owner attaches to them, plus `majhi-projects` (`list`, `propose_change`, `propose_move`) and `majhi-tasks`.

### 5.11 Trackers (optional per org)

- Adapters behind one interface: `pull(assignedToMe)`, `get(key)`, `comment(key, text)`, `setStatus(key, status)`, `link(key, url)`.
- Pull on demand and on a schedule. New items land in Up next via the Dispatcher.
- A local task can be pushed to the org's tracker later with one action.

### 5.12 Decision provider

Decision models answer typed questions against a state in one pass, with probabilities and a confidence score. They do not write text and do not speak ACP, so they are not agents. majhi uses them for small, frequent decisions.

- One interface, `DecisionProvider`, with four implementations:
  - **laya:** the default. Laya open-weights model in the `laya` service. Local, free, nothing leaves the machine. Weak without fine-tuning, reads about 512 tokens per state (English checkpoint), and gets worse past about 20 options, so questions must stay small. Its speed on CPU inside Docker on macOS must be measured in the phase that builds it. If it is too slow, run it natively on the host (Laya-MLX), the same way as `MAJHI_RUNNER=native`.
  - **jev:** TypeSafe Jev hosted API. Needs an API key in `secrets.age`. Sends the state off the machine, so it is off by default and the owner enables it explicitly.
  - **acp:** simulates Jev or Laya with an ACP agent, for when neither is available. majhi sends the same state and typed questions as a prompt to a chosen agent (default: the Dispatcher, on its cheapest model and lowest effort) and asks for JSON only. The answer is checked with the same zod schema as the other providers, and retried once if it does not match. Its probabilities are self-reported, not calibrated, so the UI labels them as estimated.
  - **rules:** plain code, no model (the task box parser, fixed defaults). Always available as the last fallback.
- The owner picks the provider and a fallback chain in `majhi.yaml` (default: laya, then acp, then rules).
- Uses:
  - **Model and effort picking:** for agents with `model: auto` or `effort: auto`, pick from the options the account offers over ACP, given the task brief, repos and the agent's role (see 5.1).
  - **Routing:** which org, repos and team a new task or tracker item belongs to (Dispatcher); whether an agent message needs the owner.
  - **Memory:** is a proposed fact a duplicate, and which scope fits it.
  - **Safety:** flag text from attachments, links or tracker items that looks like instructions to the agent. This is a warning on top of wrapping that text as data (section 6), never a replacement for it.
  - **Any agent, as a tool.** Every agent gets the `majhi-decide` MCP tool by default (the owner can remove it per agent): `decide(state, questions)`, where each question is `choice` (pick from options), `score` (rate on a rubric) or `noul` (is this statement true). It returns typed answers, probabilities, confidence, and which provider answered. Agents use it for quick judgment calls instead of spending reasoning tokens: classify an alert, triage a log line, pick which service to check first, decide whether a finding needs the owner. Limits:
    - The state is trimmed to the provider's window (about 512 tokens for Laya's English checkpoint) and the answer says when it was trimmed.
    - At most 20 options per question.
    - A per-run rate limit catches loops.
    - Jev is only used when the task's org allows hosted decisions. Otherwise the call goes to the next provider in the chain.
  - **The owner, from the palette.** "Ask the decision model" runs the same tool on any text.
- Every decision records the question, the answer, the confidence and the provider on the task. Below a confidence threshold (per use, configurable), majhi falls back to rules or asks the owner.
- Token receipts show which decisions replaced LLM calls, so the savings can be measured.

### 5.13 Context budget and compaction

No agent session may keep growing until its window is full. Every session has a budget, and majhi compacts it before it gets expensive.

- **Signal.** majhi reads ACP `usage_update` (`used` and `size`) for every session. Both adapters send it today (`claude-agent-acp`, `codex-acp`). Gate on this provider-reported number, not on a byte estimate. If an agent sends no usage, estimate from majhi's own token counts and label the number as estimated.
- **Threshold.** Compact when `used / size` reaches `compact_at` (default 0.8). The default lives in `majhi.yaml`, orgs can override it, and agents can override their org. The check runs at the end of every turn and before sending any new prompt: if the last reading plus the size of the prompt about to be sent crosses the threshold, compact first.
- **How to compact, in order:**
  1. **Native compaction.** If the agent advertises a `compact` slash command over ACP (Claude Code and Codex both do today), majhi sends it with a short note on what to keep: the task, key decisions, remaining work, files touched, and the next step. The session stays the same, so the agent does not re-read anything. majhi then waits for the next `usage_update` and checks that usage fell below `compact_target` (default 0.4).
  2. **Handoff to a fresh session.** If native compaction is missing, fails, or leaves usage above the target, majhi asks the agent for a handoff note with a fixed template: original task, what is done, key decisions, remaining work, files touched, one concrete next step. The note is saved to `<task>/.handoffs/<agent>-<n>.md`. majhi closes the session and opens a new one with, in this order: the stable prefix (instructions, TASK.md header), TASK.md, the handoff note, a short room summary, the current diff stat, then the pending prompt verbatim. The agent is told to continue silently from where it left off.
  3. **Note built by majhi.** If the agent cannot write the note (the session is broken or already over the window), majhi builds it from durable state without calling a model: TASK.md, the last checkpoint, the room since that checkpoint (newest first, within a fixed budget), and the diff.
- **Rotation without pressure.** A session is also replaced by a fresh one (same handoff path) after `max_turns` turns (default 40, 0 turns it off), and whenever the owner clicks "Fresh session" on an agent in the room.
- **Reactive recovery.** A stop reason of `max_tokens` or `max_turn_requests`, or a context-window error from the agent, triggers the handoff path at once, using the note built by majhi. At most 2 compactions per turn (the cap is per turn, not per session). After that the run pauses with reason `error` and the room says why.
- **What is not carried over.** Old tool output and whole file contents. Agents re-read what they need, preferably through Serena at symbol level.
- **Budgets for what majhi adds.** Everything majhi puts into a context has a cap: handoff prompts, `majhi-room.read_recent` (last N messages, long ones trimmed in the middle with a marker), `majhi-memory.recall` (about 500 tokens), attachment summaries. Images count as a fixed token cost in estimates.
- **Visibility.** Each agent shows a context meter (used of size) on its avatar in the room and in the Context tab. Each compaction posts a room event, for example `@globex-builder compacted: 164k to 18k tokens (native)`, and is recorded on the run and in the token receipt. majhi advertises ACP's compaction capability (unstable in ACP today) so agents that report the compaction lifecycle show it in the room.
- **Tests.** A fake ACP agent that reports rising usage: compaction fires at the threshold, falls back to a handoff when `compact` is missing or does not reduce usage, respects the per-turn cap, and rotates after `max_turns`.

### 5.14 Connections

Connections give agents access to the systems the owner debugs and reports on: clusters, observability, mail, servers, cloud accounts.

- **Types** are registry entries, like tools, so new ones are cheap to add:
  - `kubectl`: a kubeconfig, one context, a default namespace.
  - `mcp`: any MCP server, local command or remote URL, with auth from `secrets.age`. For example New Relic's official remote server (`mcp.newrelic.com/mcp`).
  - `ssh`: a host alias from `~/.ssh/config`. Only the SSH agent socket is forwarded, as everywhere else.
  - `env`: named environment variables from `secrets.age`, for CLIs such as `aws`, `gcloud`, `psql`.
  - `mail`: an IMAP and SMTP account, or a mail MCP server.
- **Storage.** Definitions live under the org in `majhi.yaml`. Secret values live in `secrets.age`. Files such as kubeconfigs live in `~/.majhi/connections/<id>/` with owner-only permissions. Values are never logged and never written to TASK.md, the room, memory or reports. Agents see a connection's name and description, never its secrets.
- **Who can use what.** An org agent can use the connections of its org that are listed in its `connections`. Root agents can use every connection of every org. A run only gets what the task needs: the connections of the task's org, or for a root task, the ones the task names plus any the root agent attaches with `majhi-connections.attach`. Every attach is logged and shown in the room. An org agent never gets another org's connection.
- **How access reaches a run.** Built into the clean per-run environment (5.1): `KUBECONFIG` points to a per-run copy holding only that context; `env` values become variables; `mcp` connections are attached as MCP servers with their auth; `ssh` uses the forwarded agent socket. Everything is removed when the run ends.
- **Safety.**
  - The real guard is the credential. Read connections should use a read-only identity (a Kubernetes viewer role, a least-privilege New Relic user). Read-only flags in MCP servers are not enough on their own (for example containers/kubernetes-mcp-server issue #1415: its read-only mode could be bypassed).
  - On top of that, majhi's permission gate classifies commands and MCP tool calls that touch a connection. Reads (`kubectl get`, `describe`, `logs`, `top`, queries) run freely. Writes (`kubectl apply`, `delete`, `edit`, `scale`, `rollout restart`, `exec`, `drain`, sending mail) always ask the owner, unless the org's policy allows that exact action. Anything majhi cannot classify counts as a write.
  - Every write is recorded in the audit table.
  - Logs, alerts, emails and command output are data, not instructions (section 6).
- **Health.** Each connection has a Test action (for example `kubectl auth can-i --list`, listing an MCP server's tools, an IMAP login). `doctor` runs them all.

### 5.15 Task kinds, reports and live control

majhi replaces the agent CLIs for everything, not only repo work.

- **Task kinds.**
  - `code`: repos, worktrees, branches, MRs, as described above.
  - `ops`: no repo needed. Debugging, incidents, investigations, reports. It uses connections and can add repos later.
  - `chat`: one agent, no team, like opening a CLI. It can be turned into a `code` or `ops` task at any time.
  - The kind is inferred from the task box (Dispatcher and decision provider) and shown as a chip the owner can change.
- **Ops flow.** For example "why is the acme api down in prod": the agent (org or root) investigates with the org's connections and posts findings as it goes. It writes `REPORT.md` in the task folder: summary, timeline, evidence, cause, what was changed, and follow-ups. Follow-ups become either fix tasks, created through `majhi-tasks` and linked to the ops task, which go through the normal code flow with worktrees and approvals, or write actions such as a rollout restart, which wait for the owner's approval.
- **Seeing what agents do.** The room streams everything ACP reports: the agent's plan as a checklist at the top, each tool call (command, target, status, output collapsed), file diffs, and thinking if the agent shares it (collapsed). A one-line "now doing" status sits on each agent's avatar. Agents are told to say what they are about to do, in one line, before any step that changes something.
- **Stopping and steering.**
  - Esc stops the focused agent's current turn (ACP `session/cancel`). "Stop all" stops every agent in the task and pauses it with reason `owner`, keeping the checkpoint.
  - Typing while an agent works queues the message for its next turn. Cmd+Enter stops the current turn and sends the message at once.
  - Model and effort can be changed mid-session (5.1).
  - Permission prompts show inline with Allow once, Allow for this task, and Deny.
- **CLI parity.** Slash commands the agent advertises over ACP work from the composer. `@file` mentions autocomplete from the task's worktrees. Pasted images and files attach. Any past session can be resumed. An embedded terminal opens in the task folder, and any file path opens in the owner's editor.

### 5.16 The boss and the control plane

The owner can run majhi by talking to one agent. The boss sets things up, changes them, runs tasks and debugs, the way the owner would use a CLI agent today, but with access to all of majhi.

- **One control plane.** Every change is a typed command with zod input and output, defined in `packages/shared/commands` and handled in majhi. Examples: create an org, clone a repo into a root and register it, add an account, start a login, create or remove an agent, set a limit, create a task, stop an agent. The UI, the palette, the boss and the tests all call the same commands. A feature is not done until its commands exist. There are no UI-only or file-only features.
- **Who the boss is.** `boss: <agent-id>` in `majhi.yaml`, by default a root agent on the owner's personal account. The owner can make any root agent the boss, in Studio or by asking the current boss. The boss is always one keystroke away (Cmd J opens its chat from any screen). Its chat is a `chat` task, so it streams, stops and resumes like any other room.
- **What it gets.** The `majhi-admin` MCP tool, which exposes every command, plus every other majhi tool and every connection of every org.
- **What it can do**, for example:
  - Clone a repo into a workspace root, create an org for it, register the project with aliases and links.
  - Create, edit, duplicate and remove agents. Assign them to teams and tasks. Change models, effort, context thresholds, limits and budgets.
  - Add accounts and run their login: it starts the device-code flow and shows the link and code in the chat, and the owner finishes in the browser.
  - Add and test connections.
  - Create, start, stop, reassign and close tasks. Interrupt or pause any agent.
  - Debug majhi itself: health, `doctor`, majhi's logs.
  - Install skills, curate memory, change the decision provider.
- **Approval policy.** Every command has a risk class:
  - `read`: runs.
  - `change` (reversible config, for example creating an agent or raising a limit): runs when the owner asked for it in the conversation. If the boss decides to do it on its own, it proposes and waits for a click.
  - `destructive` (remove an agent, org or project, delete a worktree, forget memory, move folders) and `outbound` (push, MR, merge, send mail, connection writes, sending data to a hosted service): always a confirm card in the chat, approved with one click.
  - The owner can change the policy per class or per command, also by asking the boss. Changing the policy is itself `destructive`.
- **History and undo.** `~/.majhi` is a git repository. Every command that changes a file commits it, recording who (owner, boss or which agent), which command, and why. Undo reverts that commit. Studio shows the history. Credentials, databases and caches are git-ignored.
- **Secrets never pass through a model.** When the owner pastes something that looks like a secret into any chat, the composer offers "Save as secret" and the agent only receives a reference such as `secret:newrelic-globex`. When the boss needs a secret, it asks for it through a secure input card that the UI renders, never as chat text.
- **Live changes.** Config changes apply without a restart (file watchers and in-memory registries). The only exception is adding or removing a workspace root, because Docker mounts are fixed at start. The boss says so and shows the command.

### 5.17 Performance and resource use

- **Agents on demand.** Agent processes start when a run needs them and stop after `idle_timeout` (default 10 minutes). Sessions come back with ACP `session/resume` or `session/load`.
- **Concurrency limits.** A global maximum of running agent processes (`agents_max`, default 6), a maximum per account, and a maximum per task. Extra runs wait in the jobs table and show as queued, with their place in line.
- **Budgets.** Optional token or cost budgets per account, org and task, per day. At the budget, runs pause with reason `limit`. The owner or the boss can raise them.
- **Models load lazily.** Laya and the embedding model load on first use and unload after idle. Docker memory limits cap each service.
- **Server.** SQLite in WAL mode with prepared statements, bounded caches, streaming with backpressure, repo scans cached and refreshed by file watchers. The UI pages and virtualizes long rooms and lists.
- **Configurable.** Every limit lives in `majhi.yaml` under `limits` and can be changed live, by hand, in Studio, or by the boss.
- **Targets**, measured in Phase 10: task switch under 100 ms, room updates on screen under 50 ms after the server receives them, server memory under 200 MB with no agents running.

---

## 6. Security

- Per-run environment built from scratch (5.1). An org's agent never gets another org's credentials, unless the owner explicitly allows that agent to work in the other org. Show a warning in the editor when they do.
- Private SSH keys stay on the host. Only the agent socket is forwarded.
- Tracker tokens encrypted at rest (`secrets.age`).
- Anything read from attachments, links, tracker items or repos is data, not instructions. Wrap it as such in prompts.
- majhi binds to `127.0.0.1` only by default.
- Log every push, MR, merge and permission decision in an audit table.
- Connection secrets follow the same rules as API keys. Write actions through a connection ask the owner unless the org policy allows that exact action (5.14).
- API keys are injected only into runs on the account they belong to, never logged, and never written to TASK.md or the room.
- The Jev decision provider sends task text to a hosted API. It is off by default and must be enabled by the owner.
- Config changes and folder moves follow the boss's approval policy (5.16). Every change is a commit in `~/.majhi`, and every approval is logged in the audit table.
- Secrets pasted into a chat are stored in `secrets.age` and replaced with a reference before any agent sees them (5.16).

---

## 7. Build plan

Build in phases. Each phase ends with working software, tests, and a short demo note in `docs/PROGRESS.md`. Stop at the end of each phase for the owner to review before starting the next.

Every phase exposes its features as commands (5.16). From Phase 2 on, a phase is only done when the boss can do everything that phase adds to the UI.

### Phase 0: Skeleton
- Monorepo, Biome, Vitest, Playwright, CI script.
- `docker compose up` starts the server and web. Healthchecks. `doctor` command.
- First-run workspace root picker. Load `majhi.yaml`. Scan every workspace root for git repos and show them. Generate the compose override with one mount per root.
- The command layer (5.16) for the Phase 0 config changes, and `~/.majhi` as a git repository with one commit per change.
- **Done when:** a fresh clone runs with one command, onboarding step 1 lets the owner pick workspace roots, and majhi shows detected repos.

### Phase 1: Accounts and agents
- Account model (login and API key), per-account config homes, login through the embedded terminal.
- Tool registry with Claude Code and Codex entries.
- Agent files: load, validate, watch for changes, write from the UI.
- Per-agent homes and the credential-linking check from 5.2. Log the result.
- Studio Agents and Accounts tabs.
- Onboarding steps 2 and 3 (3.6): first account and choosing the boss.
- **Done when:** a fresh install walks through onboarding to a created boss agent whose health check passes; the owner can add two Claude accounts for one org and three agents on them from the UI, add one API-key account, and each agent's health check passes.

### Phase 2: One agent, one repo, end to end
- ACP client wrapper, spawning with a clean environment, streaming to the room.
- Task box with live parsing, task creation, worktree creation, TASK.md generation.
- Room UI with streaming messages, permission prompts, attachments (images, docs, links).
- Context budget from 5.13: usage meter per agent, native compaction at the threshold, handoff to a fresh session, `max_turns` rotation.
- Live control from 5.15: plan and tool calls streamed in the room, "now doing" status, Esc to stop a turn, Stop all, queue or interrupt with a new message, inline permission prompts, slash commands, `@file` mentions. Task kind `chat`.
- The boss (5.16): chat with Cmd J, `majhi-admin` with every command built so far, the approval policy, undo, and secret capture. Onboarding step 4: the boss finishes setup as a conversation (orgs, projects, more accounts and agents). Agents on demand and concurrency limits (5.17).
- **Done when:** "add a health endpoint to api from develop" produces a working branch in a worktree, with the whole run visible in the room, and a fake agent pushed past 80% context gets compacted with the event shown in the room.

### Phase 3: Teams and rooms
- @mention routing, handoff prompts, `majhi-room` MCP server, the three coordination modes, loop guards, worktree locks.
- Team editing in the room: add, remove, swap agent, change model.
- **Done when:** lead, builder and reviewer on different tools complete a task together, and the reviewer catching an issue causes a fix round.

### Phase 4: Connections and ops tasks
- Connection registry (`kubectl`, `mcp`, `ssh`, `env`, `mail`), secrets in `secrets.age`, Studio Connections tab with Test, per-run injection, `majhi-connections` MCP tool.
- Permission gate for connection writes, audit log.
- Task kind `ops`, `REPORT.md` and the Report tab, `majhi-tasks` MCP tool so agents can create linked fix tasks.
- **Done when:** asked "why is the api down in prod", a root agent investigates with a read-only kubectl connection and New Relic, streams what it is doing, can be stopped midway and resumed, writes a report, and proposes a fix task and a restart that both wait for approval. An org agent cannot use another org's connection.

### Phase 5: Multi-repo and MRs
- Multiple task repos, merge order from links, pushing via SSH aliases, MRs on GitHub, GitLab and Bitbucket with sibling links, merge policies.
- Changes tab with per-repo diffs.
- **Done when:** one task changes two repos on two different hosts and ends with two linked MRs merged in order.

### Phase 6: Memory
- Memory store, local embeddings, `majhi-memory` MCP server, recall into TASK.md, Housekeeper proposals, approval flow, promotion to AGENTS.md, Studio Memory tab.
- **Done when:** a fact learned in one task is approved and then recalled in a later task in the same repo.

### Phase 7: Skills
- Install from link, registry name, zip or folder via the skills CLI. Per-agent enablement. Installing by message in a room ("@agent install this skill <link>").
- **Done when:** a skill sent in a room is installed, enabled for that agent, and used in its next run.

### Phase 8: Resilience and health
- Checkpoints, resume, limit detection per CLI, fallback handoff, auto-resume at reset, offline pause and resume, crash recovery, context-window error recovery (5.13).
- Usage meters and health in Studio and the top bar.
- **Done when:** unplugging the network mid-run pauses the task, and plugging it back resumes it from the checkpoint with no lost work. A simulated limit error hands off to the fallback.

### Phase 9: Root agents and trackers
- Setup, Dispatcher and Housekeeper shipped as default agent files (the boss can hand setup work to Setup). `majhi-projects` MCP tool with the proposal and approval flow for config edits and folder moves.
- Decision provider interface with Laya, Jev, ACP simulation and rules. `majhi-decide` MCP tool for every agent and "Ask the decision model" in the palette. Model and effort picking for `auto` agents.
- Jira, ClickUp and GitHub Issues adapters. Push a local task to a tracker.
- **Done when:** Setup drafts a working config on a fresh machine, a root agent moves a project after approval without breaking its worktrees, a Jira item flows into a room and gets its MR link written back, and an `auto` agent gets a model picked with the decision recorded on the run.

### Phase 10: Token receipts and polish
- Token receipts per task and agent, Serena wiring, tool gating per role, cache-friendly prompts.
- Command palette complete, keyboard shortcuts, performance pass against the targets in 5.17.
- **Done when:** receipts show where tokens go, and the owner can run a full day of work without touching a terminal.

---

## 8. Open questions for the owner

Ask these when the phase that needs them starts, not before.

1. Commit history on merge: keep WIP commits, squash per repo, or rewrite into clean commits? (Phase 5)
2. Auto-handoff on limits: allowed by default for all orgs, or opt-in per org? (Phase 8)
3. Which languages need Serena language servers in the runner image? (Phase 10)
4. Should majhi ever be reachable from a phone on the local network? (Default: no.)
5. Which mail provider does each org use (Gmail, Outlook, plain IMAP)? (Phase 4)
