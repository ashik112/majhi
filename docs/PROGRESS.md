# Progress

## Hand-off check tests only the change (not merged)

Branch `feat/handoff-changed-tests`.

- **What changed.** A project in majhi.yaml can carry `handoff: { test, build, lint, typecheck }`. Set lines win over the project card's, command by command. In a test line, `{base}` becomes the merge-base commit of the task branch and its target. majhi computes the sha itself and refuses anything but 40 lowercase hex characters; task text never reaches the shell. A failed substitution fails the step and says why. `projects.update` takes `handoff` (null clears it). The project page has a "Check before ship" section, one row per command.
- **What the owner will notice.** With `pnpm exec vitest run --changed {base} --passWithNoTests` as the majhi project's test line, the check runs only the tests that import the changed files (vitest follows the import graph; a change to a file that services.ts reaches still runs about a quarter of the suite, a leaf file runs its own test).
- **Verified.** `handoff/commands.test.ts`, `handoff/service.test.ts`; typecheck clean. In a scratch worktree, `vitest --changed <sha>` ran 1 of 426 files for a leaf change and none for no change.
- **Left.** The check has no typecheck step yet; the field is stored for when it does.
## Health & usage page that checks everything (built, not merged)

Branch `fix/health-page`.

- **Causes.** "Run health check" only ran each account's health, then re-read `health.run`, which shows each connection's last test and runs none. The owner had to press Test on every row. The page body was cut off on wide screens (patched in 08a38104), and two inner lists with `overscroll-contain` still swallowed the wheel, so scrolling stopped halfway on narrower screens.
- **One action.** `health.checkAll` runs the doctor checks, every account's health and every set-up connection's real check, four at a time, in the background. A check that throws shows as failed and never stops the rest. Each finished check emits a `checks` event, so rows update live; the button reads "Checking 12 of 31", then the header says "Checked 31: 28 ok, 3 need you". `health.check` rechecks one row. `health.run` now carries `checkedAt` per row, `lastFullRunAt` and the run's progress.
- **Fresh by default.** Opening the page starts a run when the last full run is older than 15 minutes (`healthRunDue` in `packages/shared/src/health-run.ts`). The last run time is kept in memory, so the first visit after a restart always runs.
- **Failures first.** "Needs you" lists failing, then warning rows: what is wrong, one fix button (Sign in, Reconnect, Open settings, Restart helper, Free space now, and so on) and when it was checked. Passing rows fold into "All good". Every row has a small "Check again"; a failing row with no fix shows it as its one button. Connection rows now say Reconnect (opens that connection) or Open settings, and no longer offer "Test".
- **Layout.** One column that scrolls inside the shell: checks, then accounts usage and spend, then money, then cleanup. Usage lists no longer trap the wheel.
- **Cleanup.** The panel previews on open and says what it would free ("Would free 4680 room items in 156 tasks"), with one "Run cleanup" button and a confirm. "Choose tasks" and "Only dependency caches" stay as options.
- **Verified.** Typecheck 0. Tests: check-all orchestration (all kinds run, concurrency bounded, one failure does not stop the rest, results carry timestamps, no second run), stale-run decision. In a real browser on an isolated e2e server at 1440x900, 1100x800 and 1440x1200 with fake accounts and env connections (passing and failing): auto-run on a stale page, no second run on reload, every row's time changes on Run, failing rows on top, no per-row Test, wheel scroll reaches the cleanup panel, preview then run, 0 console errors or failed requests. Log and PNGs in the scratchpad `health-page/`.
- **Left.** Real sign-ins, real provider connections and a real helper are for the owner.
## Skills reach agents on demand, and bulk switches per workspace (fix, not merged)

Branch `fix/skills-delivery`.

- **Cause.** The delivery code was sound: with the live lock (60 default-on skills) `effectiveFor` returns all 60, `prepareRunSkills` copies them and returns the read-only mount, and the deployed `dist` has the same launch code. The three containers checked (PRV-121, PYZ-6, PRV-125) were background-process containers (`/bin/sh -c 'pnpm run test'` and the like, label `majhi.task`), not agent sessions, so they correctly have no skills mount. The real gaps were the delivery itself: skills were only a prompt note, which Claude Code's own Skill tool never sees, and the note listed all 60 skills with paths (about 29,000 characters, 7,300 tokens) at the start of every session. Also an opt-out did not restart an open session.
- **Fix.** Claude Code in a runner container gets the run's skills at `<task folder>/.claude/skills` (per-run read-only bind mount, new `RunMount.target`, allowed only at that path and read-only), so the CLI lists names and descriptions itself and the prompt adds 0 tokens. Other CLIs get one line (about 60 tokens) and the `majhi-skills` MCP server with `find(query)`. Opt-outs and bulk changes restart the agent's open sessions.
- **Bulk and workspace switches.** `skills.setMany {skills, target: all | workspace | agents, on}` writes one lock change. A workspace rule is stored, so agents created later in that workspace follow it. Page: tick skills (checkbox, shift-click range, `x`), then On/Off per workspace chip or Every agent; with nothing ticked it applies to the skills shown. Detail panel: a switch per workspace group (on, off, mixed).
- **What the owner will notice.** The first prompt of a session no longer lists skills. Agents still find and use them. A bar of workspace chips on Skills & MCP.
- **Verified.** Typecheck 0. Tests: `apps/server/src/skills/skills.test.ts` (started and resumed run get mount and note, an opted-out skill is not mounted, `find` returns an enabled skill and nothing for an opted-out one, workspace off/on and agents/all targets, later agents follow the workspace rule, unknown skill changes nothing), `apps/server/src/runs/skills.test.ts` (overlay mount, note size, ranking), `packages/acp/src/runner/docker.test.ts` (overlay target guard). Browser check on an isolated server at 1440x900 and 1100x800: `scratchpad/fix-skills-delivery/run.mjs`, 22 checks all pass.
- **Left.** Native listing in Claude Code is proven by the mount path and arguments in tests, not by a real Claude run in a container: after the next deploy check one run.

## Start runs the agent (fix, not merged)

Branch `fix/start-runs-nothing`.

- **Cause.** `tasks.start` on a task paused `blocked` lifted the hold and set `running`, then asked the run manager to start the agent. The brief had been sent long before, so nothing was queued, and an empty queue starts no turn. The task said `running` with no run, no container and no room line. The command also dropped `message` (not in its schema).
- **Fix.** `startTask` queues a resume prompt when nothing is queued (not when the caller delivers an owner message itself). `tasks.start` takes an optional `message` and sends it through the normal owner-message path. If a start still leaves no agent with work, the task gets an `idle` hold with a room line instead of staying `running`. `tasks.send` now awaits its start check.
- **Verified.** `apps/server/src/tasks/start-runs.test.ts`.

## Connections v2: every service connects, and "connected" means a real call passed (built, not merged)

Branch `feat/connections-v2`.

- **What changed.** One typed state per connection (`connecting`, `connected` with `verifiedAt` and what was checked, `failed` with a typed reason and the fix, `needs-attention`). There is no separate "tested". A check ends in a reason read from an HTTP status, an MCP error code or an exit code, never message text (`packages/shared/src/connection-health.ts`, `apps/server/src/connections/health.ts`). States are saved (migration 157), re-checked every four hours, set once at startup for connections that had none, and a refused renewal fails a connection at once.
- **Every service has a path.** One click: 13 verified plus Cloudflare (full), Neon, PayPal, Intercom, Canva, Webflow, Zapier. MCP server by address (probe, then one click or a header token). On this Mac: gh, glab, vercel, stripe, aws, gcloud, az, each with a check command run signed out for its exit code. Token: GitHub (fine-grained page prefilled), GitLab, Bitbucket, Linear, Sentry, DigitalOcean, each checked with real calls before anything is saved. Own app: one Google card (guided sheet, then live checks for API on and app published), Slack, Discord, Outlook.
- **Git hosts.** GitHub Enterprise, GitLab self-managed and Bitbucket Server work through a host field. A git sign-in is also a `git` connection with its own state. `hostFor` now validates instead of refusing. Bitbucket's user name is read from `nickname` (the old `username` field is gone from Atlassian's API).
- **Self-hosted safety.** Hosts that are or resolve to private, loopback or link-local addresses are refused unless the owner confirms; metadata addresses never pass; number tricks are normalised; redirects are never followed with a token; every call a server added by address leads to goes through the same guard.
- **Removed.** GitHub device entry, Linear API (own OAuth app), X, LinkedIn, wrangler, Sentry CLI. Duplicates (Linear, Sentry, Vercel, Stripe, Cloudflare, GitLab MCP, DigitalOcean token) are "Other ways" of one service. Asana is not offered (no registration endpoint).
- **UI.** `connections-view.tsx` (rows by method, one lamp per row), `connection-detail.tsx` (side panel), `add-dialog.tsx` and its bodies. The old catalog page and its stub screenshot scripts are gone.
- **Verified.** Typecheck 0. Tests: shared state machine and address checks; health service; typed tester outcomes; provider and MCP connect flows (pass, fail, re-check, Google steps); token connect (no token in URL, log or state); git host checks and host guard; MCP by address; git link. In a real browser on an isolated e2e server at 1440 and 1100 (empty state, add dialog, host refusal, MCP by address connect and failing re-check, Google guide, 20-row list in every state, light theme), 0 console errors or failed requests. The helper ran with fake CLIs first on PATH.
- **Left.** gh and glab browser sign-in, Bitbucket Server and GitHub Enterprise against real servers, and Google's real consent and publish flow can only be checked on the owner's accounts. Atlassian's Bitbucket MCP tools (API token, admin switch) are not wired.

## Secret scan and package store fixes (built, not merged)

Branch `fix/scan-and-store`.

- **Scan.** `field_name=COUNTER_AUTO_DELIVER_LOG_FIELD` was flagged as a `token`: the generic pattern includes `=`, so the whole `name=VALUE` text scored as one random string. Now a bare code name (all upper or all lower case, words split by `_`, dotted paths such as `settings.API_TOKEN`) is skipped by the token and `assigned` rules. A random blob mixes digits inside its letters, so it still counts. Added: a hex value of 32+ characters after `api_key`, `token` and the like is flagged, and a quoted literal of 8+ characters (`password="hunter2xyz9"`). Vendor rules are unchanged.
- **Store.** Agent runs and background processes already got the shared store. The hand-off checks and the task terminal did not, so a check's `pnpm install` created `.pnpm-store/` in the worktree (which the hand-off then refused as uncommitted, and agents committed). Both now get the workspace store mount and `npm_config_store_dir`, `PNPM_STORE_DIR` and the cache variables through the environment. No repo file is edited.
- **Hand-off check.** Uses structured `git status --porcelain=v1 -z`. Ignored files, and untracked `.pnpm-store` and `node_modules` at any depth, do not count. Modified tracked files and untracked source files still block.
- **Verified.** Unit tests for the detector, the status filter against real git, and the hand-off run environment. Typecheck clean.
- **Left.** A store already committed to a branch stays in its history; the owner or the lead must remove it from the branch.

## Faster test suite (built, not merged)

Branch `perf/test-speed`. No test was deleted, skipped or weakened.

- **Numbers.** Same command both times: `vitest run --maxWorkers=4 --testTimeout=60000`, on a shared Mac under load from other agents (load average 15 to 21), so read them as a ratio. Full suite wall time: **9:28 before, 7:18 after** (4045 tests pass, 0 fail; 3992 before, the difference is 28 new tests here plus main's). Sum of per-file time: 1798 s before, 1335 s after. The 2 minute target was **not** reached under this load; a run on a quiet machine is still to be measured.
- **Per-file runs, one file alone (`--maxWorkers=1`), before to after:** settings.test 8 s to 4 s, send-back.test 12 s to 7 s, captain/done-when 18 s to 12 s, rooms/team 45 s to 16 s, tasks/shipped 26 s to 18 s, memory/housekeeper 19 s to 7 s, rooms/idle-watch 35 s to 16 s.
- **Slowest 15 files, before (s):** mrs/flow 125, runs/attribution 62, rooms/team 57, mrs/multi-repo-ship 55, rooms/idle-watch 44, tasks/shipped 36, tasks/picked-repos 35, budgets/limit 35, rooms/mcp 34, captain/tell-ship 29, handoff/script 28, tasks/orchestrate 25, gitConnect/integration 24, notify/notify 24, host/checkScript 24.
- **Slowest 15 files, after (s):** mrs/flow 99, runs/attribution 65, mrs/multi-repo-ship 44, host/checkScript 42, host/hostScript 35, rooms/idle-watch 29, rooms/team 29, tasks/shipped 28, captain/lane-reads 26, budgets/limit 23, handoff/script 23, backup/backup 23, captain/tell-ship 20, tasks/census-guard 19, captain/done-when 18. (The after run was under heavier load than the before run.)
- **Transform time.** `fsModuleCache: true` in `vitest.config.ts` (vitest 5.0.2). On a two file run transform went from 44% of 5.6 s to 16% of 3.2 s, and transformed modules now persist between runs and worker processes (`node_modules/.vitest-cache`). The full run used the JSON reporter, so its transform line was not captured.
- **Git processes, `captain/done-when`:** 1225 before, 929 after (this includes building the templates, which a normal run does once for all files). `mrs/flow`: 7084 before, 3772 after, counted with a PATH shim.
- **What changed.**
  - The sample world (org, account, agent, repo, project, config history) is built once per run and copied for each test (`testing/template.ts`, `testing/global-setup.ts`, `taskWorld`). The build fails if any file other than the listed repo config names the template's own folder. Sample repos made by `addRepo` are templates too. Each world still starts the project's card in the background, as registering the project did, because tests wait for it.
  - Config changes use 3 git processes instead of 6 (`ConfigHistory.hasChanges` is one `status`; `commit` is `add` and `commit`, and only a failed commit looks at the index). `commit` now returns whether it committed, not the hash; nothing used the hash.
  - Product git, a real speed win for the server too: `git/repo-config.ts` reads the repo's own config files and skips the `git config --get-regexp` that ran before nearly every git command, unless the config sets a key that could run a command, includes another file, or cannot be read in full (then git is asked, as before). `git/refs.ts` answers "does this branch exist" from the loose ref file or `packed-refs` instead of `git show-ref`, and leaves reftable, odd names and unreadable cases to git. Both have tests that compare against real git, including planted filters and worktrees.
  - `host/testing/scripts.ts` looks each tool up once per process.
- **Measured, no change.** Pool and isolation: 18 shared test files take 0.8 to 1.0 s under forks, threads or no isolation, so startup is not the cost; left alone. Polling helpers already poll every 5 to 10 ms with long deadlines, so no wait change was needed.
- **Where the time still goes.** Process spawns (git, shell hooks). Under load one git call costs 30 to 45 ms. Largest left: `runs/attribution` runs majhi's real hook scripts on every ref update (that is what it tests); `git remote` and `git remote get-url` (about 10% of git calls in `mrs/flow`); `git status` in ship checks; each test's own `accounts.create` and `agents.create` commands (each is a config commit); the per-world card scan; host script tests that start shells.
- **Watch.** One run (the counted one, before the card fix) had a single `orgs.create` config commit fail in `connections/mcp.test.ts` under load; it did not repeat in 6 parallel reruns or in the final full run. If it comes back, look at concurrent git in the config home.
- **How to try it.** `pnpm vitest run <file>`; the templates live in a temp folder made and removed by the run.
## Mac notifications show as majhi, and say so when macOS has them off (built, not merged)

Branch `fix/mac-notifications`.

- **Cause.** The first terminal-notifier post asked macOS for permission under the helper's 10 second timeout. The helper ended the process while the question was on screen, and macOS counted that as a No for good (`tccutil reset UserNotification` does not undo it here). From then on terminal-notifier exited 3, and majhi fell back to osascript, which macOS shows as Script Editor, with a click that opens Script Editor.
- **Fix.** No osascript on macOS. The notifier result is typed from the exit code: `shown`, `blocked` (exit 3), `unavailable`, `failed`. Blocked raises one Needs you item, "Mac notifications are off for majhi", with "Open Notification settings" and "Check again" (the item clears when a test notification shows). It also reaches the banner and the Home list through the existing decision list (kind `notifications`, label Access).
- **Shows as majhi.** The helper builds its own small app (`majhi.app`, bundle id `dev.majhi.alerts`, the majhi icon, ad hoc signed, verified) with `swiftc` at start. It falls back to terminal-notifier where there are no Command Line Tools. The permission question is asked once, at helper start, by a process that is never ended early. See DECISIONS, 2026-10-05.
- **What the owner will notice.** After the helper restarts, macOS asks once to allow notifications for "majhi". Say Yes. If it was already turned off, majhi shows the item above instead of a Script Editor banner.
- **Verified.** Typecheck 0. Tests: `apps/host/src/macNotifier.test.ts` (exit 3 is blocked and nothing runs osascript, from the code not the text, any other code is failed, build and verify, a bad signature or a program that does not start installs nothing, the question is asked without the short timeout, terminal-notifier fallback with its pinned hash), `apps/server/src/notify/mac-access.test.ts` (one item however many alerts are blocked, cleared after a shown test, raised again if blocked again). Real build on this Mac: compile, icon, ad hoc signature and `status` all pass, and usernoted accepts the bundle and shows its permission question. Browser: the new item on Home and Needs you at 1440x900 and 1100x800 (the server list was stubbed to add the item, since the e2e helper has notifications off).
- **Left.** Pressing Allow on the macOS question and a click on a real notification were not exercised (they need the owner). The item stays until a notification shows, even if the owner turns Mac notifications off in setup.

## Disk hygiene: caches after 1 day, old images removed after each update (built, not merged)

Branch `feat/disk-hygiene`.

- **Caches after 1 day.** New setting `cleanup.caches_after_days` (default 1). The captain's cleanup chore now runs a caches-only pass (`CleanupService.run(..., cachesOnly, cachesAfterDays)`, port `freeCaches`) for tasks done longer than that. It frees only ignored dependency and tool caches. Source, branches and room history stay. It skips a task that was reopened, was closed more recently, or has uncommitted changes in its worktree, and it re-checks each task when it runs. The 30-day full cleanup keeps `cleanup.after_days`. The owner's explicit "Preview dependency caches" button still works at once, as before. Settings row: "Free dependency caches of finished tasks after N days", above Free space in the Cleanup panel.
- **Old images after each update.** After the new majhi is healthy the helper (`apps/host/src/diskHygiene.ts`) removes `majhi-server:previous` (and Laya's), preview images `majhi-preview-<task>` of tasks that are done or gone with their buildx builders and builder state volumes, and dangling images that carry a majhi label (`majhi.container=image` or the new `majhi.owned=build` that compose puts on the images it builds). Rollback only uses the previous tag inside the same update run, so none is kept afterwards. The server writes `open-tasks.json` just before the update; without it every preview is kept. What was removed, with sizes, is a line in the update notice.
- **Removed on purpose.** The old clean-up ran an unfiltered `docker image prune -f` (it also removed other projects' dangling images) and trimmed the build cache with `builder prune`. Both are gone: the owner forbids touching the build cache and other projects' images.
- **Verified.** Typecheck 0. Tests: `tasks/cleanup.test.ts` (2 days freed, 12 hours kept, reopened kept, uncommitted kept, source and history stay), `host/diskHygiene.test.ts` (filters select only majhi items, other project's image and volume never selected, open task's preview kept, no build cache prune in any docker args), `host/update.test.ts`.
- **Left.** Volume sizes are not shown (docker does not list them cheaply). The first update after this one still leaves old unlabelled dangling images; they go the next time they are labelled builds.
## Skills & MCP page, and skills on for every agent by default

Branch `feat/skills-mcp-page`.

- **What changed.** Skills and MCP servers are one sidebar page, "Skills & MCP" (`/skills`, `g k`), under Agents. Skills left the Settings list; MCP servers left Connections. Old links redirect: `/setup?section=skills` to `/skills`, `/setup?section=mcp...` and `/connections?tab=mcp` to `/skills?tab=mcp`. Screens map, palette, shortcuts table and `?` help are updated.
- **The page.** One-line rows (mark, name and description, workspace, avatars with "N of M", lamp with the one-line reason, one button for the row's state: Enable for all, Fix, Sign in, Test, Retry). Problems sort first. A row opens a right-side detail (full description, source and version, files, last error with the fix, per-agent switches grouped by workspace, Update, Test, Remove). One Add dialog searches the directory or registry, takes a pasted link or command, and shows the preview before installing; the new row is highlighted. Keys: j/k, Enter, `/`, `a`. The install and review cards are the existing ones, moved into the dialog.
- **Default on.** A skill's lock entry has `defaultOn` and `optOut`. A new skill is on for every agent, including agents created later, because the run reads `effectiveFor(agent, listed)` at launch instead of anyone writing the skill into agent files. `skills.disable` records an opt-out; `skills.enable` clears it; `skills.enableAll` (new, "Enable for all agents" in the page) turns the rule on and clears opt-outs. Skills installed before this read as off until the owner applies Enable for all. Updating a skill keeps its flags. Skills are global (one store), so "all agents" means every agent; there is no workspace-scoped skill to narrow it.
- **Verified.** Typecheck clean; `skills.test.ts` (new test: install enables for all, an agent created later has it, an opt-out sticks, enable-all clears it), `admin/screens.test.ts`, census guard. Browser, isolated e2e server, 1440 and 1100, 16 skills, 10 MCP servers, 4 workspaces, failing, unconfigured and needs-sign-in servers, plus the empty state; no console errors or failed requests. PNGs in the branch report.
- **Left.** An open agent session does not restart when a default-on skill lands (it does when the agent file changes); the next run has it. The install progress path through a real source was not driven in the browser (no network in e2e); the dialog opens and its cards are the previous ones.

## Nothing merges unless the checks are green for the exact commit (built, not merged)

Branch `feat/merge-needs-green`.

- **Cause.** The merge decision answer (`decisions.answer` merge, `inbox/service.ts`) and the review card buttons (`room.cardAction`) call `tasks.merge` as the owner with no look at the hand-off. `TaskService.merge` itself checked only conflicts and uncommitted files. The captain's ship chore (`shipCheck`) did wait for the hand-off, but the other paths never asked. The owner's merge also ran no secret scan; only the ship readiness did.
- **The rule, in one place.** `MergeGate.checks` (`handoff/merge-gate.ts`) reads the task's head commits and the hand-off result recorded for that head, and `decideMerge` returns a typed `MergeVerdict` (`ok`, `running`, `failed` with the check, `stale`). `TaskService.merge` is the only function that merges a task branch, and it calls the gate before anything is touched. So the owner, the captain, decision answers, the ship chore, push after merge, a ship that waited for its lead and any agent tool all go through it. The gate is a required dependency of `TaskService`. Refusals are `MergeRefused` (typed, 409), and `tasks.shipOptions` returns `checks: { verdict, head }`.
- **Overrides.** Only the owner, with `confirmChecks: "<head>"` on `tasks.merge` or `room.cardAction`, and only for a failed test, build or lint check. Agents and the captain are refused up front (`refuseForAgents`, the command handlers and the card action). A wrong head is refused. The override is written to the audit trail (`merge-override`) and a room note. The secret scan is a hard block with no override, and now applies to every merge path, not only the ship readiness.
- **No checks set up** (no test, build or lint command on the project card): merges as before, and the Ship panel says "No checks set up for this project."
- **UI.** The Ship panel shows the verdict line. A stale or never-run verdict shows "Run checks"; a failed one shows "Fix with agent" (sends the failure to the lead) and "Merge anyway (checks failed: test)"; running shows a disabled "Checks running" and polls. The Needs you list blocks Merge with the verdict sentence and sends the owner to the task.
- **Also.** A done task can now be checked (its review-state checks do not apply), so its unshipped work can still be merged. The ship chore's `shipCheck` also reads the gate verdict.
- **Verified.** Typecheck clean. Tests: `handoff/merge-gate.test.ts` (running, failed test, stale, green, agent and captain refused and cannot confirm, wrong sha, owner override recorded, no-checks project), plus handoff, captain ship, mrs, inbox, admin and tasks suites. Browser on an isolated e2e server at 1440x900 and 1100x800: failed, stale, run checks, merge anyway; no console errors or failed requests.
- **Left.** MRs merged on the host by CI (`mrs.merge`, `tasks.mergeMrs`) follow the host's own CI, not this rule: they do not merge a task branch locally. Typecheck is not a separate hand-off step, so it is not in the verdict.
## Less web traffic (built, not merged)

Branch `perf/web-traffic`.

- **What changed.** Home reads no decision detail: a row shows what `decisions.list` carries (the diff stat and checks line on ship rows is gone). A detail is read only for the selected decision, under its own key (id and a version made from the list fields), so a list refetch never reads details again. `captain.log` takes `after`: a tab holding the log reads only newer lines and merges them, and reads it all again only when the catch-up filled its page. The `/health` poll runs every 30 s while the events socket is open and every 1.5 s only while it is down; the build-watch poll stops once the socket hello named the build. The server's 30 s ops tick tells the tabs only when it changed something (it used to refetch ops, decisions and findings every 30 s). The Captain drawer's code loads when it opens, and the idle prefetch of the Captain page is gone (hover still warms it), so room-pane, captain-page and decision-list no longer load on Home.
- **What the owner will notice.** Fewer requests while Home is open; ship rows on Home no longer show "+n -n" or the checks line (open the decision for them).
- **How verified.** Isolated e2e server with the new `team-api-volume` seed and running fake agents; 20 s idle on Home, Needs you and Captain, before and after. Unit tests for the topic to query-key mapping and the log merge.
- **Left.** Under churn (a task created every 5 s) `tasks.list` and `decisions.list` are still read in full 3 times per 20 s: some server events (`services.ts` emits `tasks` without naming tasks) trigger full list reads. The Captain page still reads `autonomy.status` (28 KB) on each autonomy event.

## Home as one list by who holds the ball (built, not merged)

Branch `feat/home-flow`.

- **What changed.** Home is no longer four columns. It is one list of one-line rows in sections: Needs you, Running now, Shipping, Up next, To triage, Captain handled, Done today. Empty sections are not drawn; an all-quiet Home says so and offers New task. Every row has a primary verb button that fixes its reason (Answer, Review, Resume, Watch, Fix with agent, Merge, Start now, Sign in, Raise limit, Verify, Undo).
- **Up next reasons.** New `lifecycle.blockerOf` in `packages/shared/src/lifecycle/blocker.ts` returns a typed reason for a ready or inbox task (dependency, account signed out or at limit, machine busy, no free slot, tasks at once, budget hold, not triaged, nobody started it), in the order of the lifecycle design section 5. Read through the new command `tasks.blockers`. `tasks.homeFacts` gives open merge requests with CI state and what working agents do now.
- **Keys.** j/k and arrows move through all rows, Shift+J/K jump sections, Enter opens, 1 to 3 run the row's numbered actions, x selects (then 1 runs on all selected), / filters, t opens To triage. `g` then a letter still goes to pages; Cmd J, Cmd K and Esc are untouched.
- **What the owner will notice.** Needs you is exactly `decisions.list`, so it matches the bell. At 1100px the detail and the other numbered actions drop to a second line of the focused row; the wait and the main button stay at the right.
- **Not sourced.** Per-row cost, step progress, the CI failure reason (shows "CI failed"), and why a paused task paused when no decision exists (shows "Paused, no agent is working on it").
- **Also fixed.** `guardMounts` wrote `refs/heads/task/.keep`, which fails for any branch not under `task/`, so tasks could not start. It now writes into the branch's own folder (separate commit).
- **Verified.** Typecheck clean. Tests: `blocker.test.ts`, `home-model.test.ts`. Browser on isolated e2e servers at 1440x900 and 1100x800 with about 50 tasks and live fake agents, an empty home, and a 200-task seed; keyboard flow checked; no console errors or failed requests.
## fix/autopilot-load: Auto-pilot made majhi slow (not merged)

Three causes of "slow with Auto-pilot on, captain chats do not load".

- **Stale tab after an update.** The web build writes a build id into index.html (a hash of the hashed file names). The server reports it on `/health` (`build`) and in a `hello` first frame of `/api/events`. A tab on another build reloads itself at once when no text box holds unsent text. Otherwise it shows "majhi was updated. Reload to use the new version." with a Reload button, and reloads by itself once the text is sent. At most one self-reload a minute per server build, so a stale cache cannot loop. The rule is `reloadDecision` in `packages/shared/src/build-id.ts` (test: same build, different build, unsent text, no id).
- **Hand-off checks starved the Mac.** Default CPUs per check are `max(2, floor(cores/6))`, and at most `clamp(floor(cores/3 / cpus), 1, 2)` checks run at once. On 10 cores that is one check of 2 CPUs, not two of 5. Hand-off containers run with `--cpu-shares 256`, so agent runs and the server win any contention. `containers.handoff_cpus` still overrides. See DECISIONS.
- **Captain retried what the gates refuse.** The wake digest now says which gate holds each backlog task and each resumable paused task ("ACM-3 waits: This workspace works on 1 task at once and ACM-2 is running."), with a line telling the captain not to start them. Gates (`StartGate`: machine busy, workspace at tasks-at-once, no free agent slot) are typed, read live, and part of the facts key. A refusal only writes events and never wakes the captain, so the same gate in the same state is the same fact: no new wake until it changes. A refused resume says its line once, not every minute. A task that waits for room no longer raises the "running, but no agent is working" alarm.

**Measured** on the in-process world (real services, fake agent, `bossWorld`; Acme with one running task, tasks-at-once 1, three waiting tasks, a captain that tries every task its digest does not mark as waiting, a news wake every 25 s for 150 s, scaled to 10 minutes):

| | captain turns / 10 min | refused starts / 10 min |
|---|---|---|
| before | 16 | 32 |
| after | 16 | 0 |

Turns stay equal here because the test sends the wakes itself. What changes is that no turn is spent on a start the gates refuse. I found no path where a refusal wakes the captain: refusals write `decision` events, and the facts key does not read events. The paid retries were the captain choosing to try gated tasks on wakes it got for other reasons, which the digest now prevents.

**How verified.** Typecheck clean. Tests: `autonomy/driver.test.ts` (digest names the gate; a refusal by the same gate does not wake again; one wake when the gate clears), `handoff/limits.test.ts`, `packages/shared/src/build-id.test.ts`. Browser (isolated e2e server, 1440x900 and 1100x800): with unsent text and a different server build the bar shows and the tab reloads once the text is gone; with nothing unsent it reloads once. No console errors. Shots: `scratchpad/fix-autopilot-load/bar-1440.png`, `bar-1100.png`.

**Left.** The repo rule (two tasks on one repo) is not a typed gate yet, so the digest does not name it. `autonomy/live-state.test.ts` (2 tests) and `autonomy/slots.test.ts` (1 test) fail the same way on main in this checkout: the test world's git lacks `refs/heads/task` (`ENOENT ... .git/refs/heads/task/.keep`), so the first started task pauses with an error and no gate holds. Not caused by this branch.

## Overnight 2026-10-05: summary for the owner (deployed, ff22e3dd)

Live majhi runs ff22e3dd. A backup was taken before the update. All server, web, host and shared tests pass (3,951), typecheck is clean, and a final browser smoke test on an isolated server passed. Since yesterday afternoon: 29 merges, 28,268 lines removed and 14,293 added.

### Do these yourself (only you can)
1. **Rotate the DigitalOcean token.** Agents could read connection tokens from process command lines; that is fixed. Sign the DigitalOcean connection out and in again under Connections, then revoke the old token at cloud.digitalocean.com (API, Tokens).
2. **Clear old token text.** Token values may sit in agent transcripts and in the room history of PRV-127. Delete those rooms or transcripts.
3. **Re-pause watches you paused on purpose.** Watches now store who paused them and why. A watch paused before tonight has no recorded reason, so it resumes by itself once it reads fine. If you paused one deliberately, pause it again.

### What you will notice
- **Counts agree everywhere.** Home, the columns, the bell and the sidebar show one number from the server. "Working" means an agent is actually working; waiting on you is under Needs you. A parent waiting on its subtasks is not a decision.
- **No dead buttons.** A finished task with nothing to merge shows Mark done and Ask for changes, not Merge. Failed answers say what failed.
- **Same permission buttons everywhere:** Allow once, Allow for this task, Deny, with the command shown. Questions answered from Needs you have a 5 s Undo.
- **Room.** Esc stops a turn wherever focus is, even while the agent is still starting. The two-question card keeps Send in view. Cleaner header, Changes shown once.
- **Captain.** Cmd J puts the cursor in the message box. It no longer sends finished code tasks back for a "short report" and spends no turn on work it may not ship.
- **New task.** The button stays on screen, Cmd+Enter submits, mixed-workspace repos are blocked up front, each repo has a "starts from" branch field, and one press makes one task.
- **Online pill** turns offline within about a second of the server dying.
- **Faster.** The board makes about 1 request a second instead of 15 while agents run, and moves 7 KB/s instead of about 1 MB/s. One task change re-renders one card. Boot no longer stalls. Web assets are compressed and cached.
- **Tools.** The captain can install a command-line tool it needs (for example doctl) through majhi with a verified checksum, so secret fetches and script watches can use it.
- **Less noise.** Findings resolve themselves when their condition is gone. Findings from removed features are closed. `~/.majhi/e2e` (about 1 GB) was removed.

### Under the hood
- Every task status change goes through one `apply()` with an audit row (`task_events`) and an outbox in the same transaction. Illegal moves are refused (a note on a merge-request task no longer restarts it).
- Counts and slot gates read live runs, so a restart cannot leave ghost "running" tasks blocking work. A restart reconciles each task once.
- Secrets are off process command lines. Hand-off secret blocks name the file, line and rule.
- Git: optional locks off, one majhi write per worktree, a write waits out another process's index lock instead of failing.
- Database: prepared statements, batched reads, new indexes, daily batched retention (audit 1 year, costs 2 years; finished rooms keep messages and cards), one bad row no longer fails a whole list.
- Tests: suite health fixed (root config per package, no keychain writes, stale expectations).

### Still open
- The first task create with a repo right after a restart took about 30 s on the test server. Not traced yet.
- The "restore folders by hand" card is handled by an instruction to agents, not by a structural guard.
- Follow-up findings about removed trackers and the old e2e runner close when their memory threads close, or dismiss them.
- Next stage of the task model: step D (readers and one owner-facing text table), E (a `hold` column, old columns dropped after a backup), F (one scheduler tick with fairness). See docs/design/task-lifecycle.md sections 9 and 12.

## Esc anywhere in a room, one task per Cmd+Enter, Watch header spacing (built, not merged)

Branch `fix/esc-focus-create-once`.

- Esc stops the running or starting turn wherever focus is on a task page (body, a button, the room), unless a dialog, menu, popover, the captain drawer or another text field has it. It goes through the shortcut table (`stop` row) and reaches the room by a window event. Right after a room opens, the Esc waits up to 4 s for the turn to start. A room that opens with nothing focused now focuses the message box.
- New task dialog: while a create is in flight further submits are ignored, both buttons are disabled and show busy ("Adding..."). The dialog sends a request id (one per dialog session); `tasks.create` returns the first task for a repeated id for 5 minutes. The dialog used to wait for the task list refetch before closing; it now closes and opens the room as soon as `tasks.create` returns.
- Watch list at 1100 px: the grid gave the name column 49 px, so its header ran into WORKSPACE. Columns are now narrower and the name column has a floor of 88 px.
- Verified in a browser on an isolated server: Esc at +0, +150, +300, +600 and +2000 ms after Cmd+Enter, with focus on the body and in the box, stops the run. After a server restart, three quick Cmd+Enter presses made one task and the dialog closed on return. Test: `apps/server/src/tasks/create-once.test.ts`.
- Left: the first `tasks.create` with a repo after a server restart took about 30 s in the isolated server (the request itself, not the UI). The likely cause is a server or host-link call that waits for a timeout on a cold start. Not investigated here.

## UI sync: typed feed events, patched lists, cheaper decisions, windowed board (built, not merged)

Branch `perf/ui-sync`. Measured on the audit's seeded rig (2,000 tasks, 200k room items, 50k events), one board tab at 1440x900, 10 fake-agent runs (about 49 turns/min), same machine, base 2c013560 plus the hot-paths merge against this branch. Renders counted with the React commit hook on an unminified build.

| Measure | Before | After |
|---|---|---|
| Requests per second, board tab, 10 runs | 15.4 | 0.9 |
| Bytes per second | 993 KB/s | 7 KB/s |
| Request latency in the browser | 2.5 to 3.3 s | 2 to 20 ms |
| Card renders per commit (`Frame`) | 1,274 | 3 |
| DOM nodes on the board | 22,393 | 1,080 |
| Main thread busy | 5.6% | 2.4% |
| `tasks.list` payload | 577 KB | 499 KB |
| `decisions.list` | 242 KB, 16 ms | 242 KB, 8 ms warm (the per-row task reads are three queries total) |

- **What changed.**
  - The events socket stamps every frame with `seq` (per connection, 1, 2, 3 ...; a frame dropped for a tab with over 1 MB unsent still takes its number). A tab that sees a gap reads everything once; so does a reconnect. A `changed` event can name its tasks (`tasks`) and say only their rows changed (`rows`). The hub has `emitTask(id, rows?)`; run start/stop, messages, titles, handoff checks, merge looks and most task state changes in `TaskService` now name their task. Owner commands and a few rare paths still send the bare `tasks` topic.
  - New command `tasks.changed {ids, decisions?}`: the list rows of those tasks plus the counts, and with `decisions` what waits in them. The web (`lib/task-sync.ts`) reads named tasks in one request per 2 s window, patches the task list and the decisions list (counts, and the named tasks' decisions in the server's order), and reads again only the open detail of those tasks' cards. `staleTime: Infinity` for the task list and decisions list; a 60 s refetch is the safety net. `cmd()` hands back the previous parsed object when the answer text is identical (no JSON parse, no zod, no new identity).
  - `decisions.list`: subjects of all rows read in three queries (was three per row), first looks at review tasks (each reads the repos) run at most three at once, the list waits 1.5 s for first looks and the rest answer when they finish (the touched task's decisions are re-read through the feed), `counts` kept. Renewals stay behind the answer.
  - Board: cards are memoised, a card reads its own row (`useTaskRow`, same object until that task changes), one shared clock replaces a timer per card, a column of more than 30 cards draws only the ones in view (`@tanstack/react-virtual`, already used by Needs you).
  - `tasks.list` rows lose `mode` and the repos' `branch` (the board shows neither).
- **What the owner will notice.** A busy board no longer lags. A card's change shows within about 2 s during a burst, at once when quiet. Long columns scroll the same.
- **How verified.** Typecheck clean. Tests: `packages/shared/src/event-seq.test.ts` (seq monotonic per connection, gaps), `apps/web/src/lib/events-model.test.ts` (a gap makes the client read everything once; what each event reads), `task-sync.test.ts` (list and decisions patches keep identity and order), `events/hub.test.ts`, inbox tests (look concurrency capped at 3, recount). Census guard green. Browser on an isolated server with 10 runs: board, Needs you and a running task room at 1440 and 1100, no console errors or failed requests (`scratchpad/perf-ui-sync/*.png`).
- **Left.** `decisions.list` is still 242 KB at 505 decisions: every field is shown by the board or Needs you, so it was not cut; it is now read only on a real change or every 60 s. The sidebar still re-renders on every room message (`NavRow`). The 10-run rig has agents that pause on an error again and again (`pausedByRuns`, about 6 a second), which is the main source of `tasks:ids` events; worth a look on its own.

## Captain soak test fixed (branch fix/captain-soak)

- **What changed.** The usage recorder now takes the run clock (`runClock`), so turns are stamped with the simulated time and the day and workspace budgets measure them. The soak test's findings stub gains `settle`, which the upkeep pass calls on every sweep since findings settle by key.
- **What the owner will notice.** Nothing.
- **How verified.** `soak.test.ts` passes; captain and autonomy folders pass; typecheck clean.

## Lifecycle C: one apply() for every status write (built, not merged)

Branch `feat/lifecycle-c`. Merge main first (migration 154 is on main from another branch; this one is 156).

- **What changed.** `TaskRepo.setStatus` is gone. Every status change goes through `apply(taskId, event)` in `apps/server/src/tasks/lifecycle/` (`apply.ts`, `rows.ts`, `types.ts`): load the state with `fromStored`, `transition()`, then a refusal writes one `task_events` row and nothing else; otherwise one transaction writes status, `paused_reason`, `paused_by` and `autonomy_tasks.held / held_scope / resumed_at` through `toStored`, the audit row and the outbox, and then the effects run through one runner (`TaskService.runEffect`). Migration 156 adds `task_events` (audit and outbox in one table). `drainOutbox()` runs at start, before the restart reconcile. All 14 writers are routed (tasks, merge requests, runs: `pausedByRuns`, `resumedByRuns`, and the restart reconcile through `runLost`).
- **What the owner will notice.** Nothing, except: a message to a task with a merge request open from the captain, a hand-off or a schedule leaves a note and does not restart it (the owner's message still sends it back); a scheduled message no longer restarts a task the owner stopped.
- **Design points to read** (DECISIONS, 2026-10-05, Lifecycle C): two changes to the pure model, found in practice: `sendBack` from `mr` for the owner, and `runResumed` lifts an `error` hold (SPEC 5.7 auto resume). The old pause fields are ambiguous in two places (a gate pause looks like an owner stop, `blocked` is idle or a dependency); each is named and handled until step E.
- **Census.** `status writes` 15 to 0 (now tracked on `LifecycleRows.commit`), `Task.pausedReason` 41 to 34, `waitsForOwner()` 9 to 6, total outside the lifecycle module 203 to 182. Baseline refreshed, no count rose.
- **Tests.** `tasks/lifecycle/apply.test.ts` (setStatus not a method, refusal writes only its row, atomic rollback, outbox drains after a crash and drops a stale event, 24 transition rows round-trip with the old columns), `illegal-moves.test.ts` (tell on mr, wish start, logged refusal, scheduler vs owner stop), `store/task-events-migration.test.ts`, transition tests for the two model changes. Task, MR, store, runs, rooms, autonomy, captain, budgets, processes, inbox, notify and automation suites run with `--maxWorkers=3`.
- **Left.** Creation still inserts the row directly (no event). Raw SQL on `autonomy_tasks` in `autonomy/repo.ts` is not moved to drizzle yet; apply writes those columns with drizzle. Step D (readers, drop `paused`), the tick lock (F). `lostByRestart` for tasks that already have a hold is a no-op as before.

## Server hot paths (built, not merged)

Branch `perf/hot-paths`. Measured on the audit's seeded rig (2,000 tasks, 750 done), base 72742a34 against this branch, same machine, run back to back. The machine is shared, so read the ratios.

| Item | Before | After |
|---|---|---|
| Boot CPU, first 60 s (includes tsx compile) | 26.2 s | 5.5 to 7.4 s |
| Slowest `config.get` after the first request | 275 to 547 ms every 10 s for 60 s | 8 to 27 ms |
| `autonomy.status` as the shell reads it | 259 KB, 0.8 to 1.2 s | 2.4 KB, 0.2 to 0.7 s, one answer shared for 2 s |
| `autonomy.status` with `detail` (Captain page only) | 259 KB | 259 KB, sizes in one query instead of one per task |
| `roomWrote` task loads | 3 per room item | 0 for items that wake nothing |
| 50 KB streamed reply on the room socket | quadratic (each flush re-sent the whole text) | about 1x text as deltas plus one whole item at the end |
| Store writes for a 25 s streamed reply | one per 50 ms | about one per second |
| Initial JS (index + shared + preloads), raw / gzip | 1819 / 545 kB | 1560 / 483 kB |
| `index` chunk | 917 kB | 654 kB |
| Markdown renderer (react-markdown, remark) | in the first load | loads with the first rendered message |
| Task screen, chats, edit-roots | in `index` | own chunks (97, 13, 2 kB) |
| Static files | no compression, no cache headers | brotli and gzip made at build, `/assets` immutable, pages `no-cache` |

What changed
- Boot: `Resilience.startup` no longer calls `statusChanged` for every done task. It reads links, merge requests and statuses once and hands only the done tasks something hangs on (a waiting task, a parent, an open merge request) to `TaskService.reconcileDone`, which runs the orchestrator once and emits `tasks` once. The restart reconcile for running tasks is unchanged and now skips non-running tasks before loading them.
- `autonomy.status` takes `{detail}`. Without it, `now`, `backlog` and `waiting` are empty and `running` (ids) is sent; the Captain page and the delegation sheet ask with `detail: true`. Commands that return the status still return the full one.
- Room socket: new `delta` message `{id, offset, append}`. The client appends only when its text is `offset` long. Stored text is saved at most once a second and whenever `flush` runs (snapshot, any other write), and then one whole item is sent so every client ends equal. A reconnecting client gets a snapshot that is flushed first, so it has the full text.

How verified: typecheck clean; tests for streaming (`room/streaming.test.ts`: linear bytes, mid-message reconnect), static headers (`http/app.test.ts`), live-state, resume, autonomy suite, census guard. `autonomy/approvals.test.ts` "counts an agent of an autonomous task" fails the same way on the base (ENOTEMPTY on temp dir cleanup). Browser: isolated server on the `team` seed at 1440x900 and 1100x800, home, task room (lazy screen and markdown render, reply and link shown), captain, chats: no console errors or failed requests; assets arrive as br with immutable cache.

Left: the shared-schemas chunk (386 kB, zod) stays in the first load because `cmd()` parses every answer with the command's schema; moving that out needs a decision on parsing. `e2e/phase2a-room.spec.ts` fails on the stale "Board" heading, unrelated.
## Ops hygiene (built, not merged)

Branch `fix/ops-hygiene`.

What changed.
- **Tools the captain can install.** The old path was only a prompt line: download a binary into `$MAJHI_TOOLS/bin` inside a run. Secret fetches and script watches run in a separate throwaway container that never mounted that folder, so `doctl` was never on their PATH. New commands `toolbox.list`, `toolbox.install`, `toolbox.remove` (MCP: `majhi_toolbox_*`). majhi downloads the vendor's release itself (https, public hosts, 300 MB cap, redirects checked), keeps it only when its SHA-256 matches the one given or the one in the vendor's checksums file, unpacks a tar.gz or zip safely, and writes it to two places: `tool-installs/<org>/bin` (checked copy, never mounted into runs) and `tools/<org>/bin` (what runs already put on PATH). Script and secret-fetch containers now mount only the checked folder, read-only, and have it first on PATH. `{arch}` and `{machine}` in a URL match the runner's CPU. The runner Dockerfile is unchanged.
- **Build-a-URL scripts are no longer refused as "sends data".** A script declares `network: "off"` (script watches and `majhi_secrets_saveFromScript`) and then runs with `--network none`, so nothing can be sent and the text guard does not apply. With network on, the "sends data" rule now reads the script's commands: a data flag counts only for an HTTP client (`curl`, `wget`, ...). `tr -d` and `psql -d` no longer trip it.
- **Findings.** `tidy:dirty:<task>` findings resolve by themselves when the worktree is clean or gone (`FindingsService.settle`, by key prefix, never text). Follow-up findings resolve when their memory thread closes. Migration 154 dismisses open findings of removed sources (radar, ci, dependency, eol, opportunity, tracker) once and deletes the `tracker-comment` channel rows, drafts and trust state. The channel is gone from `OUTBOUND_CHANNELS`.
- **Watches.** A paused watch carries who paused it and why (owner, agent with its note, or unrecorded) and shows it in the detail. An agent must give a note when it pauses. A pause nobody chose (agent, or from before this) is checked once per interval and the watch resumes once it reads fine. Only the owner's pause stays.
- **Startup cleanup.** `removeLeftoverFolders` removes `e2e` and `business/kb` under the majhi home at startup from an explicit list, never follows a link, and logs each removal.
- **Skills.** A skill that fails to install fails once with its reason, becomes a finding under the same key, and is not tried again.
- **Manual work.** The task rules and the captain's prompt now say never to ask the owner for manual file, folder or command work. The restore-folders card came from agents having no way to see git-ignored folders in a worktree and no rule against handing the step to the owner. majhi writes nothing into the owner's checkout, so it does not restore them itself.

What the owner will notice. Fewer findings, a reason on every paused watch, secret fetches that can use installed tools.

Verified. Tests for findings settle, the migration, the cleanup allowlist, watch pause reasons and auto-resume, the skill no-retry, the toolbox installer, the script classifier and the container mount guard. Typecheck clean.

Left. `psql` is not a single release binary, so it is not a toolbox install; database watches use the bundled drivers. Follow-up findings about removed features (tracker tests, the e2e runner) are text only: they resolve when their memory threads close, and are not matched by wording. The `business` playbook scope is still used by the Laya check and stays.

## Server data layer performance (built, not merged)

Branch `perf/db-layer`. Measured on the audit's seeded rig (2,000 tasks, 200k room items, 50k autonomy events, 20k turns and audit rows), same machine, old and new code run back to back. The machine is shared, so read the ratios, not the absolute times.

| Item | Before | After |
|---|---|---|
| `tasks.get` for all 2,000 tasks (4 queries each) | 362 to 906 ms | 36 to 76 ms |
| Orchestrator `waiting()` (every sweep, and per done task at boot) | 15 to 42 ms | 0.1 ms |
| Planner `running()` | 7 to 19 ms | 0.1 ms |
| Chat memory sweep, task part (every minute) | 11 to 38 ms | 0.1 ms (plus no room read for a chat with nothing new) |
| Budget lift, task part (every minute) | 7 to 23 ms | 6 to 9 ms with 504 paused tasks (a few in real use) |
| Room item write (`room.upsert`) | 0.6 ms | 0.13 to 0.15 ms |
| `pendingOfType` per task, 200 tasks | 21 to 48 ms | 10 to 16 ms |
| `pendingOfTypes` for 2,000 tasks | 4 to 9 ms | 1.7 to 2.7 ms |
| Captain key claim, settle and read, 2,000 times | 105 to 362 ms | 78 to 92 ms |
| `autonomy.task` 2,000 times | 15 to 54 ms | 3 to 4 ms |
| Outcomes pass, rows written when nothing changed | 5,015 rows, 62 ms (160 to 250 ms in the audit) | 0 rows, 0 ms (a pass that derives the same does nothing; a changed one writes only the changed rows, 1.3 ms to find them) |
| Worst-case first prune (all seeded rows old) | not possible, no pruning | 958 batches of 500, 329 ms total, event loop lag at most 6 ms |

What changed.
- **Prepared statements.** `TaskRepo` (get, list, getMany, has, statuses, links, unmerged, start-when-ready) and `RoomRepo` (upsert, get, page, pageAfter, around) build their Drizzle queries once with placeholders. `getMany` loads any number of tasks in four queries through `json_each`, so no per-id loop is left in the store. Every connection also keeps one compiled statement per SQL text (`cacheStatements` in `store/db.ts`, 400 entries), which covers the raw `db.prepare` repos (autonomy, captain keys, outcomes, findings, agenda) and Drizzle's own prepare without touching them. New loop methods: `waitingToStart()`, `runningTasks(except)`, `chatIds()`. `Orchestrator.waiting`, `TaskPlanner.running`, `ChatMemory.sweepDue` and the budget lift use them.
- **SQLite baseline.** Startup sets and reads back WAL, synchronous NORMAL, busy timeout 5000 ms and foreign keys, and logs one line with the version. A warning shows if any is below the baseline. better-sqlite3 is already 13.0.3 with SQLite 3.53.4, newer than the 3.51.3 WAL-reset fix, so nothing was upgraded. A test asserts the baseline and the version.
- **Indexes, migration 153.** `room_items.pending` is a virtual column over the payload's `state` (safe for a payload that is not JSON) with a partial index `(type, task) WHERE pending = 1`, so the owner's pending cards are an index lookup, not a JSON parse per card ever made. Also `tasks(status, updated_at)`, a partial index for open MRs, `tasks(brief) WHERE kind = 'chat'`, `findings(created_at)`, `findings(status, last_seen)`, `autonomy_events(kind, at)`, `outcomes(at)`, `captain_actions(at)`, `audit(kind)` and `audit(agent)` (the audit page's DISTINCT lists read an index now). Each was checked with EXPLAIN QUERY PLAN. Test: the migration on a pre-153 database with damaged payloads.
- **Retention.** `store/retention.ts`, numbers in `RETENTION`. A daily job (first run 10 minutes after boot) deletes in batches of 500 with the event loop free between batches: audit 365 days, turns 730, autonomy events 180, outcomes 400, captain actions 365, settled action keys 180, ended captain, playbook and automation runs 180 (the newest of each kind always stays), hand-off history 180, usage events 365. Rooms of tasks done more than 90 days: tool output, thoughts and context notes only. Messages, plans, reviews, every card, anything pending and the newest item (the room's `seq` counter) stay. Tasks, decisions and the Laya decision log are never pruned. Tests: what is kept and deleted, batching, twice in a row.
- **Idle loops.** The outcomes pass hashes what it derived and writes nothing when it is the same as the last pass, otherwise only the rows that differ; it tells the UI to refetch only when something was written. The ladder still runs every pass (it reads settings and the clock). The chat sweep reads only chats with an item newer than their last memory read. Test: only changed rows are written.
- **One bad row.** `store/tolerant.ts`: tasks, task links, task statuses and findings are parsed row by row; a bad row is skipped and logged once. `findings.list` and `agenda.today` no longer fail on a finding with an unknown source. Test: one invalid finding and one invalid task, the rest returned, one log line.

How verified. Typecheck of every package clean. Tests run: `store/*` (retention, migration, tolerant reads, existing store, audit and room tests), `outcomes/*`, `memory/chats`, `tasks/orchestrator`, `tasks/planner`, `budgets/*`, census guard (the start-when-ready column count went down by one). Bench scripts are in the scratchpad (`perf-db-layer/`).

Left. `tasks.list` is still about 9 to 20 ms for 2,000 tasks: the cost is zod and JSON parsing of each row, not SQL. `RoomRepo.page` is dominated by zod parsing of each item. The `autonomy.status` N+1 and the boot storm are outside this branch.
## Merges no longer fail on index.lock (built, not merged)

Branch `fix/git-optional-locks`.

- **What the owner will notice.** A merge or rebase no longer fails with "Unable to create index.lock" because a background `git status` or `diff` ran in the same worktree.
- **Cause.** Read-only git (checkpoint, handoff ready check, room coordinator) refreshes the index and takes `index.lock` unless told not to. Nothing set `GIT_OPTIONAL_LOCKS`.
- **Fix.** `gitEnv` in `git/git.ts` sets `GIT_OPTIONAL_LOCKS=0` for every command the server runs through `git()` (git's docs: same as `--no-optional-locks`, safe for writes). Index-writing commands (add, commit, merge, rebase, reset, checkout and so on) now run one at a time per worktree through a keyed queue (`git/keyed-queue.ts`). A single-step write that still hits a lock held by someone else (an agent's git in its container) waits and retries up to 5 times (100 ms to 2 s); the lock file is never removed. Multi-step writes (rebase, merge, pull, stash, cherry-pick, revert, am) are queued but not retried, since they leave state behind when they stop halfway.
- **Left.** `apps/host` git calls (clone, push) and the config-history and backup repos run their own git and are not in a task worktree's index path; unchanged. Agent containers' own git cannot be locked by majhi.
- **Verified.** `git/locks.test.ts` (env on every command, read during a held lock, writes never overlap, wait out a foreign lock without removing it); `tasks/shipped.test.ts` 5 runs in a row under `--maxWorkers=2`; `git/` tests; typecheck clean.

## Captain checks and the new task dialog (built, not merged)

Branch `fix/captain-checks-new-task`.

- **What the owner will notice.** Auto-pilot no longer sends finished code tasks with no changes back to running. They get one line on the log: "not ready to ship: nothing changed since it started". Investigation tasks with an empty report are still sent back. The new task dialog keeps "Add and start" on screen, the body scrolls, Enter in the title and Cmd+Enter anywhere send it, repos from two workspaces block the save with the reason beside the picker, each picked repo has a "starts from" branch field, and the dependency chip never wraps.
- **Cause.** `answerTasks` took every review task with no diff, code tasks included, and judged the report length. Now it marks `investigation` from the task's kind, repos and read mounts, and the chore skips the rest. The authority gate is one function (`answerGate`) used before the pass and again in the recheck before a turn.
- **Left as is.** The sentence still attaches no repos or branches (SPEC, decision 2026-10-02); aliases are suggested with one click. See DECISIONS.
- **Verified.** `captain/ship-mr.test.ts` (code task not bounced, investigation bounced, no turn when the workspace asks), typecheck clean. Browser on an isolated server at 1440x900, 1100x800 and 1100x600: footer visible, cross-workspace block, Enter and Cmd+Enter submit, base `develop` saved, no console errors. Isolated Auto-pilot run with three no-change review tasks: none bounced.
## Room, captain drawer and shell fixes (built, not merged)

Branch `fix/room-captain-shell`.

- **What the owner will notice.** Esc (and Stop) now stops a turn while the agent is still starting, shows "Stopping..." and posts one line ("Stopped @lead's turn." or "Stopped before the agent started."); the held prompt goes out with the next message. Cmd J focuses the box at once and keeps early keystrokes in it (a box shows while the chat opens); single-key shortcuts no longer fire inside the drawer. The online pill shows a dead server within about 3 s and a returning one within 2 s; sending while offline says so and keeps the text. A two-question card keeps Send in view and says how many questions are left. The task header no longer wraps the key or overlaps chips, keeps one primary button when a card in the room asks for the same decision, and shows Changes once (the tab, for tasks with a repo). A stopped agent reads "Idle". A restart that ends an open permission request leaves one room line.
- **Cause and fix of Esc.** Three gaps: the web ignored Esc while the task was set up but no agent had reported (now counts as busy: a start request in flight, or a running task whose agents are all stopped); the service had no run to cancel during `start` (worktrees, memory), so it now remembers the cancel and skips starting the agent; the manager cancelled nothing between the session opening and the prompt going out (`cancel` now sets `cancelBeforePrompt` whenever no prompt is in flight, and the loop checks it before sending and keeps the prompt queued).
- **Shortcuts.** `use-shortcuts.ts` treats the drawer, and the page body while the drawer is open, as typing. The drawer focuses in a layout effect, and the loading state is a real box whose text moves into the composer.
- **Pill.** `/health` every 1.5 s with a 1.5 s timeout, one immediate retry, `networkMode: always` (the browser's offline flag paused the check before), and a refetch on every events socket open or close.
- **Sockets.** `closeSocket` closes a connecting socket once it opens, so leaving a page logs no "closed before the connection is established".
- **Not done.** Expected 4xx results: the browser prints "Failed to load resource" for every 4xx response itself, and the app logs nothing of its own. Hiding them would mean answering 200 for handled errors, a protocol change; left alone.
- **Tests.** `runs/manager.test.ts` "Esc before the agent has started" (session still opening: nothing is sent, the queue waits, later messages still go). The fake runtime got `startGate`.
- **Verified in a browser** on an isolated e2e server at 1440x900 and 1100x800: Esc 60 ms to 1.8 s after Start, offline and hung-server timings, Cmd J typing, the two-question card, review header and long-chip header.
## One count, cards from current state (built, not merged)

Branch `fix/needs-you-counts-cards`.

- **What the owner will notice.** Home header, the Needs you column, the bell, the sidebar and the banner show the same number: the server counts them in `decisions.list` (`counts`: needs you, working, per workspace). "Working" is a task an agent works on right now. An agent that waits on an answer, or is queued for a slot, is not working; its task is under Needs you or Up next. A parent that waits on its own subtasks is not a decision: it sits in Up next as "Waiting on its subtasks, 0 of 2 done", with no Resume. Home's Up next also holds paused (by you), MR-open and quiet running tasks, so nothing open vanishes.
- **Cards cannot go stale.** Each card is checked against its task now. A review card only counts while the task is in review; a merge approval or permission only while the task runs or is in review; a pause card only while paused and with no open subtasks; a split approval goes once its subtasks exist. A review whose merge the server knows fails ("Nothing changed since it started.", conflict, uncommitted work) says so in one line, is titled "Finished" and offers only what can work. The look is the captain's own ship check (`shipReadiness`), kept 15 s, renewed behind the answer, and screens are told when it changes.
- **Answers.** One shared label set (`permission-labels.ts`): Allow once, Allow for this task, Deny, in the room and in Needs you. The Needs you detail shows the whole command and the task. Permission prompts have their own filter, Permission; Access is for secrets and sign-ins. A one-click answer to a question from Needs you, the bell or Home waits 5 s with an Undo toast, like the room. A multi-question card says "Answer in the task" and opens it with the card focused. A failed answer says what failed ("Could not merge" and why). The detail is not read again after its decision left (no 404).
- **Slots.** A queued run's room line names the limit and who holds the slots, from run state: "Queued, #1 in line: the limit of 2 at once on codex-acme is reached. Holding the slots: ACM-1 (@acme-builder, waiting for you), ACM-2 (@acme-two). @acme-three starts when one frees." Policy unchanged.
- **Cost.** The Home header reads "Auto-pilot spent $0.00 of $20 today"; its hover says tasks you start yourself are not in it. The task's own "Cost so far" counts all its turns.
- **Tests.** `inbox/derived.test.ts` pins header = column = bell = sidebar (one server count for a seeded mix), and each stale case is not produced. `runs/resume.test.ts` pins the queued line. `inbox.test`, `batch.test` updated for the new labels.
- **How verified.** Isolated e2e server from this branch with a seeded mix (one working, one waiting on a permission, one question, a parent with unstarted subtasks, a finished task with nothing to merge) against a server from main, at 1440x900 and 1100x800. Before: header "6 need you, 0 working", column 5, sidebar "1 working"; Ready to ship with an amber Merge on a task with nothing to merge; a "Blocked and waits for you" card for the parent; permission buttons "Allow / Always allow / Reject". After: 4 and 1 everywhere, and the cards above. Undo hold, Undo cancel and the single request after 5 s were driven in the browser; no console errors or failed requests.
- **Left.** (1) A card whose text asks the owner to restore folders by hand is agent-written text, so no state check removes it; it needs an agent rule, not code here. (2) The idle watch still pauses a parent as `blocked` when the lead ends and no subtask moves by itself (pinned by `rooms/idle-watch.test.ts`); it no longer shows as a decision. Changing that pause itself would change what the lead and the captain are told. (3) A task in `mr` has no owner decision by design: the merge happens on the host and the poller closes it.

## Live-state counts and restart reconcile (built, not merged)

Branch `fix/live-state-counts`.

- **What the owner will notice.** After a restart, a task that was running but could not be brought back no longer blocks its workspace: the captain can start and resume other tasks again. Such a task shows as paused with "majhi restarted and could not resume this; Resume to continue" (when automatic resume is off or the agent cannot be woken). Idle chats that sat "running" for days show as review. A lane's "N things for you" is now the number of open owner cards, the same as Needs you.
- **Gates.** Tasks at once (`workspaceFull`, `noRoomFor`) and the repo-rule writers count tasks with a live run (`RunManager.busy`, or a wait on a background process), not status `running`. A task queued for an agent slot still counts.
- **Reconcile.** One place, `Resilience.wakeStranded`, after the resume attempts: chats go to review, others are woken or paused with reason `error`; a failed resume in the drip or the interrupted pass also pauses instead of leaving the task running.
- **Lane count.** `forYou` comes from `inbox.list(org)`; the summary line uses it. The day's log no longer feeds it.
- **desk.test.** It was failing because the default is one task at once and the test starts two per workspace; it now sets `tasksAtOnce: 2` as its comments assume.
- **Tests.** `autonomy/live-state.test.ts`. done-when.test updated for the new count.
- **Known.** approvals.test "counts an agent of an autonomous task" fails on main too (ENOTEMPTY on cleanup).
## Secrets off process argv (built, not merged)

Branch `fix/no-secrets-in-argv`. Closes the leak behind PRV-127.

- **The leak.** The Claude adapter starts `claude --mcp-config '<json>'`, and the JSON holds every MCP header and every stdio server variable. That covers majhi's own bearer tokens (`majhi-room`, `majhi-tasks`, `majhi-processes`, `majhi-containers`, `majhi-memory`, `majhi-connections`) and the OAuth token of a signed-in connection such as DigitalOcean. Any process in the container could read them from `/proc/*/cmdline`. Checked in the runner image: the argv held the token. Codex keeps headers in memory and showed none.
- **The fix.** `packages/acp/src/mcp-env.ts` swaps each header and stdio variable value for `${MAJHI_MCP_<server>_<H|E><n>}`, and the values go in the adapter's environment. Claude expands them itself (checked end to end through the real adapter in the runner image: the server got the header, argv held only the placeholder). Only tools with `mcpOnArgv` (Claude) do this. The docker runner already passes variables by name, so the values are on no command line anywhere.
- **Service, preview and database-check containers.** Their `--env NAME=value` flags put passwords on the docker CLI's line inside the server container. `envByName` (`containers/args.ts`) now moves them into the CLI's environment. No agent could see these, but any process of the server could.
- **PID namespaces.** Each run is its own container with no `--pid`, `--ipc`, `--uts`, `--userns` or `--privileged`, so an agent sees only its own container's processes, not another task's, the server's or the host helper's. Agent-started containers refuse those flags too. Tested on the built args.
- **Per-task tokens.** Already per task and agent, in memory, per server, revoked when the session ends. Tests added for that.
- **Hand-off secret scan.** It reads only the diff (`git diff -U0`), never output or argv. A block now says the file, line, rule and a masked value (`src/app.ts line 3, rule github, value ghp_[hidden, 44 chars]`). Before it named only the file.
- **Agent guidance.** The captain prompt now says to feed a token to curl on stdin, not as an argument.
- **Known limit.** The environment of a process is readable by the same user (`/proc/<pid>/environ`), and the agent runs as that user in its own container. The tokens are per task, so what an agent can read is its own task's; they are on no process list. Anything an agent types itself (`curl -H "Authorization: Bearer $VAR"`) still shows in the argv of that curl while it runs.
- **Owner action.** Rotate: (1) the DigitalOcean token, by signing the DigitalOcean connection out and in again in Connections (the old OAuth token stays valid until it expires or is revoked at cloud.digitalocean.com under API, Tokens); (2) any other OAuth or `env` connection whose token an agent printed or ran through `ps`. majhi's own MCP tokens need no action: they live in memory and ended with their sessions (a restart also clears them). The old tokens may still sit in agent transcripts and the room history of the task that showed them (PRV-127): delete those transcripts. No token value is written here.

## Lifecycle A and B: census guard and pure model (built, not merged)

Branch `feat/lifecycle-a-b`. Nothing in `apps/server` or `apps/web` uses the new module yet.

- **A, census guard.** `scripts/census-baseline.json` refreshed against main (acd08080). `apps/server/src/tasks/census-guard.test.ts` runs `scripts/census-lifecycle.ts --check` through the TypeScript compiler API and fails if any tracked symbol's count outside the lifecycle module rises. Going down is allowed; refresh with `pnpm exec tsx scripts/census-lifecycle.ts --write scripts/census-baseline.json`. Total outside the lifecycle module: 208 sites in 31 files (was 211 in 33).
- **B, the pure model**, in `packages/shared/src/lifecycle/` (exported as `lifecycle`): `hold.ts` (`HoldSchema`, twelve kinds, `HOLD_TABLE` with lifters, typed auto-clear condition and the owner sentence, exhaustive by type; `liftersOf`, `autoClears`, `sentenceOf`, `conditionMet`, `mergeHold`), `transition.ts` (`LifecycleStatus`, `TaskState`, `LifecycleEvent`, `Effect`, `Refusal`, `transition`), `stored.ts` (`fromStored` and `toStored` for status, `paused_reason`, `paused_by`, `held`, `held_scope`, `resumed_at`). `TaskStatusSchema` is unchanged and still has `paused`.
- **Design doc updated.** The hold list in `docs/design/task-lifecycle.md` section 4.2 now says what D1 to D10 changed, and 4.4 lists the choices the build made.
- **Tests.** `lifecycle/hold.test.ts` (32), `transition.test.ts` (214: every table row, every illegal status per event, hold refusals, lift permissions per cause and lifter, reachability invariants), `stored.test.ts` (76: every combination that exists today, round trips, and the seven that cannot round-trip with the reason), plus the census guard (1).
- **Left for step C.** `apply()` with the per-task lock, routing the 14 `setStatus` sites, dual-writing through `toStored`, raw SQL on `autonomy_tasks` onto drizzle. The characterization test of `tellAgent` on an `mr` task comes with C, where the old behaviour can be run.
- **Known.** `packages/acp/testing/fake-turn.ts` typecheck error at line 920 is not from this branch.
## Test health (built, not merged)

Branch `test/suite-health`. Test and harness changes only; no product behavior changed.

- **Fixed (harness or stale test).** `config/settings.test.ts` lists the current schema defaults. `testing/fixtures.ts` `tempDir` cleanup retries ENOTEMPTY (a size rating ends after the world closes and asks a decision provider, which makes its scratch folder). `installs.test.ts` and `runner/isolation.test.ts` follow two earlier design changes (a connection reaches agents by org; the task branch folder is named by kind). `rooms/idle-watch.test.ts` signed-out pause: the lead is alone, since a teammate with a working account now takes over. `memory/housekeeper.test.ts` waits for the project card pass before it counts sessions. `packages/acp/src/runner/docker.test.ts` fake docker writes its state atomically. `host/gitGuard.test.ts` ignores the system git config (on a Mac it named the Keychain as credential helper: the test hung on a prompt and stored a fake password). `autonomy/perf.test.ts` reads the fastest of five calls. `captain/done-when.test.ts` has a 60 s timeout (about 1000 real git processes). `pnpm --filter <package> test` now exists and uses the root config, so a run from a package gets the same 20 s timeout as `pnpm test` (inside a package folder vitest used its 5 s default).
- **Left failing on purpose.** `captain/desk.test.ts` "resumes what Autonomous paused" (rule conflict, see docs/design/task-lifecycle.md and the D10 entry below). `web/lib/naming.test.ts`: `features/captain/dashboard/strip.tsx` has the retired words "day cap" (copy change, the owner approves copy).
- **Real bug, not fixed.** A merge can fail with `index.lock: File exists` in the task worktree when a background `git status` (checkpoint, hand-off, coordinator) runs at the same time. No git call in the server uses `--no-optional-locks`. Seen under load in `tasks/shipped.test.ts` "closes after a rebase". Fix in the code: read-only git calls run with `GIT_OPTIONAL_LOCKS=0`.
- **Full run.** Before: 3495 tests, 3484 passed, 11 failed, 0 skipped, 4 min 43 s. After: 3490 passed, 5 failed, 0 skipped, 9 min 21 s, on a machine at load average 45 (other jobs). Of the 5, two stay failing on purpose (above), `housekeeper.test.ts` was a fixed 50 ms sleep (now waits for the extraction), and `budgets/limit.test.ts` and `mrs/multi-repo-ship.test.ts` timed out at 20 s under that load (3 to 5 s alone). Tests of 20 s or more under load: the hand-off, ship and merge tests that run real git.
- **Slow by nature.** Config writes cost about 110 ms each (the home is a git repo and each write commits), so a world takes about 1 s to build. Tests that ship, merge or hand off run hundreds of real git processes.

## After D1 to D10: one day of use, then one list

Deployed 2026-10-05 (707aedbf). Collect what you see in one list, not one fix at a time. Watch:

- **Spend.** Chores now run on every relevant event, not up to a daily count. A run that finds nothing new makes no model call. If spend per day goes up, note when and which workspace.
- **Permission prompts reaching you.** The second-opinion model is gone, so prompts the rule table does not know come to you. Note which programs or tools they are: each one is a rule to add, not a model to bring back.
- **Stalls.** A task that sits without moving and without a reason you can see. Note the task and what the board says.
- **Loop pauses.** A task paused as "going in circles" after three answers with no progress. Note whether it was right.
- **Sign-in handoffs.** A lead whose account needs a new sign-in now hands its task to a fallback or teammate at once. Note any handoff that went to the wrong agent.

Next stage after the list: the task model (one hold per task, one transition table), then one scheduler. See docs/design/task-lifecycle.md section 9.

## D10: loop, stuck, wake gate, heartbeat, roll-ups, second opinion and echo guard (merged)

- **Progress counter first.** After 3 captain answers to one task with no progress in between, majhi pauses the task for the owner with the existing loop pause (`pauseForOwner`, reason `loop`; the paused card says so). `LOOP_GUARD_ANSWERS = 3` in `captain/rules.ts`. The count lives in `captain_loop_guard` (migration 152): per task, the progress mark it was counted against (status plus the head of each branch) and the count. A commit or a status change gives a new mark and the count starts again; answers to another task do not count, and any card of the same task does. It is stored, so a restart keeps it, and the count and the pause happen in one transaction, so answers that land together pause once. A permission Allow is not counted (a rejection is). The prompt gained one line: "After three answers with no progress, majhi pauses the task for the owner."
- **Removed.** The question-loop similarity rule (word overlap, 10-minute and 5-minute windows) in the questions chore and in `autonomy.answer`, with its room line and nudge, the `q-loop` playbook rule, and the call-outcome reader. The stuck chore (sign-in lead move, wake, pause), its playbook, log words and ports, and the stuck detector's failures and repeated-line rules. The Laya wake gate and its `wake-gate` decision slot. The driver's hourly heartbeat and its `pendingWork` input. The periodic and notable roll-up posts in the root chat. The own-work second opinion and its `own-work-second` slot, the unknown-middle flag in the rule table and the label the owner's answer put on that decision. The echo guard (`markCaused`, `CAUSED_MS`).
- **Kept, with the reason.** The root-chat relay of a workspace captain's message (now `captain/relay.ts`): a different surface from the roll-up. `HOURLY_MS` in `captain/service.ts` (it merges into the one tick later). The driver's facts-key compare and 20-second debounce. The Stuck list on the dashboard, now showing only the one definition (quiet 2 hours running, 4 hours in review or open MR, no pause and no card waiting for the owner). It is not the same as Needs you, which lists what waits for the owner.
- **The owner will notice.** A task is paused for them after three answers with no progress. No Stuck row for a failing or looping task, and none for a paused task or one with a card waiting; those are in Needs you. No "keeps asking" line in a room. No hourly check wake. No roll-up posts in All. A permission request the rule table cannot place goes to the owner (no model gives a second opinion). The Stuck tasks playbook is gone from Upkeep (12 chores). Old log lines of the stuck chore no longer show in the captain's log.
- **Verified.** `pnpm -r typecheck` clean except the known `packages/acp/testing/fake-turn.ts` error. New `captain/loop-guard.test.ts` (3 answers pause; a commit and a status change reset; another task does not count; the count survives a restart; answers at once pause once; a paused task pauses again only after progress and more answers; a gone task is not guarded), new `captain/echo.test.ts` (a run the echo starts, with every key taken, makes no ship, answer, card or lane turn), and the stuck, desk, driver, soak, runner and own-work-chore tests rewritten for what remains. Tests of captain, autonomy, rooms, playbooks, decisions, store, config, commands, inbox, findings, tasks and `packages/shared` pass; failing before and after: `config/settings.test.ts` "fills every default", `autonomy/approvals.test.ts` (ENOTEMPTY), `captain/desk.test.ts` "resumes what Autonomous paused". Some tests time out at 5 seconds when many files run at once and pass alone.
- **Left.** SPEC 5.12 and 5.18 still describe the wake gate, the second opinion, the question loop and the roll-up (SPEC edits wait for the owner, see the lifecycle design). Tables stay until E2: `captain_cap_asks`. The soak seed moved from 13 to 7. The permission-Allow exception to the loop guard is a choice (DECISIONS); typed holds replace the loop pause in a later step.
- **Signed-out handoff.** Signed-out handoff moved from the stuck chore into the run manager (`takeOverFor`, same `resume.handoff` switch as a limit; fallback first, then a teammate for a signed-out lead; pause `signed-out` only when neither works). Test: `runs/signed-out-handoff.test.ts`.
- **UI to check in a browser.** Not run in a browser here (typecheck only). Check: the Captain page dashboard Stuck panel (labels "No progress" and "Waiting", no link to a card), Playbooks (Upkeep pack has 12 chores, no Stuck tasks, the Questions chore has two outcome rules), the Captain log (no stuck rows), the Decisions Hub (no wake-gate or own-work slot), the All chat (no roll-up posts, lane relay lines still arrive), and a task paused by the loop guard (paused card, Resume works).

## D9: captain actions keyed by state; daily caps, cap asks and tell limit removed (merged)

- **Keys first (G1).** Every captain action takes a key of the state it acts on in one `INSERT OR IGNORE` on a primary key (`captain_keys`, migration 151). Ship: `ship:<task>:<repo@head,...>><repo@base,...>` (the chore and the lane share it; the base tip is new). Answer: `answer:<task>:<card item>`, for the chores, the rules and the lane's `room.approve`, `room.answerQuestion` and `room.answerAsk`. Tell: `tell:<task>:<agent>:<id of the agent's last turn row>`. A repeat is a typed no-op: `answered: false` / `refused: "already-answered" | "in-flight"` on the answer commands, `told: false` / `refused: "already-told" | "in-flight"` on `tasks.tell`, never an error the captain retries on. A failed action gives its key back; a claim a crashed call left running is taken over after an hour. Keys survive a restart.
- **Removed.** Daily chore caps (13 keys, 22 numbers), `dailyCaps` and the REACHED texts, the "raise the cap for today?" cards and `captain.answerCap`, the `cap` decision kind, the per-chore rows in Limits, the playbook "Daily limit" row and `dailyLimit`, `RAISE_FACTOR`, the tell limit (3 in 10 minutes), `RUN_CAPS`, `RUN_ACTIONS`, `RUN_MINUTES` and the duplicate `RUN_TOKENS`. `overCap` is gone from Review now.
- **One pass bound.** `PASS_BOUND` in `captain/rules.ts`: a pass ends at 45 minutes or 60,000 tokens (the 45 keeps the ship fix from 4207cc99). `FAILURES_OFF` (2) and `MAX_PASSES` (3) stay.
- **Prompt.** The captain's lane text lost "three times in ten minutes" and "the same daily cap of ships", and gained one line: "Repeating an action on the same state does nothing; a tell waits for the lead's next turn."
- **The owner will notice.** No per-chore limits in Limits and no Daily limit row on a chore playbook. No "raise the cap" cards in Needs you or the bell (budget raise requests stay). A chore can run again when something happens: what stops it doing the same thing twice is the key, not a count.
- **Verified.** `pnpm -r typecheck` is clean except the known `packages/acp/testing/fake-turn.ts` error. New `captain/keys.test.ts` (key claim, restart, two connections racing, answer once, tell once per turn, ship once per state, a different key acts, results typed) and new cases in `runner.test.ts` (no action cap, one action when the same key runs at once, key given back on failure, 45-minute bound). Tests of captain, autonomy, playbooks, store, config, commands, inbox, admin, agenda, usage, rooms, tasks and `packages/shared` pass; failing before and after: `config/settings.test.ts` "fills every default", `autonomy/approvals.test.ts` (ENOTEMPTY on cleanup), and `captain/desk.test.ts` "resumes what Autonomous paused" (the tasks-at-once gate refuses its second start; fails on main too). `tell-ship.test.ts` keeps its two lane-ship cases and the injected-text case; the 3-in-10-minutes case is replaced by the keyed one in `keys.test.ts`.
- **Left.** The `captain_cap_asks` table stays until E2. `chores` on an org and `dailyLimit` in a playbook's saved state still load (`z.unknown().optional()`, "Removed in D9"). A chore with no daily run cap now runs on every trigger; the event debounce and `MEMORY_WAITING` are its only brake, and a run that finds nothing costs no model tokens. The ship key does not cover a ship that crashed after the merge but before its log line: the claim is taken over after an hour and the state is checked again by `shipCheck`. SPEC 5.18 still describes the daily caps. UI checked in a browser on an isolated server at 1440 and 1100: Limits, chore playbooks, the bell, the Captain page and Review now render with no errors. Command summaries no longer mention chore caps.
- **Task found.** `captain/desk.test.ts` "resumes what Autonomous paused" fails on main since d1c85f58: the tasks-at-once gate refuses the second start of a task Auto-pilot paused. Two rules conflict (resume what Auto-pilot paused vs one task at a time). Fix it in the lifecycle steps (holds and `blockerOf`), not with another branch.

## D2 to D5 and D8: unused features removed (merged)

- **Removed.** Tracker sync (Jira, ClickUp, GitHub Issues: server, commands, org settings, task chip and menu items). Growth (feeds, opportunities, client updates, the Growth pack, `findings.proposal`, `findings.deadline` and their buttons on Findings). Client economics (`economics.get`, the profit and loss table, the Business playbook pack). Sensors (CI, dependencies, secrets, EOL, radar, and the five Engineering playbooks that ran them). Business knowledge base, voice and CRM, and deadlines (commands, pages, agent tools). Two Laya slots that read tracker routing were detached from `decisions`.
- **Deadlines removed too (owner decision).** The Deadlines page, its routes, sidebar row and `i` shortcut, the `deadlines.*` commands and agent tools, reminder logic, the finding-to-deadline link and the `business` event topic are gone. Old `/business`, `/knowledge` and `/deadlines` addresses fall through to the normal not-found behaviour. Today stays: it no longer lists deadlines (no agenda items, no "This week" plan list, no brief line, no close action) or CRM follow-ups, and the brief writes in a neutral style. The wall-clock helpers the brief hour needs moved into `agenda/time.ts`.
- **Also kept.** The `opportunity`, `ci`, `deps`, `eol`, `radar` finding sources (old findings still load). The monthly-ceiling "profit and loss" rates table on the Money panel: its rates and minutes come from the outcomes module (D6), so it goes with that step. Playbook packs `engineering` and `business` stay as categories for playbooks the owner makes.
- **Verified.** `pnpm -r typecheck` is clean after every commit except the `packages/acp/testing/fake-turn.ts` error already on main. Tests: playbooks, agenda, deadlines, commands, store, config, decisions, events, orgs, admin, findings, rooms and `packages/shared` all pass; only the known `config/settings.test.ts` "fills every default" fails, as before. The deadlines test lost its contact case and gained a finding-link case; the brief tests lost the voice cases; the Engineering "code health" outcome test was cut to the Upkeep default it still covers.
- **Left.** Tables stay in the DB until step E2: `tracker_links`, `sensor_cache`, `kb_entries`, `kb_versions`, `crm_*`, `voice_profiles`, `deadlines`. Config keys `tracker` on an org still load (`z.unknown().optional()`, "Removed in D2"). Folders no longer used: `~/.majhi/business/kb`. The `business` event topic and query key keep their name and now carry deadlines only. Screenshot specs for trackers, economics and business were deleted; `e2e/shots.today.ts` no longer seeds CRM contacts.

## D1: background e2e runner removed (merged)

- **Removed.** `apps/server/src/e2e/` (service, repo, wire, test), the host helper's runner (`apps/host/src/e2e.ts`, its test, the `e2e.run` job and two git-guard tests of it), `packages/shared/src/e2e.ts`, the `e2e.status` and `e2e.runNow` commands, the `e2e_latest` agent tool, the `e2e` settings section and setup row, the Health panel, the screens-map entries, the `e2e traces` self-check and the agent brief's pointer to the runner. The real Playwright suite (`e2e/*.spec.ts`, configs, `scripts/ci.sh`) is untouched.
- **Verified.** `pnpm -r typecheck` is clean except a `packages/acp/testing/fake-turn.ts` error that is already on main; tests of every touched file pass.
- **Left.** An `e2e:` key in an old `majhi.yaml` is still accepted and ignored (`MajhiConfigSchema`). The `e2e_runs` table stays in the DB and in `store/schema.ts` until step E2. `~/.majhi/e2e` on disk is no longer used.

## Needs you holds only what needs the owner (merged)

- **Runs.** A machine-wide cap on agent runs (`limits.runs_total`, auto from the core count, set on Limits). Extra runs queue, owner first. After a restart runs come back one every 20 seconds. A run near its memory limit gets one note.
- **Merge cards.** With Merge the owner's and Push the captain's, a lead's merge request becomes an MR opened by majhi on the server; with no git sign-in the card names the host and links the fix, and the captain retries once it is connected. Agents no longer push from containers.
- **Ship blockers.** The secret scan reads the branch's own changes over the merge base, file by file, skipping lockfiles. Failed hand-off checks retry after a majhi or runner image change or 6 hours, 3 times at most. Hand-off checks get their own CPUs and memory and a per-project time limit. A lead with uncommitted changes is told once.
- **Permissions.** Tools a rule covers (majhi read-only tools, the task's own containers) are allowed for the task, so they do not ask again; the stuck check ignores repeats that succeeded and tells the agent the error when one keeps failing.
- **Secrets.** The lane captain fetches a secret through a workspace connection and saves it straight to the store (`majhi_secrets_saveFromScript`), then withdraws the request. Duplicates collapse.
- **Charts** are back under the workspaces table: spend by hour or day, tasks finished per day, account usage, work flow.
- **Known:** `autonomy/approvals.test.ts` fails on a temp folder cleanup (ENOTEMPTY), also on earlier commits; the wake-gate shadow test in driver.test.ts is flaky under load.
- **Owner check:** after deploy, PRV-116's merge card turns into a GitHub MR or names the missing sign-in; Pyzasoft's secret requests are fetched through DigitalOcean.

## Captain closes the loop on review, secrets and reports (merged)

- **MRs.** When Merge is the owner's and Push the captain's, the ship chore pushes the branch and opens the MR once checks pass, and the card leaves Needs you. The task sits in Open MRs until it is merged on the host.
- **Answer tasks.** A review task with no code change whose lead report answers the brief is marked done; one that ends on a question goes back to the lead, twice at most, then waits for the owner.
- **Secrets.** Secret cards on Home, Needs you and the bell take the value or a dismissal in place. A dismissal tells the agent to find another way. The captain tries connections first, and Tidy withdraws requests over 3 days old that are no longer needed.
- **Root chat.** The root captain posts a roll-up in All: a morning post, every 3 hours in Auto-pilot, and on notable events, at most one per 15 minutes, never the same twice.
- **Dashboard.** One screen, no page scroll: status strip (Auto-pilot, spend with burn rate, accounts, machine), a workspaces table, a Stuck list and the captain's actions.
- **Task cards** show project, priority and due.
- **Branches.** New tasks get `<type>/<id>-<slug>`, following the repo's own pattern when it has one, or `branch_pattern` on the project or org. Agents write Conventional Commits when the repo uses them; MR titles follow.
- **Speed.** majhi.yaml is parsed once per change, room items have a type index, the roll-up reads the board every 5 minutes.
- **Owner check:** an MR opens on GitLab for a Pyzasoft task in review after the next deploy.

## Auto-pilot runs the workspace, not only its backlog (merged)

- **Dashboard.** The Captain page opens on an Auto-pilot dashboard while Auto-pilot is on: status counts that open their lists, a card per workspace, the captain's log, spend per hour against the day cap, tasks finished per day, and open tasks by state. New command `autonomy.report`.
- **Beyond tasks.** The digest lists open incidents, tasks in review and paused tasks of the workspace. A task entering review or pausing wakes its lane. The captain works through alerts, review, paused tasks, failing watches and old Needs-you items each turn.
- **Machine.** The host helper reads load, memory, pressure and disk; majhi reads `docker stats` of its runs. The digest has a Machine line, the captain starts nothing while the machine is busy, and a health check warns on sustained load. Each run takes 1 CPU by default (`MAJHI_RUNNER_CPUS`).
- **Parallel work.** Tasks on one repo and branch run at once unless they name the same files. PRV-117: autonomy_plan can wait for a free account slot.
- **Upkeep chores.** Discover tools (MCP servers and skills for the workspace's stack, proposed once, never again after a dismissal; skills installed with full access), Tidy up (failing connections, dirty worktrees named, idle tasks, long previews, dead watches, old Needs-you items), Health sweep (runs fixes, files majhi bugs), Owner checklist (backups, budgets, disk, account slots raised by one up to 4 with full access when the machine is calm).
- **Docker in tasks.** A `docker` shim in the runner sends allow-listed commands to majhi, which runs them as the task's own hardened containers on its network, binds only inside the task folder, images allowed or built by the task. Hand-off checks get it too. No compose or published ports yet.
- **Full access keeps Merge and Push.** Full access no longer overrides those two rows, so the captain can push and open MRs while the owner merges.
- **Owner check:** a real hand-off check that starts containers (Pyzasoft voice test) passes in a runner after the deploy; the host helper is updated so the Machine line shows.

## Captain can check anything itself: script watches (built, merging)

- **Script watch.** A watch kind that runs a short read-only script the captain writes (curl, jq, python3, node, kubectl, glab, gh) on majhi's clock in a throwaway runner container, with the workspace connections it names: their variables, and ID_TOKEN for a signed-in connection. Output is a number, a word, or JSON read at a path (series folds and formulas apply). Scripts that change something are refused when saved. The captain's fixed text says: no plain kind fits, write a script watch; custom (model) watches only when no script can check it.
- **Fixed on the way:** the database client-image runner was wired to the wrong ports, so image database checks could never run.
- **Today's other fixes (all merged):** DigitalOcean one sign-in for every product, product tool routing, tool names with the verb last read as reads, watches for agents through approvals, full access per workspace, destructive commands narrowed to those marked destructive, database watches through bundled drivers with causes named, API reads with moving time windows, formulas over several reads, standing instructions per workspace, the captain screen map, majhi problems become fix tasks on majhi.
- **Owner check:** a script watch that reads DigitalOcean database CPU through its metrics address (port 9273), set up by the captain after Start fresh on the Pyzasoft thread.

## Connections: workspaces, agents, several per service (built, merging)

- **Fixed:** DigitalOcean failed after approval: the token exchange sent its resource with an added trailing slash. GitLab reached no agent: org agents got only connections their own list named, and every list was empty. A refused or redirected check said "could not reach"; it now names the refusal, and GitLab's names the group setting (Settings > General > Permissions and group features > MCP client access).
- **Changed:** Every agent of a workspace gets its connections; switch one off on the connection page (Agents) or the agent page (Connections). Several connections of one service per workspace, each named. DigitalOcean is one connection with product chips and one sign-in. The list groups by workspace; the catalog head says "Connecting to" and the button names the workspace.
- **Verified:** Connect, connections, MCP server and shared tests of the touched files pass; web typechecks. Screens checked on the seeded e2e instance at 1440 and 1100 px. Screenshot specs updated, not run.
- **Owner-only check:** DigitalOcean consent on your account, and whether one sign-in lists tools for every picked product (the Test says per product). GitLab MCP client access on your top-level group.

## Resource lifecycle correction (merged, applied locally)

- **Reclaimed:** About 3.7 GiB on the local installation: 1.9 GiB of abandoned backup scratch copies and 1.8 GiB from seven ignored dependency/cache directories in finished work. No source worktree, branch, saved service volume or room history was removed.
- **Limits and reuse:** Previews and services now share an installation-wide cap of eight, with one concurrent preview build by default. Slots are reserved before asynchronous allocation. Starting the same named service with the same configuration returns its existing process. Settings remain adjustable in Setup, Containers.
- **Pause:** A service without a saved volume no longer keeps the entire task stack running. Only that service remains; previews, saved-volume services and the builder stop. Resume restarts parked services using their existing volumes.
- **Disk lifecycle:** Health & usage offers Preview dependency caches and cache-only cleanup for finished tasks, including recently finished tasks. Only ignored, untracked dependency/tool cache directories qualify; symlinks and tracked files are protected. Full worktree/history cleanup keeps the configured retention period. Failed Git inspection now protects existing worktrees rather than assuming they are clean. Backup operations serialize scratch cleanup so crash-left database copies cannot accumulate.
- **Remaining:** Task folders still use about 11.9 GiB. The formerly largest folders now belong mainly to paused or review tasks. Many older worktrees contain uncommitted changes and remain protected. Docker also contains unrelated applications, so no installation-wide Docker prune was performed.
- **Verified:** Repository typecheck, server/web builds and 85 affected cleanup, worktree, container and backup tests pass. Browser checks cover cache preview/confirmation and both global limit fields without submitting another cleanup. No real agent runs were started.
- **Deployment:** Updated the local server/web runtime on port 7070 with no active agent runners, then checked restart and health. The previous runtime is backed up in `/tmp`. Merged locally into `main` from `fix/connections-and-resource-lifecycle` with owner approval. The runtime update lasts until image recreation. No push was made.
- **Owner-only check:** Decide which unfinished tasks can close and which uncommitted work can be discarded before reclaiming their source folders.

## Connections usability pass (merged, applied locally)

- **Flow:** Connect a service is the primary header action. Browse services has local brand logos, alphabetical cards, search and categories. Connected rows show the account, scope and test status. Custom setup replaces the old New Connection entry and offers unlisted MCP servers, API credentials and infrastructure.
- **Destination:** Global or a named workspace is visible before choosing a service and stays locked during sign-in. Global connections are stored outside orgs, shared with agents across workspaces, and editable only by the owner. Existing workspace connections remain scoped. SPEC 5.14 records the owner-approved sharing rule.
- **DigitalOcean:** Browser sign-in through seven product-specific MCP servers: Droplets, App Platform, Kubernetes, Databases, Networking, Spaces and Account. Public endpoint and OAuth metadata were checked against the official documentation. Actual consent needs the owner's account.
- **Try:** Open Connections, choose Connect a service, select Global or one workspace, then choose a service. DigitalOcean offers a product selector. Custom setup retains the selected destination.
- **Verified:** Repository typecheck, web build, and 136 affected tests across 12 connection, consent, configuration and shared-schema test files pass. Browser checks use an isolated temporary server and fake sign-in. Checked search, scope, product selection, custom setup, saved scoped entries, Global detail, and sign-in cancellation in dark and light themes at 1440, 1100 and 800 pixels. No real credentials were changed.
- **Deployment:** Applied the built web and server assets to the local Docker instance on port 7070 after checking no agent runners were active. Its previous runtime is backed up in `/tmp`; restart and health check passed. Merged locally into `main` from `fix/connections-and-resource-lifecycle` with owner approval. The runtime update lasts until image recreation. No push was made.
- **Follow-up task:** Adapt the application shell below desktop widths. At 390 pixels its existing fixed sidebar clips every page, including Connections. This requires a shell navigation change outside this pass.
- **Design review:** The independent reviewer approved the desktop composition and scored the Global access and removal copy fix resolved.
- **Owner-only check:** Real-provider consent, identity and tool access, including DigitalOcean, on the updated live instance.
## Task folder disk: shared package store and done-task cleanup (built, branch not merged)

- **Shared store.** `apps/server/src/runs/package-cache.ts`: a run and a background process of a workspace get `~/.majhi/cache/<org>` mounted and `npm_config_store_dir`, `PNPM_STORE_DIR`, `npm_config_cache`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR` set (`launch.ts`). `packages/acp/src/runner/docker.ts` allows that one mount shape.
- **Sweep.** `apps/server/src/tasks/folder-sweep.ts` (`TaskFolderSweep`), called by the Cleanup chore (`captain/chores.ts`, ports in `world.ts`) and by Health's fix. Settings `cleanup.free_after_hours` and `cleanup.worktree_after_days`, editable in Health under Cleanup of done tasks.
- **Health.** Check "Task folders" (size of the task root, rebuildable size in done tasks, warn above 20 GB) with "Free space now" (owner only).
- **Try it.** Health, Cleanup of done tasks, set the hours, then "Free space now" on the Task folders row. Not tried on the live app.
- **Left.** The size is measured in the background at most every 30 minutes and shows "Measuring" on the first read. Orphan task folders are not touched. The owner's task terminal does not get the shared store.

## Cohesion pass 2: the daily loop in the sidebar, honest counts (built)

- **Sidebar.** Order is the loop: Today, Decisions, Watch (only when something is watched), then Board, Chats, Business, then Captain with Autonomous and Playbooks, then one Setup row that opens a menu of the eleven set-up pages. The row names the page you are on and shows one amber dot with a tooltip when something inside needs a look. Setup rows are amber, never red. At 1100x760 with the Update row open every daily row and Setup show, with no scrolling. Old routes are untouched (`/` is the Board; `/autonomous`, `/repos`, `/studio/*` still redirect). Hub setup's first list group is "Basics" and the Skills page is "Skills & MCP" everywhere.
- **Keys.** `g d` Decisions, `g j` Captain, `g w` Watch, `g r` Playbooks; the palette and the Setup menu print each page's chord; the shortcuts list names `x` (select) on Decisions. Esc closes the Setup menu from anywhere; arrows move in it.
- **Today.** The header reads "N on today's agenda, about X min" (the glossary's Agenda; the agenda holds dates, follow-ups and findings, so it is not "need you"). Rows use the Decisions kind and title (Ship, Money; no "Ready to ship:" prefix). "Watch" is now "Right now" and also lists open incidents of watched services (open in Watch). With a workspace picked, the Brief and spend say they cover all workspaces.
- **One count.** Decisions subtitle and the Captain sentence say "N need you". The Findings sheet read the newest 500 findings of every status, so Open showed 21 of 179 (Laya's 478 dismissed ones filled the window); it now reads live findings and uses the server's Open count.
- **Speed.** The shell no longer asks for the doctor checks, the 500 pending lessons and the version check in the first 2 s, so the page's own data is answered first. Measured on the live data through the read-only proxy (the server was busy with other work, so first-content numbers move by seconds between runs): see the report in the task. Server hot spots, not touched: `autonomy.status` about 0.6 s alone and 3 s under the shell's burst, `captain.status` about 0.6 s, `agenda.today` 0.4 to 1.2 s, `health.run` runs every doctor check on each sidebar load. Limits and Today wait on those.
- **Tests.** `apps/web/src/lib/naming.test.ts` bans "things need you" and "decisions wait for you". The e2e files that click sidebar rows (`shell.ui.ts`, `shots.nav.ts`, `shots.ui.ts`, `phase0.spec.ts`, `phase2b-ops.spec.ts`, `shots.captain.ts`) open Setup first; `shots.nav.ts` "every sidebar item opens its page" and `shell.ui.ts` sidebar test pass.
- **Owner calls pending (not done).** (1) Make Today the default route (`/` still opens the Board). (2) Merge Chats into the Board as a view (Chats keeps its row and route). (3) Fold Automations into Playbooks as "Custom" (Automations stays under Setup). (4) Move "44 lessons to review" into Decisions as one batch decision (server; it is an amber count under Setup for now). (5) Whether the agent rail's "5 waiting", the sidebar's "Paused 5" and the roster's "Needs you" should become one word for agents that stopped (counts of agents, not of decisions). (6) The brief text from the server says "Owner needs 9 items reviewed (21 min)"; its wording is in `apps/server/src/agenda/brief.ts`. (7) Whether "Limits" should be named "Budget" (the glossary calls money limits Budget). (8) Today's header still says "N things need you, about X min" until the owner approves "N on today's agenda, about X min" ("need you" counts decisions only everywhere else).
- **Known, not mine.** The bell tests in `e2e/shots.nav.ts` still look for a "Notifications" button (the bell is "Decisions, N need you" since the last pass) and fail. `shell.ui.ts` "an empty board invites the first task" fails on the New task dialog's project pick, which this pass did not touch. `boss.chat` cannot be read safely through a read-only proxy, so the Captain chat pane was judged from code.

## Cohesion pass: one count, one name, a fast Captain page (built)

- **One count.** Everything that waits for the owner is `decisions.list`. `needsYouCount` (`features/decisions/model.ts`) is the one definition and `useNeedsYou` feeds the sidebar, the bell, the tab title, the banner's "And N more", the Board readout (narrowed to the workspace filter), the Captain header and Needs you box, and the Decisions subtitle. The Board's column is now "Waiting" and its readout links to Decisions. Counts of failed health checks read "N to fix"; the agent rail reads "N waiting".
- **One name per kind.** `DECISION_KIND_LABEL` is the table: Ship, Question, Access (approval, secret, sign-in), Money (budget, daily limit), Paused. The chips, rows, detail head and bell use it. "Ready for review" is "Ready to ship" everywhere. The room's review card runs stored text through `plainAuthorityText` (moved from `apps/server/src/inbox/plain.ts` to `packages/shared`), so "is set to Keeps things tidy" shows the plain authority sentence. `docs/glossary.md` lists the words.
- **No global strip.** The Autonomous strip is gone. A dot on the sidebar's Captain row and the Captain header chip say a summary is new. The chip shows only the newest summary of today or yesterday that is unseen, and never in red. A hold on Autonomous shows as the tooltip of the sidebar's Autonomous row and in the Captain header sentence.
- **One health clock.** `healthCheckedAt` takes the newest of every account's check and the page's own run. The sidebar and the Health page both read it.
- **Sidebar.** "Update ready" is one 36px row above the agent lamps, with the changes in a panel above it. It no longer sits in the scrolling middle, so no navigation row hides: at 1440x900 every row shows, at 1100x760 and 900x700 the list scrolls inside the sidebar.
- **Captain speed.** The page draws its shell at once (the header fills in when `captain.status` arrives). The Captain chunk and `captain.status` are warmed when the app is idle and when the pointer reaches the Captain row. Server events refetch a query at most once per 300 ms. The cause of the slowness on the live app was a loop: `boss.chat` was announced as a change (`agents`, `config`), the page refetched it on that event, and one open tab kept the server answering about 22 events a second and refetching the config, agents and onboarding lists each time. `boss.chat` no longer announces anything.
- **Tests.** `features/decisions/model.test.ts` (the count), `lib/naming.test.ts` (retired words in `apps/web/src`), `events/watcher.test.ts` (`boss.chat` emits nothing), `packages/shared/src/plain-text.test.ts`. Shots and rules in `e2e/shots.captain.ts` (`cohesion`).
- **Left:** Decisions "Merge" is still the action name where the room offers a Ship menu (Merge is one of its entries). The Board column and cards still say "Your turn" and "Finished" from their own lamps. `autonomy.status` takes about 0.6 s and `captain.status` about 0.35 s on the live data; both run on the single server thread and are in the captain and autonomy code, which this pass did not touch.

## Phase 7: Resilience and health (PRV-22, built)

Branch `task/prv-22-phase-7-resilience-and-health`. The server and web halves reached `main` at `ac821e18` (merge `6968e842`); the branch then adds the e2e test, the account readout on the new Home top bar, limit notes that take the reset from a run's limit error, and the decisions. Phase 2b already gave checkpoints, offline pause and resume (a probe plus network-looking errors), wake, restart and crash resume, and context-window recovery. Phases 1 and 2c gave the usage reads, the Usage page meters and the health checks.

### What works

- **Limit detection per CLI.** `packages/acp/src/limit-failure.ts`, with the shapes in each tool's registry entry (`limitShapes`). Claude Code and Codex, sign-in and API key: usage limits, rate limits (429) and credit or quota errors, with the reset when the message names one (an epoch after `|`, "resets 3pm (Europe/Berlin)", "try again at 3:40 PM", "try again in 2 hours 13 minutes"). Errors count, and so does a turn whose whole text is one short limit line (the CLI's result handed back as text); an agent's prose about rate limits does not. Context-window errors and overloads are not limits.
- **The account at its limit.** A limit error marks the account (`AccountView.limit`: since, until, resetKnown, detail), `at-limit` until `until`: the error's reset, else the reset of a full usage window, else 15 minutes (shown as "about").
- **Fallback handoff.** When the agent's fallback (Agents, "When usage runs out or the run breaks", "Hand the run to") may work in the org, is not on the team, its account is signed in, not at a limit and not held by a budget, and `resume.handoff` is on (Hub setup, Resume; per org in the Orgs form; default on): the fallback takes the agent's place in the team, starts from majhi's handoff note (TASK.md, the last checkpoint, the room since, the diff) with the queued messages, and the room says "@acme-lead hit its usage limit (resets 4:24 PM). @acme-builder continues from the checkpoint." The same happens before a turn when the account is already at its limit, and when a start fails on a limit.
- **Pause and resume at the reset.** Otherwise the run pauses with reason `limit`, its prompt queued again. Other agents on the account hand off or pause at their next turn boundary. The 60 second lift sweep resumes them once the reset passes; with `resume.auto` off the room says once that the limit reset and the task waits for the owner.
- **Context-window errors.** `isContextError` is checked against both CLIs' wordings; recovery through majhi's note is Phase 2b's.
- **Usage and health in the UI.** Home's top bar ends with the fullest account of the workspace ("claude-acme-1 82%", amber from 80%, "claude-acme-1 at limit" in the limit lamp's colour, every account's windows and resets in its tooltip, a link to Health and usage; hidden under 1200 px). Health and usage rows and the account details say "At limit until 4:24 PM" with the CLI's message as the tooltip. The sidebar's Agents now and the paused cards say "At limit, back 16:24", from the limit error's reset first.

### How to try it

1. Give an agent a fallback on another account: Agents, the agent, "Hand the run to".
2. Run a task with it. When its account runs out mid-run, the room says who took over, the fallback sits in its place in the room, and the account shows at its limit until the reset on Home's top bar and in Health and usage.
3. Without a fallback, or with the handoff off for the org, the task pauses as "at its limit" and continues by itself at the reset.
4. With the fake adapters: write `Claude AI usage limit reached|<epoch>` into `<majhi home>/accounts/<account>/fake-limit`, and every prompt of that account fails with it (`e2e/phase7-limits.spec.ts`).

### Done when

- Unplugging the network mid-run pauses the task, and plugging it back resumes it from the checkpoint with no lost work: `e2e/phase2b-runs.spec.ts`, "offline pauses the running task, and it resumes on its own when the connection is back" (built in Phase 2b).
- A simulated limit error hands off to the fallback: `e2e/phase7-limits.spec.ts`, an account at its limit mid-run hands the task to the fallback with a handoff note, and Home's top bar shows the account at its limit.

### Verified

On the branch with `main` merged at `a99f71c0`, 4 Oct:

- `pnpm -r typecheck` and `tsc -p e2e` pass. The e2e check needed `agentsOff` in the two Connect screenshot fixtures, which `main` lacked.
- Biome passes on the changed files.
- Phase 7 unit tests: 73 of 73 pass. They cover `limit-failure`, the fake agent, `config/settings`, `accounts/limit`, `budgets/limit`, `runs/context`, `runs/limit` and `runs/start-failure`. The settings test also needed `main`'s new cleanup and container defaults.
- Done when, in the browser with the fake adapters: 3 of 3 pass. The specs are `e2e/phase7-limits.spec.ts` and `e2e/phase2b-runs.spec.ts`: the limit handoff, offline pause and resume, and waiting in line at the account limit.
- The whole unit and e2e suites were not run from the task (CLAUDE.md test rule: they run once, at the end of a phase).

### Left and known issues

- A fallback already on the team does not take over; the run pauses for the reset instead.
- The fallback keeps only the agent's repos override: a model or effort set for the agent may not exist on the fallback's account.
- The agent that hit its limit does not come back by itself after the reset; the fallback keeps the task.
- Only queued owner and handoff messages follow the handoff, and the fallback's queue lives in memory, so a restart before its first prompt can drop other queued entries.
- After a majhi restart, a task paused at a limit lifts at the reset whatever `resume.auto` says: the stored pause does not say whether a budget or an account limit set it.
- API-key accounts have no usage windows, so a rate limit without "try again in" is held for the 15 minute guess.

### Owner-only checks

- A real signed-in Claude Code and Codex account, and an API key, reaching their limits: the shapes come from the CLIs' published wording, not from a live account at its limit.

## Captain step 6b: staffing and lead handover (built)

- **Staffing:** `staffTask` (`tasks/staffing.ts`) picks a lead and a team from slots, usage left, floors, budgets, cost, model tier against size, skills and past results, and gives one reason line. The captain's create or start without a team uses it and the room says why; `tasks.staff` (`majhi_tasks_staff`) shows the proposal.
- **Handover:** `tasks.setLead` for the owner, the captain and the current lead (`set_lead` in majhi-tasks); other agents are refused. It reorders the team, keeps or drops the old lead, posts the handover note (plan, commits, next) and wakes the new lead. The lead brief says when to hand over.
- **Tests:** `tasks/staffing.test.ts`, `tasks/set-lead.test.ts`, `autonomy/staffing.test.ts`.
- **Left:** past results are per task, not per agent; a lead that leaves while mid-turn keeps its session until the turn ends; no UI beyond the room lines.

## Captain step 6: workspaces never collide (built)

- **Fair slots:** while Autonomous is On, `fairOrder` (`runs/limits.ts`) orders the line for a slot: the owner's own runs first, then the workspace with the fewest running agents, with workspaces that share an account taking its slots in turn. A workspace with nothing waiting leaves its share. Nothing running is stopped. Per-account and per-task limits stay hard caps.
- **Repo rule:** `autonomy/repo-rule.ts`. The captain's start, create-with-start and resume refuse with one line when a running or in-review task changes the same repo and base, unless the top-level areas differ. The owner's starts are not checked.
- **Ships:** `mrs/ship-queue.ts` runs ships into the same project and branch one at a time, in order.
- **Tests:** `runs/fair-slots.test.ts`, `autonomy/repo-rule.test.ts`, `mrs/ship-queue.test.ts`, and the repo rule through the captain's tools in `autonomy/slots.test.ts`.
- **Left:** `tasks.split` children are not checked against the repo rule.

## One Captain page (built)
## Captain page redesign: one screen (built)

The Captain page is one screen with no tabs. Header: the Autonomous switch and state, one true sentence, spend per workspace (over budget in red), a Delegation button and a one-line summary chip. Left: the Conversation (chips All and one per workspace; the captain's steps fold into "N steps it took"). Right: Needs you (Decisions rows, compact, answered in place), Running, Next, Did recently. Delegation, the full log and the daily summary open in sheets.

- **Autonomous Off still does upkeep.** Off stops starting, shipping, answering and anything that spends on workers. Memory review and cleanup of done tasks keep running in each workspace whose Upkeep row is "Captain decides", under the same caps. `effectiveAuthority` keeps the Upkeep row; `choresNow` limits the chores to memory and cleanup; `CaptainService.stopped()` is only "closing" now.
- **Pause lines name who paused.** The log says "Paused 'Phase 7' because Autonomous was turned off", "by Captain" or "by you", never "(owner)" for the other two. Chat threads no longer write task events.
- **Log lines** are plain sentences with task titles ("Shipped 'X' to main"); no ids, no "Decision: applied". Old stored lines are rewritten on the page.
- **Try it:** open Captain; toggle Autonomous; open Delegation, change a cell and a budget; "See all" for the log; `/autonomous?tab=rules` and `/captain?tab=log` open the matching sheet; Cmd J shows the same Conversation.
- **Checked:** typecheck, `pnpm exec tsc -p e2e`, vitest for the captain and autonomy files touched, and `e2e/shots.captain.ts` (stubs at the volume of a real day: 4 workspaces, 30 shipped, 9 notes, 5 decisions, 120 events, a 40-call turn, one workspace over budget; a second set with 6 workspaces and a very long name) at 1440 and 1100, dark and light.
- **Left:** the All chip sends to the owner's own chat, whose composer has no "Keep as standing instruction" switch (the workspace threads do). The summary chip hides once opened; "Summary" in Did recently reopens it.

## One Captain page (built, replaced above)

The Captain and Autonomous pages became one. Sidebar: Captain, with the Autonomous switch and today's spend as a sub-row. `/captain` has the tabs Today, Chat, Log and Rules (`?tab=`); `/autonomous` redirects to the matching tab.

- **Try it:** open Captain; switch tabs; open `/autonomous?tab=rules`.
- **Checked:** typecheck, `pnpm exec tsc -p e2e`, and the shot spec `playwright.captain.config.ts` (port 7201, `MAJHI_E2E_SEED=ui`) at 1440 and 1100, dark and light. No server change, so no new unit tests.
- **Left:** the notify service still names `/autonomous` as a link path (the redirect covers it); the Today line "N things need you" links to the board until the Decisions inbox lands.

## Phase 11: Trackers (built)

**Status.** Built on `task/prv-26-phase-11-trackers`, from `main`. The three adapters came from PRV-112. DECISIONS has its rows (2026-10-03). SPEC 5.11.

### What works

- **One tracker per org.** Jira Cloud, ClickUp or GitHub Issues, set on the org page under Tracker: the site, email and project for Jira, the list for ClickUp, `owner/repo` for GitHub. The token is saved in secrets and never shown again. Test signs in and checks the project, list or repo. GitHub falls back to the org's `mr_tokens.github`.
- **The adapters** (`apps/server/src/trackers/`) share one interface: `pull(assignedToMe)`, `get`, `comment`, `setStatus`, `link`, `create`, `test`. Each reply is checked with zod. Calls time out after 20 s, and tokens, including Jira's Basic form, are removed from every error. Jira moves an issue through its transitions and says which statuses it can reach when the wanted one is not one of them.
- **Pull.** On demand (Pull now on the org page, `trackers.pull`) and on a schedule (`pull_every`: off, 15m, 1h, 6h; default 1h). By default only items assigned to the token's user. A new item becomes a task in Up next, unstarted, routed to a project through the Dispatcher's order: the org's only project, a project the item names, else the decision provider. An item with no sure project waits on the org page with a project picker. A pulled item is linked once; later pulls only update its status.
- **Item text is reference material.** It goes into `attachments/tracker-<key>.md` (mode 600) with a warning line, never into the brief. The routing call also asks whether the text reads like instructions to an agent, and a sure yes adds a warning to the room.
- **Push.** "Push to Jira/ClickUp/GitHub" in a task's menu creates the item and links it. "Unlink" drops the link and leaves the item alone.
- **Write-back.** Each linked task's MR links and stage are written once, and again only when they change: Jira gets a remote link, ClickUp and GitHub a comment. Running is working, review and mr are review, done is done, each with a status name per tracker that the org page can change. A failed write stays on the link (the chip turns red), is said once in the room, and is tried again.
- **On the board.** A linked task shows a chip with the item key on its card and page.

### How to try it

1. Org page, Tracker: pick the type, fill in the fields, paste a token, Save, then Test.
2. Pull now. New items appear in Up next; items without a project wait under the Tracker section with a project picker.
3. Start a pulled task and open its MR: the item moves to In Progress and then In Review, and gets the MR link.
4. On a local task, open the menu and pick Push to the tracker.

### Verified

- Typecheck (shared, server, web) and biome on the touched files.
- `apps/server/src/trackers` tests: routing, pull, write-back, push, the store, and the adapters against a fake fetch. The phase's done-when is `flow.test.ts`, with the real Jira and ClickUp adapters behind a fake REST API: a Jira item flows into a room and its MR link is written back as a remote link, then the issue moves to In Review. A local task pushed to ClickUp is created on the list and follows the task through in progress, review and complete.
- A screenshot of the org page's Tracker section (`e2e/shots.trackers.ts`).

### Owner-only checks

- Real Jira Cloud, ClickUp and GitHub accounts and tokens: Test, a pull, a push, and status names on a real workflow.

### Left and known issues

- The last pull and the unrouted items are kept in memory, so a restart empties the list until the next pull.
- Status names are typed on the org page; majhi does not read a workflow's statuses to offer them. A wrong name shows as a red chip, with the names the tracker accepts.
- GitHub Issues has only open and closed, so it gets no working or review status.
- Closing an item in the tracker does not change its task.

## Phase 6: Skills and MCP servers (PRV-21, built)

**Status.** Built on `task/prv-21-phase-6-skills`, from `main`. SPEC 5.2 and section 7, Phase 6. DECISIONS has a row per part (2026-10-03).

### What works

- **Skills backend** (`apps/server/src/skills/`, `packages/shared/src/skills.ts`).
  - `skills.search|install|list|enable|disable|remove|update`.
  - Installs run the pinned `skills@1.7.0` in a runner with a throwaway home, then move the result into `~/.majhi/skills/<name>/` with `skills-lock.json`.
  - Install and update are a preview and then a confirm of exactly what was previewed (hash checked). Installing never enables.
  - Sources: `owner/repo`, URLs, a folder inside a workspace root or the tasks folder, or an uploaded zip (zip-slip and symlinks refused). Private repos use the org's git token as an env header.
  - Every install, update, enable, disable and remove writes an audit row.
- **Skills in runs** (`apps/server/src/runs/skills.ts`).
  - Each session gets read-only copies of only its agent's enabled skills, and its first prompt names each SKILL.md.
  - Changing an agent's `skills` or `connections` restarts its open sessions at the end of the turn (`RunManager.remountAgent`).
- **MCP servers** (`apps/server/src/mcp-servers/`).
  - `mcp.search|install|enable|disable` create and switch Phase 10 `mcp` connections. There is no second store.
  - Sources: the MCP Registry (`/v0.1`, then `/v0`), a URL (Streamable HTTP or SSE), a command, or a pasted `mcpServers` snippet.
  - Registry packages are always pinned. Secrets are never taken at install: they come back as `needs` for the write-only secret flow. Required fields block confirm.
  - Test runs after install and returns the full tool list. Enabling stays inside the agent's org.
- **Skills & MCP page** (`/skills`, `apps/web/src/features/skills/`).
  - Skills and MCP servers tabs (`?tab=`), each with Install and a review card, Browse, and the installed list with per-agent toggles.
  - The agent editor has Skills and MCP servers sections.
- **Install by message** (`apps/server/src/installs/`).
  - The owner's "@agent install this skill <link>" or "@agent add this MCP server <name, URL, command or snippet>" gets one approval card instead of a turn.
  - Approving installs the item and turns it on for that agent.
  - Secrets come as secret requests bound to the connection, then Test runs.
  - Root agents get the server in the task's org, not enabled for them.

### How to try it

1. Open Skills & MCP. Paste `owner/repo` or a folder path, Review, then Install. Turn it on for one agent. That agent's next turn names the skill in its prompt.
2. On MCP servers, search the registry or paste a URL, Review, then Install. Set any secret it asks for, check that Test lists its tools, and turn it on for one agent.
3. In a task room, write "@agent install this skill acme/agent-skills" and approve the card.

### Verified

- Typecheck clean. 190 tests pass in the touched areas:
  - skills: fake skills CLI, zip-slip, containment, preview and confirm, the next session has the skill
  - MCP servers: fake registry with the `/v0` fallback, fake stdio MCP server, pinning, secrets, org scoping, the next session has the tools
  - install by message: the card, reject, the skill in the next session, a root agent
  - connections, agents and admin
- Screenshots of both tabs and the agent editor against a real server, the real skills CLI 1.7.0 and a fake stdio MCP server.

### Owner-only checks

- Build the runner image with `skills@1.7.0`.
- Install a private skill repo with an org login.
- Install a real registry server with an API key.

### Left and known issues

- The sidebar link still reads "Skills", because e2e tests match that label.
- An optional secret a registry server lists is not created: it is added on the Connections page.
- A skill from a URL that needed a query token cannot be updated, because tokens are dropped from recorded sources. Use the org login instead.

## PRV-97: Run majhi on Linux, and on Windows through WSL2 (built)

**Status.** Built on `task/prv-97-run-majhi-and-through-wsl2`, from `main`. The brief is `docs/briefs/linux-and-wsl2.md`. DECISIONS has its rows (2026-10-03).

### What works

- **One platform interface.** The host helper finds macOS, Linux or WSL2 once at start and reaches the OS only through `Platform` (`apps/host/src/platform/`): start at login, the keyring, the SSH agent, notifications, opening URLs and the editor, Docker, Laya and folder suggestions. Older helpers send no `os`, so the server reads `hostOsOf(info)`.
- **Start at login.** macOS keeps the LaunchAgent. Linux and WSL2 get two systemd user units: `majhi-host.service` and `majhi-ssh-agent.service`. The helper's environment is in `~/.config/systemd/user/majhi-host.env` (mode 600). On WSL2 `make up` turns on lingering, so when Docker Desktop boots the distro at Windows sign-in, the helper starts with no terminal open. `make down` removes both units and the file.
- **`make up` checks first** (`scripts/check.sh`). It stops with one line and the step for: an OS it does not support, no Docker (on WSL2: WSL integration is off), Docker not running or not allowed, Compose older than v2, Docker Desktop for Linux, and rootless Docker. It warns and goes on when git, Node 20, a keyring or a systemd user manager is missing.
- **Secrets key.** A copy goes to the Keychain on macOS, and to a Secret Service keyring through `secret-tool` on Linux and WSL2. A locked keyring is never touched, so nothing pops an unlock dialog at login. With no keyring, Health says why, and that the export is the only other copy. `make up` and an update put a missing key file back from the keyring. SSH passphrases are kept in the keyring, as on macOS.
- **SSH agent.** On Linux and WSL2 the server always uses `~/.majhi/run/ssh-agent.sock`. That is the helper's forwarder: to the session's agent, else to majhi's own agent unit. Nothing is bind-mounted, so an agent restart or a missing agent cannot leave a root-owned folder. macOS keeps OrbStack's or Docker Desktop's socket, or an older `SSH_AGENT_SOCK`.
- **Notifications, URLs and the editor.** Linux uses notify-send and xdg-open. WSL2 uses a Windows toast (a click opens the task), wslview or explorer.exe, and Windows VS Code or Cursor opened into the distro.
- **Laya.** Native MLX on Apple silicon, as before. Elsewhere it runs in Docker: on an NVIDIA GPU (PyTorch for CUDA 13.0, device `cuda`) when `make up` finds the NVIDIA Container Toolkit or the WSL2 driver, else on the CPU. `make up LAYA_GPU=off` keeps the CPU.
- **Folders.** Suggestions and examples follow the OS (`~/code`, `~/Work`), with no `/Users` assumption.
- **Updates and rollback** go through the helper on all three. On Linux and WSL2 the helper installs its new bundle and exits, and systemd starts it again.
- **Unlocking an SSH key from the UI.** ssh-add gets the passphrase through a one-time askpass in `XDG_RUNTIME_DIR` (else the temp folder). When ssh-add stops before it asks, or takes the passphrase and still fails (an agent that refuses the key), the unlock says so and gives the command for a terminal, instead of blaming the passphrase. The log says why, never the passphrase.
- **Copy and docs.** The UI, the server's messages and the approval labels say "this computer" instead of "this Mac", and name the Keychain on macOS and the keyring elsewhere. Health's key copy check warns with the reason when no keyring answers, and its SSH check passes when `MAJHI_SSH_AGENT=off`. Notifications are desktop notifications (the config key `notifications.mac` stays). Examples and placeholders follow the OS. The warning for folders macOS guards and the native Laya install show only on macOS. The README's Install section covers macOS, Linux and Windows (WSL2). SPEC 4.2, 4.5 and 5.12 cover the three.

### How to try it

- Linux: Docker Engine with your user in the `docker` group, then `make up` from your own login session. `make host-logs` shows the helper.
- WSL2: Docker Desktop with WSL integration on for the distro, then `make up` in the distro's terminal.
- The README's Install section lists the rest (git, make, Node 20, systemd, the keyring, notify-send).

### Verified

On Linux (Debian 12, arm64, with no Docker and no systemd), on `2cf75320`:

- Typecheck (shared, host, server, web), biome, and the touched tests.
- `make up` and `make down` from the Makefile, the helper bundle on node 22, and updates through it. Fakes stood in for docker, systemctl, loginctl, secret-tool, busctl and the desktop programs. 15 passes:
  - `make up` on Linux, on Linux with NVIDIA, and on WSL2
  - 10 refusals, each before anything is built
  - `make down`
  - the key put back from the keyring, and a locked keyring left alone
  - no systemd (WSL2) and no user manager (su)
  - linger refused
  - the forwarder on a session agent and on majhi's own, with a real ssh-agent: the key is listed and a signature verifies through it
  - the desktop jobs on Linux and WSL2, including the escaping and the toast's XML
  - an update; a rollback after an unhealthy start (the previous image and override come back); and an update that puts the key back first
- The smoke e2e (4 of 4) and the Documents warning test, which now tells the web app the helper runs on macOS, since the warning shows only there.
- `tsc -p e2e` reports one error only, an older one in `e2e/shots.onboarding.ts` that the branch's base has and `main` has fixed.

### Owner-only checks

- macOS after this update: the Keychain copy, SSH keys, the agent socket (a custom `SSH_AGENT_SOCK` too, through the first update by the old helper), notifications, start at login, and update and rollback, all as before.
- A Linux desktop with Docker Engine: a real `make up`, the units starting at login, the Secret Service copy and a key restore through `secret-tool`, an SSH key unlocked from the UI and loaded again after a restart, notify-send, opening URLs and the editor, and update and rollback.
- Windows 11 with WSL2 and Docker Desktop:
  - `make up` in the distro
  - majhi starting after a Windows sign-in with no terminal open (Docker Desktop booting the distro, linger, and Windows programs run from a systemd service)
  - the server reaching `~/.majhi/run/ssh-agent.sock` through Docker Desktop's mount
  - the toast and its click, the browser, and the editor through Windows VS Code
- A machine with an NVIDIA GPU, on Linux and on WSL2: Laya on `cuda`.

### Left and known issues

- Docker Desktop for Linux and rootless Docker are refused (the brief's decision 6). Running the containers as uid 0, which both map to the owner, is a follow-up.
- An update rebuilds the server and runner images, not Laya's (PRV-102). That was already true on Intel Macs.
- `make up`, the host helper and compose can pick different secrets key files (PRV-101).
- Without systemd (WSL2 with it off, or `make up` through su or sudo), the helper is off. majhi still runs, with typed paths and no SSH agent for git.

## Phase 13: The captain per workspace (built)

**Status.** Built on `feat/captain-levels`, from `main` (`80002454`). SPEC 5.18 and section 7, Phase 13. Migration 116.

### What works

**The choice** (`packages/shared/src/settings.ts`, `captain.ts`; `apps/server/src/captain/levels.ts`)
- One choice per workspace in `autonomy.orgs.<org>.level`: `ask` (Only when I ask), `tidy` (Keeps things tidy), `runs` (Runs it). Defaults: Private `tidy`, every other workspace `ask`. The daily budget is the same entry's `cap`.
- "More rules" in the same entry: working hours and freeze dates in the workspace's zone (`tz`), the branches it ships to, merge and push, allowed AI providers, and the account that pays for its decisions. All set through `autonomy.configure`, owner only; `null` clears a field. An account of another workspace is refused.
- Autonomous mode stays the master switch: "Runs it" acts as "Keeps things tidy" unless the mode is on. "Only when I ask" runs nothing, in any mode.
- At start, an old `autonomy.pick.orgs` list becomes "Runs it" for each listed workspace in one config commit by majhi; workspaces that already had a choice keep it, the rest keep their default. The pick rule "workspaces it may work in" is gone from the schema patch, the digest and the page.

**Upkeep chores** (`captain/chores.ts`, real ports in `captain/world.ts`)
- They run only in workspaces on Keeps things tidy or Runs it, at fixed moments: when something happens (a task reaches review, a card arrives, an agent asks, a repo appears) and once an hour for those; once a day for memory, projects, triage and cleanup. Nothing stays awake.
- Ship finished work: checks first (in review, nobody working, no card waiting, Ship says it merges, no protected repo, the diff readable and no secret in it). Runs it with "Merge into the branch" on: `tasks.merge` (and push when on), as the captain. Otherwise a ship-ready line on the review card, which the bell lists ("ACM-12 is ready to ship").
- Approval cards: autonomous mode's table decides the routine ones as the card's agent; risky ones and the never list are left for the owner with the captain's line on the card; Keeps things tidy leaves starting and shipping work to the owner. Audited `captain`.
- Agents' questions: rules (nothing to pick from goes to the owner), then Laya through the decision provider (only a sure answer counts), then a short turn of the captain in the workspace's lane, which answers with `majhi_autonomy_answer` or leaves it.
- Memory: the curator keeps, merges or drops each waiting memory of the workspace; doubtful ones wait for the owner.
- Projects: a new repo in `<root>/<workspace>/<repo>` is registered in that workspace with its base; an id clash is asked about.
- Task triage: due within two days or overdue gets high priority (Undo puts it back); duplicate titles and tasks untouched for 30 days are suggested, never closed.
- Cleanup: the cleanup service on the workspace's done tasks; it never removes uncommitted work.
- Stuck tasks: a running task where nobody works and nothing is pending gets its lead woken once, then is paused for the owner. The idle watch of 5.3 still runs everywhere.

**Lanes** (`captain/lanes.ts`, `autonomy/driver.ts`)
- One chat of the captain per workspace (brief "Captain lane", the workspace's org). Autonomous mode ticks the lane of each Runs it workspace with a digest of that workspace only: its tasks, cards, backlog, holds, spend and accounts; the owner's standing instructions are shared. The old autonomy chat stays readable and is never woken.
- A lane reads one workspace only, for every read command, found from the command table (`captain/lane-scope.ts`): a read that asks about another workspace is refused; an `org` filter the command takes (also `filters.org`) is set to the lane's; and every row of another workspace is taken out of the answer at any depth: by its `org`, memory or agent `scope`, the task, project, account or agent it names, its own `id` or `key`, a record key, or a name of another workspace in its text. The majhi-tasks list goes through the same filter. A lane also refuses a change in another workspace. A lane runs on the captain's account only when it belongs to the workspace or to Private, else on the account "More rules" names; another workspace's account is refused at run start.
- A lane rests at the day budget, the workspace's budget or its account's floor; rules and Laya go on, judgment calls wait.

**Guards** (`captain/runner.ts`, `rules.ts`)
- One run per chore and workspace; a trigger during a run joins it for one more pass.
- Per run: 20 actions (100 for memory), 60,000 lane tokens, 10 minutes. Daily caps per chore and workspace (five ships, four memory runs, and so on). A run that stops at a cap writes a line.
- Every action has a key: doing it twice changes nothing. Two failures in a row turn the chore off for the workspace and tell the owner; Turn on brings it back.
- Events carry their cause: the captain's own ships, cards and lane writes start nothing.
- Right before a push, merge, card answer or post, the workspace's choice, its hours and freezes, the stop switch and presence are read again.
- Presence: the captain waits only while the owner is typing in that task (step 8; the 10-minute rule is gone). See SPEC 5.18.
- "Stop the captain" (`captain.stop`) stops autonomous mode now, cancels every lane's turn and ends runs at their next step; nothing acts until `captain.resume`. Autonomous mode cannot turn on while stopped.

**What the owner notices**
- The bell: ship-ready cards, a chore turned off, and once a day at the summary time one line per workspace for the day before.
- `captain.status`: one line per workspace for today ("shipped 2, tidied 8 memories, 1 thing for you").
- `captain.log`: each action with reason, evidence and Undo. A merge undoes as one revert commit (made in a throwaway worktree, then a fast-forward; refused when later work changed the same lines or the checkout holds changes); a config change through the config history; a priority through `tasks.update`; a memory step through `memory.undo`. A push and a cleanup say they cannot be undone.

**Web**
- The Captain page (`/captain`): a card per workspace with today's line, the three choices, the daily budget next to Runs it, chores that turned off with Turn on, and "More rules" folded away; the log beside it (its own view below 1280 px); "Stop the captain" and "Resume the captain" in the header.
- The sidebar Captain row opens the page and shows Stopped; the chat button beside it (Cmd J) still opens the captain chat.
- The Autonomous page: a Lanes section (one row per Runs it workspace: working or resting, open tasks, spend against its budget), and the chat on the right shows the picked lane and writes to it. Rules no longer has the workspace list.
- Review cards show the captain's ship-ready line.

### How to try it

1. Open Captain in the sidebar. Private is on Keeps things tidy; client workspaces are on Only when I ask.
2. Set Private to Runs it, give it a budget, and under More rules turn on Merge into the branch.
3. Turn autonomous mode on. A Private task that reaches review with its checks passing is merged; the log says why, with Undo.
4. Set a client workspace to Keeps things tidy: its finished tasks get a ship-ready line and show in the bell; nothing ships.
5. Stop the captain from the page header; Resume it the same way.

### Verified

- **Typecheck:** all packages and `e2e`.
- **Tests** (fake ACP agent, no tokens): `captain/rules.test.ts` (defaults, master switch, the pick move, hours over midnight and freezes in a zone, presence, branches, providers), `captain/runner.test.ts` (re-check before an irreversible step, joining, repeats, run cap, circuit breaker, stop, rest, tokens), `captain/undo.test.ts` (revert commit on a checked-out and a free branch, later work kept, conflicts and dirty checkouts change nothing), `captain/migrate.test.ts` (one config commit by majhi, once), `captain/done-when.test.ts` (Phase 13's Done when with real services and git: Private ships, Acme is untouched, Undo reverts, tidy asks), `runs/lane-account.test.ts`, and the autonomy tests moved to lanes (`pick.test.ts`, `approvals.test.ts`, `service.test.ts`, `driver.test.ts`, `summary.test.ts`).
- **Soak test** (`captain/soak.test.ts`, about 3 s): 30 simulated hours in Private (Runs it), Acme (Keeps things tidy) and Globex (Only when I ask) with bursts of 25 cards, questions, memories, repos, quiet tasks, two failures in a row, a crash that leaves a run open, restarts, a Stop and Resume, and every ship and card of the captain echoed back as an event. Real lane turns run the fake agent. It checks: no run past its caps and none left open, no daily cap passed, every self event dropped (none started or joined a run), no action repeated, nothing in Globex, nothing while stopped or in a task the owner was in, each lane told only its own workspace's tasks, the lane resting at Private's budget while Laya's answers went on. `e2e/captain-soak.spec.ts` runs it in every Playwright run, so the background e2e after each merge (PRV-72) runs it too.
- **Lane reads:** `captain/lane-reads.test.ts` fills Globex with a task, project, account, agent, memory, audit row, spend and settings, then calls every read command an agent may call from Acme's lane: none names Globex or a Private task, Acme's own rows are there, and filters for Globex are refused. The soak test makes the same sweep from each lane at its end.
- **Migration:** main merged (its last migration is still 115). 116 applied to a fresh copy of a real `majhi.db` (115 before, 116 after, a second run applies nothing, integrity ok).
- **Browser:** `e2e/shots.captain.ts` (`playwright.captain.config.ts`, port 7199): the Captain page at 1440 and 1100 in both themes, More rules open, the log view, Stop and Resume, the Autonomous page with lanes; click tests of a level, the budget, the stop switch and the sidebar row. `pnpm e2e:smoke` passes.

### Left and known issues

- The lane's budget is checked before each ask; turns already queued can pass it by a few cents, bounded by the run and daily caps.
- Triage marks duplicates and stale tasks in the log and the bell; it adds no task link.
- An ask card with several questions, or free text only, is left for the owner.
- Ship needs "Merge into the branch". With push alone the captain asks; it opens no merge requests itself.
- In Private's lane the `org` filter is not forced (Private tasks have no org to filter by), so a total such as `usage.summary` counts every workspace; its rows are still narrowed. Counts are what 5.18 lets lanes share.

Only the owner can check a real captain account running lanes overnight with real spend.

## Onboarding and git connect (plan)

**Status.** The contract is on `feat/onboarding-contract`: schemas and commands in `packages/shared` (`git-signin.ts`, `remote-repos.ts`, `project-create.ts`, `onboarding.ts`, new host jobs in `host.ts`), stub handlers in `apps/server/src/gitConnect/` (501 until built), the Bitbucket callback route stub, the `signins` and `clones` event topics, and the host progress route. The brief is `docs/briefs/onboarding-and-git-connect.md`. Two agents build from it: server and host, and the onboarding UI against the stubs.

### What will be built, in order

1. OAuth apps (`git.oauthApps.get/set`) and `MAJHI_ORIGIN` for the callback URL.
2. Sign-in: the flow store and its state machine, the GitHub and GitLab device flows, saving the token for one workspace (`git_accounts` token and `mr_tokens`), GitLab refresh.
3. The Bitbucket authorization code flow and its callback.
4. Host helper jobs: `openUrl`, `git.clone` with majhi's own askpass and progress, `git.lsRemote`, `git.push` with the workspace's credential.
5. `git.remoteRepos` and `git.remoteOwners`.
6. Clone jobs: the path rule `<root>/<workspace>/<repo>`, refusals, progress, registering.
7. `projects.create`, `projects.publish`, `projects.connectRemote`.
8. `onboarding.status`.
9. Web, in parallel: the steps welcome, AI account, workspaces, git accounts, projects (on this computer, from a git host, new project), captain, arrive; skip per step; Hub setup reopens any step.

### How it will be tested

- Unit tests for the crucial parts only: the sign-in state machine (pending to done, denied, expired, cancelled, failed; `slow_down`), the token saved only for the named workspace and never in a result, log or URL, GitLab refresh rotation, the single-use Bitbucket `state`, the clone path rule (Private, a second root, nesting in a repo), clone refusals and job states, no folder left after a failed clone, the askpass never putting the token in argv, and connect pushing only to an empty remote.
- Host APIs behind an injectable `fetch`; git against local bare repos. No test reaches a real git host.
- Web: typecheck, then a browser pass through every step with the longest workspace names, at about 1100px wide.
- Left for the owner: signing in to real GitHub, GitLab and Bitbucket accounts, and registering the three apps once.

### Server and host: built (2026-10-03, `feat/gitconnect`)

**What works**
- **OAuth apps** (`gitConnect/apps.ts`). `git.oauthApps.get` shows the GitHub client ID, GitLab IDs per host, the Bitbucket key and whether its secret is saved, majhi's origin and the Bitbucket callback; built-in IDs (`BUILT_IN_OAUTH_APPS`, empty for now) are marked `builtIn`. `git.oauthApps.set` writes `git_apps` in one config commit; the Bitbucket secret goes to `secrets.age` (rewritten in place on a new one, deleted on remove) and is never returned. `MAJHI_ORIGIN` (compose passes `http://127.0.0.1:${MAJHI_PORT:-7070}`).
- **Sign-in** (`flows.ts`, `signIn.ts`, `oauth.ts`). GitHub and GitLab device flows with the host's interval and `slow_down` (+5 s), denied, expired, cancelled (also by a new start for the same workspace and host), failed with a plain reason. Bitbucket authorization code through `GET /oauth/bitbucket/callback` with a single-use 32-byte `state`. The token is checked with the host's user API, then saved for the named workspace only: its git account's `token` (plus `oauth` grant for GitLab and Bitbucket) and `mr_tokens[kind]`, identity filled from the public profile when empty. A reused account waits in `confirm` until `git.signIn.confirm`. `git.signOut` revokes on GitLab, removes elsewhere and links the host page. The browser opens through the `openUrl` host job; without the helper, `opened: false` and the UI shows the link.
- **Tokens** (`tokens.ts`). One reader for sign-in tokens: refresh 10 minutes before expiry, rewriting the token and grant secrets in place (GitLab rotates the refresh token), one refresh at a time, and on a 401 one refresh and retry. MRs, `orgs.gitStatus` (Bearer for a stored Bitbucket OAuth token) and Ship's https pushes through the helper use it.
- **Remote repos and owners** (`hostRepos.ts`, `here.ts`). GitHub (all affiliations, Link paging, server-side name filter then search past 500 repos), GitLab (`membership`, `X-Next-Page`), Bitbucket (per workspace). Each repo is marked `registered`, `cloned` or `none` by normalized `host/owner/name` (ssh and https alike, aliases resolved, `.git` and ports dropped). `signed-out` and `refused` answers.
- **Clone** (`clone.ts`, `cloneJobs.ts`, host `gitClone.ts`, `gitAuth.ts`). Path rule `<root>/<workspace>/<repo>` on resolved roots with containment checks; refusals (folder not empty, workspace folder is a repo, repo already a project, id taken, same clone running, no credential, no helper). The helper clones with `--progress` into `.<folder>.majhi-clone-<id>`, parses phases and percents, renames when done and always removes the temporary folder. Progress reaches the job through `POST /api/host/progress` (at most every 500 ms, `clones` topic). The project is registered with base = the checked-out default branch and `origin` with its host (and SSH alias over ssh). Jobs live in `clone_jobs` (migration 115) and are tidied after a restart.
- **New project, publish, connect** (`project.ts`). Create: folder, `git init -b main`, README, "Initial commit" as the workspace identity, registered with base `main`; nothing half made is left on failure. Publish: repo made on the host (private by default, under the account or a chosen owner), `origin` set without credentials (SSH alias when the workspace has an SSH route), base pushed with upstream, remotes saved, an audit row. Connect: `ls-remote` through the helper with the workspace credential, the remote added, pushed only when empty; otherwise fetched with a plain line and nothing pushed.
- **Onboarding status** (`onboarding.ts`). Real done flags and details for every step, `next`, roots, host helper, and each workspace's git hosts (signed in or not) and project counts.

**How to try it.** With no app set, Sign in answers the setup card. Save a GitHub client ID with Enable Device Flow (`git.oauthApps.set`), then `git.signIn.start {org, kind: "github"}`, enter the code, and `git.signIn.poll` reaches `done`; `git.remoteRepos` lists the account's repos; `projects.clone` clones one into `<root>/<workspace>/<repo>` with the host helper running.

**Tests.** `apps/server/src/gitConnect/*.test.ts` (flows, sign-in with a fake GitHub, GitLab and Bitbucket, tokens and refresh, path rule and remote keys, clone jobs and restart tidying, host repo paging and filtering, and an integration test that drives the commands with a played host helper against local bare repos) and `apps/host/src/gitClone.test.ts` (askpass, clone with progress and cleanup, ls-remote, push with a token). No test reaches a real git host; a test asserts that no sign-in event, status, page or error holds a token or code.

**Left and known issues**
- The built-in GitHub and gitlab.com client IDs are empty until the owner registers majhi's apps and pastes the IDs into `BUILT_IN_OAUTH_APPS`.
- GitHub Enterprise Server is not covered (paste a token).
- An empty remote repo cannot be cloned (the helper says to use New project and connect).
- A clone the helper finishes after a server restart can land after the restart tidied it. The job reads failed, and the repo then shows as `cloned` in the remote list and under "On this computer", where Register adds it. Rare: it needs a restart mid-clone.
- `config/settings.test.ts` "fills every default" fails on this branch's base too (autonomy `pick` default added on main without the test); not touched here.

## PRV-31: Back up majhi.db (built)

**Status.** Built on `task/prv-31-back-up-majhi-db`, from `main`. Part of Phase 2c (SPEC: a daily snapshot of `majhi.db` kept for 7 days, with restore).

### What works

- **Daily snapshot** (`apps/server/src/backup/service.ts`). Thirty seconds after start, then every hour, majhi takes `backups/daily-<time>.db` in `~/.majhi` unless the newest daily one is under 24 hours old, so a restart or a night asleep catches up on the next check. It uses SQLite's online backup, so majhi keeps working and the copy is consistent with the WAL. The newest 7 of each kind are kept. `*.db` is already in the config history's `.gitignore`, so snapshots never enter it.
- **Kinds.** `daily` (automatic), `manual` ("Back up now") and `before-restore` (what a restore replaced). Each kind keeps its own 7, so clicking Back up now cannot push the dailies out.
- **Restore.** Hub setup, Backups, Restore on a row. majhi checks the snapshot (integrity check, has the migrations table, no migration this build does not know), snapshots the current database as `before-restore`, and stages the file as `majhi.db.restore`. `Store.open` swaps it in, and drops the old WAL, the next time majhi starts. The open database cannot be replaced under the repos holding it, so the section says to run `make up` and offers Cancel the restore. An older snapshot gets the newer migrations on open.
- **Commands.** `backup.list`, `backup.now`, `backup.restore`, `backup.cancelRestore`. Restore and cancel are in `AGENT_BLOCKED_COMMANDS`: the owner's call only.

### Left and known issues

- Restore needs a restart by the owner (`make up`); majhi cannot restart itself from inside the container.
- `memory/memory.db` (facts) is its own file and is not backed up here; the brief covers `majhi.db` only.
- Not tried with a long-running majhi or in a browser.

## PRV-74: Autonomous mode (built)

**Status.** Built on `task/prv-74-autonomous-mode`, from `main` (`1b001e74`). The contract came first, then the web, the server core and the captain driver, then the review fixes, all in this one worktree. The child task PRV-91 holds no code. The owner flips one switch and leaves; the captain runs the desk inside the caps, the account floors and the hard limits, and logs every decision with one line why.

### What works

**Server** (`apps/server/src/autonomy/`)
- **The mode.** Off, on, paused and stopping, kept in SQLite (migration 112) across restarts. Turning on is refused without a captain. Pause holds autonomous runs at their next turn boundary, and Resume restarts exactly the tasks it held. Stop gracefully lets the current turns finish, stops what would wake again, then turns off. Stop now cancels the captain's turn first, then stops every autonomous run.
- **The autonomy chat.** A chat task of the captain with the brief `Autonomous mode`, made on the first start and reused. It is not the Cmd J chat. Its sessions start with a short preamble on how to run the desk.
- **Autonomous tasks.** Tasks the captain creates, splits or starts from that chat, and tasks agents of autonomous tasks create, join for good. `tasks.list` marks them `autonomous`, with the owner's `priority` and `due`.
- **Self-approval** (`policy.ts`). While the mode is on, a call from the captain or an agent of an autonomous task that would wait for the owner is approved within the table and the limits (card marked approved, audit row `by: autonomy`), or left for the owner with one line why.
- **Hard limits** (`limits.ts`). In every mode, off included: no force push, no push with a merge, no `deleteAfter`, no secrets in any text or passed by value, nothing of one org (secrets, accounts, git accounts, logins, SSH aliases, connections) passed to another, and no org agent let work in another org.
- **Spend and holds** (`spend.ts`). Today's spend of autonomous tasks and the chat in the owner's zone, against the day cap and each org's cap. Account floors keep new work off an account until its window resets. Holds lift by themselves.
- **The run gate.** `held` in `RunDeps` answers `owner` while paused or stopping and `limit` under a cap, between turns only.
- **The driver** (`driver.ts`, `digest.ts`). It wakes the captain in its chat when the mode turns on or resumes, a task reaches review, an MR or done, a run ends idle, a card comes in, a hold changes, and hourly while nothing runs. Events are batched for 20 s, one tick waits at a time, never mid-turn. The tick message stays under about 1,500 tokens.
- **The captain's tools.** `majhi_autonomy_plan` (the queue), `majhi_autonomy_note` (decisions that are not calls, `unsure` for the summary) and `majhi_autonomy_answer` (cards of autonomous tasks, through the owner's own paths). There is no card for them, and only the captain in its chat may use them.
- **Guidance.** `autonomy.guide` reaches the captain as the owner's message in its chat; with `keep` it also becomes a standing instruction (a config commit). `autonomy.forget` removes one.
- **The daily summary** (`summary.ts`). Made once a day at `summary_at`, even across restarts, and told to the owner under the notify kind `autonomy`.
- **Settings.** The `autonomy` section of `majhi.yaml`: day cap ($20 by default, always set), per-org cap, push and merge (both off by default), floors (5-hour 10%, weekly 5%), summary time and zone, instructions. `autonomy.configure` writes only what changed.

**Web** (`apps/web/src/features/autonomy/`)
- **Sidebar.** An Autonomous row under the Captain button, with a lamp, the mode in words and a switch. On asks first, showing the day cap, the floors and each org's cap, push and merge. Off offers Pause or Resume, Stop gracefully and Stop now, which asks first.
- **The strip.** While the mode is not off, a strip that cannot be closed sits above the attention banner on every page. It shows the mode, what runs first (a task, else the captain), today's spend against the day cap, Pause or Resume, Stop and Open, and a link to a new daily summary.
- **The Autonomous page** (`/autonomous`, also in the palette). It has:
  - the mode, since when and why, and the controls;
  - the daily summary, Now, the Queue and Waiting for you;
  - the live feed with a Decisions view and load more;
  - the chat box (Ask, Add as instruction) with the captain's latest replies, and the standing instructions with remove;
  - Spend (day and org bars, holds, each account's windows with the floor marked) and the Limits form.
  Every task id opens its room.
- **Cards and tasks.** Approval cards say when autonomous mode approved them or left them for the owner. Board cards show an Auto mark and priority and due chips. The task header edits priority and due.

### Rework: pick rules, the captain chat and one-screen page (2026-10-02, `ux/auto`)

- **Pick rules** (`autonomy.pick`, Rules view). Task size it may start (Small only, Up to medium, Any size; default Any size), the workspaces it may work in (all, or a list with Private), and a per-task mark Not for autonomous mode (`autonomy.exclude`, owner only, `noAutonomy` in `tasks.list`). Size is Laya's rating of the task (`sizes.ts`), cached per task and rated again after an edit.
- **Enforcement.** The digest lists the rules and each backlog task's size, and leaves out what they exclude. The preamble states them and says size is no reason to skip allowed work. The captain's starts and creates that break them are refused in `refusal` with one line, and logged as `refused` (`pick.ts`, `pick.test.ts`).
- **The captain chat.** One chat, reused across runs. While the mode is not off it cannot be closed or removed; off, it can, and the next start makes a new one. A tick first makes or reopens a chat that is gone (`tickChat`).
- **The page** fits 1440x900 without scrolling: a status bar (mode lamp, since, today's spend against the cap, Desk/Rules/Summary, Pause or Resume, Stop with both stops); the Desk with Waiting for you, Now and Next (each with why, a size badge and a leave-alone button) beside a compact Log with All/Decisions/Tasks; the captain chat on the right with the room's timeline and a box to write to it (Keep as standing instruction). Rules holds the pick rules, the backlog with the leave-alone switches, caps, push and merge, floors, spend and accounts, and the standing instructions. Below 1280 px the Log is its own view. The strip hides on this page.
- **Checked.** 8 tests in `pick.test.ts` and a driver test; screenshots and click tests in `e2e/shots.autonomy.ts` (`playwright.autonomy.config.ts`).

### How to try it

1. Make sure there is a captain (Agents, or the last onboarding step).
2. Give tasks a priority and a due date in their header if some matter more. The captain takes high first, then the nearest due date.
3. In the sidebar, flip the Autonomous switch. Check the day cap, the floors and each org's push and merge in the confirm, then click Turn on.
4. The strip shows on every page. Click Open, or Autonomous in the sidebar.
5. Within about 20 s the feed shows "Woke the captain". Its plan shows under Queue, and its decisions show in the feed with their reasons.
6. Under Rules, set what it may pick (size, workspaces), the caps, push and merge per workspace, the floors and the summary time, then click Save. Mark tasks Not for autonomous mode in the backlog there.
7. In the captain chat on the right, Send writes to the captain. With Keep as standing instruction on, it is also kept.
8. Pause, Resume, Stop gracefully or Stop now, from the page header, the strip or the sidebar switch.

### Verified

- **Typecheck:** all five packages.
- **Tests:** the 6 files under `apps/server/src/autonomy`, 43 tests, all passing on 2026-10-02. They use the fake ACP agent and spend no tokens.
  - `policy.test.ts`: the table, holds on work that starts, and every hard limit (cross-org secrets, accounts, `where`, git accounts, logins and SSH aliases, connections, secrets in text and by value, force push, push with a merge, `deleteAfter`), and which org a call acts in.
  - `approvals.test.ts`: `AdminService` with the fake agent. A pending change is approved with its audit row, a destructive call is left, a push follows the org setting, and a hard limit is refused in every mode. It also covers agents of autonomous tasks, other agents in the chat, caps on rule, `auto` and lead starts, and the captain's tools and answers.
  - `service.test.ts`: the state machine. Refused without a captain; turn on, adopt and pause after the turn; the owner resuming one held task; Stop now; Stop gracefully; a restart in `on` and in `stopping`.
  - `spend.test.ts`: the day in a zone (with a clock change), per-org sums, a cap reached and lifted, account floors, and spend counted from when a task joined.
  - `driver.test.ts`: the debounce, no tick while the captain is busy, ticks only while on and not under the day cap, the digest's size and the backlog order.
  - `summary.test.ts`: what the summary says, and one summary per day across restarts.
- **Browser check** (2026-10-02). Against the real server and web from the worktree, with a throwaway home: org Acme, project api, and the captain on a fake agent account, with no real account. All 16 steps passed:
  - turn on from the sidebar switch through the confirm;
  - the strip on the board and on Agents;
  - the mode change and the first tick in the feed, and Now, Queue and Spend;
  - a day cap saved and still there after a reload;
  - one Ask and one instruction, which is listed;
  - Pause, Resume and Stop gracefully, ending Off with the whole run in the feed.

  It found three web problems, all fixed:
  - the strip said nothing runs while the captain worked;
  - a feed row repeated its line as its reason;
  - the captain's replies had their last line faded.

### Left and known issues

- **Automations.** While the mode is on, schedules and triggers that start tasks or run commands, and every automation resume and run now, are left for the owner. Tasks an automation starts are not autonomous, so they would run outside the caps, the run gate and Stop. The follow-up is to track them as autonomous; then the captain can create them too.
- **No end-to-end day.** No test runs a whole autonomous day with the fake agent: the captain picking a task, a builder shipping it, the summary next morning. The parts are covered by the tests above.
- **The fake captain never plans.** In a dry run with the fake agent, the captain never calls its own tools, so the Queue stays empty and no decision rows appear. Those tools are covered by `approvals.test.ts`.

### Rules that hold

1. **Mode.** Only the owner starts, pauses, stops, configures, guides or removes an instruction: those six commands are kept from agents. Every change writes a `mode` event and a quiet line in the autonomy chat.
2. **Autonomous tasks.** They stay autonomous after they are done and after the mode is off, for history and for the hard limits.
3. **Self-approval.**
   - A plain change is approved.
   - These are left for the owner: destructive calls; projects, workspaces and branch changes; the owner's settings; sensitive org fields; outbound calls; model prices, container images and the decision model.
   - Push and merge follow each org's setting.
   - Work that starts is approved only when no hold covers it.
   - An agent's `ownerAsked` counts for nothing.
4. **Hard limits** come before any rule or `auto` mode, for the captain and every agent of an autonomous task. A refusal writes a `refused` event and goes into the summary.
5. **Holds.** A cap hold pauses autonomous runs of that scope at their next turn. An account hold only keeps new work off the account. When the day ends or the owner raises the cap, majhi resumes the tasks it paused for that cap.
6. **The driver** never ticks while the mode is off, paused or stopping, or under the day cap. The owner's guidance still reaches the captain.
7. **The web** reads `autonomy.status` and the feed. The `autonomy` topic refetches them on every change, and the status is also read every 30 s while the mode is not off.

Only the owner can check a real captain account working overnight with real spend.

## Phase 10 plan (PRV-25)

**Status.** Parts A, B and C are built. The Done when is covered by `apps/server/src/connections/done-when.test.ts` with the fake ACP agent. Only the owner can check a real cluster with a viewer kubeconfig, New Relic's remote MCP server with an API key, and a runner image build (kubectl and the browser MCP servers).

Branch `task/prv-25-phase-10-connections-and-ops-tasks`, from `main` (`ff601c27`). SPEC 5.14, 5.15 (task kinds, ops flow) and section 7, Phase 10. Parts A and B are built on this branch, in that order. Part C (ops tasks) is a child task on its own branch, built at the same time. One small commit per step.

### Part A: registry, storage, commands, Test, page

1. **Registry**, `packages/shared/src/connections.ts`. One entry per type declares its fields. A field has a key, a label, a kind (`secret`, `text` or `file`), the variable it maps to, whether it is required, and help text. Adding a type means one entry, its Test and its injection.
   - `kubectl`: kubeconfig (file), context (text, required), namespace (text).
   - `mcp`: a remote URL with headers, or a local command with args and env. Header and env values can be secrets. The New Relic remote server (`https://mcp.newrelic.com/mcp` with an `Api-Key` header) must fit.
   - `ssh`: a host alias from `~/.ssh/config`, picked from the aliases majhi already reads.
   - `env`: any number of fields the owner adds, each with its kind and variable (`API_KEY` secret, `ORG_ID` text, `GOOGLE_APPLICATION_CREDENTIALS` file), plus the CLIs it is for (`aws`, `psql`). Part B's gate uses that list.
   - `mail`: IMAP and SMTP (hosts, ports, user, password), or a mail MCP server set up like `mcp`.
   - `browser`: Playwright MCP or Chrome DevTools MCP, with one profile per connection.
2. **Storage.** Definitions sit under the org: `orgs.<org>.connections.<id>` in `majhi.yaml`. The schema changes in the same commit. Ids are unique across all orgs. Text values go in the yaml. Secret values go in `secrets.age`, with a `secret:` ref in the yaml. Files go in `~/.majhi/connections/<id>/` (folder 0700, files 0600). Each connection also has a `description`, which is what agents see, and an `allow` list: the exact actions the org allows without asking (Part B). Values never reach logs, the room, TASK.md, memory or reports.
3. **Commands** in `packages/shared/src/commands.ts`, so the captain gets them:
   - `connections.list` and `connections.get`. These never return a secret value, only whether it is set.
   - `connections.create`, `connections.update` and `connections.remove`. Remove is destructive and deletes the connection's secrets and files.
   - `connections.setSecret` takes the value from the page's secure input, or a `secret:` ref the captain got from secret capture.
   - `connections.setFile` takes an upload id.
   - `connections.test`.
4. **Test** per type. Each returns `{ ok, detail, warnings }`.
   - kubectl: `kubectl auth can-i --list` against a copy holding only the context. It warns when the identity can change things (`can-i delete pods`, `can-i patch deployments`).
   - mcp: connect and list the tools, with the `@modelcontextprotocol/sdk` client (already a dependency).
   - ssh: `ssh -o BatchMode=yes <alias> true`, the way majhi's git reaches hosts.
   - env: the required fields are set. If the owner gives a test command (like `aws sts get-caller-identity`), it runs.
   - mail: an IMAP login over TLS and the SMTP greeting.
   - browser: the MCP server starts and lists its tools.

   Health and `doctor` get a Connections check that runs them all.
5. **Web.** A Connections page at `/connections`, in the sidebar and the palette. Per org, each connection is a row with its type, name and description, a lamp with the last Test result, and a Test button. The form draws the type's fields:
   - text inputs;
   - write-only secret inputs (Set or Replace, never shown again);
   - file upload;
   - for `env`, rows to add fields.

   Studio's agent editor gets a Connections picker with the org's connections. It writes the agent's `connections`.
6. **Tests:** storage (no secret value in the yaml, files at 0600, remove cleans up), cutting a kubeconfig down to one context, and `connections.get` never returning a secret.

### Part A done

What works:

- **Registry.** `packages/shared/src/connections.ts` declares the six types. A field has a key, label, kind, variable, required, help, and optionally choices, a `when` rule (a remote MCP server has a URL, a local one a command) and a format (URL, port, host, words). The owner's own entries are lists keyed by name, each with its kind: `vars` for `env`, `headers` and `env` for MCP servers. `mail` is IMAP and SMTP or a mail MCP server set up like `mcp`; `browser` is Playwright MCP or Chrome DevTools MCP. `connections.types` hands the registry to the captain.
- **Storage.** `orgs.<org>.connections.<id>`, checked by the org schema, so `orgs.update`, `orgs.rename` and the Private org's first write keep connections. Ids are unique across orgs, hand edits included. Secret values go to secrets.age under names derived from the connection and field; a replaced secret is deleted once nothing else names it. Files sit in `~/.majhi/connections/<id>/` (0700, 0600). Remove deletes them and takes the id off the agents that list it. Variables that steer majhi or the agent CLIs (PATH, LD_*, GIT_*, ANTHROPIC_*, KUBECONFIG and the like) are refused. A connection's file comes through `POST /api/uploads?for=connection`: any type, at most 1 MB, owner-only, never a task attachment.
- **Commands.** `connections.types`, `list`, `get`, `create`, `update`, `remove`, `setSecret`, `setFile`, `allow` (destructive: it lets agents write unasked) and `test`. No view holds a secret's value. An agent may pass only a `secret:` reference, never one the config already uses. It may not change where a connection that holds a secret sends it (URL, command, test command, transport, mail hosts).
- **Test.** As planned per type, through the sessions' spawner: with runner containers, kubectl, the env test command and local or browser MCP servers run in a runner. They get PATH, LANG, a throwaway HOME and the connection's own values. Their files go in an owner-only scratch folder in the tasks folder, removed afterwards. SSH logs in from majhi, only to an alias of ~/.ssh/config. Secret values are replaced in every result. Health and `doctor` have a Connections group. `doctor` tests each connection. The Health page and the sidebar read the checks every few minutes, so they only show the last Test: testing there would start containers and sign in to clusters and APIs unasked. Each row offers Test as its fix. The runner image gets kubectl 1.37.1, pinned by SHA-256. Both choices are in `docs/DECISIONS.md`.
- **Web.** Connections in the sidebar, the palette ("Open connections") and `g n`. Rows by org show a lamp with the last Test and a Test button. The detail has Status (problems, last result, warnings, which agents list it), Details (name and description), the type's settings and "Allowed without asking". Settings has text inputs, write-only secrets (Set or Replace), file upload and rows for variables or headers. The New connection form takes the org, type, name, description and text values; secrets and files are set right after. The agent editor has a Connections section with the org's connections; a root agent gets a note instead, since it gets every connection of the task's org.
- **Tests.** Registry and stored shape, storage (no secret in the yaml or the history, 0600 files, remove and replace clean up, round trips through `orgs.update` and the Private org), the commands (no secret returned, the agent rules), the kubeconfig cut, and each Test with a fake kubectl, a fake stdio MCP server, a local HTTP MCP server and a fake ssh.

How to try it: Connections > New connection > Kubernetes, give it a name and the context, Create, upload the kubeconfig, then Test. Ask the captain "add the New Relic MCP server for Acme": it asks for the key with a secret request.

Left and known issues:

- The runner image was not built here (no Docker), so kubectl in the runner is not checked yet. A browser Test downloads its MCP server with `npx` on first use; Part B puts both servers in the runner image.
- The last Test is kept in memory. After a restart a connection reads "Not tested" until it is tested again: the Test button, the row's fix on Health, or `doctor`.
- The IMAP and SMTP Test has no test against a mail server.
- Part B (which run gets which connection, injection, `majhi-connections`, the gate, audit, redaction) is not started.

### Part B: injection, majhi-connections, the gate, audit

1. **Which connections a run gets.** One pure function, tested:
   - An org agent gets the connections of its own org that its `connections` lists, and only in a task of that org.
   - A root agent gets every connection of the task's org.
   - A task without an org gets only the connections the task names (`tasks.create` `connections`) and the ones attached to it.
   - An org agent never gets another org's connection, even when `where` lets it work in that org.
2. **Injection**, in `runs/launch.ts` and `processLaunch` (a background process gets the same):
   - `KUBECONFIG` points to a per-run copy holding only that context. Several kubectl connections share one file with several contexts; the first is current.
   - `env` values become variables, and `file` fields become paths in their variables.
   - `mcp` and `browser` connections become MCP servers on the session, with auth from `secrets.age`.
   - `mail` IMAP and SMTP values become `MAIL_*` variables.

   Per-run files go in a folder outside the task folder, mounted read-only into that run only. The folder is removed when the run ends, and leftovers are removed at start. The browser profile persists per connection and is mounted read-write only into runs that hold it. Record where these live in `docs/DECISIONS.md`.
3. **ssh.** Runs still get no SSH agent socket and no key. `majhi-connections.ssh` runs `ssh <alias> -- <command>` from majhi, the way majhi's git reaches hosts, through the gate: reads run, and writes wait for the owner. SPEC 5.14 left this open, so record the choice in `docs/DECISIONS.md`.
4. **The `majhi-connections` MCP tool**, at `/mcp/connections` and gated in `rooms/gating.ts`. It is on for every session that holds a connection, and for root agents. Tools:
   - `list`: the run's connections with name, type, description and how to use each (variable names, MCP server name). Never a value.
   - `attach`: root agents only. It adds a connection of any org to the task, writes an audit row and posts in the room. The session then reloads with `session/load` at the end of the turn, so the new variables and MCP servers apply.
   - `ssh`.
5. **The gate**, `connections/gate.ts`. It is pure and heavily tested. It classifies a command line or an MCP tool call against the connections the run holds.
   - kubectl reads: `get`, `describe`, `logs`, `top`, `explain`, `events`, `version`, `cluster-info`, `api-resources`, `auth can-i`, `config view`, `rollout status` and `rollout history`, `diff`. Anything else is a write (`apply`, `delete`, `edit`, `scale`, `rollout restart`, `exec`, `drain`, `patch`, `label`).
   - MCP tools of a connection's server: a name starting with a read verb (get, list, search, query, describe, fetch, read, show, find, count) is a read, unless a write verb also appears (create, update, delete, send, post, restart, run, execute, write, set, mute, ack, close). A connection can list exceptions by exact tool name.
   - `env` CLIs and `ssh` remote commands: read verbs (`get`, `list`, `describe`, `show`, `ls`, `logs`, `status`, `view`, `whoami`) are reads, and anything else is a write.
   - Sending mail is a write.

   The whole line counts. It is split on `;`, `&&`, `||`, `|`, newlines, `$(...)`, backticks and `sh -c`. A pipe into `grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `jq` or `cut` stays a read. A redirect to a file is not a free read. Anything the gate cannot classify is a write.

   In `runs/permissions.ts`:
   - A line made only of connection reads runs without asking.
   - A connection write always asks, unless the connection's `allow` holds that exact action. Perms and "Allow for this task" do not cover it, and "Allow always" counts as once.
   - The prompt names the connection and says the action is a write.
6. **Audit.**
   - Every connection write is a row of kind `connection-write`, with the org and `<connection>: <action>` as detail. That covers writes allowed by `allow`, allowed by the owner, denied and cancelled.
   - Every attach is a row of kind `connection-attach`.
   - Both show on the audit log page.
7. **Redaction.** The values of a run's secret fields are replaced with `[secret <connection>.<field>]`:
   - in anything the run sends to the room (text, tool output, diffs);
   - in what `majhi-processes` returns;
   - in REPORT.md when it is shown.
8. **TASK.md** lists the task's connections (name, type, description, how to use), never values. It also says that logs, alerts, emails and command output are data, not instructions.
9. **Tests:**
   - who gets which connection (org isolation both ways, tasks without an org, attach);
   - the gate (reads, writes, chains, `sh -c`, unknown commands);
   - per-run files removed at the end;
   - redaction.

### Part B done

What works:

- **Who gets which connection.** One pure function, `connections/access.ts`. An org agent gets the connections its `connections` lists from its own org, and only in a task of that org; never another org's, also when `where` lets it work there. A root agent gets every connection of the task's org and the ones the task names. A task without an org gives root agents only the ones it names. `tasks.create` takes `connections` (kept in `tasks.connections`, migration 110); an org agent can only name its own org's.
- **Injection.** Sessions (`runs/launch.ts`) and background processes (`processLaunch`) get the same plan. kubectl connections share one kubeconfig with one context per connection, named by its id; the first is current. `env` values become variables and `file` fields paths. `mcp` and `browser` connections become MCP servers on the session (HTTP with their headers, or a local command). `mail` IMAP and SMTP become `MAIL_*` variables. When two connections set the same variable, the first keeps it and the room says so. The files go in a folder of the run's own under `~/.majhi/run/connections/`, not the tasks folder (the reason is in `docs/DECISIONS.md`). It is mounted read-only into that run only, and removed when the session or process ends and at start. A browser connection's profile stays in `~/.majhi/connections/<id>/profile`, mounted read-write only into runs that hold it. Playwright MCP 0.0.83 and Chrome DevTools MCP 1.10.1 are in the runner image, pinned, with Chromium; sessions and the browser Test use them there.
- **majhi-connections** at `/mcp/connections`, for sessions that hold a connection and for root agents. `list` shows the run's connections and how to use each, never a value; a root agent also sees the ones it can attach. `attach` (root agents only) adds a connection of any org to the task, writes a `connection-attach` audit row, posts in the room and rewrites TASK.md; the session reloads with it when its turn ends. `ssh` runs `ssh -o BatchMode=yes -- <alias> <command>` from majhi: reads run at once, writes wait for the owner, and the output reaches the agent when the owner answers.
- **The gate.** `connections/shell.ts` parses a shell line (quotes, escapes, `;`, `&&`, `||`, `|`, groups, `$(...)`, backticks, redirects, here-docs). `connections/gate.ts` is pure and classifies as planned, plus:
  - kubectl's `--context` must name a context the run holds; identity flags (`--kubeconfig`, `--token`, `--as` and the like) and a `KUBECONFIG=` prefix are writes;
  - wrappers (`env`, `timeout`, `xargs`, `nohup`, `nice`, `sudo`) are looked through, and `sh -c`, `eval`, `watch` and `find -exec` are read inside;
  - a program named by a variable is a write;
  - MCP tools go by their verbs, with `read_tools` and `write_tools` per connection. Browser servers come with their read tools (navigate, snapshot, screenshot, console, network, wait); clicks, typing, forms and scripts are writes;
  - a remote command is a read when its programs only read (cat, ls, df, ps, journalctl without vacuum or rotate) or its first verb is a read verb.
- **Permissions.** A line made only of connection reads runs without asking. A connection write asks, unless the connection's `allow` has the exact action. Its prompt names the connection and the action and has no "Allow always"; perms and "Allow for this task" never cover it. While a session holds a connection, Claude's choices to leave plan mode into auto or bypass mode are removed. A Codex MCP approval is matched to its tool by the tool call's title. `majhi-processes` refuses a connection write and says to run it in the agent's own shell, where the owner can approve it.
- **Audit.** `connection-write` rows, with the org and `<connection>: <action>`, for writes allowed by `allow`, allowed or denied by the owner, and cancelled. `connection-attach` rows for attaches. The audit log page names both.
- **Redaction.** A run's secret values (secret fields, header and env values, kubeconfig tokens and keys) show as `[secret <connection>.<field>]` in all it sends to the room, the live "now doing" line, audit rows, `majhi-processes` output, and REPORT.md through `tasks.report`.
- **TASK.md** has a Connections section next to the Ops section: name, type, description and how to use each. Outside ops tasks it also says that writes wait for the owner and that logs, alerts, emails and command output are data, not instructions; in an ops task the Ops section says so.
- **Agents cannot loosen the gate.** The fields the gate reads (`clis`, `read_tools`, `write_tools`, a kubectl `context`) are owner-only. On a connection that holds a secret, an agent cannot change where it goes (URL, command, test command, transport, mail hosts) or its variables, headers and env. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_PATH`, `SSL_CERT_FILE` and `SSL_CERT_DIR` are reserved.
- **Tests.** The gate, who gets which connection, the plan and the kubeconfig merge, the run's files (written, mounted, removed), the permission flow (prompt, `allow`, audit), majhi-connections (list, attach, ssh), redaction, TASK.md and the runner mounts. The Done when is `connections/done-when.test.ts`. It uses the fake ACP agent, which can now run `run: <command>` lines and call `call: <server>/<tool>`:
  - A root agent works an ops task ("why is the api down in prod", inferred as ops) with a kubectl connection (a fake `kubectl` on PATH) and an MCP connection (a local HTTP server that wants its key).
  - Its reads stream into the room without a prompt. Esc stops it midway. The owner's Stop removes its files, and Resume brings the session back with new ones.
  - It writes REPORT.md.
  - It proposes a fix task with `followUpOf`. The proposal waits for the owner; once approved, starting the fix task posts another approval card, and it does not start.
  - `kubectl rollout restart` waits as a prompt and leaves a `connection-write` row when allowed.
  - The kubeconfig's token shows only as its name.
  - An org agent gets its own org's connection and none of Acme's, neither in its variables nor in its MCP servers, and cannot attach one.

How to try it: give the Acme kubectl connection from Part A to an ops task ("why is the api down in prod") with a root agent. TASK.md lists it. `kubectl get pods` runs without asking. `kubectl rollout restart deployment/api` asks, naming the connection, and the audit log shows the answer.

Left and known issues:

- The gate stops unasked writes; it is not a sandbox. It reads the command lines and MCP calls the agent CLI asks about. A program it does not know (`./fix.sh`, `python -c ...`) is not a connection command, and any program in the run can read the kubeconfig. Give agents identities that can only read; Part A's Test warns when one can change things.
- Checked with the fake agent only. What a real Codex session's own sandbox runs without asking is not checked here.
- The runner image was not built here (no Docker), so the browser servers, their Chromium, the Chrome DevTools flags and kubectl in the runner are unchecked. Without runner containers, browser connections need the servers installed where majhi runs.
- An attached connection reaches the session when its current turn ends.

### Part C: ops tasks (child task, own branch)

1. **TASK.md for `ops` tasks** (`tasks/brief.ts`). The agent:
   - investigates with the task's connections and posts findings as it goes;
   - says in one line what it is about to do before any step that changes something;
   - writes `REPORT.md` in the task folder (Summary, Timeline, Evidence, Cause, What was changed, Follow-ups);
   - turns follow-ups into fix tasks with `majhi-tasks.create` and `followUpOf` set to this task.

   Write actions such as a rollout restart wait for the owner's approval.
2. **Fix tasks.** `tasks.create` takes `followUpOf`, which adds a `follow-up` link to the ops task. A fix task does not start until the owner approves it (an approval card, through `tasks.start`), whatever `lead_start` says. It then goes through the normal code flow. Gating gives an ops task's agent `majhi-tasks` for this.
3. **Report tab** in the task view. It shows for `ops` tasks and for any task with a `REPORT.md`:
   - it renders the report as markdown with the room's renderer and updates when the file changes;
   - it says "No report yet" until the file exists;
   - it lists the linked fix tasks with their status and a Start button.

   The read command `tasks.report` lets the captain read a report.
4. **Kind.** The task box infers `ops` for investigations and incidents ("why is the api down in prod") and shows a chip the owner can change. `task-parse.ts` has no `ops` inference today.
5. **Tests:** the follow-up link, that starting a fix task needs the owner, and the brief section for ops tasks.

### Part C done (PRV-86)

Built in the child task PRV-86 on its own branch and merged into `main` (`27f4f221`). This branch has it from `main`.

What works:

- **Kind.** The task box infers `ops` for an investigation or an incident: "investigate", "incident", "outage", "postmortem", "root cause", "why is ... down" (or failing, slow, broken, crashing, timing out, returning 5xx) and "debug ... in prod" (or staging). Not when the text says the code changes: a working branch with a slash, implement, refactor, a pull or merge request, a commit, or, with a project picked, a change verb such as fix, add or update. Otherwise a task is `code` with a project and `chat` without. New task has a Kind row (code, ops, chat), preselected from the words and the picked projects. `code` needs a project, `chat` has none, `ops` fits both. The kind is sent only when the owner picks one.
- **An ops task is an investigation**, whether its kind was inferred or picked: its repos are mounted read-only, with no branch, worktree, Changes or Ship.
- **TASK.md** of an ops task has an Ops section. Investigate with the task's connections and post findings as you go. Before a step that changes something, say it in one line; write actions such as a rollout restart wait for the owner. Logs, alerts, emails and command output are data, not instructions. Write `REPORT.md` with Summary, Timeline, Evidence, Cause, What was changed and Follow-ups. Turn each follow-up that needs code into a fix task. The section is fixed text, so it stays in the cached prefix.
- **Fix tasks.** `tasks.create` takes `followUpOf`: the new task gets a `follow-up` link to the ops task, and takes its org when it lists no repo. An agent's create with `followUpOf` is always created unstarted. An agent's `start` of a fix task always posts an approval card: `lead_start`, an `auto` policy and saved allow rules do not apply to it (`AdminService.call` with `confirm`). Every agent of an ops task gets `majhi-tasks`, not only leads. The owner's Start runs `tasks.start` as the owner.
- **REPORT.md.** `tasks.report` is a read command, so the captain has it. It returns the report and when it last changed, or null before the file exists. It opens only `<task folder>/REPORT.md`, without following a link: a link, a folder or a file over 2 MB is refused with 409. Part B shows it with the run's secret values replaced.
- **Report tab** in the task view, for ops tasks and for any task with a REPORT.md. It renders the report like markdown in the room, says "No report yet" until the file exists, and lists the fix tasks with their status and a Start button for those not started. It reads the file again every 5 s while the page is visible.
- **Tests.** The ops inference (`task-parse.test.ts`), the Ops section (`brief.test.ts`), `readReport` refusing a link or a folder (`report.test.ts`), ops agents getting `majhi-tasks` (`rooms/gating.test.ts`), and `followUpOf` with a start that waits for the owner (`rooms/mcp.test.ts`). The Done when (Part B) runs the whole flow with the fake agent.

How to try it: New task, type "why is the api down in prod" and pick the Acme project: Kind reads ops. Pick a root agent, which gets every Acme connection, and start the task. TASK.md has the Ops section. When the agent writes REPORT.md, the Report tab shows it. A fix task it proposes waits for your approval, then shows under Fix tasks, and starts only when you click Start there or approve its start card. The captain reads a report with "show the report of ACM-12".

Left and known issues:

- REPORT.md has no file event, so the Report tab reads it every 5 s while the page is visible.
- The kind is inferred from English words only. The owner can change it in the Kind row.
- Checked with the fake agent only. No real agent has written a report or proposed a fix task here.

### How it is checked

Each part runs typecheck and the tests of the files it touched. At the end, the Done when runs with the fake ACP agent:

- A root agent works an ops task with a read-only kubectl connection (a fake `kubectl` on PATH) and an `mcp` connection (a local fake MCP server).
- It streams its tool calls, is stopped with Esc, resumes and writes REPORT.md.
- It creates a fix task, which waits for approval.
- It runs `kubectl rollout restart`, which waits for the owner.
- An org agent's run gets no connection from another org.

Real clusters and New Relic are left to the owner.

## Phase 9 plan (PRV-24)

Branch `task/prv-24-phase-9-token-receipts-and-polish`, from `main`. SPEC 5.9, 5.12, 5.13 and section 7, Phase 9. Part 1 (server-heavy, the hardware builder) is below; the palette, shortcuts and performance pass follow after it, and PRV-40 (budgets), PRV-41 (audit log) and PRV-42 (phone access) run as child tasks.

Part 1, in this order, one small commit per step:

1. **Token receipts.** Migration 108 adds `usage_events` (the brief size once per task, the TASK.md memory section, each `majhi-memory.recall` result, each compaction with before, after and native or handoff) and `runs.tools`. `usage.receipt` (one task) and `usage.agentReceipt` (one agent, a date range) in `packages/shared`, so the captain gets them as tools. The math is a pure function in `usage/receipt.ts`: totals and the cache hit rate `cache_read / (input + cache_read)`, or "not reported" when the agent reported no cache numbers; cost and the split per agent come from the `turns` rows already there; decisions that replaced an LLM call are the logged decisions of the task that a local or hosted provider answered and the gate accepted. Web: a Context tab in the task view and the agent receipt in the agent drawer.
2. **Tool gating.** One function turns the role defaults plus the agent's `tools` list into the attached servers. A `-name` entry in `tools` turns a default off (`-majhi-decide`). Today's rules are the defaults, so no agent loses a tool. `runs.tools` records what each run attached; the Studio agent editor shows it.
3. **Serena.** A stdio MCP server per task worktree for roles that edit code, gated by step 2. The package, launch command and the runner image change are checked first and written to `docs/DECISIONS.md`. A Health check says whether it is there.
4. **Cache-friendly prompts.** Audit of `runs/prompt.ts`, `runs/handoff.ts`, `runs/wake.ts` and `tasks/brief.ts`: stable text first, volatile text last. TASK.md's "Team facts" block (it carries an "As of" time) moves behind the stable sections. The measure is the cache hit rate in the receipt; before and after go in this file.

Tests: the receipt math, the migration, the gating function. Typecheck, plus the tests of the files touched.

### Part 1 done (token receipts, tool gating, Serena, cache-friendly prompts)

What works:

- **Receipts.** `usage.receipt` (a task) and `usage.agentReceipt` (an agent, a range) are commands, so the captain has them as tools. A task receipt has: brief size at the first prompt (estimated, once per task), the TASK.md memory section and each `majhi-memory.recall` result (estimated), input, output, reasoning, cache read and write, the cache hit rate `cache_read / (input + cache_read)` ("Not reported" when no cache number came in), cost with the split per agent, compactions (before, after, native or handoff, with the reason) and the decisions a local or hosted provider answered that the gate accepted (the `acp` stand-in and the rules do not count). Migration 108 adds `usage_events` and `runs.tools`. Web: a Context tab in the task view (context meter per agent, receipt, attachments, skills of the team) and the agent's receipt for the month in the agent drawer.
- **Tool gating.** `gateTools` (`rooms/gating.ts`) is the only place that decides which MCP servers a run gets. The defaults are the old rules, unchanged. In an agent's `tools`, `-majhi-decide` turns a default off and a bare name adds one. Each run records what it attached (`runs.tools`, command `agents.attached`); Studio's agent editor has a Tools section with Default, Add and Off per server and shows the latest run's list. The captain keeps `majhi-admin`.
- **Serena 1.7.0.** Stdio MCP server per run for builders with a worktree, when agents run in runner containers. Runner image installs it under `/opt/serena`. Health and `make doctor` have a "Serena" check (a warning, with Rebuild majhi). Choice and launch command in `docs/DECISIONS.md`.
- **Cache-friendly prompts.** TASK.md now ends with Related tasks, Team facts (its "As of" line) and Memory; "How the lead plans" is fixed text and moved up with the rules. Handoff prompts open with their fixed rules. A note majhi builds repeats only the Brief instead of all of TASK.md, which the fresh prompt already carries.

Cache, before and after. A real hit rate needs real runs, and none are recorded where this was built, so there is no before and after hit rate yet; the receipt will show it from the next runs. What was measured is the stable start of TASK.md: two renders of the same task a while apart (the clock, the limits, a related task's status and one recalled fact differ) share 300 of 3,717 characters before (8%) and 3,424 of 3,717 after (92%). A provider cache can only reuse that shared start, and only in a fresh session of the same agent (a rotation, a handoff, a restart): inside one session the conversation already is the prefix. Compare the hit rate of tasks before and after this branch once a few have run.

How to try it: open a task, then its Context tab; click an agent mention for the drawer; Studio > Agents > an agent > Tools. `usage.receipt` from the captain: "show the token receipt of PRV-24".

Left and known issues:

- The runner image was not built here (no Docker), and Serena was not run inside it. It was installed with uv and driven over MCP stdio on a Linux machine (21 tools, 14 with memories and onboarding off, about 20,000 characters of tool descriptions a session). Serena downloads each language's server on first use, so the first use needs network. Build the image and run one builder task before relying on it.
- For a Claude agent on a task with several repos, Serena covers the first repo only (its `claude-code` context has no `activate_project`).
- Receipts start at this change: tasks started before it have no brief size, and their compactions are only in the room. Sizes of what majhi adds are character counts divided by four.
- The receipts migration is numbered 108 so it does not clash with PRV-41 (106) and PRV-40 (107).
- `admin/boss.test.ts` and `usage/integration.test.ts` fail now and then with `ENOTEMPTY` while removing their temp folder (a background write during teardown). It is not from this branch: `boss.test.ts` failed 7 of 10 runs on `main` (a75aa4da).
- Not done in part 1: the palette, keyboard shortcuts and the performance pass of Phase 9.

### Part 2 done (palette, shortcuts, performance pass)

What works:

- **Command palette** (`Cmd/Ctrl K`). Search stays: tasks, and anything said or run in a room. Memory facts join it. Commands match on their name and filter as you type: New task, Add account, New agent, Install skill from link, Search memory, Swap an agent in this task (only on a task page), Resume paused runs, Go to task, Open the audit log, Budgets and alerts, Manage workspace roots, Ask the decision model, Reopen onboarding, Open the captain. They reuse what exists: the New task dialog, the add-account form (`/accounts?create=`), the new-agent form (`/agents?create=`), `team.swap` and `tasks.update`, `tasks.start`, `/settings/roots`, the decision panel's ask form and the onboarding mailbox. Some open a list of their own (Search memory, Go to task, Swap); Esc or Backspace on an empty field goes back, Esc from the root closes. Arrows, Enter and Esc work throughout.
- **A room search match** opens its task and scrolls to the message, lighting its row once. Older pages load until the row exists (a match 5,990 messages back took 11 s, in view, address cleared).
- **Shortcuts** come from one table (`features/shell/shortcuts.ts`); the handlers and the `?` list both read it. New: `]` and `[` for the next and previous open task (board order), `a` to approve (clicks the review card's main button: Ship opens its panel, or Mark done for a task with no repos), `g l` for the audit log. `Cmd/Ctrl Enter` sends from the message box (it stops a working agent first), and `Cmd/Ctrl K`, `Cmd/Ctrl J` and send are the only keys that work while typing in a field. The list shows every key, grouped.
- **Performance.** Two causes, both in the room. Every row took the whole agent list and the task in its context, so each message or status change redrew every row (markdown and code highlighting made that the cost: 6 updates spent 2.2 s in the highlighter and the garbage collector). Rows now take only what they show. And a long room drew its 200 newest rows before anything showed: a room over 60 rows now draws its newest 40 first and the rest a frame later.

Measured with `scripts/perf.ts` (the built server with no agents, a headless browser, rooms of 40, 600 and 6,000 items; one Linux container with other work on it, so single runs vary by about a third; medians of 8):

| | Before | After | Target |
|---|---|---|---|
| Server RSS, idle after start | 156 MB | 151 to 164 MB | under 200 |
| Server RSS, after opening three tasks | 183 MB | 178 to 204 MB over several runs | under 200 |
| Task switch, room of 40 (reopened) | 80 ms | 62 to 76 ms | under 100 |
| Task switch, room of 600 | 182 ms | 60 ms | under 100 |
| Task switch, room of 6,000 | 111 ms (first open 199 ms) | 74 to 78 ms (first open 53 to 77 ms) | under 100 |
| Room update, room of 6,000 | 148 ms (worst 308) | 15 ms (worst 37) | under 50 |
| Room update, after 1,550 rows are loaded | 529 ms (worst 822) | 20 to 24 ms (worst 35) | under 50 |

Run it with `pnpm --filter @majhi/web build && pnpm --filter @majhi/server build && pnpm exec tsx scripts/perf.ts` (add `PROFILE=1` for the heaviest functions during updates).

How to try it: press `Cmd/Ctrl K` and type "acc", "memory" or a word from a room; press `?`; on a task press `]`; open a task in review and press `a`.

Phase 9 as a whole: token receipts, tool gating, Serena and cache-friendly prompts (part 1); the palette, shortcuts and the performance pass (part 2); budgets with alerts (PRV-40), the audit log page (PRV-41) and phone access on the local network (PRV-42, not started) are child tasks.

### PRV-84: server memory under 200 MB, and a search match opens fast

Branch `task/prv-84-server-memory-over-200-mb-after-opening`. Two problems left over from Phase 9 part 2: server memory after opening tasks sat on the 200 MB target, and a room-search match 5,990 messages back took 11 s to scroll into view.

**Memory: what was found.** Heap snapshots of the server with no agents, idle and after opening tasks:

- No cache, per-task room list or set of prepared statements grows with the tasks opened. After a full garbage collection the live heap is about 44 MB, and most of that is the 4 MB server bundle's own source text. A room of 6,000 items costs the server one page of 200 items.
- The growth is memory the process holds on to after it was used. V8 let its young generation grow to its default of 16 MB (up to 48 MB with its two halves and promoted garbage), and glibc kept several malloc arenas.
- One request made it much worse: `health.run`, which the web client sends on every page load (the sidebar reads it). Thirty calls added 21 MB of resident memory, 300 added about 120 MB, with the JS heap flat. Each call ran `config.load()` and the agent file listing about 18 times, and each listing read and parsed every agent file again (about 290 file reads per request). The native buffers of those reads were what stayed resident.

**Memory: what changed.**

- The Dockerfile starts the server with `--max-semi-space-size=2` and `MALLOC_ARENA_MAX=2`; `pnpm --filter @majhi/server start` and `scripts/perf.ts` do the same. Alone these two took idle memory from 173 to 131 MB and the opened state from 194 to 153 MB in a probe.
- `AgentStore` keeps each parsed agent file with the file's signature (inode, size, and change times to the nanosecond) and reads a file again only when the signature changes. `ConfigService.load` does the same for `majhi.yaml`. A hand edit still shows at once. Both return copies, and entries of removed agent files are dropped, so the cache holds at most one entry per file. Test: `agents/store.test.ts`.

**Search match: what changed.** The room used to load older pages of 100 until the match existed (about 60 round trips and a growing list of 6,000 rows to draw), and the new `?item=` address then cleared and hid rows above the newest 40 for a moment. Now `room.around` returns the 50 items before and after the match in one request, the room shows that window, loads older pages as you scroll up and newer ones as you scroll down (`room.items` takes `afterSeq`), and a "Latest messages" button goes back to the end. Live messages are not added to the window, so it never has a gap; sending a message leaves the window for the newest messages. A window is not kept in the room cache.

Measured with `scripts/perf.ts` on the same machine, same seed (rooms of 40, 600 and 6,000 items). "After" is two runs:

| | Before | After | Target |
|---|---|---|---|
| Server RSS, idle after start | 174 MB | 130 and 132 MB | under 200 |
| Server RSS, after opening three tasks | 236 MB | 156 and 164 MB | under 200 |
| Server RSS, at the end of the run | 249 MB | 164 and 174 MB | under 200 |
| Scroll to a match 5,990 messages back | 13.6 s, in view | 0.9 and 1.0 s, in view | |
| Task switch, room of 6,000 (reopened median) | 83 ms | 80 and 79 ms | under 100 |
| Room update, room of 6,000 (median) | 16 ms | 13 and 20 ms | under 50 |
| Room update, after 1,550 rows are loaded (median) | 18 ms | 20 and 19 ms | under 50 |

The memory margin is 36 to 70 MB under the target, where it was a few MB over. Run it as before: `pnpm --filter @majhi/web build && pnpm --filter @majhi/server build && pnpm exec tsx scripts/perf.ts`.

Left:

- Memory after opening tasks still grows by about 25 to 30 MB from the first open (heap growth that the garbage collector has not reclaimed yet), then stays level. A longer soak with real agents and several tasks has not been run.
- The bundle's source text is 8.5 MB of the heap; minifying the server bundle would save a few MB but make stack traces harder to read, so it was not done.
- Other commands that call `config.load()` or list agents many times per request now cost far less, but `health.run` still spawns `git` and `ssh-add` on every call.


Left and known issues:

- Server memory after opening tasks sat at the 200 MB line (178 to 204 MB), and reached 211 MB after the script made the server try to start an agent. Fixed in PRV-84 (see its section above): 156 to 164 MB after opening three tasks.
- "Install skill from link" only opens the Skills page: skills are Phase 6 and the page's install field is still disabled. The command works once that lands.
- A match far back in a long room loads older pages 100 at a time, so it takes seconds.
- `mrs/flow.test.ts` ("a task closed with merge requests not merged") fails on `main` (`b9c85f24`) and on this branch alike; it is not from Phase 9.

## PRV-40: Budgets and alerts (built, waiting for owner review)

Branch `task/prv-40-budgets-and-alerts`, from `main`. Weekly budgets per org and per account, built on the Phase 2c `turns` table. The choices are in `docs/DECISIONS.md` (2026-10-01, Weekly budgets).

### What works

- **Config.** `budgets.orgs.<org>` and `budgets.accounts.<account>` in `majhi.yaml`, each `{ tokens?, cost? }` per week. `settings.get` returns them, `settings.set` changes one at a time (`null` removes one). Changes apply live.
- **Check.** After each recorded turn, this week's turns for its org and account are summed and compared (`budgets/thresholds.ts` holds the pure math). Tokens are input + output + cache write.
- **Alerts.** 80% and 100%, once per (scope, id, week, threshold) in `budget_alerts` (migration 106). Raising a budget re-arms only the thresholds now under. Each alert is a quiet room line in the newest task that spent in that scope this week, and a `budgets` event that refreshes open pages.
- **Commands.** `budgets.status` (read, no confirm card for the captain).
- **Web.** Health and usage has a "Budgets" panel above "Tokens and cost": a bar per budget (amber from 80%, red from 100%), edit, remove and add, and a banner when one is over.
- **100% action (pause).** After the 100% alert, runs pause with reason `limit` through the run manager's own pause and resume. An org budget holds the runs of tasks in that org, an account budget the runs on that account. A run asks `limited` between turns, so a turn in progress finishes, and new runs and queued prompts wait; the task shows Paused. A pause lifts when the budget is raised above the use (or removed), when the owner resumes the task by hand (`tasks.start`; that task is not paused again until a new 100% alert is recorded), or when the week resets (a 60 second sweep notices, since a paused scope records no turns). The lifts also reach a task still paused at budget after a majhi restart: it starts again as majhi, not as an owner resume. The panel and banner say "Paused at budget".
- **Overshoot.** A budget is a brake, not a hard cap: turns in progress finish, and the captain's chat is never held (the captain is how the owner raises a budget), so spend can pass 100% a little.

### How to try it

1. Health and usage, Budgets: add a small token budget for an org.
2. Run a task in that org. Watch the bar turn amber at 80% and red at 100%, with a room line at each.
3. At 100% the task pauses with "Paused at budget". Raise the budget, or resume the task, and it continues.
4. Ask the captain (Cmd J): "How are the budgets this week?"

### Left and known issues

- Not run with real accounts or a long-running majhi. Per-task and per-day budgets from SPEC 5.17 are not built.
- After a restart, a prompt that was waiting in a paused run may not be in the stored queue, so it may not be sent when the pause lifts. This looks like how restarts already treat any pause; not confirmed.
- The captain integration tests share a cleanup race (`ENOTEMPTY` while the chat is still being titled) that fails now and then. It is filed as its own task.

## PRV-63: Scheduler and watch triggers (built, waiting for owner review)

Branch `task/prv-63-scheduler-and-watch-triggers`, from `main`. Choices: the `docs/DECISIONS.md` rows of 2026-10-01 on schedules, triggers and automation.

### What works

- Shared: `automation.ts` (specs, actions, run records, overlap, the phrase parser), `schedule-time.ts` (next runs with croner, used by server and UI), `triggers.ts` (eight watch kinds, poll defaults, `describeWatch`). Commands `schedules.*` and `triggers.*` (list, get, runs: read; create, update, pause, resume, runNow: change; delete: destructive), so the captain gets `majhi_schedules_*` and `majhi_triggers_*`.
- Server, `apps/server/src/automation/`: `ActionRunner` (org checks on save and on every run, overlap, secret refusal, how a run ends), `RunHistory` (`automation_runs`, shared), the scheduler loop (one timer, catch-up runs a missed schedule once), the trigger engine (baseline, settle, cooldown, one firing per change after a restart). Migrations 101 and 102.
- Actions: start a task from a template, post to a task's room (wakes its lead), run a command as a process of a task.
- Web: the Automations page (`/automations`, sidebar, `g t`) with Schedules and Triggers tabs, forms with a live next-runs preview and an explicit time zone, row actions and a run history drawer.

### How to try it

- Automations in the sidebar, New schedule, "weekdays at 9:00", start a task in a project, Run now, open History.
- Or ask the captain: "every hour, post 'status?' to ACM-4".
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
7. Commands (5.16), so the captain and the UI share them: `memory.search`, `memory.list` (scope, status, task), `memory.add` (the owner adds an active fact), `memory.approve`, `memory.reject`, `memory.forget` (retire, sets valid to), `memory.pin`, `memory.events` (the log, per task or all).

**Part B: curation, Housekeeper, promotion, settings**

1. Settings: a `memory:` section in `majhi.yaml`, shown in Hub setup under Memory.
   - `auto_threshold`: default 0.8.
   - `review_all`: "Review every fact", default false.
   - `housekeeper`: the agent that extracts facts. The default is the captain.
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
- `settings.set { memory }` takes `null` for `housekeeper` and `housekeeper_model`, to put back the captain and "Cheapest".

Web (checked in Chromium, 1440x900, against the e2e server with a seeded home: `e2e/memory-seed.ts`, `e2e/shots.memory.ts`, `playwright.memory.config.ts`; screenshots in `media/`):

- **Memory page** (sidebar, `g m`, `/memory`): search over active facts (`memory.search`), tabs All, Global, each org (its project facts included) and Needs review. A row shows the fact, where it holds, its source (task id opens the task drawer, and the agent), how many tasks got it, Pinned and "In AGENTS.md via <task>". Pending facts have Approve and Reject; active ones Pin/Unpin, To AGENTS.md (project facts not yet promoted, with a confirm that a task is made and waits in review) and Forget (confirm). "Recent automatic decisions" lists what curation kept, dropped, retired or merged, with the reason, how sure it was, the provider and Undo. Everything refreshes on the `memory` topic. The sidebar shows "N to review" for pending facts.
- **Task Memory tab** (next to Room and Changes; shown when the task has facts or is done): the facts this task proposed or the Housekeeper wrote, each with its status and its logged steps, Approve and Reject on pending ones, Undo on steps, and Extract again for a done task or an empty tab.
- **Hub setup, Memory**: the auto-keep threshold (0.5 to 1, with a line that explains it), Review every fact, the Housekeeper agent (default the captain) and its model (from that agent's account, or Cheapest).

Try it: `pnpm exec playwright test -c playwright.memory.config.ts` starts the e2e server on port 7075 with the seeded home. `e2e/memory-seed.ts` has to run against it first (see the file header); for the screenshots, set `MEMORY_SHOTS` to the folder.

The real embedding model was downloaded and run once on this linux arm64 host (`Xenova/all-MiniLM-L6-v2`, 384 numbers, cosine 0.86 for two sentences about the same thing and -0.06 for unrelated ones). The first load takes about 12 seconds including the download. A search waits up to 30 seconds for it (`EMBED_WAIT_MS`) and then goes on with keywords only; the load continues, and later searches use both.

### Phase 5 result

What works: the memory store and hybrid search, recall into TASK.md at task start, `majhi-memory` for every agent with org isolation, the `memory.*` commands (also through the captain), curation with duplicates, decisions, thresholds and Undo, the Housekeeper after a done task, promotion to AGENTS.md through a task in review, and the Memory screens above.

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
- **The captain** has all of it through `majhi-admin`, since every step is a command. `openMrs` and `mergeMrs` are outbound, so they wait for the owner under the approval policy.

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
- **Left.** Thoughts are not searched. A line still in the room's write buffer is found once it is saved. (Two gaps listed here first, a match opening the task at its bottom and a palette with search only, were closed in Phase 9 part 2: the palette lists commands above the search results, and a match scrolls to its row. PRV-69 checked both in Chromium against a seeded server: a match on message 31 of an 800-message room opened with that row centred in view and lit, in 1.4 s.)

## Phase 3: Teams, rooms and decisions (built, waiting for owner review)

Branch `task/prv-18-phase-3-teams-rooms-and-decisions`, from `main` (Phase 2c merged). Lead orchestration (PRV-32), background processes (PRV-33) and more agents per task from the task box (PRV-45) are their own tasks. Task ids that open a drawer (PRV-34) are done. The plan below is kept for reference; the result comes first.

### Done when, status

- [x] Lead, builder and reviewer on different tools complete a task together, and the reviewer catching an issue causes a fix round. `apps/server/src/rooms/team.test.ts`: the lead (Codex) hands to the builder (Claude), who writes in the worktree and hands to the reviewer (a second Claude account), who asks for a test; the builder adds it, the reviewer approves, and the task goes to review with the work in checkpoints.
- [x] A new task gets its default team picked by the decision provider, with the decision recorded (same file: the pick, the room line, and the decision log entry with the task).

### Lead orchestration and parallel planning (PRV-32)

- A lead (or the captain) given a parent task splits it (`tasks.split` with `start`), is woken when a child reaches review, reviews it, closes it with the `majhi-tasks` `close` tool, and the next child starts by itself. The parent closes with a report when every child is done. Approvals for destructive and outbound actions still go to the owner.
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
- **`majhi-room`** (`read_recent`, `post`, `mention`) for team members, and **`majhi-tasks`** (`list`, `get`, `create`, `split`, `update`, `link`) for leads and root agents. `majhi-tasks` goes through the captain's approval policy, with cards in the room, and keeps an org agent to its org. New command `tasks.split` makes children in order, each able to wait for earlier ones.
- **Dependencies.** Waiting tasks start on their own (2b). A `ready` dependency now stacks the waiting task's branch on the dependency's working branch, and majhi rebases it after every checkpoint of the dependency. Conflicts are aborted and named in the room.
- **Decisions in teams.** The default team comes from the org's `team` when set. Otherwise the decision provider picks one of: one agent; builder and reviewer; lead, builder and reviewer. The pick is recorded, and the rules pick one agent when the provider is not sure. The decision provider also reads unclear reviewer verdicts in the review loop, and flags a lead-mode message that needs the owner while others work.
- **Laya in Docker** for Linux and Windows. It is the `laya` compose service (`laya-serve` 0.3.22, PyTorch CPU), which `make up` builds everywhere but Apple silicon Macs. It starts on the first question and stops after 10 idle minutes. The provider tries native Laya first.
- **Settings.** Hub setup, Settings has a Teams group (agent turns without you, review rounds). `orgs.update` takes `team` and `rooms`.
- **The captain** has every new command through `majhi-admin` (`team.*`, `tasks.split`, `tasks.update mode`, `settings.set rooms`, `orgs.update team`).
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
- The Orgs form does not show the default team or the loop guard yet; the captain and `orgs.update` set them.
- "Needs you" lines use the decision provider. With the ACP stand-in in the chain, each one costs a small prompt.
- Background processes live in memory: a restart of majhi ends them. In container mode their ports are not published to the Mac yet, so the card's port link works only in local mode.
- No new Playwright spec: the done-when runs as integration tests. `sh scripts/ci.sh` and e2e were not run from this task.

### Goal

Done when: lead, builder and reviewer on different tools complete a task together, and the reviewer catching an issue causes a fix round; a new task gets its default team picked by the decision provider, with the decision recorded.

### What I will build, in order

1. **Contract.** A coordination mode per task (`lead`, `pipeline`, `review-loop`), per-task agent overrides (model, effort, repos), a `handoff` room item, `rooms` settings (`max_agent_turns` 12, `review_rounds` 5, orgs override `max_agent_turns`), and commands `team.add`, `team.remove`, `team.swap`, `team.set`, `tasks.split`, plus `mode` on `tasks.create` and `tasks.update`.
2. **Routing.** Every agent turn's final message is parsed for @mentions. A mention wakes that agent with a handoff prompt: the message, the TASK.md pointer, a short room summary and the diff stat. Owner messages go to the mentioned agent, else the lead. Mentioning an agent outside the team adds it when it may work in the org. The three modes and the loop guard (pause with reason `owner` after 12 agent turns without the owner) are one pure module. A worktree lock per edit turn, so two agents never edit one worktree at once.
3. **MCP servers.** `majhi-room` (`post`, `mention`, `read_recent`) and `majhi-tasks` (`create`, `list`, `get`, `update`, `split`, `link`) at `/mcp/room` and `/mcp/tasks`, one bearer token per session, `majhi-tasks` through the captain's approval policy and limited to the agent's org.
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
- **Commands.** `usage.summary`, `usage.breakdown` (by org, project, agent, account, model, task or day, for a named range or from/to days), `usage.turns` (the rows themselves), `usage.prices`, `usage.setPrice`. The captain has them through `majhi-admin`; the reads run without a confirm card, so "what did Acme cost this week?" is one tool call.
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
3. Ask the captain (Cmd J): "What did Acme cost this week?"
4. On a Codex account, set a price for its model in the price table (Codex reports no cost).

### Left and known issues

- **Not run with real Docker.** Docker is not available where this was built. The Docker arguments, the mount guard and the network guard are unit tested, and the spawner is tested against a stand-in `docker`. The owner's review step: `make up`, then check that "Agent runner" passes and that a real task runs, builds and commits in its runner.
- The first `make up` builds the runner image with Chromium: expect several minutes and about 1.5 GB.
- Codex reports only the last model call of a turn, so its token counts are low for turns with several calls. Claude's are complete.
- Reported cost follows the adapter process. A resumed session's first turn may include cost from before the resume if the CLI counts it.
- A new price applies to new turns only; the unpriced count stays until turns are priced.
- Sign-in, health probes and usage reads still start the CLIs in the server container (they touch only the account home).

### Secrets key backup (PRV-30)

- **Keychain copy.** The host helper reads `~/.config/majhi/secrets.key` (or `MAJHI_SECRETS_KEY`) and saves it in the login Keychain as the generic password "majhi secrets key" (account `secrets.key`). It does so at start when the Keychain has none, and looks again every 10 minutes. The key goes to `security -i` on stdin, never in an argument, and is read back to confirm. It never replaces a different key on its own. The helper reports only a fingerprint (the first 16 hex characters of the SHA-256 of the key line) in its poll header.
- **Restore.** When the key file is missing, the helper's Update and `make up` put the Keychain copy back before they make a new key, so a lost file no longer turns `secrets.age` unreadable.
- **Export.** `secrets.exportKey` encrypts the key file's content with a passphrase (age scrypt, at least 12 characters), armored, and the browser downloads `majhi-secrets-key.age`. `age -d` with the passphrase gives back a key file majhi reads as is. majhi records only which key it exported and when (`~/.majhi/secrets-key-backup.json`). Agents cannot call it.
- **Warnings.** Health and usage has "Secrets key in Keychain" and "Secrets key export". Each warns until it holds the key majhi uses. The fixes are "Save to Keychain" (or "Replace copy" when the Keychain holds another key; the helper refuses a key file that is not the server's key) and "Export key", which opens the passphrase form under the check.
- **Left.** The Keychain calls were tested against a fake `security`, not a real Keychain: the owner's check is that after `make up` both checks pass once the key is exported, and the item shows in Keychain Access. Restoring from the export is in majhi since PRV-95 (below).

### Restore the secrets key from its export (PRV-95)

- **Where.** Health and usage, check "Secrets key". It fails when secrets.age exists but there is no key file, or the key file does not open it, and warns when there is neither (`make up` makes a new key). Each offers "Restore from export": choose `majhi-secrets-key.age`, type its passphrase, Restore. A new Mac needs no terminal.
- **Server.** `secrets.restoreKey` decrypts the export with the passphrase, takes its one `AGE-SECRET-KEY-1` line (comment lines are skipped) and checks that it opens secrets.age. It refuses when majhi's key file already works, and reads only armored passphrase files with a work factor of 18 or less. Owner only: agents cannot call it. The passphrase and the key are never logged, stored or returned, and no error holds them.
- **Helper.** The `secretsKey.restore` job checks the key file on the Mac again: it writes only when the file is missing or does not open secrets.age, and only a key that opens it. Whatever was at the path is kept as `secrets.key.old-<UTC time>`. The key is written mode 600 in a folder of mode 700. The helper answers, recreates majhi's server so Docker mounts the new file, then saves the key to the Keychain. Without Docker it says to run `make up` once. An older helper answers that it needs `make up`.
- **Health.** While the key file does not open secrets.age, the Keychain and export checks are hidden and "Save to Keychain" is refused, so a good Keychain copy is never replaced by the wrong key.
- **Tests.** `apps/server/src/secrets/restore.test.ts`: the decrypt (comments, wrong passphrase against a damaged file, not an export, a high work factor, no key, two keys, a damaged key), the server's guard, and a round trip from `KeyExports.export` through the helper's own write in a temp home, after which secrets.age reads again. `apps/host/src/keyRestore.test.ts`: the write guard (missing, wrong, a folder at the path, the same key, a working key, keys that do not open secrets.age), restart before the Keychain, and one restore at a time. Plus cases in `store.test.ts` and `jobs.test.ts`. Checked once in a browser on an e2e home: Export key, delete the key file, Restore from export, and the check passes again with the same key.
- **Left.** Not run against real Docker or a real Keychain. The owner's check: on a Mac whose key file is missing or wrong, Health, Secrets key, "Restore from export", then majhi restarts and the check passes.

### Goal

Done when: after a few runs on two orgs, Health and usage shows correct totals per org, project, agent and model that match the sum of the recorded turns, and the captain answers a cost question from the same data; and an agent run cannot read `~/.majhi`, the secrets key or another account's home.

### What I will build, in order

1. **Recording.** `packages/acp` emits one `turn` event per prompt: input, output, reasoning, cache read and cache write tokens from the prompt response, the cost the adapter reported for that turn (the change in its running session cost), and the model. The server writes one row per turn to a `turns` table with the task, agent, account, org, project, run and time. Cost: an API-key account's reported cost is real; a sign-in account's reported cost is the equivalent API cost, marked estimated; without a reported cost, majhi prices the tokens from a price table (built-in defaults for Claude models, owner rows in `majhi.yaml` under `prices`), marked estimated.
2. **Commands.** `usage.summary` (today, this week, this month, a daily series and the top tasks, with filters), `usage.breakdown` (totals grouped by org, project, agent, account, model, task or day), `usage.prices` and `usage.setPrice`. The captain gets them through `majhi-admin` like every command.
3. **Web.** A "Tokens and cost" section on Health and usage: three totals, filters by org, project, agent, account and model, a daily chart, the top tasks. The task header shows the task's total; org cards show the month's cost; API-key accounts show today and this week in the accounts table.
4. **Runner isolation.** A separate `runner` image with the dev toolchain (pnpm, build tools, Playwright). The server starts each agent session in its own container on the runner network, mounting only the task folder, the `.git` of each task repo (its `config` and `hooks` read-only) and the account's config home. A guard refuses any mount of `~/.majhi` (other than the run's own account home), the secrets key, or another account's home. Secrets reach the run only as environment variables. From the runner network only `/mcp` answers. A Health check starts a throwaway runner and proves it cannot see `~/.majhi`, the secrets key or another account's home.

### How I will test it

- Unit: per-turn usage from the adapters' shapes, cost rules and price matching, day, week and month ranges in the owner's time zone, the docker arguments and the mount guard.
- Integration: turns recorded through the run manager with the fake adapter on two orgs, totals from `usage.summary` and `usage.breakdown` equal to the sum of the rows, and the captain (fake adapter) answering from `usage.summary` through `majhi-admin`.
- Real Docker is not available where this is built, so the runner container itself is checked by the Health check on the owner's machine.

## Phase 2b: The captain and staying cheap (in progress)

Wave 1 and the decision provider are merged into `main`. Wave 2 (the run manager) is task PRV-15, from `phase-2b`, following `docs/briefs/2b-wave2.md`. PRV-14 is the parent: it tracks the phase and runs the integration step once PRV-15 is done.

### Done when, status

- [ ] A fake agent pushed past 80% context gets compacted, with the event shown in the room. PRV-15.
- [x] The captain creates an org and an agent after the owner approves (`e2e/phase2b-boss.spec.ts`).
- [ ] A running task resumes on its own after the network drops and returns, and after majhi restarts, with its work intact. PRV-15.
- [ ] An `auto` agent gets a model and effort picked by Laya, with the decision recorded on the run. The pick itself is built (`decisions.pickModel`); calling it at session start is PRV-15.
- [x] With Laya stopped, the chain falls back to the ACP simulation, then rules (`decisions/integration.test.ts`).
- [x] Task links, and no manual work outside majhi.
- [ ] Agents on demand, concurrency limits, and the two-agents-on-one-account check. PRV-15.

### Goal

Done when: a fake agent pushed past 80% context gets compacted with the event shown in the room; the captain creates an org and an agent after the owner approves; a running task resumes on its own after the network drops and returns, and after majhi restarts, with its work intact. Plus task links, concurrency limits, and no manual work outside majhi (update, health, protected folders).

### What I will build, in order

1. **Contract** (done): settings (context, limits, resume, approval policy), org overrides, task links on summaries, agent live states `queued`/`paused`, room items `approval`, `secret-request`, `context`, and commands: `tasks.link|unlink`, `room.fresh|approve|secret`, `secrets.list|save|remove`, `history.list|undo`, `settings.get|set`, `policy.set`, `boss.chat`, `health.run|fix`, `system.version|update`.
2. **Wave 1, in parallel** (done):
   - **Captain:** `majhi-admin` MCP server exposing every command as a tool, attached to the captain's sessions; approval policy with confirm cards; undo from config history; secret capture and secret requests; Cmd J captain chat; onboarding step 4; Hub setup becomes the captain conversation, with history and settings.
   - **Task links:** parent and child tasks, `depends-on` with the Waiting on chip, progress on parents, links in TASK.md, in the New task dialog and the task view.
   - **No manual work:** Health view with every doctor check and Fix buttons; Update ready and one-click update through the host helper; warning before mounting a macOS-protected folder; majhi and Docker start at login.
   - **Decision provider** (done, moved in from Phase 3): Laya on the Mac, the provider chain, `majhi-decide`, the Decisions section in Hub setup.
3. **Wave 2** (PRV-15, not started): one agent owns the run manager: context budget (meter, native compaction, handoff, rotation, Fresh session), checkpoints after every turn, automatic resume after sleep, restart, crash and lost internet, agents on demand with idle stop, concurrency limits with a queue, and the decision hooks (`attachTool`, `auto` model picks).
4. **Integration** (PRV-14, after PRV-15): e2e for the done-when with the fake adapter, `make ci`, then the owner uses it.

### How I will test it

- Unit: settings defaults and merge order (majhi, org, agent), approval decisions per policy, secret detection, link cycles and waiting-on, compaction thresholds, limit queue order, offline and wake detection, version compare.
- Integration: the MCP server over HTTP with a real MCP client; the captain (fake adapter calling MCP tools) creating an org after approval; undo; a fake agent with rising usage compacting natively and by handoff; checkpoints and resume after a simulated restart and a simulated network drop; limits queueing a third agent.
- Playwright: boss chat with an approval card and undo; secret request card; links and the Waiting on chip; context event in the room; Health view with a fix; update banner.

### The captain (built)

- **majhi-admin MCP server** at `/mcp` (`apps/server/src/admin/`): stateless streamable HTTP, `Authorization: Bearer <token>`, 401 without a valid token, 403 for a browser Origin that is not loopback. One tool per command (`majhi_orgs_create`, ...) with the command's zod input as JSON schema plus `ownerAsked` and `reason`, and `majhi_request_secret`. Tokens map to (task, agent); the run manager issues one when it starts a session for the captain or a root agent with `majhi-admin` in `tools`, and revokes it when the session ends.
- **Approval** (`settings.policy`): `auto` runs, `when-asked` runs when `ownerAsked` is true, `confirm` waits. Every non-read call posts an `approval` card in the agent's task: `applied` (with the config `commit`, so Undo works), `failed`, or `pending` (the agent gets "Waiting for the owner..." at once). `room.approve` runs or rejects it, updates the card and sends the agent a message ("The owner approved: ..."). Commands run through the same dispatcher with the agent as actor and the reason, so history records who did it. Secrets in inputs are redacted on cards, results and errors.
- **History and undo**: `history.list` reads the config git log (trailers), `history.undo` reverts one commit and refuses on conflict; an applied card shows Undo and becomes `undone`.
- **Secrets**: `secrets.list|save|remove`; `room.send` and `tasks.create` replace detected secrets with `secret:<name>` (detector in `packages/shared/src/secrets-detect.ts`); `room.secret` answers a request card. Values never reach logs, room items, commits or responses (tests read every file under the majhi home and the config git log).
- **Settings**: `settings.get` merges defaults with majhi.yaml, `settings.set` and `policy.set` write only the given fields through the config history.
- **Web**: Cmd J / Ctrl J and the sidebar "Captain" button open the captain chat as a right drawer on any page; approval and secret-request cards in the room; composer warning; Hub setup is the captain conversation plus setup cards, History (with Undo) and Settings (changing the policy asks first); onboarding step 4.
- **Try it**: with a signed-in captain, press Cmd J and ask for an org. Changes wait for Approve unless you asked for them in the chat. Hub setup shows History and Settings.
- **Tests**: unit (decision table, redaction, detector, name derivation, history parsing, settings merge, web models); integration (MCP with the SDK client, 401, revoked token, approve and reject through the fake adapter, undo and conflict, secret capture and `room.secret`); E2E `e2e/phase2b-boss.spec.ts` (needs the captain from `phase1.spec.ts`, so run the whole suite: `PATH=$PWD/apps/server/node_modules/.bin:$PATH MAJHI_E2E_PORT=7081 npx playwright test`).
- **Known gaps**: A pending card whose input held a secret cannot run after a restart. The captain's tool calls are not rate limited.

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
- **Public keys in the container.** `make up` and every remount mount `<IdentityFile>.pub` read-only (never a private key), so `IdentitiesOnly yes` aliases like `gitlab-acme` offer the right agent key. The image now adds a passwd entry for the owner's uid, without which ssh could not start at all. `doctor` and Repos check each git host the registered projects use (reachable, auth failed, unreachable). The running container needs a `make up` to pick up the mounts and the new image.
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
- Only one agent per task; teams and the captain's compaction are Phase 2b.

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

- Onboarding continues after roots: step 2 adds the first account, step 3 creates the captain (`majhi-boss`, a root agent) with a model and effort read from the account, and runs its health check. A reload resumes at the first missing step. "Skip for now" on steps 2 and 3.
- Studio (top bar or Cmd+.) with two tabs:
  - **Accounts:** every account with tool, org, status and signed-in email, usage, and "Used by" (agents on it, captain marked). Usage per login account, read without tokens: `5h` and `Week` with reset times in the table, plan, per-model windows and Refresh in the details panel. Details panel with the last health check and "Used by" grouped by scope. Agent files that name a missing account are listed. Add account: pick tool and org (or create an org inline), suggested id, then sign in through the embedded terminal or paste an API key. Check, Sign in again, Remove (refused while agents use it).
  - **Agents:** grouped by Root and each org. Editor for scope, role, where, account, model and effort (from the account over ACP, plus auto and account default), instructions, permissions, fallback. Saves as you type. New, Duplicate, Health check, Make captain, Remove (not the captain). Files with errors are shown with each error.
- Health checks spend no tokens: the CLI starts, it reports signed in, an ACP session opens, and the agent's model and effort are offered.
- API keys are encrypted in `~/.majhi/secrets.age` with a key at `~/.config/majhi/secrets.key` (created by `make up`). They never appear in `majhi.yaml`, git history or any response.
- Every change is a commit in `~/.majhi`. Hand edits to `majhi.yaml` or `agents/` show in the UI live through `/api/events`.
- The image ships `@agentclientprotocol/claude-agent-acp` 0.84.0 and `@agentclientprotocol/codex-acp` 2.0.0. `make doctor` shows both CLI versions and each account's health.

### How to try it

1. `make up`, open http://127.0.0.1:7070. With roots already set, onboarding opens at step 2.
2. Add a Claude account with Sign in. In the terminal, open the link, sign in, paste the code. It shows healthy.
3. Create the captain with the suggested model and effort.
4. Studio (Cmd+.): create an org, add accounts, create agents, change model and effort, run health checks. Look at `~/.majhi/agents/` and `git -C ~/.majhi log`.

### Verified

- `make ci`: Biome clean, typecheck, 279 unit and integration tests, both builds, 14 Playwright tests (8 Phase 0, 6 Phase 1). The Phase 1 spec passed 3 runs in a row.
- e2e with a fake ACP adapter covers the whole "Done when": fresh install to a healthy captain; an org with two signed-in Claude accounts and three agents, each passing its health check; an API-key account whose key is absent from every response, socket frame, `majhi.yaml`, `secrets.age` bytes and `git log -p`; Used by and Missing accounts updating live; editor saves to disk and picks up hand edits; remove refusals.
- `docker compose build` succeeds; node-pty works in the image; both adapters are on PATH.

### Left and known issues

- Not yet run with a real account: the real Claude and Codex logins in the embedded terminal, and the real model lists. This is the owner's review step.
- SPEC 5.2 concurrency check (two agents on one account refreshing tokens at once) needs real runs, so it moves to Phase 2. Accounts share one config home per DECISIONS, which avoids the linked-file problem.
- Codex API-key accounts set `cli_auth_credentials_store = "ephemeral"` so the key is not written to `auth.json`. Unverified against a real key.
- API-key accounts show no windows; tokens and cost come with the first runs (Phase 2).
- The Claude usage call is experimental in the SDK. If a release removes it, the table keeps the last numbers and the details panel shows the error.
- Codex device login is not covered by e2e (only Codex API key).

### Goal

A fresh install walks through onboarding to a captain agent whose health check passes. From the UI the owner can add two Claude accounts for one org, three agents on them, and one API-key account, and every agent's health check passes.

### What I will build, in order

1. **Contract** (`packages/shared/src/accounts.ts`, `commands.ts`): account, org and agent file schemas, tool info, models, health check, the `/api/events` and `/api/term/<id>` WebSocket messages, and the commands: `tools.list`, `orgs.list|create`, `accounts.list|suggestId|create|remove|login.start|health|models`, `agents.list|create|update|duplicate|remove|health`, `boss.set`.
2. **`packages/acp`**: tool registry (Claude Code, Codex), per-run env built from scratch, login commands, and `probeAccount`, which checks the CLI, the sign-in and an ACP session (models and effort levels) without spending tokens. A fake ACP adapter in `packages/acp/testing` for every test.
3. **`apps/server`**: orgs and accounts in `majhi.yaml`, account homes, API keys in `secrets.age` (age), agent files with a watcher, the login terminal (node-pty over WebSocket), the events socket, handlers for every command, `doctor` checks for the CLIs, and the adapters installed in the image.
4. **`apps/web`**: Studio overlay with Agents and Accounts tabs, the add-account flow with an embedded terminal (xterm.js), the agent editor with models and effort read from the account, health check buttons, onboarding steps 2 (first account) and 3 (choose the captain).
5. **Integration**: e2e through onboarding and Studio against the fake adapter, `make ci`, and a real `make up` with the real adapters.

Steps 2 to 4 run in parallel against the contract.

### How I will test it

- Unit: schemas, account id suggestion, env building (nothing from the server env leaks), agent file parse and write round trip, secrets encrypt and decrypt, model and effort checks.
- Integration: every command through the dispatcher with the fake adapter; the login terminal end to end with the fake login; the file watcher picking up a hand edit.
- Playwright: onboarding to a healthy captain; two Claude accounts for one org and three agents; one API-key account; editing an agent and seeing the file change.
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

## Backups and restore of majhi's data (built)

**Status.** Built on `worktree-agent-a50a98df07d88978b`, from `main`. Captain v2 essential 10 (`docs/briefs/captain-v2-playbooks.md`). SPEC 5.19; decisions dated 2026-10-04. Replaces the PRV-31 snapshot of `majhi.db` alone.

**What works.**
- One age-encrypted archive per backup: both databases (online backup API), the config history (git bundle) and its files, and `secrets.age` as it is on disk. Never the key, logins, connection credentials or caches. Manifest with versions, migration ids and checksums.
- Daily, before `system.update`, before a migration at start, before a restore, and on request. Folder is the default `backups/` or one the owner picks with the folder browser. 7 daily, 4 weekly, 3 of each other kind; the last good backup is never deleted.
- Test restore (weekly and on demand) into a temp folder; result in Hub setup and the Health checks "Backups" and "Backup test restore".
- Restore: verify, back up what is there, stage, restart; the next start swaps with a journal, keeps a rollback, and undoes itself on any failure.

**How to try it.** Hub setup, Backups: Back up now, Test restore, Restore on a row. Health shows the two checks. Tests: `npx vitest run apps/server/src/backup`.

**Measured.** 300 MB database: backup 8 s (text-like data, 98 MB archive) to 17 s (incompressible, 302 MB), test restore 4 to 6 s, about 300 MB of memory.

**Left.** The destination check needs a real container with a mounted folder to prove (owner: pick an iCloud or Dropbox folder on a real install and read the mount message). Restore restarts itself only under docker compose; elsewhere the section says to run `make up`. Old `daily-*.db` snapshots are listed and restorable but not written any more.
