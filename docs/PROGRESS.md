# Progress

## Phase 2a: Working with one agent (built, waiting for owner review)

Branch `phase-2a`, from `phase-1-accounts`. The plan below is kept for reference; the result comes first.

### What works

- **Register a project** from Repos: pick the org, a project id, aliases and an optional base branch. Projects live in `majhi.yaml`.
- **Task box** on the home screen. "add a health endpoint to api from develop" shows chips (`api: from develop`, the agent, the kind) before anything starts. `@agent` picks the agent, a kind chip switches code and chat, files and images can be attached, links are fetched once. Start (or Cmd+Enter) creates the task and its folder `<tasks_dir>/<KEY>/` with `TASK.md`, `AGENTS.md` and `CLAUDE.md`, a git worktree at `<KEY>/<project>` on `task/<key>-<slug>` from the base branch, and starts the agent. A failed fetch is a warning in the room; the task starts from the local copy. Nothing is ever pushed.
- **Room**: the owner's text, the plan pinned while it has open entries, streamed agent text as markdown, tool rows that expand to their output or diff, permission prompts inline, system lines, a composer with Enter to queue, Cmd+Enter to stop and send, Esc to stop, slash commands and `@file`, attachments.
- **Permissions**: reads always pass, `edit` and `shell` on the agent cover edits and commands, everything else asks. "Allow for this task" is remembered per task and tool kind. Pushes and MR commands always ask.
- **Stop and queue**: Esc cancels the turn. A message queued while the agent worked stays queued until the next send.
- **Changes tab**: per repo the branch and worktree path, and the files the agent touched, with diffs.
- **Remove a task**: refused with the reason when a worktree has uncommitted changes; "Remove anyway" removes the worktree and the folder.
- **Markdown** in agent text: paragraphs, headings, bold, italic, inline code, fenced code (an unclosed fence renders as code while it streams), lists, quotes, rules, links. Built as React elements; no HTML is ever injected.
- **Media**: agents show images, video, audio and pages by saving them in the task folder and linking them (`![chart](media/chart.png)`, `[report](media/report.html)`). Images render inline at most 480 px wide and open full size on click (Esc closes), video and audio get controls, pages and other files are compact cards that open in a new tab. Image blocks and links an agent sends over ACP are saved under `<task>/media/` and shown with the message. `GET /api/tasks/<id>/files/<path>` serves the task folder: no dot names, no path outside the folder (symlinks included), Range for video and audio, `nosniff`, `no-store`. Pages and SVG carry `Content-Security-Policy: sandbox allow-scripts ...`, so they run in an opaque origin and their requests to `/api/cmd` carry `Origin: null` and are refused. `AGENTS.md` tells agents how to use this.

- **SSH keys, no terminal.** The host helper loads the Mac's SSH keys into its agent at login, after every wake from sleep, when a fetch fails for lack of SSH access (then the fetch is retried once), and on "Check again": Apple's `ssh-add --apple-load-keychain` first, then each key without a passphrase that `~/.ssh/config` or the default names point to. A key with a passphrase shows on Repos as an "Unlock SSH key" card (password field, Unlock); the passphrase goes browser to server to helper over localhost, into `ssh-add --apple-use-keychain` through a throwaway askpass file, and the Keychain keeps it. majhi never stores or logs it. The card also offers the terminal command under "or run it yourself", and `doctor` prints it. With SSH working, Repos shows nothing.
- **Public keys in the container.** `make up` and every remount mount `<IdentityFile>.pub` read-only (never a private key), so `IdentitiesOnly yes` aliases like `gitlab-ashik112` offer the right agent key. The image now adds a passwd entry for the owner's uid, without which ssh could not start at all. `doctor` and Repos check each git host the registered projects use (reachable, auth failed, unreachable). The running container needs a `make up` to pick up the mounts and the new image.
- **Agents have no SSH.** Agent runs no longer get `SSH_AUTH_SOCK`. Only majhi's own git uses it (fetching the base at task start, pushes in Phase 5). `AGENTS.md` says so: to fetch or pull, ask the owner in the room.

### How to try it

1. `make up`, open http://127.0.0.1:7070. Have an org, a signed-in account and an agent (Phase 1).
2. Repos: Register a repo, pick the org, add an alias.
3. Home: type "add a health endpoint to api from develop", check the chips, Start. Watch the room. Look at `<tasks_dir>/<KEY>/` and `git -C <repo> worktree list`.
4. Tell the agent to draw something and link it, and to show a page, to see media.
5. Task menu, Remove task, on a task with edits: it is refused until you choose Remove anyway.
6. SSH: `pnpm --filter @majhi/host ssh:dry-run` prints which keys the helper found, which are loaded and which need a passphrase, and changes nothing. After `make up`, Repos shows an unlock card for any key that needs its passphrase.

### Verified

- `sh scripts/ci.sh`: Biome clean, typecheck, 659 unit and integration tests, both builds, 25 Playwright tests (8 Phase 0, 6 Phase 1, 9 Phase 2a, 2 SSH). The whole suite passed 3 more runs in a row (the specs build on each other's state, so they run together).
- e2e with the fake ACP adapter (Claude fake pauses 250 ms between steps, Codex fake 600 ms) covers: registering a project; the done-when task with chips, the streamed turn, the expanded diff, the rule-answered `npm test`, and on disk the worktree, the branch made from `develop`, `TASK.md`, `AGENTS.md`, an unchanged remote with nothing pushed; a file requested in the worktree showing under Changes; Esc on a slow turn with a queued message that stays queued until the next send; Deny and "Allow for this task"; a chat task; media inline, the lightbox, the sandboxed page that cannot reach `/api/cmd`, the files endpoint refusals; remove refused then forced.
- Screenshots (1440x900) in `e2e/screenshots/`: `task-screen`, `room-running`, `room-permission`, `repos-register`, `room-media`.

### Left and known issues

- Not run with a real account yet: a real Claude run on a real repo, the real adapters' permission option names (the room shows "Allow", "Allow for this task", "Deny" by option kind), and real image content blocks. This is the owner's review step.
- A task stays "Working" in the list while its agent is idle between turns. Status follows the task, not the turn.
- `.md` files are served as `text/plain` so a new tab shows them instead of downloading.
- Web images (`![x](https://...)`) are not loaded into the room: they show as a link card, so an agent cannot make the room call out to a tracker.
- Task-folder media links need the file to exist when the owner clicks; nothing checks it when the message arrives.
- Full git diffs, MRs and pushing come in later phases. The Changes tab shows the agent's own edits.
- Only one agent per task; teams and the boss's compaction are Phase 2b.

### Goal

Type "add a health endpoint to api from develop", and majhi creates the task, a worktree on a new branch from `develop`, and TASK.md, then runs one agent in it with the whole run visible and controllable in the room. A `chat` task works like opening the agent's CLI.

### What I will build, in order

1. **Contract** (done): projects, tasks, links, attachments, room items, live agent state, the room socket, uploads, the task box parser signature, and the `projects.*`, `tasks.*` and `room.*` commands. The ACP session interface in `packages/acp`.
2. **`packages/acp`**: `startSession`: spawn the adapter with the clean env, initialize, new or loaded session, apply model and effort, prompt with text, images and links, cancel, stream every session update as a normalized event, and route permission requests to a handler. The fake adapter grows scripted turns: streamed text, a plan, tool calls with diffs and commands, permission requests, slash commands, usage updates.
3. **`apps/server`**: SQLite store (Drizzle, WAL, migrations at startup), projects in majhi.yaml, the task box parser, task creation with worktrees and TASK.md, attachments (uploads, fetched links), the run manager (one session per task agent, queue and interrupt, cancel, permissions from agent perms or the owner, resume after restart), the room socket, and `@file` search.
4. **`apps/web`**: the main screen from the design in three columns: task box with live chips and task list on the left, the room in the middle (streamed messages, plan, tool calls, diffs, permission prompts, composer with slash commands, `@file` and attachments, Esc and Stop all), and the Changes tab on the right. Register projects from the repos view.
5. **Integration**: e2e through the done-when with the fake adapter, `make ci`, then a real run with the owner's Claude account.

### How I will test it

- Unit: the parser (repos, aliases, base and working branch, mentions, links, warnings), task keys, TASK.md generation, permission auto-allow rules, event normalization, room item upserts.
- Integration: the session engine against the fake adapter; task create to worktree against temp git repos with a real remote; run manager queue, interrupt, cancel and resume; the room socket.
- Playwright: register a project, create the done-when task, watch the run stream, answer a permission prompt, stop with Esc, send a queued message, open a chat task.
- Manual: a real Claude run on a real repo.

## Phase 1: Accounts and agents (built, waiting for owner review)

Branch `phase-1-accounts`, from `phase-0-skeleton`. The plan below is kept for reference; the result comes first.

### What works

- Onboarding continues after roots: step 2 adds the first account, step 3 creates the boss (`majhi-boss`, a root agent) with a model and effort read from the account, and runs its health check. A reload resumes at the first missing step. "Skip for now" on steps 2 and 3.
- Studio (top bar or Cmd+.) with two tabs:
  - **Accounts:** every account with tool, org, status and signed-in email, usage, and "Used by" (agents on it, boss marked). Usage per login account, read without tokens: `5h` and `Week` with reset times in the table, plan, per-model windows and Refresh in the details panel. Details panel with the last health check and "Used by" grouped by scope. Agent files that name a missing account are listed. Add account: pick tool and org (or create an org inline), suggested id, then sign in through the embedded terminal or paste an API key. Check, Sign in again, Remove (refused while agents use it).
  - **Agents:** grouped by Root and each org. Editor for scope, role, where, account, model and effort (from the account over ACP, plus auto and account default), instructions, permissions, fallback. Saves as you type. New, Duplicate, Health check, Make boss, Remove (not the boss). Files with errors are shown with each error.
- Health checks spend no tokens: the CLI starts, it reports signed in, an ACP session opens, and the agent's model and effort are offered.
- API keys are encrypted in `~/.majhi/secrets.age` with a key at `~/.config/majhi/secrets.key` (created by `make up`). They never appear in `majhi.yaml`, git history or any response.
- Every change is a commit in `~/.majhi`. Hand edits to `majhi.yaml` or `agents/` show in the UI live through `/api/events`.
- The image ships `@agentclientprotocol/claude-agent-acp` 0.84.0 and `@agentclientprotocol/codex-acp` 2.0.0. `make doctor` shows both CLI versions and each account's health.

### How to try it

1. `make up`, open http://127.0.0.1:7070. With roots already set, onboarding opens at step 2.
2. Add a Claude account with Sign in. In the terminal, open the link, sign in, paste the code. It shows healthy.
3. Create the boss with the suggested model and effort.
4. Studio (Cmd+.): create an org, add accounts, create agents, change model and effort, run health checks. Look at `~/.majhi/agents/` and `git -C ~/.majhi log`.

### Verified

- `make ci`: Biome clean, typecheck, 279 unit and integration tests, both builds, 14 Playwright tests (8 Phase 0, 6 Phase 1). The Phase 1 spec passed 3 runs in a row.
- e2e with a fake ACP adapter covers the whole "Done when": fresh install to a healthy boss; an org with two signed-in Claude accounts and three agents, each passing its health check; an API-key account whose key is absent from every response, socket frame, `majhi.yaml`, `secrets.age` bytes and `git log -p`; Used by and Missing accounts updating live; editor saves to disk and picks up hand edits; remove refusals.
- `docker compose build` succeeds; node-pty works in the image; both adapters are on PATH.

### Left and known issues

- Not yet run with a real account: the real Claude and Codex logins in the embedded terminal, and the real model lists. This is the owner's review step.
- SPEC 5.2 concurrency check (two agents on one account refreshing tokens at once) needs real runs, so it moves to Phase 2. Accounts share one config home per DECISIONS, which avoids the linked-file problem.
- Codex API-key accounts set `cli_auth_credentials_store = "ephemeral"` so the key is not written to `auth.json`. Unverified against a real key.
- API-key accounts show no windows; tokens and cost come with the first runs (Phase 2).
- The Claude usage call is experimental in the SDK. If a release removes it, the table keeps the last numbers and the details panel shows the error.
- Codex device login is not covered by e2e (only Codex API key).

### Goal

A fresh install walks through onboarding to a boss agent whose health check passes. From the UI the owner can add two Claude accounts for one org, three agents on them, and one API-key account, and every agent's health check passes.

### What I will build, in order

1. **Contract** (`packages/shared/src/accounts.ts`, `commands.ts`): account, org and agent file schemas, tool info, models, health check, the `/api/events` and `/api/term/<id>` WebSocket messages, and the commands: `tools.list`, `orgs.list|create`, `accounts.list|suggestId|create|remove|login.start|health|models`, `agents.list|create|update|duplicate|remove|health`, `boss.set`.
2. **`packages/acp`**: tool registry (Claude Code, Codex), per-run env built from scratch, login commands, and `probeAccount`, which checks the CLI, the sign-in and an ACP session (models and effort levels) without spending tokens. A fake ACP adapter in `packages/acp/testing` for every test.
3. **`apps/server`**: orgs and accounts in `majhi.yaml`, account homes, API keys in `secrets.age` (age), agent files with a watcher, the login terminal (node-pty over WebSocket), the events socket, handlers for every command, `doctor` checks for the CLIs, and the adapters installed in the image.
4. **`apps/web`**: Studio overlay with Agents and Accounts tabs, the add-account flow with an embedded terminal (xterm.js), the agent editor with models and effort read from the account, health check buttons, onboarding steps 2 (first account) and 3 (choose the boss).
5. **Integration**: e2e through onboarding and Studio against the fake adapter, `make ci`, and a real `make up` with the real adapters.

Steps 2 to 4 run in parallel against the contract.

### How I will test it

- Unit: schemas, account id suggestion, env building (nothing from the server env leaks), agent file parse and write round trip, secrets encrypt and decrypt, model and effort checks.
- Integration: every command through the dispatcher with the fake adapter; the login terminal end to end with the fake login; the file watcher picking up a hand edit.
- Playwright: onboarding to a healthy boss; two Claude accounts for one org and three agents; one API-key account; editing an agent and seeing the file change.
- Manual: `make up`, sign in to a real Claude account in the embedded terminal, health check passes, the model list comes from the real adapter.

## Phase 0: Skeleton (done, waiting for owner review)

Branch `phase-0-skeleton`. The plan below is kept for reference; the result comes first.

### What works

- `make up` builds one image, installs the host helper, generates the mounts from `majhi.yaml`, starts majhi on http://127.0.0.1:7070 and waits until it is healthy. It is the only manual command; `make down` stops majhi and removes the helper.
- Host helper (`apps/host`): a small Node process on the Mac, run as a LaunchAgent. It links to the server, suggests roots (home folders that hold git repos), lists folders for the browser, and remounts roots by regenerating the compose override and recreating the container. `make host-logs` follows its log.
- Onboarding step 1: pick workspace roots from suggestions or a folder browser, no typing. Saving a new root restarts majhi with the mount and reloads when it is healthy. If the helper is offline, the typed-path form comes back with a one-line hint.
- Unmounted roots on the repos screen get a "Mount now" button when the helper can remount.
- Repos screen: every git repo under each root, grouped by root, with branch, host (GitHub, GitLab, Bitbucket, other), SSH alias, and a details panel. `/` searches, `j`/`k` move, `Enter` copies the path, `r` rescans.
- Config errors in `majhi.yaml` show the file and each error, with Retry.
- Every change goes through a typed command (`POST /api/cmd/<name>`). `~/.majhi` is a git repo; each change is a commit with who and why. Hand edits are committed separately first.
- `make doctor` checks config, the config folder, git, each root's mount, the SSH agent and disk space.

### How to try it

1. `make up`, open http://127.0.0.1:7070. The top bar pill should read Online.
2. Pick `~/Work` from the suggestions (or browse to it), save. majhi restarts with the mount and reloads by itself.
3. The repos screen lists everything under `~/Work`. Try `/`, `j`, `k`, `Enter`, `r`.
4. `make doctor`. `git -C ~/.majhi log` shows the config history.
5. Checks: `make ci` (Biome, typecheck, unit and integration tests, builds, Playwright).

### Verified

- `make ci`: Biome clean, typecheck, 126 unit and integration tests, both builds, 8 Playwright tests pass.
- Host helper in real Docker (isolated copy, temp home): suggestions from the real home in 13 to 34 ms, folder listing, and a remount that added `~/Documents` and recreated the container healthy with the new mount.
- In Docker, against the real `~/Work` (with a temporary config folder): 68 repos found in 75 ms, doctor all green, the SSH agent reachable through OrbStack, a config change from the UI committed on the host mount, 34 MB memory used, a cross-origin write rejected with 403.

### Left for later phases and known issues

- The first mount of a folder macOS protects (Documents, Desktop, Downloads) triggers a macOS privacy prompt for OrbStack. Docker hangs until it is answered. majhi does not warn about this yet.
- The helper is macOS only (LaunchAgent). Linux would need a systemd user unit.
- A custom `tasks_dir` outside every root is not mounted yet. Phase 2 needs it and will add it.
- SSH keys: the host helper now loads them (see the 2a section).
- Web bundle is 590 kB (185 kB gzipped), served from localhost. Route-level code splitting can come with the Phase 10 performance pass.
- `PRODUCT.md` (design context for the UI skill) was written from SPEC section 1 without an interview. Edit it if anything is off.

### Goal

A fresh clone runs with one command, lets the owner pick workspace roots, and shows the git repos found in them.

### What I will build, in order

1. **Repo and tooling**
   - `git init`, commit the build kit on `main`, then work on branch `phase-0-skeleton`.
   - pnpm workspace with `apps/server`, `apps/web`, `packages/shared`. (`packages/acp` and `packages/mcp` come in the phases that need them.)
   - Shared strict `tsconfig`, Biome, Vitest, Playwright.
   - `scripts/ci.sh`: Biome check, type check, unit and integration tests, Playwright.
   - Verify every package name and current version before installing.
2. **`packages/shared`**
   - zod schema for `majhi.yaml`: `workspaces`, `tasks_dir`, `orgs`, `projects`, `accounts`, `decisions`. Only `workspaces` and `tasks_dir` are used in Phase 0. The rest are validated so a hand-written file fails early with a clear message.
   - zod schemas for the HTTP API: config state, repo list, workspace update.
   - The command contract (SPEC 5.16): `config.get`, `repos.scan`, `workspaces.set`, each with a risk class, served at `POST /api/cmd/<name>`. The web app calls only commands.
3. **`apps/server`** (Node 22, Hono, bound to 127.0.0.1)
   - Config loader: reads `~/.majhi/majhi.yaml`, expands `~` with the host's home (passed in as `HOST_HOME`), validates it, and reports errors. A missing file means first run.
   - Repo scanner, for each root:
     - Walks up to 4 levels deep and finds folders with a `.git` directory.
     - Skips `node_modules`, hidden folders and `tasks_dir`. Folders with a `.git` file (worktrees, submodules) are also skipped.
     - Reads remotes and classifies the host (GitHub, GitLab, Bitbucket, other) and the SSH alias.
     - Marks each repo as registered in `majhi.yaml` or not.
   - Routes:
     - `GET /health`
     - `POST /api/cmd/config.get`: first run or loaded, plus errors
     - `POST /api/cmd/repos.scan`: repos grouped by root
     - `POST /api/cmd/workspaces.set`: writes roots and `tasks_dir` to `majhi.yaml`, commits, and reports roots that need a restart
   - Serves the built web app.
   - `gen-override` command: reads `majhi.yaml` and prints `docker-compose.override.yml`, with one bind mount per root at the same absolute path.
   - Config history: `~/.majhi` becomes a git repo on first write, with a `.gitignore` for credentials, databases and caches. Every `change` command commits with the actor, command name and reason.
4. **`apps/web`** (React 19, Vite, TanStack Router and Query, Tailwind, shadcn/ui, IBM Plex, dark)
   - Top bar from the design (app name, Studio button disabled until Phase 1).
   - First-run screen: enter one or more absolute paths, save, then see the restart command.
   - Repos screen: repos grouped by root, each showing name, path, remotes and host, registered or not.
   - Roots that are not mounted yet are shown as a warning.
5. **Docker and commands**
   - `Dockerfile` (Node 22, multi-stage, builds web into the server).
   - `docker-compose.yml`:
     - `server` service with a healthcheck, published on `127.0.0.1` only.
     - `~/.majhi` mounted read-write, at the same absolute path as on the host.
     - `~/.ssh/config` and `known_hosts` mounted read-only.
     - SSH agent socket forwarded (OrbStack or Docker Desktop path from `.env`).
   - `.env.example`: port, socket path, host UID and GID.
   - `Makefile`:
     - `up`: generates the override using the server image, then runs `docker compose up -d`.
     - `down`, `logs`.
     - `doctor`: Docker present, SSH agent reachable from the container, git present, each root mounted, free disk space in `tasks_dir`.
     - `login` comes in Phase 1 with accounts.

### How I will test it

- **Unit (Vitest):**
  - `majhi.yaml` schema: valid file, missing fields, bad paths, unknown keys.
  - `~` expansion.
  - Scanner, against temp folders with real `git init`: nested repos, depth limit, skipped folders, worktrees skipped, remotes parsed per host.
  - Override generator: several roots, paths with spaces.
- **Integration:** start majhi against temp roots and a temp `~/.majhi`, and call each route.
- **Playwright:**
  - First run, pick two roots, see the restart message.
  - With config present, see the repos grouped by root.
- **Manual smoke:** `make up` on this machine with `~/Work` as a root, open the UI, check that the repos under `~/Work` are listed and `make doctor` passes.

### Choices

- majhi serves the web build, so Phase 0 runs one container (`server`). Vite runs only in dev. SPEC 4.2 allows this.
- Port `7070` on `127.0.0.1`.
- Scan depth 4 below each root.
- Answers from the owner: name majhi, first root `~/Work`, config folder `~/.majhi`, stack and memory design approved.
