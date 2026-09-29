# Progress

## Phase 2b: The boss and staying cheap (in progress)

Branch `phase-2b` (worktree `~/Work/majhi-2b`, so the owner's checkout keeps running the stable `phase-2a-ui`), from `phase-2a-ui`.

### Goal

Done when: a fake agent pushed past 80% context gets compacted with the event shown in the room; the boss creates an org and an agent after the owner approves; a running task resumes on its own after the network drops and returns, and after majhi restarts, with its work intact. Plus task links, concurrency limits, and no manual work outside majhi (update, health, protected folders).

### What I will build, in order

1. **Contract** (done): settings (context, limits, resume, approval policy), org overrides, task links on summaries, agent live states `queued`/`paused`, room items `approval`, `secret-request`, `context`, and commands: `tasks.link|unlink`, `room.fresh|approve|secret`, `secrets.list|save|remove`, `history.list|undo`, `settings.get|set`, `policy.set`, `boss.chat`, `health.run|fix`, `system.version|update`.
2. **Wave 1, in parallel:**
   - **Boss:** `majhi-admin` MCP server exposing every command as a tool, attached to the boss's sessions; approval policy with confirm cards; undo from config history; secret capture and secret requests; Cmd J boss chat; onboarding step 4; Hub setup becomes the boss conversation, with history and settings.
   - **Task links:** parent and child tasks, `depends-on` with the Waiting on chip, progress on parents, links in TASK.md, in the New task dialog and the task view.
   - **No manual work:** Health view with every doctor check and Fix buttons; Update ready and one-click update through the host helper; warning before mounting a macOS-protected folder; majhi and Docker start at login.
3. **Wave 2:** one agent owns the run manager: context budget (meter, native compaction, handoff, rotation, Fresh session), checkpoints after every turn, automatic resume after sleep, restart, crash and lost internet, agents on demand with idle stop, concurrency limits with a queue.
4. **Integration:** e2e for the done-when with the fake adapter, `make ci`, then the owner uses it.

### How I will test it

- Unit: settings defaults and merge order (majhi, org, agent), approval decisions per policy, secret detection, link cycles and waiting-on, compaction thresholds, limit queue order, offline and wake detection, version compare.
- Integration: the MCP server over HTTP with a real MCP client; the boss (fake adapter calling MCP tools) creating an org after approval; undo; a fake agent with rising usage compacting natively and by handoff; checkpoints and resume after a simulated restart and a simulated network drop; limits queueing a third agent.
- Playwright: boss chat with an approval card and undo; secret request card; links and the Waiting on chip; context event in the room; Health view with a fix; update banner.

### The boss (built)

- **majhi-admin MCP server** at `/mcp` (`apps/server/src/admin/`): stateless streamable HTTP, `Authorization: Bearer <token>`, 401 without a valid token, 403 for a browser Origin that is not loopback. One tool per command (`majhi_orgs_create`, ...) with the command's zod input as JSON schema plus `ownerAsked` and `reason`, and `majhi_request_secret`. Tokens map to (task, agent); the run manager issues one when it starts a session for the boss or a root agent with `majhi-admin` in `tools`, and revokes it when the session ends.
- **Approval** (`settings.policy`): `auto` runs, `when-asked` runs when `ownerAsked` is true, `confirm` waits. Every non-read call posts an `approval` card in the agent's task: `applied` (with the config `commit`, so Undo works), `failed`, or `pending` (the agent gets "Waiting for the owner..." at once). `room.approve` runs or rejects it, updates the card and sends the agent a message ("The owner approved: ..."). Commands run through the same dispatcher with the agent as actor and the reason, so history records who did it. Secrets in inputs are redacted on cards, results and errors.
- **History and undo**: `history.list` reads the config git log (trailers), `history.undo` reverts one commit and refuses on conflict; an applied card shows Undo and becomes `undone`.
- **Secrets**: `secrets.list|save|remove`; `room.send` and `tasks.create` replace detected secrets with `secret:<name>` (detector in `packages/shared/src/secrets-detect.ts`); `room.secret` answers a request card. Values never reach logs, room items, commits or responses (tests read every file under the majhi home and the config git log).
- **Settings**: `settings.get` merges defaults with majhi.yaml, `settings.set` and `policy.set` write only the given fields through the config history.
- **Web**: Cmd J / Ctrl J and the sidebar "Boss" button open the boss chat as a right drawer on any page; approval and secret-request cards in the room; composer warning; Hub setup is the boss conversation plus setup cards, History (with Undo) and Settings (changing the policy asks first); onboarding step 4.
- **Try it**: with a signed-in boss, press Cmd J and ask for an org. Changes wait for Approve unless you asked for them in the chat. Hub setup shows History and Settings.
- **Tests**: unit (decision table, redaction, detector, name derivation, history parsing, settings merge, web models); integration (MCP with the SDK client, 401, revoked token, approve and reject through the fake adapter, undo and conflict, secret capture and `room.secret`); E2E `e2e/phase2b-boss.spec.ts` (needs the boss from `phase1.spec.ts`, so run the whole suite: `PATH=$PWD/apps/server/node_modules/.bin:$PATH MAJHI_E2E_PORT=7081 npx playwright test`).
- **Known gaps**: A pending card whose input held a secret cannot run after a restart. The boss's tool calls are not rate limited.

### No manual work outside majhi (built)

- **Checks in the UI.** `apps/server/src/health/checks.ts` holds every doctor check, shared by `make doctor` and `health.run`. Health and usage has a "Checks" section above Accounts: grouped rows (majhi, This Mac, Git over SSH, Accounts, Disk) with a dot, label, detail and a Fix button. Fixes (`health.fix`, `health/service.ts`): mount an unmounted root (helper remount), create the config or tasks folder, reload SSH keys (also for a git host that took no key), check an account again, open an account's sign-in terminal, restart the helper. Checks with no fix say the exact step. The sidebar "need you" count adds failed checks (not warnings, not account checks).
- **Update.** The image bakes `MAJHI_COMMIT` (Dockerfile ARG, `make up`, the helper). `/health` reports it. The helper reports its checkout's HEAD and dirty flag; `system.version` lists commit subjects through the `version.changes` job. The sidebar shows "Update ready" under the logo with the changes and an Update button (or the `make up` command when no helper is connected). `system.update` starts the helper's `update` job; the "Updating majhi" screen lives above the app gate, shows the helper's progress lines from `~/.majhi/update.json`, keeps showing them while the server is down, and reloads when `/health` answers with the new commit. A failed build leaves the old majhi running and says why.
- **Protected folders.** `protectedFolder(path, home)` (shared) flags Documents, Desktop, Downloads and iCloud Drive. The roots form warns before saving, naming OrbStack or Docker Desktop (the helper reads `docker info`).
- **Start at login.** The helper, which launchd starts at login, opens Docker if `docker info` fails (waits up to 2 minutes), then runs `docker compose up -d --wait` when majhi's container is not running. It retries twice a minute apart and then posts one macOS notification with the step to take. Decision logic in `apps/host/src/startup.ts`, tested with injected commands.
- **Try it.** In the owner's checkout after merge: `make up` once (bakes the commit, installs the new helper). After that, commit something and open majhi: "Update ready" appears; click Update. Health and usage shows the checks. Real Docker, launchd and the notification were not run for real here.
- **Tests.** Unit: check mapping, version compare, protected folder, startup decisions, update steps with fake docker and git, helper jobs, web models. Server integration with a fake helper: `health/ops.integration.test.ts`. E2E: `pnpm exec playwright test -c playwright.ops.config.ts` (port 7083, `e2e/phase2b-ops.spec.ts`; needs `tsx` on PATH, for example `PATH=$PWD/apps/server/node_modules/.bin:$PATH`).
- **Known gaps.** A changed LaunchAgent plist needs `make up`. The startup flow only runs when the helper has a checkout (`MAJHI_REPO`), as installed by `make up`.

### Wave 2: the run manager (built)

All in `apps/server/src/runs/`: rules in small pure modules (`context.ts`, `handoff.ts`, `limits.ts`, `network.ts`, `wake.ts`, `checkpoint.ts`); `compaction.ts` (budget, native compaction, handoffs, Fresh session), `launch.ts` (agent, account and ACP session), `permission-flow.ts`, `durable.ts` (checkpoints and notes), `pick.ts` (model picks) and `live.ts` (live state and room lines); `manager.ts` keeps the queue loop, limits and pause and resume; `resilience.ts` handles startup, the network watch and wake.

- **Context budget (5.13).** Each agent's `used / size` from ACP usage shows as a thin meter under it in "In this room". At the end of every turn, and before a prompt that would cross the line, majhi compacts at `compact_at` (majhi default, then the org's, then the agent's): the agent's `/compact` first, and if usage does not fall under `compact_target`, a handoff note from the agent in the fixed template, saved to `<task>/.handoffs/<agent>-<n>.md`, and a fresh session that gets prefix, TASK.md, note, room summary, diff stat and the pending prompt. When the agent cannot write the note (max_tokens, max_turn_requests, a context-window error, a lost session), majhi builds it from TASK.md, the last checkpoint, the room since it and the diff. Rotation after `max_turns`, and a "Fresh session" button per agent (`room.fresh`). At most 2 compactions per turn, then the task pauses with reason `error`. Every compaction is one quiet room line, "@acme-lead compacted: 42k to 4k tokens (native)", with a link that opens the note in the file viewer.
- **Checkpoints (5.7).** After every turn that changed a worktree: `wip(<TASK>): checkpoint N` on the task branch, with the org's commit identity or `majhi <majhi@majhi.local>` (and a one-time room hint). Number, room position and session id are on the run. Never pushed.
- **Automatic resume (5.7).** A turn is marked in flight on its run. After a restart or crash, cut turns continue ("Continue from where you stopped. The last checkpoint is N.", loading the ACP session when possible); two failures pause with reason `error`. Done tasks get `statusChanged` at startup. Offline: a probe every 20 s plus network-looking agent errors pause running turns (agent "Paused, offline", the task card says majhi is offline) and resume them when the network returns. Wake: the host helper reports `wokeAt`, and turns that failed or stalled while the Mac slept continue. Orgs can turn resume off in the Orgs form. Update: with agents working, the Update card offers "Update when they finish" next to "Update now"; cut turns resume after the restart either way.
- **Agents on demand and limits (5.17).** An idle process stops after `idle_timeout`; the next message loads its session again (or starts fresh with a note). `agents_max`, `per_account` and `per_task` apply when a process starts; extra starts wait in request order, shown as "Queued, #n in line", and a waiting start may stop an idle process in its way. Limit changes apply at once.
- **Decision hooks (5.12).** Every session gets `majhi-decide` next to `majhi-admin` (token revoked when it ends). `auto` agents get a pick with option descriptions and a 0.4 floor, applied with `setOption`, posted in the room and recorded on the run with the decision id.
- **Two agents on one account (5.2).** Proven with the fake adapter through the run manager; how to confirm with a real account is in `docs/DECISIONS.md`.
- **Try it.** Settings: set `context.compact_at` to 0.15 and send a message; the room shows the compaction line. Click the refresh icon next to an agent for a fresh session and open its note. Set `limits.per_account` to 1 and start two tasks on one account: the second waits in line.
- **Tests.** Unit: merge order and thresholds, the note template and majhi's note, the queue order and eviction, offline and wake decisions, checkpoint commits (`runs/*.test.ts`). Integration with the fake adapter (`--rising-usage`, `/compact` that lowers usage or `--compact-noop`, the handoff reply, `stop:max_tokens`): native, handoff and majhi-note compaction, the per-turn cap, rotation, Fresh session, two agents on one account (`runs/budget.test.ts`); restart, crash, org resume off, two failed resumes, network drop, network-looking errors, wake, the queue under `per_account: 2`, live limits, idle stop, decision hooks (`runs/resume.test.ts`). E2E `e2e/phase2b-runs.spec.ts` (after phases 0, 1 and 2a; the server's network probe is a file, `MAJHI_NET_PROBE=file:...`).
- **Known gaps.** Real CLIs were not run: native `/compact` and its usage report are checked against the fake only. A compaction is recorded as a room item and a run ending in `handoff`, not yet in a token receipt (Phase 2c/9).

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
