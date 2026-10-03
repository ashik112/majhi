# majhi: Build Spec

Version 1.0 · owner: Ashik · status: approved for build

This spec is the source of truth. If something here is unclear or wrong, stop and ask the owner. Do not guess. Record every decision you make that this spec does not cover in `docs/DECISIONS.md`.

---

## 1. What this is

majhi is a local, dockerized workspace where one developer runs AI coding agents for all of their work at once: their own projects, clients and teams, each kept apart as an org. It replaces opening separate CLIs (Claude Code, Codex) by hand. It is the owner's main daily tool, so speed, clarity and reliability matter more than feature count. The UI must be polished and fast enough to be a developer's daily driver: keyboard-first, dense where it helps, calm everywhere else.

The owner works on several orgs: their own projects, clients and teams. An org can come with its own Claude and Codex accounts, usually CLI subscriptions, sometimes API keys. An org can have several accounts of the same tool. More tools (OpenCode, Cursor, others) may be added later. Projects live under one or more workspace roots that the owner picks (for example `~/Work` and `~/private`). Repos are on GitHub, GitLab and Bitbucket, and the owner has SSH access to all of them. Trackers vary (Jira, ClickUp, GitHub Issues), but most tasks are local and never touch a tracker.

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
- **One control plane, and the captain runs it.** Every change in majhi is a typed command. The UI, the palette and the captain agent all use the same commands, so the owner can set up and run everything just by talking to the captain (5.16). Everything is configurable at runtime, and every change can be undone.
- **No manual work outside majhi.** Anything the owner would otherwise do in a terminal, a config file or another app (loading SSH keys, restarting, mounting, signing in, fixing setup) is done by majhi itself, through the UI, the captain or the host helper. When something truly needs the owner outside majhi (answering a macOS prompt, finishing a browser sign-in, the very first `make up`), majhi says so explicitly, in the place the owner is looking, with the exact step. A terminal command is only ever a fallback, never the main path.
- **Light on resources.** Agent processes and models start when needed and stop when idle. Limits keep memory, CPU and tokens bounded (5.17).

---

## 2. Core concepts

| Concept | Meaning |
|---|---|
| **Org** | A body of work kept apart from the rest: the owner's own projects, a client or a team. Has accounts, agents, projects, a default team, a default base branch, a merge policy, a tracker (optional), and a git commit identity. One org is built in: **Private** (id `private`, task key `PRV`), for the owner's own accounts and repos. It always exists, is the default when nothing else fits, and cannot be removed. Its entry in `majhi.yaml` appears only when the owner changes its settings. |
| **Account** | One login for one tool (Claude Code or Codex in v1), owned by an org, or by Private for the owner's own. Signs in either with the tool's own login (subscription) or with an API key. API-key accounts can carry extra fields the provider needs (a base URL for OpenRouter or a gateway, an org id, an Azure endpoint and deployment), with the same field kinds as connections (5.14). Has its own isolated config home. Usage limits belong to accounts. |
| **Agent** | A configured worker: role, account, model, instructions, skills, MCP tools, permissions, where it can work, and a fallback agent. Several agents can share one account. |
| **Root agent** | An agent with scope "anywhere", usually on a private account. Examples: Dispatcher (routes new tasks), Housekeeper (curates memory, cleans worktrees), Setup (scans the machine, drafts config, organizes projects). Root agents can create tasks and edit config, always with owner approval. |
| **Workspace root** | A folder the owner picks that holds projects, like `~/Work`. There can be several. majhi scans them for repos and mounts each one into the containers. |
| **Project** | A git repo under one of the workspace roots, belonging to one org. Has aliases used for parsing ("api", "web"), remotes, the remote used for MRs, and links to other projects. |
| **Task** | A unit of work. Local by default, optionally mirrored to a tracker. Has a kind (`code`, `ops` or `chat`, see 5.15), a brief, attachments, zero or more task repos, a team, a coordination mode and a status. Can have a parent task and depend on other tasks (5.4a). |
| **Task repo** | One repo inside a task: base branch, working branch, worktree path, MR, merge order. |
| **Room** | The task's conversation: owner messages, agent messages, and system events. |
| **Run** | One agent's ACP session working on a task. Has checkpoints and token usage. |
| **Memory** | Short facts with a scope (global, org, project) and provenance. Recalled into tasks. Curated with owner approval. |
| **Skill** | A folder with a SKILL.md in the Agent Skills format. Enabled per agent. |
| **Connection** | Access to an outside system: a Kubernetes cluster, New Relic, a mailbox, a server over SSH, a cloud CLI, any MCP server. Owned by an org. Org agents use their org's connections; root agents can use all of them. See 5.14. |
| **Tool** | A kind of agent CLI majhi can drive over ACP (Claude Code, Codex). Each tool is one entry in a registry, so new tools are added without touching the rest of majhi. |
| **Decision provider** | An optional fast model that answers small typed questions (pick one, score, true or false) instead of writing text. Used for routing and model picking. See 5.12. |
| **Captain** | The one root agent the owner talks to for everything: setup, orgs, repos, agents, accounts, limits, tasks, debugging, stopping other agents. Which agent is the captain is itself a setting. See 5.16. |

### Task statuses

`inbox` → `ready` → `running` ⇄ `paused` → `review` → `mr` → `done`

- `paused` always carries a reason: `limit`, `offline`, `error`, or `owner`, plus the checkpoint to resume from.
- `review` means the team finished and the reviewer agent approved. The owner decides next.
- The task list groups these as: **Needs you** (review, paused, mr), **Working** (running), **Up next** (inbox, ready), **Done**.
- A task waiting on a dependency stays in **Up next** with a "Waiting on #12" chip. Waiting is derived from its links, not a separate status.

---

## 3. User experience

The UI reference is `design/ui-demo.dc.html`. It is a prototype written in a canvas component format, not production code. Reimplement it in React. Read its markup for layout and its `renderVals()` script for behavior and sample data. Where the prototype and this spec disagree (for example pause behavior or MCP tool names), this spec wins.

### 3.1 Main screen (one screen, three columns)

**Top bar:** app name, a command button that opens the palette (Cmd K), status pills (online state, teams working, accounts at limit, each clickable), and a Studio button.

**Left column: task box and task list**
- Task box: a multiline input. While typing, it parses the text live and shows chips for what it understood:
  - repos, matched by project aliases
  - never a base or working branch: words in the title or text are prose ("taken with Playwright", "work on main later", "the default branch"). The base is the project's, or the one picked for a repo on purpose (a project chip's branch, `repos[].base` on create); a picked base the repo does not have falls back to the project's with a warning. Until the task starts, its base can change (`tasks.update` with `base`). The working branch is always a new `task/<key>-<slug>`, the slug keeping every title word
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
- **Accounts:** its own sidebar page (`/accounts`, `g u`), the one place to add, see, check, sign in again and remove every AI account, and see where it is used. Health and usage keeps the checks and the usage overview and links here. Org cards have an Add account button that opens the same flow with that org selected. Table with tool, org, "Used by" (the agents on the account, captain marked; from Phase 2 also the tasks running on it), current-window usage with reset time, weekly usage, status (healthy, running high, at limit, re-login soon, unreachable). API-key accounts show tokens and cost instead of windows. Add account flow: pick tool, pick org (Private is preselected unless the org filter or the only other org says otherwise), name is suggested (`claude-acme-2`), then either sign in through a device-code flow in an embedded terminal or paste an API key, then one click to create an agent on it. Selecting an account opens its details: status, last health check, usage, and "Used by" grouped by scope with each agent's role, model and effort. Agents that point at a missing account are listed so the broken reference is visible.
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
Set during onboarding (3.6) and changed later from the palette or by the captain. The owner never types a path: a folder browser lists folders on the host (via the host helper, 4.2), marks git repos, and suggests likely roots (folders under home that hold repos, with their repo counts). Typing a path stays possible for keyboard users. Container mounts are fixed at start, so when a new root is saved, the host helper regenerates the mounts and restarts majhi on its own; the UI shows "Restarting to mount ~/X" and comes back with the new repos. Only when no host helper is connected does majhi show the `make up` command.

### 3.6 Onboarding
The first run is a short guided flow. Nothing else shows until it is done, and it can be reopened later from the palette.

1. **Workspace roots:** pick the folders that hold projects (3.5), from suggestions or the folder browser. majhi mounts them, scans them and shows what it found.
2. **First account:** add a Claude Code or Codex account, personal or for an org, by signing in through the embedded terminal or pasting an API key.
3. **Choose the captain:** pick the account, model and effort for the captain (5.16), or keep the suggested defaults. It is created as a root agent file the owner can edit later.
4. **Hand-off to the captain:** the captain opens its chat and finishes the setup as a conversation. It proposes orgs from the repos it found (remotes, folder names), asks one question at a time, adds more accounts and agents, sets limits, and registers projects. Everything it does follows the approval policy and can be undone.

Each step is one entry in a step list, so later phases add steps without redesigning the flow. The owner can skip ahead after step 3 and continue the setup with the captain at any time.

---

## 4. Architecture

### 4.1 Reused parts (do not rebuild these)

| Need | Use |
|---|---|
| Driving agents | **Agent Client Protocol (ACP)** over stdio, JSON-RPC. Use the official ACP TypeScript library (check the current package name at agentclientprotocol.com). |
| Claude | `@agentclientprotocol/claude-agent-acp` (the old `@zed-industries/claude-agent-acp` is deprecated) |
| Codex | `@agentclientprotocol/codex-acp` (replaces `@zed-industries/codex-acp`) |
| More agents later | The **ACP Registry** (agentclientprotocol.com/get-started/registry) lists ACP agents such as Cursor, OpenCode and Cline with install info. New tools are added from it. |
| Decision models | **Laya** (open weights, Apache 2.0), run locally: `laya-mlx` natively on Apple silicon Macs, `laya` (PyTorch) in Docker everywhere else. **TypeSafe Jev** (hosted API, needs a key), optional. An ACP agent can stand in for either. See 5.12. |
| Skills | Agent Skills format (SKILL.md). Install with the open `skills` CLI (`npx skills add ...`). |
| Semantic code tools | **Serena** MCP server (LSP-based symbol lookup and editing) |
| GitHub | `gh` CLI |
| GitLab | `glab` CLI |
| Bitbucket | Bitbucket Cloud REST API |
| Jira, ClickUp | Their REST APIs (or official MCP servers if they cover what we need) |
| Git worktrees | `git worktree` via a thin wrapper |
| Web terminal for logins | `xterm.js` + `node-pty` |
| Command palette | `cmdk` |
| Diff view | `@git-diff-view/react` or Monaco diff editor, pick one in Phase 4 and log it |

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
└── laya       local Laya decision model (Python, PyTorch on the CPU or an
               NVIDIA GPU), behind a compose profile; used on Linux, Windows
               and Intel Macs, and as the fallback on Apple silicon; see 5.12

host helper   `apps/host`, a small Node process on the owner's computer (not
              in Docker), installed by `make up` as a login service: a macOS
              LaunchAgent, or systemd user units on Linux and WSL2 (the table
              below has what differs per OS). It opens no port: it long-polls
              the server over the published 127.0.0.1 port with a token from
              `~/.majhi/host.token`, and does only fixed jobs: list host
              folders, suggest roots, remount roots, keep the SSH agent loaded
              (below), and give a key's passphrase to `ssh-add` once
              (`ssh.unlock`; the passphrase travels browser, server, helper
              over localhost, is never logged by majhi, and only the OS
              keyring keeps it).
              SSH keys: at start (login), after a wake from sleep, when a
              fetch fails for lack of SSH access, and on `ssh.reload` it loads
              the keys whose passphrase the keyring keeps, then every private
              key from `~/.ssh/config` `IdentityFile` entries and the default
              names that has no passphrase and is not loaded yet, and reports
              the count and the keys that still need a passphrase.
              Ops jobs (Phase 2b): it reports the checkout's HEAD, whether it
              has uncommitted changes and which Docker runtime is in use in
              its poll header; `version.changes` answers with the commit
              subjects between the running image's commit and HEAD (`git log
              --format=%s running..HEAD -n 20`); `update` rebuilds and
              restarts majhi (below); `restart` exits so the login service
              starts it again. At start (login) it makes sure Docker is up
              (starting it where it can, waiting up to 2 minutes, polling
              every 5 s) and that majhi is running (`docker compose up -d
              --wait` in the checkout when its container is not), logs each
              step, retries a failed start twice a minute apart, and only then
              posts a notification with the one step the owner must take.
              `update`: `docker compose build` with the same environment as
              `make up` (HOST_UID, HOST_GID, HOME, MAJHI_COMMIT from `git
              rev-parse HEAD`, and the agent socket and Laya GPU `make up`
              picked), create the secrets key if missing, regenerate the
              override, `up -d --wait`, copy the helper bundle out of the new
              image over `~/.majhi/bin`, then exit so the login service starts
              the new helper. Progress goes to `~/.majhi/update.json` (the
              server that would relay it is replaced part-way); the UI reads
              it through `system.version` and reloads when `/health` reports
              the new commit.
              On Apple silicon it also runs Laya natively with `laya-mlx`
              (MLX on the GPU). Later it is also where MAJHI_RUNNER=native
              spawns agents.
```

The host helper per OS:

| | macOS | Linux | WSL2 |
|---|---|---|---|
| Login service | LaunchAgent `dev.majhi.host` | systemd user units `majhi-host.service` and `majhi-ssh-agent.service` (majhi's own SSH agent), enabled for `default.target`, with the helper's environment in `~/.config/systemd/user/majhi-host.env` | The same units, plus `loginctl enable-linger`: WSL has no login of its own, so Docker Desktop starts the distro at Windows sign-in and the lingering user's systemd starts the units |
| Restart after `update` or `restart` | launchd `KeepAlive` | `Restart=always` | Same |
| Secrets key copy | The login Keychain through `security` | A Secret Service keyring through `secret-tool`, asked over D-Bus first whether it is locked, so it never prompts. With none: `keyring: none` and the reason, and the export on Health is the only other copy | Same; usually there is none |
| Agent the keys go into | The helper's `SSH_AUTH_SOCK`, else `launchctl getenv SSH_AUTH_SOCK` | The helper's `SSH_AUTH_SOCK`, else the systemd user manager's, else majhi's own agent at `~/.majhi/run/agent.sock` | Same |
| Agent socket in the server (4.5) | `/run/host-services/ssh-auth.sock`, from OrbStack or Docker Desktop | `~/.majhi/run/ssh-agent.sock`, which the helper serves and forwards to the agent above | Same |
| Key passphrases | Apple's `ssh-add --apple-use-keychain`, reloaded with `--apple-load-keychain` | Kept in the keyring and given to `ssh-add` through a throwaway askpass at each check; with no keyring, kept nowhere | Same |
| Docker | OrbStack or Docker Desktop, started with `open -a` | Docker Engine run as root, a system service the helper cannot start: its notification says `sudo systemctl enable --now docker` | Docker Desktop with WSL integration, started through `powershell.exe`; `docker` is looked for again once it runs |
| Notifications | terminal-notifier, which majhi installs (clickable), else osascript | `notify-send` (not clickable) | A Windows toast through `powershell.exe` (clickable) |
| Open a URL | `open` | `xdg-open` | `wslview`, else `explorer.exe` |
| Open in editor | `code` or `cursor` CLI, the CLI inside the app, then `open -a` | `code` or `cursor` on PATH | `code` or `cursor` on PATH, else the Windows install's |
| Laya | Native on Apple silicon, else Docker on the CPU | Docker, on the CPU or an NVIDIA GPU (5.12) | Same, with the NVIDIA driver in Windows |
| Folder defaults | `~/Work` | `~/code` | `~/code` |

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
├── skills/<name>/SKILL.md   installed skills (Agent Skills format), with skills-lock.json beside them (5.2)
├── accounts/<id>/           each account's own CLI config home, shared by its agents (login credentials live here)
├── memory/memory.db         memory store
├── majhi.db                   tasks, rooms, runs, usage, index of the files above
├── secrets.age              tracker tokens and API keys, encrypted with age
└── .git/                    config history: every change is a commit, so it can be undone (5.16)

<tasks_dir>/<task-id>/       one folder per task (default: <first workspace root>/.majhi)
├── TASK.md                  generated brief (see 5.4)
├── AGENTS.md, CLAUDE.md     generated, point to TASK.md
├── attachments/             images, docs, fetched link content
└── <repo-short>/            one git worktree per task repo
```

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
context: { compact_at: 0.8, cap: 150000 }   # optional, overrides the org default (see 5.13)
origin: setup            # setup | owner
---
Frontend builder. Match attached designs exactly and reuse existing components.
```

`majhi.yaml` example:

```yaml
workspaces: [~/Work, ~/private]   # one or more roots, owner picks them
tasks_dir: ~/Work/.majhi             # default: <first root>/.majhi
decisions: { provider: laya, fallback: acp, acp_agent: dispatcher }   # laya | jev | acp | rules
context: { cap: 200000, compact_at: 0.8, compact_target: 0.4, max_turns: 40 }   # default for every org (5.13)
boss: majhi-boss                  # which root agent is the captain (5.16)
limits: { agents_max: 6, idle_timeout: 10m, per_account: 2 }   # see 5.17
turns: { max_length: 2h, idle: 25m, max_tool_calls: 0 }   # per turn, off or 0 turns one off (5.13)
accounts:
  claude-globex-2: { tool: claude, org: globex, auth: login }
  claude-api:      { tool: claude, org: private, auth: api-key, key: secret:anthropic-private }
orgs:
  # private is built in (name Private, key PRV). An entry appears only after the owner edits it.
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

- The image bakes the git commit it was built from (`ARG MAJHI_COMMIT`, exposed as the env var `MAJHI_COMMIT`, `dev` when unknown). `make up` and the host helper pass `git rev-parse HEAD`. `/health` reports it, so a browser can tell the new server from the old one after an update. Building never needs the owner: `docker compose build` reads the same variables the Makefile exports. Docker access: macOS asks once whether OrbStack or Docker Desktop may read `~/Documents`, `~/Desktop`, `~/Downloads` and iCloud Drive; without a yes the container sees an empty folder, so the roots screen warns before saving a root there and names the runtime the helper found.
- `health.run` runs the same checks as `make doctor` (config, config folder, git, each root mounted, tasks folder, host helper, SSH agent, each git host, secrets key, each CLI version, each account from its cached health, disk space). Each failed check that majhi can fix carries a `fix` label and `health.fix` runs it: mount a root (helper remount), create a missing folder, reload SSH keys, check an account again, open an account's sign-in (the UI opens the terminal), restart the helper. A failed check with no fix says the exact step in plain words.
- Bind mount each workspace root at the **same absolute path** inside the containers, so paths match between host, agents and the owner's editor. `docker compose` cannot loop over a list, so majhi generates `docker-compose.override.yml` with one mount per root from `majhi.yaml`. The host helper regenerates it and recreates the server container whenever roots change; `make up` does the same on first start. Only roots are mounted, never the whole home folder, so agents cannot reach other credentials in it.
- Docker per OS: OrbStack or Docker Desktop on macOS, Docker Engine run as root on Linux, Docker Desktop with WSL integration on WSL2. `make up` refuses Docker Desktop for Linux and rootless Docker for now: both map container uids through a user namespace, so the owner's uid in the server lands on another uid outside, and worktrees and `~/.majhi` would stop belonging to the owner.
- Mount `~/.ssh/config` and `known_hosts` read-only. Forward an SSH agent from the host to majhi's own git only (fetching the base when a task starts, pushing after approval). The generated override adds it from `MAJHI_SSH_AGENT`, which `make up` sets per OS and the host helper keeps for remounts and updates: on macOS `/run/host-services/ssh-auth.sock`, the Mac's agent as OrbStack and Docker Desktop give it to containers, mounted at `/run/ssh-agent.sock`; on Linux and WSL2 `~/.majhi/run/ssh-agent.sock`, the host helper's forwarder (4.2), which the server already sees through the `~/.majhi` mount, so only `SSH_AUTH_SOCK` is set and the path stays the same when the agent behind it restarts; any other absolute path is mounted at `/run/ssh-agent.sock`; `off` gives none. It is never forwarded to agent runs: agents have no SSH access, which also closes the push-by-script gap in the push check, and the runner isolation check makes sure a runner cannot see `~/.majhi/run`. Private keys never enter the container. Only the **public** keys (`<IdentityFile>.pub` for every `IdentityFile` in `~/.ssh/config` and the default names, when the file exists) are bind-mounted read-only at their host paths, in the generated override next to the roots: with `IdentitiesOnly yes` OpenSSH reads the `.pub` file to choose the matching agent key when the private file is missing. A mount source without the `.pub` suffix is refused. The image adds a passwd entry for the owner's uid at start (home = the host home), because ssh will not run without one. `doctor` runs `ssh -T -o BatchMode=yes -o ConnectTimeout=5` against each ssh alias or `user@host` used by a registered project's remotes and reports reachable, auth failed or unreachable; `host.status` carries the same result (`sshHosts`) and Repos names a host that took no key. The host helper keeps the agent loaded (4.2); a key with a passphrase is unlocked once from the Repos screen and kept by the OS keyring: the macOS Keychain, or a Secret Service keyring on Linux and WSL2.
- Mount `~/.majhi` read-write.
- The host's keyring (the macOS Keychain or a Secret Service keyring) is not reachable from the containers. Login credentials live in each account's config home under `~/.majhi/accounts/<id>/`. Tracker tokens and API keys live in `secrets.age`, decrypted at startup with a key passed as a Docker secret.
- Provide a `MAJHI_RUNNER=native` option that spawns agents directly on the host instead of in the runner container, for when bind-mount performance hurts (large test suites on macOS). UI and services stay in Docker either way.
- Ship `docker-compose.yml`, a `.env.example`, and a `Makefile` or `justfile` with `up`, `down`, `logs`, `login <account>`, `doctor`.
- Healthchecks on every service. `doctor` checks: SSH agent reachable, each workspace root mounted, each account's auth, CLIs present with versions, git identity per org, disk space for worktrees.

---

## 5. Key mechanisms

### 5.1 Agent runtime (ACP)

- majhi spawns one ACP agent process per run with an explicit environment built from scratch: PATH, HOME, TMPDIR, locale, the agent's config home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), the account's API key variable if it is an API-key account (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), git identity for the org. There is no SSH agent socket: agents cannot fetch or push over SSH, and only majhi's own git uses the forwarded agent (4.5). Never pass majhi's own environment through.
- Tools live in a registry (`packages/acp/tools/`). Each entry declares: the ACP launch command, the config home variable, the API key variable, how login works, and how to detect limit errors. v1 ships Claude Code and Codex. Adding Cursor, OpenCode or another agent from the ACP Registry means adding one entry with its tests.
- **Models and effort levels are never hardcoded.** majhi reads them from the agent's ACP session config options (categories `model` and `thought_level`, plus `model_config`), caches them per account, and refreshes them when a session starts. If an agent's saved model or effort is no longer offered, majhi warns in Studio and the room and uses the agent's own default until the owner picks again.
- Working directory: the task folder `<tasks_dir>/<task-id>/`, so the agent sees every repo in the task.
- majhi is the ACP client: it creates sessions, sends prompts, streams updates to the room, and answers permission requests according to the agent's permissions (auto-allow what is permitted, ask the owner otherwise).
- Model and effort per run, highest priority first: the owner's override for this task, then the agent's fixed `model` and `effort`, then, for `auto`, the role's model and effort tiers (Hub setup, overridable per org and agent), moved at most one step by how much work the decision provider (5.12) rates the task, resolved against the newest models the account offers (or the agent's `models` list). When the rating does not count (the gate below), the role's tiers apply unchanged. majhi applies the choice with `session/set_config_option`. The chosen model and effort, and why, are posted as a room event and recorded on the run.
- Attach MCP servers per agent from its `tools` list: `serena`, `majhi-memory`, `majhi-room`, `majhi-tasks`, `majhi-projects`, `majhi-connections`, `majhi-decide` (on by default for every agent, 5.12), `majhi-processes` (on for every agent, 5.15), plus any others the owner adds.

### 5.2 Accounts, per-agent homes and skills

- A login account has one config home holding its credentials. Login runs the tool's own login inside the runner, shown in an embedded terminal (device-code or browser flow). An API-key account needs no login: its key is stored in `secrets.age` and injected only into runs on that account.
- Several agents can share an account but need different skills. Agents on one account share its config home (checked in Phase 1: a linked credential file breaks Claude's token refresh, see DECISIONS 2026-09-29), so per-agent skills reach a run through the run itself, never through a shared `.claude/skills`.
- **Skills** use the open Agent Skills format: a folder with a `SKILL.md` whose YAML frontmatter has `name` and `description`.
  - **Store.** Installed once into `~/.majhi/skills/<name>/`, with `skills-lock.json` beside them recording source, ref or commit, content hash and install time.
  - **Install.** The Vercel `skills` CLI, pinned in the runner image, runs non-interactively in a runner with a throwaway home: `skills add <source> -y --copy --agent claude-code codex [--skill <name>]`, telemetry off. Sources: `owner/repo`, repo or `tree/.../skills/<name>` URLs, other git URLs, a SKILL.md or archive URL, a folder inside a workspace root or the tasks folder, or an uploaded zip (extracted with path containment). Private repos use the org's git login. Installing is two steps: a preview (name, description, files, source) and a confirm of exactly what was previewed. Installing never enables.
  - **Per agent.** The agent file's `skills` list. Each run gets read-only copies of only its agent's enabled skills in a folder of its own, removed when the session ends, and the session's first prompt names each skill with its SKILL.md path. Changing an agent's skills restarts its open sessions when their turn ends, so the next turn has them.
  - **Browse** searches the skills.sh directory and shows each result's source repo. Update previews the change first; remove takes the skill off every agent that lists it. Every install, update, enable, disable and remove gets an audit row.
- **MCP servers** are `mcp` connections (5.14), installed from the same page: the official MCP Registry (`/v0.1/servers`, falling back to `/v0`), a remote URL (Streamable HTTP or SSE, with headers), a local command, or a pasted `mcpServers` snippet. A registry package is always pinned to a version. Fields marked secret are set through the write-only secret flow, required ones must be filled before saving, and Test runs right after and shows the tool list. Per agent, a server is turned on in the agent's `connections`, inside its own org only.
- **By message.** In a room, the owner's "@agent install this skill <link>" or "@agent add this MCP server <name or link>" gets one approval card (what, source, which agent). Approving installs it and turns it on for that agent; secrets an MCP server needs are asked for with secret requests, never in chat. The same `skills.*` and `mcp.*` commands serve the page, the room and the captain.

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

### 5.4a Parent tasks, child tasks and dependencies

- **One link model.** A task has links of three types: `parent` (it is part of a bigger task), `depends-on` (it waits for another task), and `follow-up` (created from another task, like the fix tasks of an ops task, 5.15). Links are stored in `majhi.db` and shown on both tasks.
- **Parent and child tasks.**
  - A task can have one parent. Nesting can go several levels deep.
  - Each child is a full task: its own room, team, repos, worktrees and branch.
  - The parent shows its children's progress ("3 of 5 done") and a rollup of their statuses. It moves to `done` when every child is done, unless the owner closes it earlier.
  - The owner, the captain or a lead agent can split a task into children. Agents do it through `majhi-tasks`, which follows the approval policy (5.16).
  - The task list nests children under their parent, collapsed by default.
- **Dependencies.**
  - `depends-on` points at one or more tasks. Cycles are refused when the link is made.
  - A task with an unmet dependency does not start. When the last one is met, majhi starts it automatically, subject to the concurrency limits (5.17).
  - Each link says when the dependency counts as met:
    - `merged` (default): the dependency's MRs are merged. The waiting task starts from the updated base branch.
    - `ready`: the dependency reached `review`. The waiting task stacks its branch on the dependency's working branch, and is rebased when that branch changes.
  - If a dependency is closed without finishing, the waiting task pauses with reason `owner` and asks what to do.
- **Context for agents.** `TASK.md` lists related tasks in one or two lines each: the parent and its goal, what this task waits on or builds on (with the branch), and its children. Agents do not read other tasks' rooms unless they ask for them.
- **Commands.** `tasks.link`, `tasks.unlink` and `tasks.split` are commands like any other (5.16), so the UI, the palette, the captain and agents use the same rules.

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
- **Sleep and wake:** the host helper notices a wake (a jump in wall-clock time, or macOS power events) and tells the server. Turns that failed or stalled while asleep resume on their own from the last checkpoint.
- **Shutdown and reboot:** at login the host helper makes sure Docker and majhi are running. Tasks that were running when majhi stopped reload and resume on their own.
- **Crash:** if majhi restarts, tasks that were running resume on their own from their checkpoints. If a resume fails twice, the task pauses with reason `error` and the room says why.
- **What resume means.** Files the agent changed are already on disk in the worktree, and each turn ends with a checkpoint, so no finished work is lost. A reply that was streaming is cut off, and a command that was running (for example tests) is killed; the agent is told to continue and runs it again. Auto-resume is on by default and can be turned off per org.

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

All three are normal agent files the owner can edit, swap or delete. One root agent is the captain (5.16); it can hand work to the others.

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
  - **laya:** the default. Laya open-weights model (`convaiinnovations/laya`, 421M parameters, about 850 MB). Local, free, nothing leaves the machine. On Apple silicon Macs it runs natively through the host helper with `laya-mlx`, on the GPU. On Linux, Windows and Intel Macs, or when the native one is not available, it runs in the `laya` Docker service with `laya` on PyTorch, on the CPU or with CUDA on an NVIDIA GPU. `make up` gives it the GPU when Docker can use one (the NVIDIA Container Toolkit's runtime on Linux, the Windows NVIDIA driver on WSL2) and sets `MAJHI_LAYA_GPU=nvidia`: the image then takes PyTorch's CUDA 13.0 wheels (`MAJHI_LAYA_TORCH_INDEX` picks another index, such as CUDA 12.6 for a GPU older than Turing or a driver older than 580), and the generated override reserves the GPUs for `laya` and sets `LAYA_DEVICE=cuda`. `make up LAYA_GPU=off` keeps it on the CPU. Both load on first use and unload when idle. Weak without fine-tuning, reads about 512 tokens per state (English checkpoint), and gets worse past about 20 options, so questions must stay small.
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
- Every decision records the full request, every answer's probabilities, the provider, the gate result and the outcome on the task. The decision provider is asked about the task, never about models, with described options, an abstain option and several option orders averaged. An answer counts only when it clearly beats chance and the runner-up (lift and margin, configurable in Hub setup); otherwise majhi falls back to rules or the role's tiers. The owner can mark a wrong pick, which builds the labeled set for tuning.
- Token receipts show which decisions replaced LLM calls, so the savings can be measured.

### 5.13 Context budget and compaction

No agent session may keep growing until its window is full. Every session has a budget, and majhi compacts it before it gets expensive.

- **Signal.** majhi reads ACP `usage_update` (`used` and `size`) for every session. Both adapters send it today (`claude-agent-acp`, `codex-acp`). Gate on this provider-reported number, not on a byte estimate. If an agent sends no usage, estimate from majhi's own token counts and label the number as estimated.
- **Cap.** `context.cap` is the most tokens a session may use, whatever the model's window (default 200000; 0 is no cap). It merges majhi, org, agent like `compact_at`. `size` below is the cap when it is smaller than the window. Inside a turn the CLI enforces it where it can (see DECISIONS.md, PRV-47); majhi's own compaction runs between turns.
- **Threshold.** Compact when `used / size` reaches `compact_at` (default 0.8) of the cap. The default lives in `majhi.yaml`, orgs can override it, and agents can override their org. The check runs at the end of every turn and before sending any new prompt: if the last reading plus the size of the prompt about to be sent crosses the threshold, compact first.
- **How to compact, in order:**
  1. **Native compaction.** If the agent advertises a `compact` slash command over ACP (Claude Code and Codex both do today), majhi sends it with a short note on what to keep: the task, key decisions, remaining work, files touched, and the next step. The session stays the same, so the agent does not re-read anything. majhi then waits for the next `usage_update` and checks that usage fell below `compact_target` (default 0.4).
  2. **Handoff to a fresh session.** If native compaction is missing, fails, or leaves usage above the target, majhi asks the agent for a handoff note with a fixed template: original task, what is done, key decisions, remaining work, files touched, one concrete next step. The note is saved to `<task>/.handoffs/<agent>-<n>.md`. majhi closes the session and opens a new one with, in this order: the stable prefix (instructions, TASK.md header), TASK.md, the handoff note, a short room summary, the current diff stat, then the pending prompt verbatim. The agent is told to continue silently from where it left off.
  3. **Note built by majhi.** If the agent cannot write the note (the session is broken or already over the window), majhi builds it from durable state without calling a model: TASK.md, the last checkpoint, the room since that checkpoint (newest first, within a fixed budget), and the diff.
- **Rotation without pressure.** A session is also replaced by a fresh one (same handoff path) after `max_turns` turns (default 40, 0 turns it off), and whenever the owner clicks "Fresh session" on an agent in the room.
- **Turn limits.** One turn may run at most `turns.max_length` (default 2h), go at most `turns.idle` (default 25m) without output or tool activity, and optionally make at most `turns.max_tool_calls` tool calls (default 0, off). Orgs and agents override each field; `off` turns a duration off. A running `wait` process of the agent, or a permission prompt waiting for the owner, is not idleness, and no limit fires while such a prompt waits. A turn over a limit is cancelled, checkpointed and handed off (the agent writes the note within 5 minutes, except after an idle stop, when majhi builds it), and a fresh session continues with "Continue from the handoff note." The room shows one quiet line, like "@builder reached the 2 hour turn limit. Continued in a fresh session with a handoff note." When a task hits a limit 3 times in a row with no new commit in any of its worktrees, it pauses with reason `error` instead. The live agent row shows how long the current turn has run. Settings in Hub setup, Turns.
- **Reactive recovery.** A stop reason of `max_tokens` or `max_turn_requests`, or a context-window error from the agent, triggers the handoff path at once, using the note built by majhi. At most 2 compactions per turn (the cap is per turn, not per session). After that the run pauses with reason `error` and the room says why. The cap counts majhi's own compactions only, not the CLI's below.
- **The CLI's own compaction.** Inside a turn the CLI compacts on its own at the window majhi gave it at launch (Cap above). majhi did not ask, so it watches for it (PRV-103): first the adapter's report, a "Compact conversation" tool call that both adapters send to a client without ACP's compaction capability (Claude's carries the trigger and the tokens before and after; Codex's carries neither, so the size after is the next `usage_update`); else a sharp fall between two `usage_update`s of one session (under 60% of the reading before, and at least 20k tokens less) that majhi did not cause. Either one is recorded once, as method `auto`, with before and after when known, and posts the room's context line. Reports while majhi compacts itself, and Claude's `manual` ones, are majhi's or the owner's `/compact`, not counted again.
- **What is not carried over.** Old tool output and whole file contents. Agents re-read what they need, preferably through Serena at symbol level.
- **Budgets for what majhi adds.** Everything majhi puts into a context has a cap: handoff prompts, `majhi-room.read_recent` (last N messages, long ones trimmed in the middle with a marker), `majhi-memory.recall` (about 500 tokens), attachment summaries. Images count as a fixed token cost in estimates.
- **Visibility.** Each agent shows a context meter (used of size) on its avatar in the room and in the Context tab. Each compaction posts a room event, for example `@globex-builder compacted: 164k to 18k tokens (native)`, or `(auto)` for one the CLI did on its own, and is recorded on the run and in the token receipts of the task and the agent. majhi does not advertise ACP's compaction capability (unstable in ACP today): with it, claude-agent-acp keeps the token counts for JetBrains AIR only, while the tool call majhi gets without it carries them.
- **Tests.** A fake ACP agent that reports rising usage: compaction fires at the threshold, falls back to a handoff when `compact` is missing or does not reduce usage, respects the per-turn cap, and rotates after `max_turns`. The same fake compacts on its own inside a turn, with and without a report, and majhi records it once.

### 5.14 Connections

Connections give agents access to the systems the owner debugs and reports on: clusters, observability, mail, servers, cloud accounts.

- **Types** are registry entries, like tools, so new ones are cheap to add:
  - `kubectl`: a kubeconfig, one context, a default namespace.
  - `mcp`: any MCP server, local command or remote URL, with auth from `secrets.age`. For example New Relic's official remote server (`mcp.newrelic.com/mcp`).
  - `ssh`: a host alias from `~/.ssh/config`. Agent runs get no SSH agent socket (4.5); giving a run that holds an `ssh` connection its own access is decided when connections are built.
  - `env`: any number of named values for CLIs and APIs such as `aws`, `gcloud`, `psql`, OpenRouter or a video API. One connection can hold several, for example `API_KEY`, `USER_ID` and `ORG_ID` for one service.
  - `browser`: a browser the agent drives through a browser MCP server (Playwright or Chrome DevTools), with its own profile per connection, so each org's logins stay separate. Used for research and checking results; posting goes through platform APIs where they exist.
  - `mail`: an IMAP and SMTP account, or a mail MCP server.
- **Fields.** Every connection type declares its fields, and each field has a kind:
  - `secret`: stored in `secrets.age`, entered once through a secure input, never shown again.
  - `text`: a plain value such as a user id, org id, region or endpoint URL. Stored in `majhi.yaml`, visible and editable.
  - `file`: a file such as a kubeconfig or a service-account JSON, stored in `~/.majhi/connections/<id>/`. The run gets its path in a named variable (for example `GOOGLE_APPLICATION_CREDENTIALS`).
  Each field maps to the variable name the tool expects. The `env` type lets the owner add any fields they need and pick the kind of each.
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
- **Media and pages from agents.** Agents show the owner things by saving them in the task folder and linking them in a message with markdown (`![chart](media/chart.png)`, `[report](media/report.html)`), or by sending ACP image content. The room renders images, video and audio inline, and shows pages, PDFs and other files as cards that open in a new browser tab. Web links are clickable. Task files are served only from inside the task folder, and HTML runs sandboxed in its own origin, so an agent's page cannot call majhi's API. The generated `AGENTS.md` tells agents how to do this.
- **Background processes.** Quick commands run in the agent's own shell. Anything slow or long-running (test suites, builds, dev servers, watchers) the agent starts through the `majhi-processes` MCP tool (`start`, `list`, `output`, `stop`, `restart`), so majhi owns the process. The ACP adapters majhi ships do not use client terminals, so majhi does not rely on them (DECISIONS.md, 2026-09-30). A process runs with the session's environment and mounts, in a folder inside the task folder. With `wait` (the default), when it exits by itself majhi wakes the agent that started it with the exit code and the last lines of output, and a task in review runs again; while it runs, the task stays running and the room shows "Waiting for" it. `wait: false` is for servers and watchers. Processes show in a Processes card in the task view: name, command, running time, port, output tail, and a Stop button or the exit code. Agents are told what is already running so they do not start a second copy. Stopping or closing the task stops its processes; at most 5 run at once per task.
- **CLI parity.** Slash commands the agent advertises over ACP work from the composer. `@file` mentions autocomplete from the task's worktrees. Pasted images and files attach. Any past session can be resumed. An embedded terminal opens in the task folder, and any file path opens in the owner's editor.

#### Containers for agents

Agents run without Docker on purpose (the socket is root on the host). When they need containers (to build and try a branch of majhi itself, or a database for tests), majhi runs them from a short list of actions, never a raw socket. The `majhi-containers` MCP tool (on for every session when majhi runs in Docker) has `preview_build`, `preview_run`, `preview_stop`, `service_start`, `service_stop`, `list` and `logs`. The captain and the Hub have the same actions as `containers.*` commands.

- **Preview.** `preview_build` builds a repo's Dockerfile as `majhi-preview-<task>` on the task's own BuildKit builder, as a process that wakes the agent when it ends. `preview_run` runs it with a throwaway folder and nothing of the host, on the runner network, with one port on `127.0.0.1` for the owner's link.
- **Services.** `service_start` runs an allowed image (postgres, redis) on a per-task internal network that only that task's runners join, with only named volumes majhi creates for the task. A port is never published.
- **Images.** A new image asks the owner once through an approval card (`containers.images.allow`), and PRV-49's always-allow rules apply. `settings.get` lists the allowed images.
- **Limits.** `containers` in `majhi.yaml`: `cpus`, `memory`, `per_task`, `build_cpus`, `build_memory`.
- **Processes.** Each container is a majhi process: the Processes card, `majhi-processes output`, Stop and waking the agent work as for any process.
- **Cleanup.** Stopping a task removes its containers and network and keeps its volumes. Done or removed also removes the volumes, the builder and the preview image. majhi removes leftovers at start.

### 5.16 The captain and the control plane

The owner can run majhi by talking to one agent. The captain sets things up, changes them, runs tasks and debugs, the way the owner would use a CLI agent today, but with access to all of majhi.

- **One control plane.** Every change is a typed command with zod input and output, defined in `packages/shared/commands` and handled in majhi. Examples: create an org, clone a repo into a root and register it, add an account, start a login, create or remove an agent, set a limit, create a task, stop an agent. The UI, the palette, the captain and the tests all call the same commands. A feature is not done until its commands exist. There are no UI-only or file-only features.
- **Who the captain is.** `boss: <agent-id>` in `majhi.yaml`, by default a root agent on the owner's private account. The owner can make any root agent the captain, in Studio or by asking the current captain. The captain is always one keystroke away (Cmd J opens the Captain panel from any screen). The panel holds one thread per workspace and an "All" view (5.18); those threads are not tasks, never show in Chats or on the Board, and cannot be deleted ("Start fresh" clears one and keeps a summary). A topic chat the owner starts with the captain is an ordinary `chat` task. The captain has its own run slot, outside "agents at once" and "per account", so the owner's message is answered in seconds; its spend still counts against the autonomous budget and the account floors.
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
  - `change` (reversible config, for example creating an agent or raising a limit): runs when the owner asked for it in the conversation. If the captain decides to do it on its own, it proposes and waits for a click.
  - `destructive` (remove an agent, org or project, delete a worktree, forget memory, move folders) and `outbound` (push, MR, merge, send mail, connection writes, sending data to a hosted service): always a confirm card in the chat, approved with one click.
  - The owner can change the policy per class or per command, also by asking the captain. Changing the policy is itself `destructive`.
- **History and undo.** `~/.majhi` is a git repository. Every command that changes a file commits it, recording who (owner, captain or which agent), which command, and why. Undo reverts that commit. Studio shows the history. Credentials, databases and caches are git-ignored.
- **Secrets never pass through a model.** When the owner pastes something that looks like a secret into any chat, the composer offers "Save as secret" and the agent only receives a reference such as `secret:newrelic-globex`. When the captain needs a secret, it asks for it through a secure input card that the UI renders, never as chat text.
- **Live changes.** Config changes apply without a restart (file watchers and in-memory registries). The only exception is adding or removing a workspace root, because Docker mounts are fixed at start. The captain says so and shows the command.

### 5.18 Autonomous mode and the captain's authority

The captain works like a chief of staff: the owner gives it a budget and authority per workspace, sees only the decisions that need them, and keeps one switch. The proposal and its reasons are in `docs/briefs/captain-chief-of-staff.md` (approved 2026-10-04).

**One switch: Autonomous, On or Off,** in the sidebar and on the Captain page.

- **On:** the captain acts by itself in each workspace, within that workspace's authority and budget.
- **Off:** it acts only when the owner talks to it. It starts nothing, ships nothing and answers no cards by itself.
- **Turning off** pauses the tasks it started, right away (default); the owner can choose "Let them finish their current step" instead. Nothing it started is lost.
- **Turning on** lists the tasks it paused and resumes them, with a checkbox to leave them paused.
- The captain itself is never stopped: the owner can always talk to it.

**Authority per workspace,** a table read as a delegation policy, each row "Captain decides" or "Ask me": pick and start work from the backlog, answer agents' questions, answer routine approval cards, upkeep, merge into the base branch, push and open merge requests. New client workspaces start with every row on "Ask me" except upkeep. While Autonomous is Off every row behaves as "Ask me". The never list below is not a row and always holds.

**Budgets.** An autonomous budget per day for all autonomous work (the captain's own turns and every task it starts or resumes), required while Autonomous is On. An optional workspace budget per day inside it; empty means the workspace shares the whole autonomous budget. Account floors and weekly budgets stay, on the same Limits screen under "Safety". When a budget runs out the captain asks as a decision ("Pyzasoft used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?"), and a held task names the budget that holds it.

**Decisions.** Everything that waits for the owner is a decision in one inbox, with the captain's recommendation and one-click answers. The bell opens it. Alerts go out only for decisions.

**Workspaces never collide.** One session per workspace ("lane"), reading and acting in its own workspace only. While Autonomous is On the agent slots are split evenly across the workspaces with runnable work; a workspace with nothing to run leaves its share to the others, and the owner's own tasks come first. Workspaces that share an account take its per-account slots and floors in turn. The captain never runs two tasks that write to the same repo and base branch at once unless their plans touch different areas, and ships into one base branch one at a time, in order.

**Staffing.** For each task the captain weighs the task's size and kind, every agent that may work in the workspace (role, skills, model, effort), each account's free slots and usage left, floors and budgets, expected cost, past results on similar work in the repo, and the repo rule, with no built-in preference. It picks the team that does the work best, from one agent to a lead with builders and a reviewer, and says why in one line. Another workspace's agents and accounts are never considered.

**Lead handover.** The lead, the captain or the owner can make another team member the lead (`tasks.setLead`): when the lead's account is at its limit, the task needs another skill or model, or the lead is stuck. The new lead must be on the team or able to join it; the old lead stays as a builder or leaves. A handover note in the room carries the plan, what is done and what is next.

**Labels.** Every captain action is labelled "Captain", never "You", in rooms, cards and the log, with its reason and Undo where Undo exists.

**Daily summary** at 08:00 by default, changeable on the Captain page: what shipped, spend per workspace against its budget, what waits on the owner, and what the captain plans next.

**Upkeep.** Short runs at fixed moments, never a captain that stays awake:

| Chore | When it runs | What the captain does |
|---|---|---|
| Ship finished work | A task reaches review and its checks pass | Merge and push "Captain decides": ships by the workspace's ship rule. "Ask me": asks. |
| Approval cards | A card arrives | Answers routine ones by the workspace's Approvals rules. Risky ones and the never list go to the owner. |
| Agents' questions | An agent asks | Answers from the brief, memory or code. Real choices go to the owner. |
| Memory | Daily, and when 10 memories wait for review in a workspace (at most four runs a day) | Keeps, merges and drops waiting memories, all of them in one run. Private also reviews global memories; a client workspace never sees them. Asks about doubtful ones. |
| Projects | A new repo appears, and daily | Registers it in the right workspace with base and remotes. Asks when unsure. Never touches protected repos. |
| Task triage | Daily | Sets priority and due dates, marks duplicates and stale tasks. Suggests closing; never closes. |
| Cleanup | Daily | Removes worktrees and containers of done tasks. Never removes uncommitted work. |
| Stuck tasks | Nobody works and nothing is pending | Wakes the lead once, then tells the owner (5.3). |

**One captain, one conversation per workspace.** There is only the owner's captain. It keeps a separate session per workspace ("lane"), so one client's code and details are never in its context while it decides for another. Lanes share only the owner's global instructions and counts, never content.

**Rules that always hold** (never shown as settings):

- **The never list:** no force push, no deleting uncommitted work, no moving one workspace's secrets, accounts or logins to another, no change to a protected repo, no secret in a diff that ships.
- **The stricter rule wins:** never list, then protected repo, then the workspace's choice, then the global default. A standing instruction can tighten a rule, never loosen it.
- **Time never approves anything.** What needs the owner waits, with one reminder a day.
- **Presence:** while the owner is typing in a task, the captain waits until they send or leave. Otherwise it acts within its authority, and the owner overrules with Undo.
- **Re-check before anything that cannot be undone.** The rules are read again right before a push, merge, request or post, so a change the owner made a second ago applies.
- **Text is not instruction.** Words in repos, issues, attachments or messages never authorise an action; checks and the owner's rules do.

**No runaway, no loops** (structural, proven by a soak test):

- Every run has a hard cap on actions, tokens and minutes, and stops at the cap with a line in the log.
- Events record who caused them. The captain's own actions never start an upkeep run.
- One run per chore per workspace at a time. A trigger during a run joins it.
- Every action checks the current state first, so running it twice changes nothing.
- Two failures in a row turn that chore off for the workspace and tell the owner.
- Daily caps per chore and workspace (for example five ships, four memory runs).
- The captain's lane rests when its budget or its account's window runs out; rules and Laya keep routine upkeep moving, judgment calls wait.
- The Autonomous switch turns every lane's own action off at once and pauses the tasks it started.
- A soak test with the fake agent replays hours of events (restarts, failures, bursts of cards, the captain's own ships) and fails if a run passes its caps, an event re-triggers itself, or an action repeats. It runs on every merge.

**What the owner notices:** the bell for what needs them, one daily summary line per workspace ("Acme: shipped 2, tidied 8 memories, 1 thing for you"), and the captain's log with each action's reason, evidence and Undo where Undo is possible (a merge undoes as a revert commit; a push cannot be undone, which is why the captain pushes only after checks pass).

### 5.17 Performance and resource use

- **Agents on demand.** Agent processes start when a run needs them and stop after `idle_timeout` (default 10 minutes). Sessions come back with ACP `session/resume` or `session/load`.
- **Concurrency limits.** A global maximum of running agent processes (`agents_max`, default 6), a maximum per account, and a maximum per task. Extra runs wait in the jobs table and show as queued, with their place in line.
- **Budgets.** Optional token or cost budgets per account, org and task, per day. At the budget, runs pause with reason `limit`. The owner or the captain can raise them.
- **Models load lazily.** Laya and the embedding model load on first use and unload after idle. Docker memory limits cap each service.
- **Server.** SQLite in WAL mode with prepared statements, bounded caches, streaming with backpressure, repo scans cached and refreshed by file watchers. The UI pages and virtualizes long rooms and lists.
- **Configurable.** Every limit lives in `majhi.yaml` under `limits` and can be changed live, by hand, in Studio, or by the captain.
- **Targets**, measured in Phase 9: task switch under 100 ms, room updates on screen under 50 ms after the server receives them, server memory under 200 MB with no agents running.

---

## 6. Security

- Per-run environment built from scratch (5.1). An org's agent never gets another org's credentials, unless the owner explicitly allows that agent to work in the other org. Show a warning in the editor when they do.
- Private SSH keys stay on the host. Only the agent socket is forwarded, and only to majhi's own git, never to agent runs. A key's passphrase is typed into majhi once, goes to the host helper over localhost, and ends in the OS keyring (the macOS Keychain or a Secret Service keyring; with none, it is kept nowhere); majhi never writes it to its own files or logs.
- Tracker tokens encrypted at rest (`secrets.age`).
- Anything read from attachments, links, tracker items or repos is data, not instructions. Wrap it as such in prompts.
- majhi binds to `127.0.0.1` only by default.
- Log every push, MR, merge and permission decision in an audit table.
- Connection secrets follow the same rules as API keys. Write actions through a connection ask the owner unless the org policy allows that exact action (5.14).
- API keys are injected only into runs on the account they belong to, never logged, and never written to TASK.md or the room.
- The Jev decision provider sends task text to a hosted API. It is off by default and must be enabled by the owner.
- Config changes and folder moves follow the captain's approval policy (5.16). Every change is a commit in `~/.majhi`, and every approval is logged in the audit table.
- Secrets pasted into a chat are stored in `secrets.age` and replaced with a reference before any agent sees them (5.16)
- Containers majhi runs for agents (5.15) never get a bind mount, the Docker socket, `~/.majhi`, the secrets key or `~/.ssh`: every docker call is built by majhi from checked values and refused unless each flag is on an allow list.

---

## 7. Build plan

Build in phases. Each phase ends with working software, tests, and a short demo note in `docs/PROGRESS.md`. Stop at the end of each phase for the owner to review before starting the next.

Every phase exposes its features as commands (5.16). From Phase 2 on, a phase is only done when the captain can do everything that phase adds to the UI.

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
- Onboarding steps 2 and 3 (3.6): first account and choosing the captain.
- **Done when:** a fresh install walks through onboarding to a created captain agent whose health check passes; the owner can add two Claude accounts for one org and three agents on them from the UI, add one API-key account, and each agent's health check passes.

### Phase 2: One agent, one repo, end to end

Delivered in two parts, each usable and reviewed on its own.

#### Phase 2a: Working with one agent
- Projects: register repos from the repos screen with an org and aliases (`projects.*` commands). Task keys per org (`GLX-420`), `LOCAL-n` for tasks without an org.
- Task store in SQLite (`majhi.db`, Drizzle over better-sqlite3): tasks, task repos, task links, room items, runs.
- Task box with live parsing, task creation, worktree creation, TASK.md generation. Task links from 5.4a are in the data model from the start (UI in 2b).
- ACP run engine: spawning with a clean environment, model and effort applied, streaming to the room, resume with `session/load`.
- Room UI with streaming messages, plan, tool calls, diffs, "now doing" status, permission prompts, attachments (images, files, links).
- Live control from 5.15: Esc to stop a turn, Stop all, queue or interrupt with a new message, inline permission prompts, slash commands, `@file` mentions. Task kind `chat`.
- **Done when:** "add a health endpoint to api from develop" produces a working branch in a worktree, with the whole run visible in the room, stoppable with Esc, and a `chat` task works like opening the agent's CLI.

#### Phase 2b: The captain and staying cheap
- Context budget from 5.13: usage meter per agent, native compaction at the threshold, handoff to a fresh session, `max_turns` rotation.
- The captain (5.16): chat with Cmd J, `majhi-admin` with every command built so far, the approval policy, undo, and secret capture. Onboarding step 4: the captain finishes setup as a conversation (orgs, projects, more accounts and agents).
- Task links UI from 5.4a: parent and child tasks (created by the owner), nested in the task list with progress, and manual `depends-on` links with the "Waiting on" chip. Related tasks listed in TASK.md.
- Agents on demand and concurrency limits (5.17). The two-agents-on-one-account token refresh check from 5.2.
- Decision provider (5.12), built alongside the run manager work: Laya natively on Apple silicon (`laya-mlx` in a private Python environment the host helper installs, with the model downloaded once and a local decision service), Jev (off until the owner adds a key), the ACP simulation and rules, in a fallback chain with every decision recorded. The `majhi-decide` MCP tool for every agent. Model and effort picking for `auto` agents at session start. A Decisions section in Hub setup: provider order, Laya status, an "Ask the decision model" box and recent decisions. Laya in Docker for Linux and Windows comes later.
- Resume after sleep, shutdown, reboot, lost internet and crashes (5.7), without the owner clicking anything: checkpoints after every turn, wake and offline detection, auto-restart at login, auto-resume from the checkpoint. Limit handling and fallback handoff stay in Phase 8.
- No manual work outside majhi (principles): "Update ready" when the code on disk is newer than the running image, and the host helper rebuilds and restarts majhi on one click; a Health view in the UI with every `doctor` check and a Fix button where majhi can fix it; a warning before mounting a macOS-protected folder (Documents, Desktop, Downloads) that a system prompt will appear and must be allowed.
- **Done when:** a fake agent pushed past 80% context gets compacted with the event shown in the room; the captain creates an org and an agent after the owner approves; and a running task resumes on its own after the network drops and returns, and after majhi restarts, with its work intact; an `auto` agent gets a model and effort picked by Laya with the decision recorded on the run, and with Laya stopped the chain falls back to the ACP simulation, then rules.

#### Phase 2c: Tokens, cost and runner isolation
- Record every turn: input, output, reasoning, cache read and cache write tokens (from ACP's cumulative session usage, stored as per-turn deltas), cost, model, and the task, agent, account, org, project and time. API-key accounts show real cost; subscription accounts show the equivalent API cost, labelled estimated; tools that report no cost get an estimate from an owner-editable price table per model.
- A "Tokens and cost" section on the Health and usage page: totals for today, this week and this month, filters by org, project, agent, account and model, a daily chart and the top tasks. Each task shows its total in the task view; org cards show theirs.
- Commands `usage.summary` and `usage.breakdown`, so the captain can answer questions like "what did Acme cost this week?"
- Runner isolation (4.2, 6): agents run in a separate runner container, not in majhi's own. Each run mounts only its task folder (with its worktrees) and its account's config home, never `~/.majhi`, the secrets key, other accounts' homes or other orgs' files. Secrets and connection values reach a run only through its environment. The runner has the dev toolchain (pnpm, build tools, Playwright).
- Desktop notifications when a task needs the owner (review, permission prompt, limit, failed run), with per-event settings.
- Backups: the secrets key kept in the OS keyring (the macOS Keychain or a Secret Service keyring) with a passphrase-protected export; a daily snapshot of `majhi.db` kept for 7 days, with restore.
- **Done when:** after a few runs on two orgs, the page shows correct totals per org, project, agent and model that match the sum of the recorded turns, and the captain answers a cost question from the same data; and an agent run cannot read `~/.majhi`, the secrets key or another account's home.

### Phase 3: Teams, rooms and decisions
- @mention routing, handoff prompts, `majhi-room` MCP server, the three coordination modes, loop guards, worktree locks.
- Team editing in the room: add, remove, swap agent, change model.
- `majhi-tasks` MCP tool: a lead splits a task into children and adds dependencies. Waiting tasks start on their own when their dependencies are met. `ready` dependencies with stacked branches.
- Decisions in teams: choosing the default team for a new task, and whether an agent message needs the owner, with the decision provider from Phase 2b. Laya in Docker (`laya`, PyTorch CPU) for Linux and Windows.
- Lead orchestration: a lead (or the captain) given a parent task drives it to the end without the owner: it splits the work into child tasks, is told when a child finishes, reviews what was delivered, starts the next child, and reports when the parent is done. Approvals for destructive and outbound actions still wait for the owner.
- The lead chooses the cheapest way to staff a task, and says why. `TASK.md` of a lead-mode task carries "Team facts", rewritten each time majhi wakes the lead: each member's role, model, price tier, effort and account with what is left of its 5-hour and weekly windows, the org's other agents that could join, the other running tasks with the files they touch, and up to three recent plans with the tokens each agent used. A short block goes into the wake prompt only when those facts changed. A lead working alone also gets `majhi-room`, so it can bring in agents that could join. The lead states its plan in its first reply and records it with the `majhi-room` `record_plan` tool (lead only): the room shows a plan line, and majhi keeps each version on the task (`task_plans`). When the task reaches review or done, majhi stores on each version the tokens each agent used from that version to the next, subtasks included, and posts one line for the latest. The owner can reply to change the plan, and the lead records the new one.
- Background processes from 5.15: the Processes card, Stop by the owner or the agent, cleanup with the task.
- Task ids mentioned in any message (`PRV-15`) are links that open the task's details in a drawer.
- **Done when:** lead, builder and reviewer on different tools complete a task together, and the reviewer catching an issue causes a fix round; a new task gets its default team picked by the decision provider, with the decision recorded.

### Phase 4: Multi-repo and MRs
- Multiple task repos, merge order from links, pushing via SSH aliases, MRs on GitHub, GitLab and Bitbucket with sibling links, merge policies.
- Changes tab with per-repo diffs.
- `merged` dependencies (5.4a): a waiting task starts when its dependency's MRs are merged.
- Full-text search across rooms; review comments on lines in the Changes view sent to the agent as one review; open files and worktrees in the owner's editor; an embedded terminal in the task folder.
- **Done when:** one task changes two repos on two different hosts and ends with two linked MRs merged in order.


### Phase 5: Memory
- Memory store, local embeddings, `majhi-memory` MCP server, recall into TASK.md, Housekeeper proposals, approval flow, promotion to AGENTS.md, Studio Memory tab.
- **Done when:** a fact learned in one task is approved and then recalled in a later task in the same repo.


### Phase 6: Skills and MCP servers
- Install skills from a link, registry name, zip or folder via the skills CLI. Per-agent enablement. Installing by message in a room ("@agent install this skill <link>", "@agent add this MCP server <name>").
- MCP servers on the same Skills & MCP page, installed as Phase 10 `mcp` connections from the MCP Registry, a URL, a command or a pasted snippet (5.2).
- **Done when:** a skill sent in a room is installed, enabled for that agent, and used in its next run. An MCP server picked from the registry or pasted as a URL is installed as a connection, passes Test, is enabled for one agent, and its tools are available in that agent's next run.


### Phase 7: Resilience and health
- Limit detection per CLI, fallback handoff, auto-resume at reset, context-window error recovery (5.13). (Checkpoints and resume after sleep, shutdown, offline and crashes arrive in Phase 2b.)
- Usage meters and health in Studio and the top bar.
- **Done when:** unplugging the network mid-run pauses the task, and plugging it back resumes it from the checkpoint with no lost work. A simulated limit error hands off to the fallback.


### Phase 8: Root agents
- Setup, Dispatcher and Housekeeper shipped as default agent files (the captain can hand setup work to Setup). `majhi-projects` MCP tool with the proposal and approval flow for config edits and folder moves. The Dispatcher routes new tasks to an org, repos and team with the decision provider.
- Cleanup of done tasks: worktrees, merged task branches and old room logs after N days, previewed and approved.
- **Done when:** Setup drafts a working config on a fresh machine, a root agent moves a project after approval without breaking its worktrees, and the Dispatcher routes a new task with its decision recorded.

### Phase 9: Token receipts and polish
- Token receipts per task and agent, Serena wiring, tool gating per role, cache-friendly prompts.
- Command palette complete, keyboard shortcuts, performance pass against the targets in 5.17.
- Budgets per org and account with alerts at 80% and 100%; an audit log page; optional phone access on the local network (off by default, with a login).
- **Done when:** receipts show where tokens go, and the owner can run a full day of work without touching a terminal.


### Phase 10: Connections and ops tasks
- Connection registry (`kubectl`, `mcp`, `ssh`, `env`, `mail`, `browser`) with typed fields, Connections page with Test, per-run injection, `majhi-connections` MCP tool.
- Permission gate for connection writes, audit log.
- Task kind `ops`, `REPORT.md` and the Report tab; agents create linked fix tasks through `majhi-tasks`.
- **Done when:** asked "why is the api down in prod", a root agent investigates with a read-only kubectl connection and New Relic, streams what it is doing, can be stopped midway and resumed, writes a report, and proposes a fix task and a restart that both wait for approval. An org agent cannot use another org's connection.

### Phase 11: Trackers
- Jira, ClickUp and GitHub Issues adapters, per org. Items flow into the board through the Dispatcher; push a local task to a tracker; MR links and status written back.
- **Done when:** a Jira item flows into a room and gets its MR link written back, and a local task pushed to ClickUp stays in sync.

### Phase 12: Creative and marketing
- Work without a repo for marketing projects, using `ops` tasks and the task folder for drafts and assets.
- Media in the room: images and videos render inline, with Approve, Redo and Edit.
- Tools in the runner image for media: ffmpeg, Remotion. Video and image generation APIs (for example Higgsfield) as `env` connections per org.
- `browser` connections per org for research and checking results. Social platforms (Meta, X, LinkedIn, TikTok) as connections using their official APIs. Every public post is an outbound action with an approve card showing the exact post.
- Scheduled and recurring tasks (for example "post three times a week"), which create tasks on a schedule.
- **Done when:** a task for a project produces a short captioned video and three post drafts in the room, the owner approves one, it is scheduled, and it posts through the platform API at the set time.

### Phase 13: The captain per workspace
- The chief-of-staff model (5.18, `docs/briefs/captain-chief-of-staff.md`), built in its eight steps: the captain's own slot and labels, one switch, the authority table, budgets, the Decisions inbox, collision rules, staffing and lead handover, the Captain panel threads, the presence rule and the summary.
- Captain lanes (one session per workspace), the upkeep chores, the never list and the rules in 5.18.
- The runaway and loop guards and the soak test.
- The daily summary line per workspace and the captain's log with Undo.
- **Done when:** with Autonomous On, Private's rows on "Captain decides" and a client's on "Ask me", a simulated night ships Private's ready work within its budget, touches nothing of the client's, and the soak test passes.

---

## 8. Open questions for the owner

Ask these when the phase that needs them starts, not before.

1. Commit history on merge: keep WIP commits, squash per repo, or rewrite into clean commits? (Phase 4)
2. Auto-handoff on limits: allowed by default for all orgs, or opt-in per org? (Phase 7)
3. Which languages need Serena language servers in the runner image? (Phase 9)
4. Should majhi ever be reachable from a phone on the local network? (Default: no.)
5. Which mail provider does each org use (Gmail, Outlook, plain IMAP)? (Phase 10)
