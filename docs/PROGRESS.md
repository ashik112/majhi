# Progress

## PRV-63: Scheduler and watch triggers (built, waiting for owner review)

Branch `task/prv-63-scheduler-and-watch-triggers`, from `main`. Choices: the `docs/DECISIONS.md` rows of 2026-10-01 on schedules, triggers and automation.

### What works

- Shared: `automation.ts` (specs, actions, run records, overlap, the phrase parser), `schedule-time.ts` (next runs with croner, used by server and UI), `triggers.ts` (eight watch kinds, poll defaults, `describeWatch`). Commands `schedules.*` and `triggers.*` (list, get, runs: read; create, update, pause, resume, runNow: change; delete: destructive), so the boss gets `majhi_schedules_*` and `majhi_triggers_*`.
- Server, `apps/server/src/automation/`: `ActionRunner` (org checks on save and on every run, overlap, secret refusal, how a run ends), `RunHistory` (`automation_runs`, shared), the scheduler loop (one timer, catch-up runs a missed schedule once), the trigger engine (baseline, settle, cooldown, one firing per change after a restart). Migrations 101 and 102.
- Actions: start a task from a template, post to a task's room (wakes its lead), run a command as a process of a task.
- Web: the Automations page (`/automations`, sidebar, `g t`) with Schedules and Triggers tabs, forms with a live next-runs preview and an explicit time zone, row actions and a run history drawer.

### How to try it

- Automations in the sidebar, New schedule, "weekdays at 9:00", start a task in a project, Run now, open History.
- Or ask the boss: "every hour, post 'status?' to ACM-4".
- Screenshots: `e2e/shots.automations.ts` with `playwright.automations.config.ts`.

### Left and known issues

- No dry run for a watch (what it sees now).
- An explicit `pollSeconds` cannot be cleared back to the default.
- Usage watches count periods in the server's time zone.
- Not tried against real accounts or a long-running majhi; the scheduler and triggers are covered by unit tests with a fake clock.

## PRV-53: Containers for agents, run by majhi (built, waiting for owner review)

Branch `task/prv-53-containers-for-agents-run-by-majhi`, from `main`. Design: `SPEC.md` 5.15 "Containers for agents" and the `docs/DECISIONS.md` rows of 2026-09-30.

### What works

- Shared: `packages/shared/src/containers.ts` (image, name, path, env and command schemas, the tool inputs), the `containers` settings section (`images`, `cpus`, `memory`, `per_task`, `build_cpus`, `build_memory`), `ProcessInfo.container`, the `containers` event topic and seven `containers.*` commands with card summaries.
- Server, `apps/server/src/containers/`: `names.ts`, `args.ts` (argument builders and `assertSafe`, an allow list of flags), `docker.ts` (`DockerCli`: `exec` for reads and removals of `majhi-` things, `connect` to a task network, `create` and `attached` which run `assertSafe`), `service.ts` (`ContainerService`), `mcp.ts` (the `majhi-containers` tool, on `/mcp/containers`, only when majhi runs in Docker).
- `ProcessManager` runs managed processes; `TaskService` calls `taskStopped` and `taskEnded`; `RunnerConfig.taskNetworks` joins runners to the task network; `SpawnRequest.task` labels runner containers `majhi.task`.
- The Dockerfile copies the buildx plugin into the runtime stage.
- Web: a Containers section in Hub setup (running previews and services across tasks with Stop and the preview's link, allowed images with Remove and Allow, the five limits) that follows the `containers` event, and container rows in the task's Processes card (kind, image, address, the preview's link). Checked in a browser with the fake docker.
- Tests: `containers/args.test.ts` (mounts, networks, caps, flag injection, builds and paths), `service.test.ts` and `commands.test.ts` (a fake docker), the runner additions in `runner/docker.test.ts`, `config/settings.test.ts`, and `config/load.test.ts` (majhi.yaml with a `containers` section loads).

### How to try it

Without Docker: `apps/server/src/testing/fake-docker/README.md` starts majhi with a fake `docker` and lists the calls. With Docker: `make up`, then in a task with a repo ask an agent to call `preview_build`, `preview_run` and `service_start`.

### Left and known issues

- Not tried against a real Docker: the buildx plugin path in the Dockerfile, `docker buildx create --driver-opt memory/cpu-quota`, repeated `--network` (Docker 25+), a real preview build of majhi and a real postgres. The owner's steps: build and run a preview of majhi, start postgres, see the Hub list, close the task and see everything go.
- The approval card for a new image was not seen in a browser: it needs a real agent's `service_start`. It is the existing approval card, and `commands.test.ts` covers the card and its approval.
- A build's `Dockerfile` and context are checked just before the build; a symlink swapped in that moment is not caught. BuildKit does not follow symlinks out of the context.
- The BuildKit container of the `docker-container` driver runs privileged (the driver's design). Only Dockerfile `RUN` steps reach it, and `--allow` entitlements are refused.
- `terminal/terminal.test.ts` "caps the buffer at 256 KB" times out here, with or without this work.

## Phase 5: Memory (built, waiting for owner review)

Branch `task/prv-20-phase-5-memory`, from `main` (Phase 4 merged).

### Done when

- [x] A fact learned in one task is approved and then recalled in a later task in the same repo. `apps/server/src/memory/integration.test.ts`, "Done when": an agent proposes a fact through `majhi-memory` in a task in `acme-api`, it stays pending and a task started meanwhile does not get it, `memory.approve` makes it active, and the next task in `acme-api` has it under "Memory" in TASK.md. A task in another org gets nothing, in TASK.md or from the tool. The Housekeeper path is covered by `memory/housekeeper.test.ts` (a done task's room is read, its candidates curated).

### Plan

Built in three parts, one after the other in this worktree.

**Part A: store, embeddings, recall, MCP server, commands**

1. Shared schemas (`packages/shared/src/memory.ts`): fact, scope, status, memory event, command inputs and outputs, MCP tool inputs.
2. Store: `~/.majhi/memory/memory.db`, its own better-sqlite3 file with its own migrations. `facts` (text, scope, source task, source agent, status, pinned, promoted, use count, created, valid from, valid to, duplicate of, decided by), `facts_fts` (FTS5), `facts_vec` (`sqlite-vec`, 384 floats), `memory_events` (fact, action, actor, reason, confidence, provider, time, undone).
   - Scope is `global`, `org:<org>` or `project:<project>`.
   - Status is `pending`, `active`, `retired` or `rejected`. `rejected` is added to the spec's three so a dropped fact can be undone.
3. Embeddings: an `Embedder` interface. The real one is transformers.js (`@huggingface/transformers`) with `Xenova/all-MiniLM-L6-v2` (384 dims, quantized). The model is downloaded once into `~/.majhi/cache/models`, then used offline. It loads on first use and unloads when idle. Tests use a deterministic hashed bag-of-words embedder. When the model cannot load, keyword search keeps working, and vectors are filled in later.
4. Hybrid search: FTS5 (bm25) top 20 and vector top 20, merged by reciprocal rank fusion. Only active facts in the allowed scopes are searched, and pinned facts come first.
5. Recall into TASK.md: at task start, the top facts for `global`, the task's org and each of its projects, searched with the brief as the query. A "Memory" section is capped at about 500 tokens (4 characters per token). Each recalled fact's use count goes up.
6. `majhi-memory` MCP server for every agent, like `majhi-decide`, with one token per session:
   - `recall(query, scope?)`, `propose(text, scope)` and `list_recent(scope?)`.
   - An agent sees and proposes only in `global`, its task's org and that org's projects. It never sees another org's facts.
   - `propose` makes a pending fact and hands it to curation (Part B).
7. Commands (5.16), so the boss and the UI share them: `memory.search`, `memory.list` (scope, status, task), `memory.add` (the owner adds an active fact), `memory.approve`, `memory.reject`, `memory.forget` (retire, sets valid to), `memory.pin`, `memory.events` (the log, per task or all).

**Part B: curation, Housekeeper, promotion, settings**

1. Settings: a `memory:` section in `majhi.yaml`, shown in Hub setup under Memory.
   - `auto_threshold`: default 0.8.
   - `review_all`: "Review every fact", default false.
   - `housekeeper`: the agent that extracts facts. The default is the boss.
   - `housekeeper_model`: the cheapest model its account offers when not set, for example Haiku.
2. Extract (the only step that spends tokens): when a task becomes `done` (after a merge, or closed as done), and on `memory.extract(task)`.
   - One throwaway ACP session, like the ACP decision provider, reads the room (trimmed to about 8k tokens) and answers JSON only: up to 8 short facts (under 200 characters), each with a scope.
   - The answer is checked with zod and retried once. Its tokens are recorded under the task.
3. Duplicates, without a model: embed the candidate. Cosine 0.92 or more with an active or pending fact in the same or a wider scope marks it as the same fact (`duplicate_of`, logged). No row is added.
4. Decide, with the decision provider chain (Laya first). Each candidate gets one `decide` call on a small state (the candidate and its nearest existing fact) with three questions:
   - Keep, or task chatter.
   - Against the nearest fact (cosine 0.75 to 0.92): same fact, contradicts it, or unrelated.
   - `noul`: it contains a secret or personal data.

   A rules check (token and key patterns, emails, the existing secret patterns) runs first. A fact it flags is always rejected, whatever the model says.
5. Apply:
   - Above `auto_threshold`, keep (active) or drop (rejected) happens on its own. It is logged with the reason, confidence and provider.
   - A confident "contradicts" retires the old fact (valid to now).
   - Everything else stays pending for the owner, and so does everything when `review_all` is on.
   - Facts in `global` scope always wait for the owner, so one org's task cannot write facts every org sees.
   - `memory.undo(event)` reverses any logged step.
6. Promotion to AGENTS.md: `memory.promote(fact)`, for active project facts. majhi makes a task in that project and adds the fact as a bullet under `## Facts` in the repo's `AGENTS.md` in the task's worktree, with a commit and no agent. The task goes to review, and the owner merges it through the usual card. `promoted` holds the task id.

**Part C: web**

1. Studio Memory tab (3.3):
   - Search, and scope filters: All, Global, each org, Needs review.
   - Rows with text, scope, source (task and agent) and use count.
   - Actions: Pin, To AGENTS.md, Forget, plus Approve and Reject for pending facts.
   - The auto decisions log, with reason, confidence and Undo.
2. The task's Memory tab, next to Room and Changes: what this task proposed and what was decided, with Approve, Reject and Undo.
3. Hub setup, Memory section: threshold, "Review every fact", and the Housekeeper agent and model.
4. Checked in Chromium against the e2e server, with screenshots.

### Part A status (built)

Works, checked by tests that run against the fake runtime and the hashed fake embedder:

- Store: `~/.majhi/memory/memory.db` with `facts`, `facts_fts`, `facts_vec`, `memory_events` and `task_recalls`, migrations of its own. `sqlite-vec` 0.1.9 loads into better-sqlite3 (run here on linux arm64, and the filtered nearest-neighbour query too).
- Embedder: `Embedder` interface, the transformers.js one (`Xenova/all-MiniLM-L6-v2`, q8, cache `~/.majhi/cache/models`, unloads after 5 idle minutes) and the hashed fake for tests. When the model does not load or is slow, search uses keywords and vectors are filled in by a later search.
- Hybrid search: bm25 top 20 and vector top 20 (cosine 0.25 or more), reciprocal rank fusion, active facts in the allowed scopes only, pinned first.
- TASK.md gets a "Memory" section when the task starts: pinned facts, then the best matches for the brief, cut at about 500 tokens, `use_count` up once per task.
- `majhi-memory` (`recall`, `propose`, `list_recent`) for every session at `/mcp/memory`. An agent sees and proposes in global, its task's org and that org's projects only. `propose` makes a pending fact and calls `curate(fact)`, which does nothing until Part B.
- Commands: `memory.search`, `memory.list`, `memory.add`, `memory.approve`, `memory.reject`, `memory.forget` (destructive), `memory.pin`, `memory.events`.
- Done when, as a test (`memory/integration.test.ts`): a fact proposed in task one in `acme-api` is approved with `memory.approve` and is in task two's TASK.md in `acme-api`, and not in a task in another org.

Try the tests: `npx vitest run apps/server/src/memory` from the repo root.

Not checked here: the Docker image build and the x64 libraries (no Docker in this environment), and the real model download (the tests use the fake embedder). The `Dockerfile` installs `sqlite-vec` and `@huggingface/transformers` with npm for the image's CPU and loads `sqlite-vec` once as a build check.

### Part B status (built)

Works, checked by tests against the fake runtime and the hashed fake embedder (no tokens, no model):

- **Settings.** `memory:` in `majhi.yaml` (`auto_threshold` 0.8, `review_all` false, `housekeeper`, `housekeeper_model`), in `settings.get` and `settings.set { memory }`. An unknown `housekeeper` is refused, and `agents.rename` follows it. The UI is Part C.
- **Curation** (`memory/curator.ts`), the same path for an agent's proposal and the Housekeeper's candidates:
  1. Rules first: a secret, an email or a phone number is rejected, under `review_all` too.
  2. Duplicates without a model: cosine 0.92 or more with an active or pending fact in the same or a wider scope.
  3. Decide: one `decide` call per candidate (use `memory`, recorded on the task) with the candidate and its nearest fact as state. The questions are keep or chatter, same, contradicts or unrelated (only for a nearest active fact from 0.75 to 0.92), and a yes/no on secret or personal data.
  4. Apply: a sure answer (the decision gate accepts it and its probability is at least `auto_threshold`) keeps or drops the fact, and a confident contradiction keeps the new fact and retires the old one. Everything else waits. `review_all` and `global` skip the model and wait.
  5. Every step is logged with reason, confidence and provider. Nothing is deleted.
- **Undo.** `memory.undo(event)` reverses an automatic keep, drop, retire or merge and the owner's approve, reject or forget. It refuses a step already undone or one the fact has moved on from.
- **Housekeeper** (`memory/housekeeper.ts`). One throwaway scratch session reads the brief and the room (cut to about 8k tokens), answers JSON only (up to 8 facts under 200 characters, each with a scope), checked with zod and asked once more if not valid. The model is `housekeeper_model` or the cheapest the account offers. Its tokens are recorded under the task. It never reads a room on an account that may not work in the task's org.
- **When it runs.** When a task becomes done (`TaskService.close`: the merge, the plain close and the rest all pass there) and on `memory.extract(task)`. The close never waits for it or fails because of it. No Housekeeper is silent; any other problem is a warning in the room; a finished run says what was kept, dropped, known and left waiting.
- **Promotion.** `memory.promote(fact)` for active project facts: a task with no agent, a worktree, the bullet under `## Facts` in `AGENTS.md`, one commit, the task in `review`, `promoted` set.

Try the tests: `npx vitest run apps/server/src/memory apps/server/src/config apps/server/src/agents/rename.test.ts` from the repo root.

Not checked here: a real Housekeeper session on a real model (the fake runtime answers in tests), Laya's answers on real candidate facts (the tests play the provider; how sure Laya is on these questions is for the owner to watch in the log), and the Docker image (see Part A).

### Part C status (built)

Server:

- `Extraction.afterClose` skips a task where no agent wrote anything (a promotion task, a task closed without a run), so it spends no tokens. `memory.extract` still reads any room when asked.
- A promotion task that is closed or removed without its branch reaching the base branch clears the fact's `promoted` and logs an `unpromoted` step, so the fact can be promoted again (`Promotion.release`). A merged one keeps it.
- `settings.set { memory }` takes `null` for `housekeeper` and `housekeeper_model`, to put back the boss and "Cheapest".

Web (checked in Chromium, 1440x900, against the e2e server with a seeded home: `e2e/memory-seed.ts`, `e2e/shots.memory.ts`, `playwright.memory.config.ts`; screenshots in `media/`):

- **Memory page** (sidebar, `g m`, `/memory`): search over active facts (`memory.search`), tabs All, Global, each org (its project facts included) and Needs review. A row shows the fact, where it holds, its source (task id opens the task drawer, and the agent), how many tasks got it, Pinned and "In AGENTS.md via <task>". Pending facts have Approve and Reject; active ones Pin/Unpin, To AGENTS.md (project facts not yet promoted, with a confirm that a task is made and waits in review) and Forget (confirm). "Recent automatic decisions" lists what curation kept, dropped, retired or merged, with the reason, how sure it was, the provider and Undo. Everything refreshes on the `memory` topic. The sidebar shows "N to review" for pending facts.
- **Task Memory tab** (next to Room and Changes; shown when the task has facts or is done): the facts this task proposed or the Housekeeper wrote, each with its status and its logged steps, Approve and Reject on pending ones, Undo on steps, and Extract again for a done task or an empty tab.
- **Hub setup, Memory**: the auto-keep threshold (0.5 to 1, with a line that explains it), Review every fact, the Housekeeper agent (default the boss) and its model (from that agent's account, or Cheapest).

Try it: `pnpm exec playwright test -c playwright.memory.config.ts` starts the e2e server on port 7075 with the seeded home. `e2e/memory-seed.ts` has to run against it first (see the file header); for the screenshots, set `MEMORY_SHOTS` to the folder.

The real embedding model was downloaded and run once on this linux arm64 host (`Xenova/all-MiniLM-L6-v2`, 384 numbers, cosine 0.86 for two sentences about the same thing and -0.06 for unrelated ones). The first load takes about 12 seconds including the download. A search waits up to 30 seconds for it (`EMBED_WAIT_MS`) and then goes on with keywords only; the load continues, and later searches use both.

### Phase 5 result

What works: the memory store and hybrid search, recall into TASK.md at task start, `majhi-memory` for every agent with org isolation, the `memory.*` commands (also through the boss), curation with duplicates, decisions, thresholds and Undo, the Housekeeper after a done task, promotion to AGENTS.md through a task in review, and the Memory screens above.

Left, and known:

- Facts are found by meaning only when the embedding model has loaded; until then keywords rank alone and vectors are filled in later.
- Promotion adds one bullet per task. Several facts mean several tasks.
- The "Needs you" count on Health and usage is not changed: pending facts have their own "N to review" on the Memory item, since they are not an account or a check.
- The decision provider's calibration on real candidate facts is for the owner to watch in the decisions log.
- TASK.md is now written through a temp file and a rename. Recall added a rewrite at task start, and a reader could catch the file empty mid-write (`rooms/team.test.ts` did).
- Full CI at the end of the phase, after merging `main` in: lint and typecheck are clean, and every unit test passes. `tsc -p e2e` fails on `main` in two old specs, so `scripts/ci.sh` stops there; that is PRV-58. Playwright: 28 passed, 3 failed, 4 skipped and 9 did not run, and `main` gives the same result. The three are older Phase 2a and 2b specs; that is PRV-59.

Only the owner can check: the Docker image with `sqlite-vec` and onnxruntime on x64 and arm64 (not built here), and a Housekeeper run on a real model.

### Memory rework (2026-09-30)

Branch `task/memory-rework`. The owner's review: memory kept one-line facts, most restating repo rules already in CLAUDE.md or AGENTS.md, and nearly all of them waited for approval. Nothing about what tasks did, decided or left. The store, embeddings, hybrid search, scopes, org isolation, the MCP server, Undo and the log stay; what is stored and how it flows changed.

What works:

- **Task records, automatic.** When a task becomes done (closed, merged, or its MRs merged), the Housekeeper writes one record in plain prose: Asked, Done, Decisions, Outcome, Left. One session per task, tokens under the task. It reads the last three agent messages whole (the hand-back), the rest of the room cut to about 5k tokens, and what git says about each repo: the branch's own commits, the diff stat and the lines added to `docs/PROGRESS.md` and `docs/DECISIONS.md` (`memory/task-git.ts`, which finds the branch's range before a merge, after a merge commit and after a fast-forward). One record per task: a second close does nothing; `memory.extract` (Write again) rewrites it in place. Stored in `task_records` with FTS and vectors, seen only in its org's and projects' scopes, never global.
- **Project briefs, versioned.** Five sections (What it is, Architecture, Current state, Plans and next steps, Known problems), under about 800 words. After each record the Housekeeper answers a patch (only the sections that change); a patch that changes nothing adds no version. A project with no brief gets all five from its README start and the headings of README, SPEC, AGENTS.md, CLAUDE.md and docs/PROGRESS.md. Every version is kept; `memory.restoreBrief` puts an older one back as the newest. `memory.buildBrief` (Build it now) writes one from the docs and the records.
- **Open threads.** Each Left item becomes a thread (text, project, source task, follow-up task when one was made from this task). A thread closes when a later record lists it as done (only in that task's own projects), when its follow-up task is done, or by hand; `memory.reopenThread` undoes a close.
- **Lessons, rare.** At most three per task, each with what actually happened; a lesson without it is dropped. The prompt carries the repo's CLAUDE.md, AGENTS.md and README and says never to restate them, and curation checks every lesson and agent proposal against chunks of those files (cosine 0.8 with the model, or 85% of its words in one chunk). A match is not stored (Housekeeper) or is dropped with Undo (agent). The duplicate check, the secret and personal-data rules, the Laya gate and global-needs-owner stay. Only global lessons and contradictions wait for the owner; everything else is kept or dropped on its own, and an unsure answer keeps the lesson, saying so in the log.
- **Recall into TASK.md.** One Memory section, at most about 1500 tokens: the project brief (compact), the three task records most like this task's brief, the open threads of its projects (most shared words first), and the lessons, each under its own heading. It is kept per task so a rewrite of TASK.md gives the same text. `majhi-memory` gains `records(query)`, `brief(project)` and `threads(project)`; another org's are refused.
- **Cleanup of the old facts.** Once at startup, pending facts near-identical to a chunk of their repos' CLAUDE.md, AGENTS.md or README (cosine 0.88, or 85% of the words) are rejected with "Already in the repo docs (<file>)", as curation steps Undo reverses. The rest are left. It runs again at each start until it has run with the embedding model loaded. The review list has Approve all and Reject all.
- **UI.** The Memory page has four tabs: Brief (per project, with History and Restore this version), Tasks (the records, newest first, and search), Threads (open per project, Close with Undo, the closed ones) and Lessons (the old facts view with scope chips, Needs review with Approve all and Reject all, and the automatic decisions). The task's Memory tab shows its record, the threads it left open and its lessons, with Write the record or Write again.

Tests (fake runtime, hashed embedder, no tokens): `npx vitest run apps/server/src/memory apps/server/src/tasks/brief.test.ts`, 72 tests (with `agents/rename.test.ts` and `rooms/team.test.ts`, 84, all passing). They cover a record written once per task and rewritten in place, brief versions and restore, thread open and close (by a record, a follow-up, by hand), isolation (another org's task and agent never get records, briefs, threads or lessons), the repo-docs rule for lessons and for the cleanup, the 1500-token cap, and git ranges before and after merges.

Screens checked in Chromium at 1440 and 1100 wide against the e2e server with `e2e/memory-seed.ts` (records, a brief with three versions, threads): `pnpm exec playwright test -c playwright.memory.config.ts` with `MEMORY_SHOTS` set.

Left, and known:

- Existing done tasks have no record. Write the record on a task's Memory tab writes one; there is no bulk backfill.
- The first search after a start waits for the embedding model (up to 30 seconds), as before.
- `buildBrief` records its tokens under the project's newest task, or under `brief:<project>` when it has none, so those turns show no org in usage.
- `apps/server/src/config/settings.test.ts` "fills every default" fails on `main` too: it expects `auto_threshold` 0.8, the default is 0.4.

Only the owner can check: a Housekeeper run on a real model, and how well its records and brief patches read.

### How I will test it

- Unit tests:
  - Store migrations and status changes.
  - FTS plus vector ranking.
  - The scope filter, so another org's facts never leak.
  - The recall token cap.
  - The secret rules.
  - The curation state machine: duplicate, threshold, `review_all`, a global fact waits, contradiction retires, undo.
- MCP scope checks.
- Promotion against a local repo.
- Done when test: task one in `acme-api`. The fake Housekeeper proposes a fact, the rules provider leaves it pending, and `memory.approve` makes it active. Task two in `acme-api` has it in its TASK.md; a task in another org does not.

## Phase 4: Multi-repo and MRs (server and web built, child tasks pending)

Branch `task/prv-19-phase-4-multi-repo-and-mrs`, from `main` (Phase 3 merged). Search across rooms (PRV-35), review comments on diffs (PRV-36), open in editor (PRV-37), the terminal (PRV-38) and agent attribution (PRV-43) are their own tasks. The Changes tab and the MR screens are the web part, built after the server part.

### Plan (server part)

1. Shared schemas and command shapes: project `remotes` and `links`, org `merge` and `mr_tokens`, MR state on task repos, six `tasks.*` commands.
2. Store: migration 80, merge order, MR url, number, state, CI state and push time on `task_repos`.
3. Pure logic: merge order, MR description, merge policy decisions, URL rewriting through SSH aliases.
4. Push, three host clients, the MR service and the poller.
5. Tests: unit for the pure parts; integration against local bare repos with fake `gh`, `glab` and a fake Bitbucket server.

### Done when, status

- [x] One task changes two repos on two different hosts and ends with two linked MRs merged in order. `apps/server/src/mrs/flow.test.ts`, first test: `acme-api` on GitHub and `acme-web` on GitLab, web depends on api, the task lists web first; the MRs are opened with each description naming both, merged api then web, the task is done, the worktrees are gone, and a task waiting on it with `merged` starts from the updated base.

### What works (server)

- **Config.** Project `remotes: { <name>: { host, ssh, mr, token } }` and `links: [{ to, type: depends-on }]` (loops refused). Org `merge: never | approve | auto-if-green` (default `never`) and `mr_tokens: { github, gitlab, bitbucket }` (secret references). `projects.register`, `projects.update` and `orgs.update` take them; `projects.list` and `orgs.list` show them.
- **Merge order.** `mrs/order.ts`: dependencies first, ties keep the task's repo order, loops refused. `tasks.mergeOrder` shows it, `tasks.setMergeOrder` overrides it (or clears the override with `null`).
- **Push.** `tasks.openMrs` pushes each worktree branch to the project's MR remote (the one marked `mr`, else `origin`), through the SSH alias when the remote has one. The server's own ssh runs it, so the forwarded agent supplies the key; no key is read or copied. Never forced.
- **Hosts.** One interface (`mrs/hosts`): open, update description, read state and CI, merge. GitHub through `gh`, GitLab through `glab`, Bitbucket Cloud through its REST API. Credentials come from a secret reference per org and host, or per remote.
- **Flow.** `tasks.openMrs` (outbound) checks every repo first, then opens one MR per repo in merge order and rewrites each description to name all of them; the task moves to `mr`. `tasks.mergeMrs` (outbound) merges in order and stops at the first failure with the reason in the room. `tasks.markMerged` is "I merged it". `tasks.refreshMrs` reads the hosts. The poller (`MrPoller`, every 60 seconds) reads open MRs, merges under `auto-if-green`, and notices merges done on the host.
- **After the merge.** Base fetched, clean worktrees removed (one with uncommitted changes stays, and the room says so), task `done`, waiting tasks start. A `merged` dependency is met only when none of the task's MRs is left open or closed; a task closed with one makes its waiting tasks pause with reason `owner`, and the poller tells them when it merges.
- **Credentials.** Every host needs a token (org `mr_tokens` or the remote's `token`); `tasks.openMrs` refuses before pushing when one is missing.
- **The boss** has all of it through `majhi-admin`, since every step is a command. `openMrs` and `mergeMrs` are outbound, so they wait for the owner under the approval policy.

### How to try it (server, without the web)

1. Save a token: `secrets.save`, then `orgs.update` with `mr_tokens: { github: "secret:<name>" }` and `merge: "approve"`.
2. `projects.update` for each project: `remotes: { origin: { host: "github" } }` (add `ssh` when the remote uses an alias) and `links` for the dependency.
3. Let a task with two repos reach review, then `tasks.openMrs`, `tasks.mergeMrs`.
4. Tests: `pnpm exec vitest run apps/server/src/mrs`.

### Left

- **Real hosts.** Nothing ran against a real GitHub, GitLab or Bitbucket. The `gh` and `glab` flags were checked against the real tools' help output (`gh` 2.102.0, `glab` 1.120.0), and the calls run against fakes. The owner's check: one MR on a throwaway repo per host. The image (`gh` and `glab` pinned in the `Dockerfile`) was not built here, since Docker is not available; its install steps were run by hand.
- **Tracker update and the Housekeeper** (SPEC 5.5, last line) do not exist yet.
- **GitHub Enterprise and self-hosted GitLab** work only through the host name in the remote's URL (`GH_HOST`, `GITLAB_HOST`), not through an alias, and were not tried. Bitbucket Server / Data Center is not supported (Cloud only).
- **CI reading** is a summary (none, pending, passing, failing). Required reviews and branch protection are left to the host: a host that refuses the merge stops majhi with the host's message.
- The poller keeps nothing across a restart, and reads every task in `mr` each pass, so many open tasks mean many host calls a minute.

### What works (web)

- **Changes tab.** The task view has a Room / Changes switch when the task has a repo. Changes shows, per repo, each file's git diff against the base branch (commits and uncommitted work together, new files included), folded when a repo has more than 8 files. `tasks.diff` (read) runs `git diff` from the merge base in the worktree, or in the source checkout once the worktree is gone. Patches over 200 KB and repos past 300 files are cut with a note. The Changes card in the right column shows the same diff per repo (files, +/-, uncommitted work), and a file opens the tab. Files an agent changed outside the worktrees still come from the room and open in the file viewer.
- **Merge requests card** (right column, for tasks in review or mr, or with an MR). One row per repo in merge order, each with its MR number and link, state and CI. Arrows change the order (`tasks.setMergeOrder`); "Use the order from links" clears the override. The next step follows the org policy: "Push and open MRs" (or "Open the missing MRs" after a partial failure), "Merge in order" under `approve`, "Merge now" and a note under `auto-if-green`, "I merged it" under `never` (asks again with "Record as merged anyway" when the host still shows an MR as open). Refresh reads the hosts. Every outbound step asks first in a dialog. The header's local merge is now "Merge locally".
- **Org settings.** Merge policy, and per host (GitHub, GitLab, Bitbucket) the token: pick a saved secret or paste a new one, which is saved as a secret and only its reference goes to the org. The org card lists the policy and the hosts that have a token.
- **Repos screen.** The project dialog has the remote MRs go to, its host (or auto), the SSH alias, and the projects it depends on. The project row shows what it depends on, and marks the MR remote when there are several.
- **Needs you.** `mr` tasks were already in the Needs you group; their board card now says "MR open, waiting for the merge".
- **Checked in Chromium** against the e2e server (`e2e/start-server.ts` with the seeded UI home), with the fake `gh` and `glab` from `testing/mrHosts.ts` first on the server's PATH and local bare repos as the hosts. A Globex task on alpha-api (GitHub) and beta-web (GitLab, depends on alpha-api) reaches review; the Changes tab and card show both repos' diffs; "Push and open MRs" opens two MRs in order; "Merge in order" merges alpha-api, then beta-web; the task is done and its worktrees are gone. The check found the card saying "No files changed yet" next to a real diff, and "Start makes one" on a merged task; both are fixed. The driver script is not in the repo. No web tests, per CLAUDE.md.

### Search across rooms (PRV-35)

- **What works.** `room.search` finds messages, handoffs, system lines and tool output in every task, best match first, with the matched words marked. The board search shows the matches in a panel above the columns while it still filters cards by id, title and project. Cmd or Ctrl K opens a palette with task and room matches. Migration 90 builds the FTS5 index `room_search` and fills it from the existing room items; triggers keep it current.
- **How to try it.** Type a word an agent wrote or a command printed in the board search, or press Cmd K anywhere. Tests: `pnpm exec vitest run apps/server/src/store/store.test.ts`.
- **Left.** A match opens the task, not the place in the room. The palette has search only, not the commands SPEC 3.2 lists (new task, add account, and so on). Thoughts are not searched. A line still in the room's write buffer is found once it is saved.

## Phase 3: Teams, rooms and decisions (built, waiting for owner review)

Branch `task/prv-18-phase-3-teams-rooms-and-decisions`, from `main` (Phase 2c merged). Lead orchestration (PRV-32), background processes (PRV-33) and more agents per task from the task box (PRV-45) are their own tasks. Task ids that open a drawer (PRV-34) are done. The plan below is kept for reference; the result comes first.

### Done when, status

- [x] Lead, builder and reviewer on different tools complete a task together, and the reviewer catching an issue causes a fix round. `apps/server/src/rooms/team.test.ts`: the lead (Codex) hands to the builder (Claude), who writes in the worktree and hands to the reviewer (a second Claude account), who asks for a test; the builder adds it, the reviewer approves, and the task goes to review with the work in checkpoints.
- [x] A new task gets its default team picked by the decision provider, with the decision recorded (same file: the pick, the room line, and the decision log entry with the task).

### Lead orchestration and parallel planning (PRV-32)

- A lead (or the boss) given a parent task splits it (`tasks.split` with `start`), is woken when a child reaches review, reviews it, closes it with the `majhi-tasks` `close` tool, and the next child starts by itself. The parent closes with a report when every child is done. Approvals for destructive and outbound actions still go to the owner.
- Before majhi starts a child by itself it checks overlap with the running tasks (changed files and named paths), removes "waits for" links between independent tasks, and checks the account's 5-hour and weekly windows. It starts, waits, hands the task to an agent on another account, or queues. One `choice` card goes to the owner only for a long wait on heavy overlap. Each step is a short line in the parent's room. `tasks.plan` (and the `plan` tool) answers "what can I start now?" without changing anything. Code: `tasks/planning.ts` (pure), `planner.ts` (inputs), `orchestrator.ts` (acts). Rules and numbers: `docs/DECISIONS.md`, 2026-09-30.
- Tests: `tasks/planning.test.ts` (paths, overlap, limits, verdicts) and `tasks/orchestrate.test.ts` (link removed, overlap waits then starts, owner card, `tasks.plan`, lead told and parent report).
- Known limits: the overlap check reads paths from task text and the worktree diff, so a task that names no paths is never held back or freed; the size and cost numbers are estimates; the queue is not saved across a restart (a sweep runs on the next status change).

### The lead builds the most efficient way (PRV-52)

- **Team facts.** `TASK.md` of a lead-mode task has "Team facts" and "How the lead plans", rewritten before every prompt to the lead (`RunDeps.beforePrompt`, `TaskService.beforePrompt`). Each member: role, model, price tier, price, effort, account and what is left of its 5-hour and weekly windows; agents of the org that could join; other running tasks with the files they touch and the overlap; up to three recent plans with the tokens each agent used. The prompt gets a short block only when the facts changed. `tasks/team-facts.ts` is pure, `tasks/team-facts-source.ts` gathers the inputs, `AccountService.cachedModels` reads the cached model list without probing.
- **The plan.** A lead states its plan in the first reply and records it with `record_plan` (`majhi-room`, lead only). The room shows a plan line (`team-plan` item). `tasks/plans.ts` and `store/plans.ts` keep each version in `task_plans` (migration 70) with the team at that time. At review or done, each version gets the tokens each agent used from its time to the next version's, subtasks included, and the room gets one line for the latest. A lead working alone now gets `majhi-room` too.
- **Tests:** `tasks/team-facts.test.ts` (models, price tier, limits, joinable agents, running tasks, TASK.md lines, wake block, recent plans) and `tasks/brief.test.ts`. `store/store.test.ts` lists the new table. Nothing else is tested, on purpose: the plan tool, the outcome and the web line are wiring.
- **How to try it:** start a lead-mode task and open its `TASK.md`; the lead's first reply should state a plan, and the room shows it as "Plan". Move the model of an agent in the room: the next wake shows the new one.
- **Known limits:** the outcome splits by time, so a turn that spans a plan change counts in the version it ended in; a model set for the task is shown as is, even when the account does not offer it; recent plans need finished tasks with a plan, so the block is empty at first.

### What works

- **@mention routing (5.3).** An agent's last message of a turn is read for @mentions, and each mentioned teammate is woken with a handoff prompt: the message, a TASK.md pointer, recent room lines and the diff stat. The room shows "@acme-lead handed to @acme-builder". `@owner` hands the task back. A mentioned agent from outside the team joins when it may work in the org. TASK.md has a Team section: who is in it, the mode, and how to hand work on.
- **Owner messages** go to the mentioned agents (several at once is fine), else to the lead. The owner's message resets the loop guard.
- **Three modes**, picked in "In this room" or with `tasks.update mode`:
  - Lead delegates: mentions route. When the reviewer approves and wakes nobody, the room says so and the task goes to review.
  - Pipeline: lead, builders, reviewer, tester, each once, in order.
  - Build and review loop: builder and reviewer alternate until APPROVED, at most 5 rounds, then the room pauses and asks.
- **Loop guard.** After 12 agent-to-agent turns without the owner (org override `rooms.max_agent_turns`), the task pauses with reason owner and says why.
- **Worktree locks.** An agent with `edit` holds its worktrees' locks for its turn. Another editing agent waits, showing "Waiting for @x to finish in api". Builders on different repos (`team.set repos`) work in parallel.
- **Team editing in the room.** Add agent, and a menu per agent: make lead, model and effort for this task, swap, remove. Commands: `team.add`, `team.remove`, `team.swap`, `team.set`. A model or effort change applies to a live session at once.
- **`majhi-room`** (`read_recent`, `post`, `mention`) for team members, and **`majhi-tasks`** (`list`, `get`, `create`, `split`, `update`, `link`) for leads and root agents. `majhi-tasks` goes through the boss's approval policy, with cards in the room, and keeps an org agent to its org. New command `tasks.split` makes children in order, each able to wait for earlier ones.
- **Dependencies.** Waiting tasks start on their own (2b). A `ready` dependency now stacks the waiting task's branch on the dependency's working branch, and majhi rebases it after every checkpoint of the dependency. Conflicts are aborted and named in the room.
- **Decisions in teams.** The default team comes from the org's `team` when set. Otherwise the decision provider picks one of: one agent; builder and reviewer; lead, builder and reviewer. The pick is recorded, and the rules pick one agent when the provider is not sure. The decision provider also reads unclear reviewer verdicts in the review loop, and flags a lead-mode message that needs the owner while others work.
- **Laya in Docker** for Linux and Windows. It is the `laya` compose service (`laya-serve` 0.3.22, PyTorch CPU), which `make up` builds everywhere but Apple silicon Macs. It starts on the first question and stops after 10 idle minutes. The provider tries native Laya first.
- **Settings.** Hub setup, Settings has a Teams group (agent turns without you, review rounds). `orgs.update` takes `team` and `rooms`.
- **The boss** has every new command through `majhi-admin` (`team.*`, `tasks.split`, `tasks.update mode`, `settings.set rooms`, `orgs.update team`).
- **Background processes (PRV-33, 5.15).** Agents start slow or long-running commands through the `majhi-processes` MCP tool (`start`, `list`, `output`, `stop`, `restart`), which every session gets. majhi runs them with `/bin/sh -c` through the session's own spawner, environment and mounts, at most 5 at once per task, and refuses a second copy of a running command. When a `wait` process exits by itself, majhi wakes the agent that started it with the exit code and the last lines, and a task in review runs again. While one runs, the task stays running and the room says "Waiting for p1 `pnpm test`". Each prompt says what already runs. The Processes card in the task view shows each one with its output and a Stop button (`processes.stop`). Stopping, closing or removing the task stops its processes. TASK.md no longer tells agents to run tests in the foreground.

### How to try it

1. Make three agents in one org, for example a Lead, a Builder and a Reviewer, on Claude and Codex accounts.
2. New task: "add a health endpoint to api". With several teams possible, the room says which team the decision provider picked. Or name the team: "@acme-lead @acme-builder @acme-reviewer add a health endpoint to api".
3. Watch the handoff lines. Change the mode, add or swap an agent, or set a model from the menu next to each agent.
4. Ask the lead to split the work: it proposes `tasks.split` with a card to approve.
5. On Linux: `make up` builds Laya's image; Hub setup, Decisions shows "Laya runs in Docker".

### Left and known issues

- **Not run with real CLIs or Docker here.** The flows run against fake sessions. The Laya image was not built: `laya-serve`'s request and answer shapes were read from its 0.3.22 source. The owner's review step: `make up` on Linux (or `LAYA=docker` on the Mac), then "Ask the decision model" in Hub setup.
- The first question to Laya in Docker downloads the English checkpoint (about 850 MB). It can pass the 3-minute limit on a slow line; that question then falls back to the next provider.
- A lock covers a whole turn, so two editing agents on one repo take turns even when one only reads. Reviewers should not have `edit`.
- An agent added to the team mid-session gets `majhi-room` from its next session.
- Changing the mode starts the new mode's turn order from its first step.
- The Orgs form does not show the default team or the loop guard yet; the boss and `orgs.update` set them.
- "Needs you" lines use the decision provider. With the ACP stand-in in the chain, each one costs a small prompt.
- Background processes live in memory: a restart of majhi ends them. In container mode their ports are not published to the Mac yet, so the card's port link works only in local mode.
- No new Playwright spec: the done-when runs as integration tests. `sh scripts/ci.sh` and e2e were not run from this task.

### Goal

Done when: lead, builder and reviewer on different tools complete a task together, and the reviewer catching an issue causes a fix round; a new task gets its default team picked by the decision provider, with the decision recorded.

### What I will build, in order

1. **Contract.** A coordination mode per task (`lead`, `pipeline`, `review-loop`), per-task agent overrides (model, effort, repos), a `handoff` room item, `rooms` settings (`max_agent_turns` 12, `review_rounds` 5, orgs override `max_agent_turns`), and commands `team.add`, `team.remove`, `team.swap`, `team.set`, `tasks.split`, plus `mode` on `tasks.create` and `tasks.update`.
2. **Routing.** Every agent turn's final message is parsed for @mentions. A mention wakes that agent with a handoff prompt: the message, the TASK.md pointer, a short room summary and the diff stat. Owner messages go to the mentioned agent, else the lead. Mentioning an agent outside the team adds it when it may work in the org. The three modes and the loop guard (pause with reason `owner` after 12 agent turns without the owner) are one pure module. A worktree lock per edit turn, so two agents never edit one worktree at once.
3. **MCP servers.** `majhi-room` (`post`, `mention`, `read_recent`) and `majhi-tasks` (`create`, `list`, `get`, `update`, `split`, `link`) at `/mcp/room` and `/mcp/tasks`, one bearer token per session, `majhi-tasks` through the boss's approval policy and limited to the agent's org.
4. **Dependencies.** Waiting tasks start on their own (built in 2b); `ready` dependencies stack the branch on the dependency's working branch and rebase when it moves.
5. **Decisions in teams.** The default team for a new task is picked by the decision provider from teams built of the org's agents, with the decision recorded on the task; whether an agent message needs the owner, and whether a reviewer approved. Laya in Docker (`laya-serve`, PyTorch CPU) for Linux and Windows, behind a compose profile, started on first use and stopped when idle.
6. **Web.** Handoff lines in the room, the mode picker, team editing in "In this room" (add, remove, swap, model and effort).

### How I will test it

- Unit: mention parsing, routing per mode, the loop guard, worktree locks, the approval rules, the team options.
- Integration with fake sessions: the done-when scenario (lead delegates, builder, reviewer asks for a fix, builder fixes, reviewer approves, task goes to review), pipeline order, the review loop's round cap, the loop guard pause, locks between two builders, `majhi-room` and `majhi-tasks` over HTTP with a real MCP client, a `ready` dependency stacked and rebased, the team decision recorded.

## Phase 2c: Tokens, cost and runner isolation (built, waiting for owner review)

Branch `task/prv-17-phase-2c-tokens-cost-and-runner-isolatio`, from `main` (Phase 2b merged). Desktop notifications and the two backups are their own tasks (PRV-29, PRV-30, PRV-31) and are not part of this branch. The plan below is kept for reference; the result comes first.

### What works

- **Every turn is recorded.** Each prompt an agent finishes writes one row to `turns` (`majhi.db`, migration 40): input, output, reasoning, cache read and cache write tokens, cost, model, task, agent, account, org, project, run and time. majhi's own prompts (`/compact`, handoff notes) and the decision stand-in's answers count too. What each CLI reports, and what is estimated, is in `docs/DECISIONS.md`.
- **Cost.** A cost the agent reports is used as is: real on an API-key account, the equivalent API price on a sign-in account (marked estimated). Otherwise majhi prices the tokens from the price table (marked estimated). A turn with neither is counted as unpriced, never guessed. The table has Claude's prices built in (checked 2026-09-25); the owner adds or changes rows on the page (`prices` in `majhi.yaml`, with history and undo).
- **Health and usage, "Tokens and cost".** Today, this week and this month, filters by org, project, agent, account and model (the sidebar org preselects it), a 30-day chart split into real and estimated cost, this month's top tasks, the unpriced count with a link to the price table, and the price table itself. API-key accounts show today's and this week's cost in the accounts table. The task header shows the task's total; org cards show the month's cost.
- **Commands.** `usage.summary`, `usage.breakdown` (by org, project, agent, account, model, task or day, for a named range or from/to days), `usage.turns` (the rows themselves), `usage.prices`, `usage.setPrice`. The boss has them through `majhi-admin`; the reads run without a confirm card, so "what did Acme cost this week?" is one tool call.
- **Runner isolation.** With `make up`, agents no longer run in majhi's container:
  - Each session starts its own container from the new `majhi-runner` image (pnpm, build tools, Playwright's Chromium).
  - A container mounts only the task folder, each task repo's `.git` (`config` and `hooks` read-only) and the account's own home.
  - A guard refuses anything else: `~/.majhi` and other accounts' homes, the secrets key, the Docker socket, system folders, symlinks included.
  - Secrets reach a run only as environment variables, passed by name.
  - Runners are on their own network, where majhi answers only `/mcp`.
  - Health and usage has an "Agent runner" check that starts a throwaway runner the same way and proves it cannot see `~/.majhi`, the secrets key or another account.
  - The server image no longer carries the dev toolchain.

### How to try it

1. `make up` (builds both images; the host helper's Update does the same from now on). Health and usage should show "Agent runner: Agent runs are isolated".
2. Run a task or two in two orgs. Health and usage, Tokens and cost: pick an org, a project, an agent. The task header shows the task's total.
3. Ask the boss (Cmd J): "What did Acme cost this week?"
4. On a Codex account, set a price for its model in the price table (Codex reports no cost).

### Left and known issues

- **Not run with real Docker.** Docker is not available where this was built. The Docker arguments, the mount guard and the network guard are unit tested, and the spawner is tested against a stand-in `docker`. The owner's review step: `make up`, then check that "Agent runner" passes and that a real task runs, builds and commits in its runner.
- The first `make up` builds the runner image with Chromium: expect several minutes and about 1.5 GB.
- Codex reports only the last model call of a turn, so its token counts are low for turns with several calls. Claude's are complete.
- Reported cost follows the adapter process. A resumed session's first turn may include cost from before the resume if the CLI counts it.
- A new price applies to new turns only; the unpriced count stays until turns are priced.
- Sign-in, health probes and usage reads still start the CLIs in the server container (they touch only the account home).

### Goal

Done when: after a few runs on two orgs, Health and usage shows correct totals per org, project, agent and model that match the sum of the recorded turns, and the boss answers a cost question from the same data; and an agent run cannot read `~/.majhi`, the secrets key or another account's home.

### What I will build, in order

1. **Recording.** `packages/acp` emits one `turn` event per prompt: input, output, reasoning, cache read and cache write tokens from the prompt response, the cost the adapter reported for that turn (the change in its running session cost), and the model. The server writes one row per turn to a `turns` table with the task, agent, account, org, project, run and time. Cost: an API-key account's reported cost is real; a sign-in account's reported cost is the equivalent API cost, marked estimated; without a reported cost, majhi prices the tokens from a price table (built-in defaults for Claude models, owner rows in `majhi.yaml` under `prices`), marked estimated.
2. **Commands.** `usage.summary` (today, this week, this month, a daily series and the top tasks, with filters), `usage.breakdown` (totals grouped by org, project, agent, account, model, task or day), `usage.prices` and `usage.setPrice`. The boss gets them through `majhi-admin` like every command.
3. **Web.** A "Tokens and cost" section on Health and usage: three totals, filters by org, project, agent, account and model, a daily chart, the top tasks. The task header shows the task's total; org cards show the month's cost; API-key accounts show today and this week in the accounts table.
4. **Runner isolation.** A separate `runner` image with the dev toolchain (pnpm, build tools, Playwright). The server starts each agent session in its own container on the runner network, mounting only the task folder, the `.git` of each task repo (its `config` and `hooks` read-only) and the account's config home. A guard refuses any mount of `~/.majhi` (other than the run's own account home), the secrets key, or another account's home. Secrets reach the run only as environment variables. From the runner network only `/mcp` answers. A Health check starts a throwaway runner and proves it cannot see `~/.majhi`, the secrets key or another account's home.

### How I will test it

- Unit: per-turn usage from the adapters' shapes, cost rules and price matching, day, week and month ranges in the owner's time zone, the docker arguments and the mount guard.
- Integration: turns recorded through the run manager with the fake adapter on two orgs, totals from `usage.summary` and `usage.breakdown` equal to the sum of the rows, and the boss (fake adapter) answering from `usage.summary` through `majhi-admin`.
- Real Docker is not available where this is built, so the runner container itself is checked by the Health check on the owner's machine.

## Phase 2b: The boss and staying cheap (in progress)

Wave 1 and the decision provider are merged into `main`. Wave 2 (the run manager) is task PRV-15, from `phase-2b`, following `docs/briefs/2b-wave2.md`. PRV-14 is the parent: it tracks the phase and runs the integration step once PRV-15 is done.

### Done when, status

- [ ] A fake agent pushed past 80% context gets compacted, with the event shown in the room. PRV-15.
- [x] The boss creates an org and an agent after the owner approves (`e2e/phase2b-boss.spec.ts`).
- [ ] A running task resumes on its own after the network drops and returns, and after majhi restarts, with its work intact. PRV-15.
- [ ] An `auto` agent gets a model and effort picked by Laya, with the decision recorded on the run. The pick itself is built (`decisions.pickModel`); calling it at session start is PRV-15.
- [x] With Laya stopped, the chain falls back to the ACP simulation, then rules (`decisions/integration.test.ts`).
- [x] Task links, and no manual work outside majhi.
- [ ] Agents on demand, concurrency limits, and the two-agents-on-one-account check. PRV-15.

### Goal

Done when: a fake agent pushed past 80% context gets compacted with the event shown in the room; the boss creates an org and an agent after the owner approves; a running task resumes on its own after the network drops and returns, and after majhi restarts, with its work intact. Plus task links, concurrency limits, and no manual work outside majhi (update, health, protected folders).

### What I will build, in order

1. **Contract** (done): settings (context, limits, resume, approval policy), org overrides, task links on summaries, agent live states `queued`/`paused`, room items `approval`, `secret-request`, `context`, and commands: `tasks.link|unlink`, `room.fresh|approve|secret`, `secrets.list|save|remove`, `history.list|undo`, `settings.get|set`, `policy.set`, `boss.chat`, `health.run|fix`, `system.version|update`.
2. **Wave 1, in parallel** (done):
   - **Boss:** `majhi-admin` MCP server exposing every command as a tool, attached to the boss's sessions; approval policy with confirm cards; undo from config history; secret capture and secret requests; Cmd J boss chat; onboarding step 4; Hub setup becomes the boss conversation, with history and settings.
   - **Task links:** parent and child tasks, `depends-on` with the Waiting on chip, progress on parents, links in TASK.md, in the New task dialog and the task view.
   - **No manual work:** Health view with every doctor check and Fix buttons; Update ready and one-click update through the host helper; warning before mounting a macOS-protected folder; majhi and Docker start at login.
   - **Decision provider** (done, moved in from Phase 3): Laya on the Mac, the provider chain, `majhi-decide`, the Decisions section in Hub setup.
3. **Wave 2** (PRV-15, not started): one agent owns the run manager: context budget (meter, native compaction, handoff, rotation, Fresh session), checkpoints after every turn, automatic resume after sleep, restart, crash and lost internet, agents on demand with idle stop, concurrency limits with a queue, and the decision hooks (`attachTool`, `auto` model picks).
4. **Integration** (PRV-14, after PRV-15): e2e for the done-when with the fake adapter, `make ci`, then the owner uses it.

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

### Task links (built)

- **Parent and child tasks.** A task has at most one parent. Parents show their children nested with progress and close when every child is done. When a parent is removed, its children become top-level.
- **Depends on.** Manual `depends-on` links with cycle checks and a "Waiting on" chip on the board and in the task view. A task created with unmet dependencies stays `ready` and starts on its own when they are met. `tasks.start` answers 409 "Waiting on X, Y". Removing a dependency pauses its waiting tasks and asks what to do. `merged` counts as met when the target is `done`, until MRs exist (Phase 4).
- **TASK.md** lists related tasks.
- **Tests.** E2E `e2e/phase2b-links.spec.ts`: a dependent task waits, shows it on the board and starts when its dependency is done; a parent shows progress and closes.

### Decision provider (built)

- **Chain.** Laya, then the ACP stand-in agent, then rules, with every decision logged. Jev exists behind an unverified client and stays off. The order changes through the config history.
- **Laya on the Mac.** The host helper installs `laya-mlx` in `~/.majhi/laya/venv` and runs a local service that loads the model on the first question and unloads it after 10 idle minutes.
- **`majhi-decide`** at `/mcp/decide`, with its own tokens and a per-run call limit. `pickModel` for `auto` agents, with a confidence floor, is built behind the run manager interface; wave 2 calls it.
- **Hub setup** has a Decisions section: install, provider order, an "Ask the decision model" box and recent decisions.
- **Tests.** `apps/server/src/decisions/*.test.ts` (Laya through a fake helper, the fallback chain, order changes, model picks, the decide tool limit) and `e2e/phase2b-decisions.spec.ts`.

### No manual work outside majhi (built)

- **Checks in the UI.** `apps/server/src/health/checks.ts` holds every doctor check, shared by `make doctor` and `health.run`. Health and usage has a "Checks" section above Accounts: grouped rows (majhi, This Mac, Git over SSH, Accounts, Disk) with a dot, label, detail and a Fix button. Fixes (`health.fix`, `health/service.ts`): mount an unmounted root (helper remount), create the config or tasks folder, reload SSH keys (also for a git host that took no key), check an account again, open an account's sign-in terminal, restart the helper. Checks with no fix say the exact step. The sidebar "need you" count adds failed checks (not warnings, not account checks).
- **Update.** The image bakes `MAJHI_COMMIT` (Dockerfile ARG, `make up`, the helper). `/health` reports it. The helper reports its checkout's HEAD and dirty flag; `system.version` lists commit subjects through the `version.changes` job. The sidebar shows "Update ready" under the logo with the changes and an Update button (or the `make up` command when no helper is connected). `system.update` starts the helper's `update` job; the "Updating majhi" screen lives above the app gate, shows the helper's progress lines from `~/.majhi/update.json`, keeps showing them while the server is down, and reloads when `/health` answers with the new commit. A failed build leaves the old majhi running and says why.
- **Protected folders.** `protectedFolder(path, home)` (shared) flags Documents, Desktop, Downloads and iCloud Drive. The roots form warns before saving, naming OrbStack or Docker Desktop (the helper reads `docker info`).
- **Start at login.** The helper, which launchd starts at login, opens Docker if `docker info` fails (waits up to 2 minutes), then runs `docker compose up -d --wait` when majhi's container is not running. It retries twice a minute apart and then posts one macOS notification with the step to take. Decision logic in `apps/host/src/startup.ts`, tested with injected commands.
- **Try it.** In the owner's checkout after merge: `make up` once (bakes the commit, installs the new helper). After that, commit something and open majhi: "Update ready" appears; click Update. Health and usage shows the checks. Real Docker, launchd and the notification were not run for real here.
- **Tests.** Unit: check mapping, version compare, protected folder, startup decisions, update steps with fake docker and git, helper jobs, web models. Server integration with a fake helper: `health/ops.integration.test.ts`. E2E: `e2e/phase2b-ops.spec.ts` (part of the default suite).
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
