# Guarantees: one test each

Source: origin/main 065031af (388 test files, 1841 test cases by `it`/`test` count; vitest reported 2658 runs on the last full run). Read-only pass: nothing was run or edited.

## How to read this

- A guarantee is one thing that must always hold, written in plain words. The test kept is the one closest to how the owner or an agent triggers it. Every other test of the same guarantee is deleted.
- **Table rows** says what to fold into the kept test as `it.each` rows when variants matter. Folding means moving the cases into the kept test, not adding new behaviour.
- **(goes with the Autonomous step)**: the only test of that guarantee today lives in a file the workflow reset replaces. Keep it until step 5 ships its own, then it moves. These are not 'missing'.
- A fold may move cases out of a file that is otherwise deleted (for example `room/socket.test.ts` into the cross-site row); that file is then deleted after the move.
- Test names are exact titles from the files (or the `describe` name where marked). Path prefix: `apps/server/src/` is written `server/`, `apps/host/internal/` is `host/` (the host helper is Go since step 2c, and its tests are Go tests: `TestName` is the function's name).

## 1 Security and isolation (47)

| # | Guarantee | Test kept (file: title) | Table rows |
|---|---|---|---|
| 1 | An API key is stored encrypted and never reaches majhi.yaml, git, command output or the cache. | `server/accounts/commands.test.ts`: stores an API key encrypted, and it never reaches majhi.yaml, git, output or the cache |  |
| 2 | A secret typed or pasted into a chat is swapped for a reference before the agent or the room sees it. | `server/secrets/service.test.ts`: replaces secrets in room.send before the agent or the room see them |  |
| 3 | The secrets file holds values only encrypted and opens only with the right key. | `server/secrets/store.test.ts`: round trips values and keeps them out of the file |  |
| 4 | The host helper hands a git token to clone and push through a private file, never argv or the environment. | `host/git/token_test.go`: TestCloneKeepsTheTokenOutOfArgvEnvAndErrors | add TestPushKeepsTheTokenOutOfArgvAndEnv as a second row |
| 5 | Connection secret values are replaced by their names in the room, audit log, process output and report. | `server/connections/redact.test.ts`: never reach the room, the audit log, a process's output or the report |  |
| 6 | Secret detection finds private keys, long tokens and keyword values, and leaves hashes, ids and paths alone. | `packages/shared/src/secrets-detect.test.ts`: finds a long random token and a value after a keyword | fold into one it.each: private key block / long token / keyword value; then hash / uuid / path / word / reference |
| 7 | A branch that adds a secret is blocked from shipping, and the block names file, line and rule without showing the value. | `server/handoff/secret-scan.test.ts`: names the file, line and rule, and masks the value, so a block is never unexplained |  |
| 8 | A workspace's agent never gets another workspace's connection. | `server/connections/access.test.ts`: never gives an org agent another org's connection, even working in that org |  |
| 9 | A run in one workspace gets only that workspace's CLI sign-in folders. | `server/connect/cli.test.ts`: gives a run in workspace A only A's folders and the tool's own variables |  |
| 10 | Captain read commands never show another workspace, whatever they are asked. | `server/captain/lane-reads.test.ts`: never show another workspace, for every read command an agent may call |  |
| 11 | An agent sees only global memory, its own workspace's and its projects', never another workspace's. | `server/memory/integration.test.ts`: shows an agent only global, its org and that org's projects, and never another org's facts |  |
| 12 | Wiki answers never use a source or page from another workspace. | `server/wiki/ask.test.ts`: never returns a source or page from another workspace, or from a project outside the scope |  |
| 13 | A client room is never read, listed or found by another workspace's captain lane. | `server/chat/isolation.test.ts`: is not read, listed, found or described to a captain lane of this workspace |  |
| 14 | A workspace's runs use only that workspace's AI account, never another's. | `server/runs/lane-account.test.ts`: refuses another workspace's account, whatever the lane asks |  |
| 15 | Two workspaces share no builder, network, container, volume or image. | `server/containers/environment.test.ts`: share no builder, network, container, volume or image | fold 'never reuse a volume another workspace made' in as a row |
| 16 | Each workspace has its own browser container, network and profile. | `server/browsers/service.test.ts`: is never shared: each workspace has its own container, network and profile folders, and its tasks join only its own |  |
| 17 | An agent container mounts only its task folder, the repo's git folder (config and hooks read-only), its own workspace's agent home and, inside it, that account's sign-in file. It refuses another workspace's home, any account folder and any other file of one. | `packages/acp/src/runner/docker.test.ts`: mounts only the task folder, the repo's .git (config and hooks read-only), the run's own workspace home and that account's sign-in file; refuses %s | rows: another workspace's home (also read-only) / every agent home / the account folder / another account's folder / every account folder / another file of the account folder / the sign-in file at another place or as a skills overlay / the account folder as the session's own home / another account's home with this account's sign-in / a home that climbs out |
| 18 | A task's containers never get a host folder, the Docker socket, ~/.majhi, the key or ~/.ssh, and never extra capabilities or privileges. | `server/containers/args.test.ts`: never mounts anything of the host, names the socket, ~/.majhi, the key or ~/.ssh | fold the 'missing or widened caps, privileges and limits' refusals in as rows |
| 19 | Only images the owner allowed run in a task. | `server/containers/service.test.ts`: refuses an image the owner has not allowed, and asks through a card when it can |  |
| 20 | Agents start with a clean environment: nothing from majhi's own, and no SSH agent. | `packages/acp/src/env.test.ts`: never copies from process.env | fold: no SSH variable row |
| 21 | Majhi's own git never runs a command named by a repo's config or attributes. | `server/git/git.test.ts`: runs none of the commands a repo's config and attributes name |  |
| 22 | Outbound calls never go to private, loopback, link-local or metadata addresses, also when a public name resolves to one; only the owner can confirm a private one, never metadata. | `server/connect/self-host.test.ts`: never allows a metadata address, not by name and not by number, even when confirmed | 18-row classifyAddress table from packages/shared/src/self-host.test.ts (public, loopback, 10/172.16/192.168, CGNAT, metadata, link-local, IPv6, IPv4-mapped) moves in as rows (if the connect check does not take a raw IP per row, keep the shared table as the one test instead); also fold 'refuses a public name that resolves to a private address, unless the owner confirms' |
| 23 | A runner's network blocks every private range, the LAN, the VPN and link-local addresses. | `packages/acp/src/runner/netguard.test.ts`: refuses every private range, the LAN, the VPN and link-local ones included |  |
| 24 | The build network fails closed: no build runs when the private-range guard cannot be set. | `server/containers/compose-run.test.ts`: fails closed: no build runs when the guard cannot be set |  |
| 25 | A path counts as inside a folder only if it really is: neighbours, climbs out with .. and links that lead out fail. | `server/fs.test.ts`: path containment (describe) | describe 'path containment', existing 8-row table plus symlink case |
| 26 | Task files are served only from inside the task folder: no dot names, escapes or symlinks that leave it; pages and SVG are sandboxed. | `server/http/taskFiles.test.ts`: refuses dot names, escapes and symlinks that leave the folder | fold 'sandboxes pages and svg' in as a row |
| 27 | Wiki and repo files are served only from the workspace's own exports and projects: no .., absolute paths, symlinks out, other projects. | `server/http/wikiFiles.test.ts`: refuses .., absolute paths, symlinks out of the export and backslashes | fold taskRepoFiles.test.ts cases in as rows |
| 28 | The editor opens only paths inside the allowed roots. | `server/editor/allowed.test.ts`: refuses a path outside the roots, including one that climbs out with .. |  |
| 29 | An attachment can come only from inside the task folder, also through a symlink. | `server/uploads/attach.test.ts`: refuses a file outside the task folder, also through a symlink |  |
| 30 | The admin tool endpoint answers 401 without a valid token and 403 to a foreign origin. | `server/admin/mcp.test.ts`: answers 401 without a valid token and 403 to a foreign origin |  |
| 31 | A command from another website or an unrelated local page is refused, with or without an Origin header, also on sockets. | `server/http/app.test.ts`: blocks commands from other websites and unrelated loopback pages | rows: simple POST without Origin / upload from another port / malformed origin / opaque origin / runner peer with forged owner origin (from room/socket.test.ts) |
| 32 | A session token works for one task and agent, only on the server it was issued for, and stops when the session ends. | `server/rooms/access.test.ts`: belong to one task and agent: another task's token never resolves to this one | fold 'stop working the moment the session ends' in as a row |
| 33 | The host helper answers only requests with its token, and never a browser request. | `server/host/routes.test.ts`: requires the token from host.token | add 'refuses browser requests' as a second row |
| 34 | A sign-in answer is accepted once and only for the workspace and issuer that began it. | `server/connect/connect.test.ts`: refuses a replayed answer: the state works once | fold into one it.each: replayed state / another workspace's attempt / another issuer / expired page |
| 35 | A run never gets a connection's refresh or access token in its environment or mounts. | `server/connect/e2e.test.ts`: never puts the refresh token or the access token in a run's environment or mounts |  |
| 36 | A token goes only to the service's own host, in a header, with no redirect followed and never into a URL or log. | `server/connect/token-connect.test.ts`: the token goes only in an Authorization header, to Linear's host, with no redirect followed, and never into a URL, a log or a state |  |
| 37 | Only the owner sets a workspace's authority level. | `server/autonomy/authority-set.test.ts`: is set by the owner alone: an agent's actor is refused, no tool exists for it, and autonomy.configure does not take it |  |
| 38 | A captain change is a card that changes nothing until the owner applies it. | `server/admin/boss.test.ts`: becomes a card with a plain diff, and changes nothing |  |
| 39 | Only the owner answers decisions: an agent or the captain is refused before anything runs. | `server/inbox/inbox.test.ts`: answers only for the owner: an agent, the captain too, is refused before anything runs |  |
| 40 | A destructive command always asks, whatever the policy or an Always rule says. | `server/admin/policy.test.ts`: keeps a destructive command on confirm whatever the policy says |  |
| 41 | Agents have no push tool, and a push sent anyway is refused. | `server/admin/owner-asked.test.ts`: has no push in its merge tools, and a push sent anyway is refused |  |
| 42 | An agent cannot loosen a connection's write gate. | `server/connections/commands.test.ts`: keeps an agent from loosening the gate, even without a secret |  |
| 43 | A write cannot be smuggled past the connection gate through $(...), backticks, sh -c, eval, xargs or an unreadable command. | `server/connections/gate.test.ts`: reads inside $(...), backticks, sh -c, eval, watch, xargs and find -exec | fold 'counts what it cannot read as a write' in as a row |
| 44 | A destructive connection command asks even when the exact command is allow-listed. | `server/connections/gate.test.ts`: asks for kubectl delete even when allow holds the exact command |  |
| 45 | An approval link from a phone is refused when altered, forged, for another reference or action, or taken from another decision. | `server/ops/phone.test.ts`: refuses a changed byte, a link that names another reference or action, a forged payload, and a token from another decision |  |
| 46 | A secret in text is never saved as a memory (the sink agents feed directly; the other sinks share the detection in #6). | `server/memory/memory.test.ts`: refuses facts that hold a secret |  |
| 46a | A Codex tool call that writes to a connection asks the owner through the managed hook, and is denied when the owner refuses (#43 and #44 for Codex). | `server/runs/codex-hook.test.ts`: asks the owner for %s, and is denied when the owner refuses | rows: a shell write to a held cluster / an MCP write in Codex's spelling of the server and tool (`acme_obs`, `reset_alerts`) |
| 46b | A destructive command through the Codex hook asks even when the connection's `allow` holds it and the level is Full (#40 and #44 for Codex). | `server/runs/codex-hook.test.ts`: asks for a destructive command even when the connection allows it and the level is Full |  |
| 46c | The Codex hook script fails closed (server down, garbage or error reply, no credential, no call, deadline reached) and lets a call run only on majhi's allow, with a deadline shorter than Codex's timeout. | `acp/runner/codex-hook.test.ts`: fails closed, and lets a call run only on majhi's allow |  |
| 46d | The Codex hook endpoint answers only a session's own credential: none, a wrong one, another server's or one of a session that ended is refused, and each token asks for its own task and agent. | `server/rooms/codex-hook.test.ts`: answers only a session's own token |  |
| 46e | The `files` tools of a read-only session read inside its folders with numbered lines, and refuse a climb out with `..`, an absolute path, a link inside the folders that leads out, and `/proc/self/environ`. | `server/memory/files-mcp.test.ts`: read inside the folders with numbered lines, and refuse everything outside them |  |
| 46f | A `files` token answers only for its own session's folders: another session's token, a hook token, a revoked token and none are refused. | `server/memory/files-mcp.test.ts`: answer only for their own session's folders |  |
| 46g | Through the Codex hook endpoint, a read-only Housekeeper session gets a shell and a patch denied with the reason, and its files tools allowed. | `server/rooms/codex-hook.test.ts`: denies a shell and a patch to a read-only Housekeeper session with the reason, and allows its files tools |  |
| 46h | The host helper pushes with no force, no delete and https only, and a push runs no hook, credential helper, signing program, askpass or rewrite the checkout names. | `host/git/guard_test.go`: TestPushRefusesForceDeleteAndNonHTTPS | rows: TestPushGuardIgnoresWhatTheRepoPlants / TestPushGuardRefusesOrBeatsRewrites / TestGuardsHoldAgainstARealRepo |
| 46i | A secret reaches the keyring on stdin only, never on a command line, and a different key already in it is never replaced by the helper looking again. | `host/platform/platform_test.go`: TestKeyringsTakeASecretOnStdinOnly | row: `host/secretskey/secretskey_test.go`: TestEnsureNeverReplacesADifferentKeyInTheKeyring |
| 46j | An SSH key's passphrase goes to ssh-add through a private askpass folder that is removed after the job, right, wrong or never asked. | `host/ssh/ssh_test.go`: TestAskpassFolderIsRemovedAfterTheJob |  |
| 46k | A download or release package is used only when it matches: terminal-notifier by its pinned SHA-256, a release package by the version and commit published, and never through a link. | `host/platform/platform_test.go`: TestTerminalNotifierWithAnotherChecksumIsRefused | rows: `host/checkout/package_test.go`: TestReleaseThatDoesNotMatchWhatWasPublishedIsRefused / TestReleaseNeverWritesThroughALink; `host/download/download_test.go`: TestOnlyHTTPS |
| 46l | The host helper speaks the shared protocol: every method's reply, the poll header and the progress parse against the zod schemas, and the CLI tool table equals the shared one. | `server/host/contract.test.ts`: the Go host helper against the shared schemas |  |
| 46m | A push is refused when the repo's own git config sets a network setting (any `http.` key, a remote's proxy, pushurl or receivepack, `push.recurseSubmodules` other than `no`), and the token file is never written. | `host/git/network_test.go`: TestPushRefusesNetworkSettingsOfTheRepo |  |
| 46n | A token folder does not outlive a crash: a panic during a push leaves no `job-*` folder, and a folder a stopped helper left is removed at start. | `host/git/network_test.go`: TestTokenFolderDoesNotOutliveACrash |  |
| 46o | A planted update journal (a git option as the head, an image id that is not a sha256 id, a moved release with a missing field, a mount of the root, the Docker socket, a path outside the home or a privileged service) is kept aside and nothing runs. | `host/update/update_test.go`: TestAPlantedJournalIsRefusedAndNothingRuns |  |
| 46p | A command run on a connected host is read from its parsed words by typed tables, never by its text: a read (logs, `docker ps`, `docker inspect`, files, a SELECT, a local status endpoint) runs with no card, one restart or recreate of a service on the same image and config is a recovery, and everything else, or anything that cannot be parsed, is a write that asks. A key, a login or an `.env` file is never a plain read. | `server/connections/remote-command.test.ts`: reads, recovers and writes (three it.each tables) |  |

| 17a | A new workspace home is seeded only with who the account is, never with MCP servers, hooks, settings, instructions, skills or plugins from the account folder, and a file the CLI already made is never overwritten. | `packages/acp/src/seed.test.ts`: copies only who the account is, never MCP servers, hooks, settings, instructions, skills or plugins |  |
| 17b | A session never starts on a sign-in file that belongs to someone else than the person the account was pinned to: the account becomes signed out with the reason (Needs you shows Sign in), and a refreshed file of the same person passes. | `server/accounts/identity.test.ts`: refuses the next session when a changed file belongs to someone else and asks to sign in again, and lets a refreshed file of the same person through |  |
| 17c | Codex's sign-in identity comes only from its signed access token (RS256 against OpenAI's published keys, issuer, expiry): a genuine id_token beside another account's access token, a forged signature, an unknown key id, another issuer, an expired token, or keys that cannot be read are refused. | `packages/acp/src/tools/codex.test.ts`: is the signed access token's account and user, and a genuine id_token beside another account's access token is refused | rows: stranger's key / unknown kid / other issuer / expired / no signature / keys unreadable |

## 2 Data loss and corruption (20)

| # | Guarantee | Test kept (file: title) | Table rows |
|---|---|---|---|
| 47 | A secrets key file that works is never replaced by a restore. | `server/secrets/restore.test.ts`: never replaces a key file that works | the helper's own write: `host/secretskey/secretskey_test.go`: TestRestoreNeverReplacesAWorkingKeyFile |
| 48 | A full disk leaves no half-written backup and keeps the earlier ones. | `server/backup/backup.test.ts`: leaves no file that looks like a backup when the disk fills mid-write, and keeps the earlier ones |  |
| 49 | A damaged or too-new backup restores nothing and changes nothing live. | `server/backup/backup.test.ts`: changes nothing when the backup is damaged | fold: cut-off archive / flipped bit / wrong key / newer migration / failed integrity check |
| 50 | Retention never deletes the only good backup. | `server/backup/retention.test.ts`: never deletes the only good backup, even when damaged ones are newer and the limits are zero |  |
| 51 | If any step of a restore swap fails, the old data stays exactly as it was. | `server/backup/swap.test.ts`: leaves the old data exactly as it was when any single step fails |  |
| 52 | A database that is behind is backed up before migrating, and migration stops if the backup cannot be written. | `server/backup/backup.test.ts`: blocks migration when its safety backup cannot be written |  |
| 53 | A failed update restores both databases before the old server starts. | `server/backup/updateDatabases.test.ts`: restores both databases after destructive migrations, including WAL writes |  |
| 54 | If the new majhi does not start, the host goes back to the previous image with the reason. | `host/update/update_test.go`: TestUpdateGoesBackWhenTheNewMajhiDoesNotStart | add TestAnInterruptedUpdateIsRecoveredAtStart (a helper stopped at any phase goes back from its journal at the next start) and TestAFailedRecoveryKeepsTheJournal as rows |
| 54a | A crash between the steps of a durable write leaves the old file or the new one, never half of one, and no temporary file behind. | `host/durable/durable_test.go`: TestCrashBetweenStepsLeavesOldOrNew |  |
| 54b | A half-written update journal is never read as a transaction. | `host/update/journal_test.go`: TestAHalfWrittenJournalIsNeverRead |  |
| 55 | Removing a task with uncommitted changes needs force and the task id. | `server/tasks/commands.test.ts`: refuses to remove a task with uncommitted changes unless forced and confirmed with its id |  |
| 56 | Cleaning up an old finished task keeps a worktree with uncommitted changes, its branch and files. | `server/tasks/cleanup.test.ts`: keeps a worktree with uncommitted changes, its branch and its files |  |
| 57 | Cleanup deletes a branch only when its commits exist elsewhere (merged or pushed, checked against the remote itself). | `server/tasks/cleanup.test.ts`: keeps the branch of a merged MR when it holds commits that were never pushed | fold into a table: unpushed commits / unmerged / remote unreachable / tracking ref only / MR still open / branch the task did not create |
| 58 | A task with unshipped commits cannot be closed until the owner confirms. | `server/tasks/shipped.test.ts`: refuses the owner with what is unshipped, and closes once the owner confirms |  |
| 59 | A ship onto a remote branch that moved merges and pushes nothing. | `server/mrs/ship.test.ts`: refuses to merge and push when the remote branch moved, and changes nothing |  |
| 60 | A merge conflict leaves both branches untouched and the checkout clean. | `server/git/merge.test.ts`: on a conflict changes neither branch and leaves the checkout clean |  |
| 61 | Majhi never force-pushes: a diverged branch is refused. | `server/mrs/push.test.ts`: never forces: a diverged branch is refused |  |
| 62 | A run cannot move, delete or commit on the owner's branches. | `server/runs/attribution.test.ts`: cannot move, delete or commit on the owner's branches |  |
| 63 | Ending a task never removes the project's shared volume, only the task's private ones. | `server/containers/environment.test.ts`: is the only kind `docker compose down -v` removes: the project's shared volume stays |  |
| 64 | A migration that fails is rolled back and not recorded. | `server/store/store.test.ts`: rolls a failing migration back and does not record it |  |
| 65 | An older database upgrades keeping its rows readable. | `server/store/store.test.ts`: adds the column to an older database and keeps its rows readable |  |
| 66 | A config write refuses a file with YAML errors and keeps comments and keys it does not own. | `server/config/service.test.ts`: refuses to rewrite a file with YAML errors |  |
| 66a | The worktree budget never removes the folder of a task that is not done: a paused task, a task in review and a captain lane keep theirs, however many folders there are. | `server/tasks/folder-sweep.test.ts`: never removes the folder of a task that is not done, a captain lane included |  |
| 66b | A run opens its task folder only after it exists: a folder that was deleted is made again with TASK.md before the session starts. | `server/runs/launch.test.ts`: makes its folder again when it is missing, with TASK.md, and starts |  |

## 3 Money and limits (15)

| # | Guarantee | Test kept (file: title) | Table rows |
|---|---|---|---|
| 67 | A workspace over its budget has its runs paused and other workspaces keep running. | `server/budgets/limit.test.ts`: pauses the runs of the org that is over, and not other orgs |  |
| 68 | Each budget alert fires once per threshold, and the 100% action runs once. | `server/budgets/monitor.test.ts`: fires 80 and then 100, each once, and runs the 100% action once |  |
| 69 | Budget use counts input, output and cache write, not cache reads or reasoning. | `server/budgets/thresholds.test.ts`: counts input, output and cache write, and leaves cache reads and reasoning out |  |
| 70 | Every turn is recorded and every total equals the sum of its rows. | `server/usage/integration.test.ts`: records every turn on two orgs, and every total matches the sum of the rows |  |
| 71 | The day cap holds an org whose cap is reached, holds everything at the overall cap, and lifts when raised. (goes with the Autonomous step) | `server/autonomy/spend.test.ts`: holds an org whose cap is reached, holds everything at the day cap, and lifts when the cap is raised |  |
| 72 | A running turn is cut when the day cap is passed by more than the margin, and nothing starts after. (goes with the Autonomous step) | `server/autonomy/cap.test.ts`: stops a running turn once the cap is passed by more than the margin, and starts nothing after |  |
| 73 | New starts stop once the monthly spend ceiling is reached, but a running turn is not cut. | `server/outcomes/outcomes.test.ts`: holds new starts once spend reaches it, never a turn already running, and asks as a Money decision |  |
| 74 | An unattended playbook run ends when it reaches its token budget. | `server/playbooks/service.test.ts`: ends a run that reached its token budget: the turn is cancelled, the run is capped, it backs off |  |
| 75 | Tasks start under the running cap and wait in line at it; at the open-tasks cap the captain's, chat and schedule tasks become ideas, never the owner's or an incident's. | `server/tasks/gate.test.ts`: starts every origin under the running cap and queues it at and over the cap | fold 'files the captain's, client chats' and schedules' tasks as ideas at the open cap' in as a second row |
| 76 | The captain's starts are capped at two at once and the owner's start is never held. (goes with the Autonomous step) | `server/autonomy/slots.test.ts`: refuses the captain's start with one line when no slot is free, starts it when one is, and never holds the owner's start |  |
| 77 | The captain never starts work the owner marked not for autonomous. (goes with the Autonomous step) | `server/autonomy/pick.test.ts`: are left alone by the captain, show in tasks.list, and only the owner sets the mark |  |
| 78 | Running agents never exceed agents_max. | `server/runs/limits.test.ts`: never lets the machine-wide run total exceed agents_max |  |
| 79 | A third start on one account queues, shows its place and starts when a slot frees. | `server/runs/limits.test.ts`: queues a third start on one account, shows its place, and starts it when a slot frees |  |
| 80 | When an account hits its limit mid-run, another agent continues from the last checkpoint (lead replaced by the worker with most headroom; a worker's step finished by another); the task does not pause. | `server/tasks/crew.test.ts`: is replaced by the worker with the most headroom, who carries on with the plan | add the worker case 'has its step finished by another agent from the last checkpoint' as a second row; replaces e2e/phase7-limits.spec.ts |
| 81 | A task is paused after three answers with no progress. | `server/captain/loop-guard.test.ts`: pauses a task after three answers with no progress, and not before |  |

## 4 Core state machines (29)

| # | Guarantee | Test kept (file: title) | Table rows |
|---|---|---|---|
| 82 | Every legal task move lands in the state the table says, with its effects. | `packages/shared/src/lifecycle/transition.test.ts`: transition table (describe) | describe 'transition table', existing it.each over ROWS |
| 83 | Every illegal task move is refused with wrong-status and nothing changes. | `packages/shared/src/lifecycle/transition.test.ts`: illegal transitions are refused (describe) | describe 'illegal transitions are refused', existing it.each over event x status |
| 84 | After a crash the outbox drains once, never twice. | `server/tasks/lifecycle/apply.test.ts`: drains after a crash and a restart, and only once |  |
| 85 | A hold is lifted only by who the table lists (owner, captain, majhi); the captain cannot lift an owner stop, a loop guard or a closed dependency. | `packages/shared/src/lifecycle/transition.test.ts`: by %s is allowed exactly when the table lists them | existing it.each; add the 'captain cannot lift owner stop' cases as rows |
| 86 | A hold clears only when its cause is gone: back online, signed in again, window reset, budget room, new activity. | `packages/shared/src/lifecycle/hold.test.ts`: account-limit clears when the window reset, and never for a signed-out account | fold the five cause tests into one it.each |
| 87 | No held task can be started or sent back, none with unmet dependencies is ever started, and every hold can be lifted by someone. | `packages/shared/src/lifecycle/transition.test.ts`: no held task can be started or sent back, from any reachable state | fold the three invariant tests into one |
| 88 | Over the cap, a resume waits in line like a start. | `server/tasks/gate.test.ts`: makes a resume wait in line like a start when the cap is full |  |
| 89 | An urgent task pauses the lowest-priority runner, which resumes through the line without a second run. | `server/tasks/crew.test.ts`: pauses the lowest-priority running task for an urgent one, which resumes through the line without a second run |  |
| 90 | With every agent down, the task pauses at the checkpoint and resumes by itself once, on recovery. | `server/tasks/crew.test.ts`: pauses at the checkpoint with the exact fix, then resumes by itself on recovery, once |  |
| 91 | After a restart a cut turn continues with its work and a checkpoint, once. | `server/runs/resume.test.ts`: continues a cut turn after a restart, with its work and a checkpoint |  |
| 91a | A run that signs out mid-run while its account checks fine (another session refreshed the token) resumes by itself once per task and sign-in file, with one room line; a second sign-out on the same file pauses as signed out and does not loop. | `server/runs/sign-out-heal.test.ts`: resumes once when the account checks fine (another session refreshed it), and a second sign-out on the same sign-in is a real one |  |
| 92 | What each kind of action asks at Ask me, Routine and Full follows the table (sandbox work never asks). | `server/runs/permission-flow.test.ts`: %s asks at Ask me: %s, at Routine: %s, at Full: %s | existing 13-row it.each; the sandbox-only case is a row |
| 93 | Secrets, a client's server, deleting outside, going over budget, a new image and the unknown ask at every level. | `packages/shared/src/risk-kinds.test.ts`: never lets secrets, a client's server, deleting outside, going over budget, a new image or the unknown through, at any level |  |
| 94 | Work inside the task sandbox never asks, and work that leaves it does. | `server/runs/manager.test.ts`: never asks for what stays inside the task, and asks for what leaves it |  |
| 95 | The captain starts work above Ask me, pushes from Routine up and merges at Full only. | `server/autonomy/policy.test.ts`: merges at Full only | fold the three tests into one it.each: start / push and open MR / merge, by level |
| 96 | The captain never merges when a guard fails, whatever the level. | `server/captain/ship-decision.test.ts`: never merges when a guard fails, whatever the level says |  |
| 97 | An Always rule covers the next task in its workspace and kind, and no other workspace. | `server/runs/permission-flow.test.ts`: keeps one rule for the workspace and the kind, and covers the next task there and no other workspace |  |
| 98 | A card is answered once. | `server/rooms/ask.test.ts`: rejects answering twice on the same card |  |
| 99 | A merge from its card happens once. | `server/tasks/cards.test.ts`: merges from the card once, and refuses a second click |  |
| 100 | A phone approval link works once: a replay is refused, and taking one button voids the other. | `server/ops/phone.test.ts`: approves once, and a replay of the same link is refused |  |
| 101 | Two identical captain actions at once run once. | `server/captain/keys.test.ts`: lets two connections to one database race: one wins on the unique key |  |
| 102 | A merge needs green checks on the exact head: a failed check, an agent, a wrong sha or a moved head cannot get it through. | `server/handoff/merge-gate.test.ts`: refuses a failed check, cannot be overridden by an agent or a wrong sha, and lets the owner confirm the head | fold queued-merge 'never merges when the head moved, even if the new head is green' in as a row |
| 103 | A client message never goes out under Ask me, and a secret, another client, a report or a first message always waits for the owner. | `server/chat/rails.test.ts`: never goes out under Tell Ask me, however clear it is | fold chat/rails 'always waits' tests in as rows |
| 104 | Stop everything halts the captain: no lane, no tools, no start, whatever else is on. (goes with the Autonomous step) | `server/autonomy/switch.test.ts`: Stop everything halts captain work: no lane, no tools, no start, whatever Auto-pilot says |  |
| 104a | A client message is marked handled ("had nothing to send") only when a captain turn ended normally after the message was given to it; a lane that was paused, errored or never started leaves it waiting and urgent, so it shows in Needs you. | `server/chat/desk.test.ts`: waits, urgent, when the lane stopped without a turn that ended; is handled when the lane's turn ran and ended with no reply |  |
| 104b | A connection command the owner approves runs exactly once, whether the owner answers while the agent's turn still runs or before the wait is registered, and the agent gets the output: with its next majhi-connections call, or in a message at the end of its turn, never both. | `server/connections/approved-ssh.test.ts`: runs once and the agent gets the output: approved %s, read through %s | rows: while its turn runs / before the wait is registered, each read through its next tool call / a message at the end of its turn |
| 104c | The Acme replay: a client's two messages open one case in the workspace, the captain reads and restarts the stuck worker once with no card, a read shows the symptom is gone, the client gets two messages at most, the case closes with a summary, zero tasks and zero bug reports are made (the captain's tries are refused), and the owner has nothing to decide. | `server/cases/replay.test.ts`: opens one case for two messages, reads and restarts without a card, checks it works, and closes it |  |
| 104d | The replay where the fix needs a code deploy ends with exactly one Needs-you card ("Deploy fix X to Acme?") with its buttons, the client told it is being worked on, a second card and a repeated read refused, a later message joining the same case with no reply of its own, and the owner's answer reaching the captain. | `server/cases/replay.test.ts`: ends with one card, tells the client it is being worked on, and takes a later message into the same case |  |
| 104e | A captain lane that is held by an error and has lost its folder is resumed by the watchdog, the waiting messages are woken, the client is answered, and the owner is told nothing. | `server/cases/replay.test.ts`: heals a lane that is paused with a sign-in error and has lost its folder, answers the client, and never tells the owner |  |
| 104f | When the heals keep failing, a client message that waited ten minutes gets exactly one message to the owner (what was tried) and the client's fixed words once; the lane is resumed three times and no more. | `server/cases/replay.test.ts`: tells the owner once at ten minutes when the heals keep failing, and tells the client we are looking into it |  |
| 104g | Setup's automatic ids (the workspace, the account, the lead agent, the captain) never replace an existing one: a clash gets the next free id, and a captain that is set is kept. | `packages/shared/src/setup-ids.test.ts`: never replace an existing account, workspace or agent: a clash gets a new id |  |
| 104h | A background process stays one room item per run and its end sets the exit and the end time, also when the same end is reported again after a restart; a run still recorded as running when majhi starts is ended with its time. | `server/room/process-items.test.ts`: stays one item per run, takes its exit and end time, and survives a restart |  |
| 104i | Closing the last subtask of an incident (or a case, or any task a client chat is linked to) leaves the parent open: nothing is sent to the client, the captain is not woken to tell one, no report is made, and its room says once that the subtasks are done. | `server/chat/incident-close.test.ts`: is not done by its last subtask: the incident stays open, no client is told and no report is made |  |
| 104j | An incident close sends at most one report per chat, however many passes run and however its done time moves, and the report's times start no earlier than the incident's own open, not at an older watch incident it took over. | `server/chat/incident-close.test.ts`: sends one report, whatever the passes, and its time starts at the incident's own open |  |
| 104k | A reply's link to a message is kept only when the id is a message of that chat (a user id is not one): otherwise the reply goes with no link and does not fail. | `server/chat/rails.test.ts`: is dropped when the id is not a message of this chat, and the reply still goes |  |
| 104l | A helper in a case never messages the client, asks the owner or files a task (a client reply, a case card, a new task, the `ask` tool and a changing ssh command are each refused in code), and a second job is refused while the helper works. | `server/cases/replay.test.ts`: never messages the client, asks the owner or files a task, and a second helper is refused while one works |  |
| 104m | A case deploy is refused without a deploy path majhi knows or without passing checks, nothing moves when it is refused, the version it replaces is noted and kept on the deploy record, and the rollback puts it back once. | `server/cases/deploy.test.ts`: refuses without passing checks or a known deploy path, notes the version it replaces, and rolls back once |  |
| 104n | The replay where the fix needs code: a helper writes it on a branch of its own, the captain deploys it through the project's own deploy, reads the symptom, tells the client and closes the case, with zero owner cards and one task (the case), and the summary says what was deployed and which version it replaced. With the workspace's Fix switch at Ask me the captain's deploy is refused and nothing deploys. | `server/cases/replay.test.ts`: has a helper write it, deploys it, reads the symptom and closes, with no card and no task |  |
| 104o | A project's deploy path is read from its own CI files: the sample `acme-shop` (a build that names its image by the commit, a release with one target per client environment, a rollback, a GitLab file with a manual production job) gives one production environment per target with the runs that deploy it (build for the commit, then release with the built tag and the commit), the runs that put it back (the rollback workflow with the version and commit before, or the release itself when there is no rollback workflow), the file and line it was read from, the parts a change picks by folder, an environment that asks when nothing says which part changed, a build that takes its version as an input (majhi picks it, and the titles of its runs hold the versions built), the image its containers run, and a build that names its tag by the commit alone. | `server/deploy/discover.test.ts`: reads one environment per target with the runs that deploy and put it back, asks instead of guessing, and reads a GitLab job |  |
| 104p | A case deploy through the recipe of the project's CI, against a fake GitHub and a fake host: what the environment runs is read from its containers with a read command before anything is dispatched, majhi picks the next patch after the highest version built, the build is dispatched first (and once more one patch up when it fails), then the release with the built tag and the commit, only the parts the change touched are deployed, and the rollback dispatches the rollback workflow once with the recorded version and commit (a second rollback starts nothing). | `server/cases/deploy.test.ts`: picks the next version, reads what runs from the host, builds, releases the built tag, and goes back once |  |
| 104q | When what an environment runs now cannot be read, or two hosts could be its host, the deploy starts nothing and asks with one question; with the owner's answer it goes, and the host the owner picks is the one read and kept. In the replay the captain's two calls write exactly one Needs-you card, deploy nothing and the case stays open. | `server/cases/deploy.test.ts`: asks once, and starts nothing, when what an environment runs cannot be read or several hosts could be it; `server/cases/replay.test.ts`: refuses the deploy, asks the owner once with one card, deploys nothing, and keeps the case open |  |
| 104r | A code task of a project with checks does not start or wake its agent until the project's environment build ends: its line says "Preparing the project's environment (m:ss)" meanwhile. A failed build makes one room line (failing step, end of the log in a fence) and no card, the agent then starts without the environment, TASK.md says it failed, and the next task of the project does not build again. | `server/projectenv/gate.test.ts`: keeps the agent from starting until the project environment is ready, and a failed build makes one room line and starts it without |  |
| 104s | Every task of a project uses one environment: a second task whose install files are the same finds it ready and builds nothing. | `server/projectenv/gate.test.ts`: gives a second task of the project the same environment, with no second build |  |
| 104t | A project's GitLab pipeline (a manual deploy job per target with a confirmation that must equal the target, a version and parts, a build job per registry, a status job per target) gives one production environment per deploy job, with the recipe that plays it: `TARGET` from the job, `CONFIRM_TARGET` equal to it, the version bound to the build of the target's registry (read from the target's settings file the script sources), the parts and their folders, the image the containers run, the status last, and the rollback as the same job with the version before. Without the settings files it asks which registry, once, and offers the builds. | `server/deploy/discover.test.ts`: reads each GitLab target as a manual job with its confirmation, version and parts, linked to the build of its registry |  |
| 104u | A case deploy of a project with three production targets, against a fake GitLab and fake hosts: the merged commit is pushed to the GitLab remote first (a fast-forward, once), then each target in order (the case's own first) builds its registry's image (once per registry) and deploys with its confirmation and version and is checked by its status, with the version it replaces read from its host and noted right before its own step; when the second target's deploy fails only that target is played again with the version before, in a pipeline of its own, the first stays and the third is never touched. | `server/cases/deploy.test.ts`: pushes the commit to GitLab first, then builds and deploys each target in order, each with the version it replaces recorded before it; puts only the target that failed back to its version, and stops before the next one |  |

## Cut that you may want back

These have a real test today and I did not give them a guarantee of their own, because they sit outside the four categories or repeat a kept guarantee at another layer. Say the word and any of them becomes a guarantee with that one test. Cases listed under 'Same rule, separate code' are the ones the kept test will not catch if they break.

**Outside the four categories (strict reading)**
- Deploy flow: `server/deploy/service.test.ts`: starts a target and commit once, however many ask | rolls back to the earlier commit, opens an incident and tells the owner when the run fails | does not deploy production before staging is live. Also `server/deploy/rails.test.ts`: never sets a tier to staging, not even on an environment that is production (this one is authority; I would keep it first).
- Incidents: `server/incident/engine.test.ts`: closes the task only when the fix is live and the watch stayed green for the soak; `packages/shared/src/incident.test.ts`: needs a shipped fix AND a green watch for the soak to resolve.
- Findings: `server/findings/findings.test.ts`: reports the same finding once | allows the moves of the table and refuses the rest.
- Connection and sign-in states: `server/connections/health.test.ts`: never shows connected without a pass; `server/gitConnect/flows.test.ts`: moves pending to exactly one end state and never back.
- Prompt injection: `server/handoff/service.test.ts`: text in the diff or the brief that tells the reviewer to approve changes nothing; `server/chat/settings.test.ts`: holds an injection for the owner and never wakes the captain. CLAUDE.md lists this as a never-happen, so I would add the first one.
- Supply chain: `server/tools/installer.test.ts`: installs nothing when the checksum does not match. The helper's own are rows of 46k.
- Skills and MCP installs: `server/skills/skills.test.ts`: installs only after a confirmed second call; `server/installs/installs.test.ts`: asks once, installs an MCP server and turns it on for that agent only after approval.
- Client identity: `server/chat/slack/send-as-me.test.ts`: never posts a Me chat's reply as the bot when the owner's token is refused; `server/mrs/no-internal-ids.test.ts`: keeps the task id and checkpoints out of the branch, commits, merge request and merge.
- Other secret outlets (same rule, separate code; only memory is kept as the sample sink): `server/decisions/log.test.ts`: never writes a detected secret; `server/admin/policy.test.ts`: hides secret-looking fields and strings; `server/chat/rails.test.ts` secret row is folded into #99; `server/handoff/exec.test.ts`: masks every secret.

**Same rule, separate code: the kept test will not catch a break in these**
- Git safety: `server/mrs/update-target.test.ts`: refuses when the local branch has commits the remote lacks; `server/mrs/multi-repo-ship.test.ts`: a conflict in one changed repo merges nothing anywhere | does not push the owner's own unpushed commits on the target; `server/captain/undo.test.ts`: refuses while the owner's checkout of the target holds uncommitted changes; `server/tasks/delete-after.test.ts` and `server/mrs/ship.test.ts`: refuses delete after while the worktree has uncommitted files; `server/tasks/folder-sweep.test.ts`: deletes nothing in a task with an uncommitted change to a tracked file | never follows or removes a symlink; `server/runs/checkpoint.test.ts`: leaves the owner's checkout alone; `server/git/locks.test.ts`: waits out a lock someone else holds and never removes it; `server/git/worktrees.test.ts`: keeps a live task's entry when its folder is out of reach; `server/tasks/change-branch.test.ts`: never touches a worktree with uncommitted changes; `server/runs/attribution.test.ts`: refuses a raw update-ref from a run of another task.
- Workspace isolation at other stores: `server/findings/findings.test.ts`: scopes lists, reads and changes to the lane's workspace; `server/captain/tell.test.ts`: refuses another workspace's task, and a task of no workspace, from a lane; `server/tasks/read-mounts.test.ts`: refuses another org's project; `server/runs/package-cache.test.ts`: keeps two workspaces apart; `server/deploy/credentials.test.ts`: come from the project's own workspace; `server/mrs/route.test.ts`: falls back to https without an account when nothing else fits; `server/tasks/agents.test.ts`: lets org agents work in their own org only; `server/gitConnect/signIn.test.ts`: polls, slows down when told, checks the user and saves the token for the named workspace only | a cancelled flow never saves; `server/connect/connect.test.ts`: two workspaces connect the same service as different accounts | a reconnect that signs in as another account changes nothing; `server/chat/unlink.test.ts`: stops triage after an unlink | discards the replies that waited for the owner.
- Host helper secrets: rows of 46h to 46k. Still untested in Go, on purpose: a failed CLI gives a fixed sentence (`clitools/gitlogin.go`, `tools.go`), and disk hygiene removes only majhi's own labelled images (`update/hygiene.go`, selected by label from typed rows).
- Auth and sandbox variants: `server/runner/isolation.test.ts`: lets a runner reach only /mcp; `server/room/socket.test.ts` (folded as a row of the cross-site guarantee); `server/cli/genOverride.test.ts`: never mounts a source without the .pub suffix; `server/containers/compose-run.test.ts`: pulls only images the owner allowed or the task built; `server/containers/task-docker.http.test.ts`: keeps a container to its task; `server/containers/env-file.test.ts`: reads a file of the task, and refuses one outside it; `server/uploads/attach.test.ts` cross-org row.
- Money variants: `server/decisions/uses/uses.test.ts`: never reaches a paid model when Laya is down | counts the answers of the day in the log and stops at the cap; `server/wiki/service.test.ts` and `server/wiki/ask.test.ts` budget refusals; `server/projectcard/service.test.ts`: limits the model's own passes per day; `server/handoff/service.test.ts`: the monthly ceiling and a model that fails leave the free notes; `server/chat/settings.test.ts`: holds replies once the day's limit is sent; `server/containers/service.test.ts`: stops at containers.per_task | reserves a global slot before concurrent starts; `server/processes/manager.test.ts`: allows five running processes per task; `server/budgets/thresholds.test.ts`: rolls over at local midnight on Monday; `server/runs/turn-limits.test.ts` and `server/rooms/idle-watch.test.ts` (the kept loop guard is `captain/loop-guard`); `packages/shared/src/usage.test.ts`: never prices a newer model with an older family's row; `packages/acp/src/turn-usage.test.ts`: turns running totals into per-turn deltas.

## Delete

### Delete entirely (298 files)

- `host/`: the TypeScript tests went with the TypeScript helper (step 2c).
- `server/accounts/`: limit.test.ts, sign-in.test.ts
- `server/admin/`: agents-through-approvals.test.ts, clipboard-copy.test.ts, fetch-secret.test.ts, policy-owner.test.ts
- `server/agenda/`: brief.test.ts, overnight.test.ts, service.test.ts
- `server/agents/`: commands.test.ts, file.test.ts, rename.test.ts
- `server/automation/`: migrate.test.ts, scheduler.test.ts
- `server/autonomy/`: answer-rules.test.ts, approvals.test.ts, budget-asks.test.ts, live-state.test.ts, repo-rule.test.ts, resume-signin.test.ts, resume.test.ts, service.test.ts, waits.test.ts
- `server/`: background.test.ts, env.test.ts
- `server/captain/`: deploy-chore.test.ts, lane-gate.test.ts, lanes-account.test.ts, memory.test.ts, merge-card-mr.test.ts, one-home.test.ts, rules.test.ts, runner.test.ts, ship-mr.test.ts, tell.test.ts, undo.test.ts, upkeep.test.ts
- `server/chat/`: contacts.test.ts, format.test.ts, incidents.test.ts, ingest.test.ts, retry-and-make-task.test.ts, settings.test.ts, unlink.test.ts
- `server/chat/slack/`: adapter.test.ts, channels.test.ts, send-as-me.test.ts
- `server/chat/telegram/`: adapter.test.ts
- `server/ci/`: safe.test.ts
- `server/cli/`: genOverride.test.ts
- `server/config/`: load.test.ts, migrate-levels.test.ts, migrate-org-merge.test.ts, migrate-remote-routes.test.ts, migrate-slack-chat.test.ts, settings.test.ts, undo.test.ts
- `server/connect/`: apps.test.ts, mcp-url.test.ts, probe-refusal.test.ts, provider.test.ts, verified-mcp.test.ts, verified-provider.test.ts
- `server/connections/`: gate-flow.test.ts, git-link.test.ts, health.test.ts, host-service.test.ts, inject.test.ts, kubeconfig.test.ts, live-host.test.ts, read-only.test.ts, service.test.ts, tester.test.ts
- `server/containers/`: commands.test.ts, compose.test.ts, docker-env.test.ts, dockerfile-images.test.ts, env-file.test.ts, guard.test.ts, image-check-failure.test.ts, prune.test.ts, task-docker.http.test.ts, task-docker.test.ts
- `server/decisions/`: calibration.test.ts, decisions.test.ts, integration.test.ts, labels.test.ts, log.test.ts, refit.test.ts, shadow.test.ts
- `server/decisions/uses/`: injection.test.ts, uses.test.ts
- `server/deploy/`: bitbucket.test.ts, credentials.test.ts, gitlab.test.ts, plan.test.ts, rails.test.ts, service.test.ts, verify.test.ts
- `server/export/`: export.test.ts
- `server/findings/`: findings.test.ts, followups.test.ts, triage.test.ts
- `server/git/`: diff.test.ts, keyOwners.test.ts, locks.test.ts, no-prune.test.ts, outgoing.test.ts, refs.test.ts, repo-config.test.ts, sync-branch.test.ts, worktrees.test.ts
- `server/gitConnect/`: check.test.ts, cloneJobs.test.ts, flows.test.ts, integration.test.ts, paths.test.ts, signIn.test.ts, tokens.test.ts
- `server/handoff/`: checks-ci.test.ts, exec.test.ts, home-checks.test.ts, logs.test.ts, service.test.ts, uncommitted.test.ts
- `server/health/`: ops.integration.test.ts
- `server/http/`: taskRepoFiles.test.ts
- `server/inbox/`: batch.test.ts, derived.test.ts
- `server/incident/`: engine.test.ts
- `server/installs/`: installs.test.ts
- `server/machine/`: busy.test.ts
- `server/mcp-servers/`: mcp-servers.test.ts
- `server/memory/`: chats.test.ts, curation.test.ts, escalate.test.ts, housekeeper.test.ts, placement.test.ts, read-only.test.ts, records.test.ts
- `server/mrs/`: flow.test.ts, multi-repo-ship.test.ts, no-internal-ids.test.ts, order.test.ts, policy.test.ts, project-fetch.test.ts, route.test.ts, ship-queue.test.ts, update-target.test.ts
- `server/mrs/hosts/`: hosts.test.ts, reviews.test.ts
- `server/notices/`: notices.test.ts
- `server/ops/`: agent-watches.test.ts, script.test.ts, self.test.ts, watch.test.ts
- `server/ops/anything/`: anything.test.ts, db-drivers.test.ts, script-watch.test.ts, watch-action.test.ts, watch-events.test.ts
- `server/orgs/`: gitAccount.test.ts, gitLogin.test.ts, keys.test.ts, private.test.ts, rename.test.ts
- `server/playbooks/`: custom.test.ts, goals.test.ts, outbound.test.ts, outcomes.test.ts, script.test.ts
- `server/processes/`: handoff-tools.test.ts, manager.test.ts, tasks.test.ts
- `server/projectcard/`: scanner.test.ts, service.test.ts
- `server/projects/`: commands.test.ts, protected.test.ts
- `server/reader/`: tools.test.ts
- `server/room/`: socket.test.ts
- `server/rooms/`: gating.test.ts, idle-watch.test.ts, mcp.test.ts, team.test.ts
- `server/runner/`: isolation.test.ts, network.test.ts
- `server/runs/`: captain-slot.test.ts, checkpoint.test.ts, mounts.test.ts, owner-queue.test.ts, package-cache.test.ts, permissions.test.ts, serena.test.ts, turn-limits.test.ts
- `server/secrets/`: backup.test.ts
- `server/ship/`: lines.test.ts, plan.test.ts
- `server/skills/`: migrate.test.ts, skills.test.ts, zip.test.ts
- `server/store/`: audit.test.ts, chat-origin-migration.test.ts, day-caps-migration.test.ts, paused-by-migration.test.ts, perf-migration.test.ts, retention.test.ts, retire-removed-migration.test.ts, slack-ids-migration.test.ts, task-events-migration.test.ts, task-lines-migration.test.ts, tolerant.test.ts, type-origin-migration.test.ts, wiki-rename.test.ts
- `server/system/`: removed-folders.test.ts, safety-backup.test.ts
- `server/tasks/`: agents.test.ts, branch-naming.test.ts, change-branch.test.ts, chat-link.test.ts, create-once.test.ts, delete-after.test.ts, folder-sweep.test.ts, one-conversation.test.ts, orchestrate.test.ts, pending-ship.test.ts, picked-repos.test.ts, planning.test.ts, queued-merge.test.ts, read-mounts.test.ts, relations.test.ts, rename-by-name.test.ts, report.test.ts, resume-signed-in.test.ts, set-lead.test.ts, ship-plan.test.ts, staffing.test.ts, start-runs.test.ts, task-links.test.ts, task-names.test.ts, type-origin.test.ts
- `server/tasks/lifecycle/`: illegal-moves.test.ts
- `server/terminal/`: task-terminal.test.ts, terminal.test.ts
- `server/tools/`: installer.test.ts
- `server/uploads/`: store.test.ts
- `server/usage/`: recorder.test.ts
- `server/wiki/facts/`: extract.test.ts
- `server/wiki/`: service.test.ts, tools.test.ts, workspace.test.ts
- `server/wiki/writer/`: check.test.ts, write.test.ts
- `e2e/`: phase1.spec.ts, phase2b-boss.spec.ts, phase7-limits.spec.ts
- `packages/acp/src/`: home.test.ts, limit-failure.test.ts, mcp-env.test.ts, session.test.ts, tool-process.test.ts, turn-usage.test.ts
- `packages/shared/src/`: actor.test.ts, approval-groups.test.ts, connection-health.test.ts, connections.test.ts, decisions.test.ts, deploy.test.ts, incident.test.ts, media.test.ts, paths.test.ts, queue.test.ts, self-host.test.ts, task-type.test.ts, usage.test.ts
- `packages/shared/src/lifecycle/`: blocker.test.ts, stored.test.ts

The whole `e2e/` folder of specs goes: `e2e/phase1.spec.ts`, `e2e/phase2b-boss.spec.ts`, `e2e/phase7-limits.spec.ts`. `phase1` and `phase2b-boss` repeat unit tests #1 and #2. `phase7-limits` tests the old `fallback` field through the browser; `server/tasks/crew.test.ts` ('is replaced by the worker with the most headroom...') tests the same hand-off at the task boundary with the fake agent, so it is not the sole test (#80).

### Trim to the listed titles (90 files stay)

Every other test in these files is deleted. Files where every case stays are marked `(unchanged)`.

- `server/accounts/commands.test.ts` (1 of 3 stay)
    - stores an API key encrypted, and it never reaches majhi.yaml, git, output or the cache
- `server/admin/boss.test.ts` (1 of 7 stay)
    - becomes a card with a plain diff, and changes nothing
- `server/admin/mcp.test.ts` (unchanged)
- `server/admin/owner-asked.test.ts` (1 of 2 stay)
    - has no push in its merge tools, and a push sent anyway is refused
- `server/admin/policy.test.ts` (1 of 5 stay)
    - keeps a destructive command on confirm whatever the policy says
- `server/autonomy/authority-set.test.ts` (unchanged)
- `server/autonomy/cap.test.ts` (unchanged)
- `server/autonomy/pick.test.ts` (1 of 4 stay)
    - are left alone by the captain, show in tasks.list, and only the owner sets the mark
- `server/autonomy/policy.test.ts` (1 of 18 stay)
    - merges at Full only
- `server/autonomy/slots.test.ts` (1 of 2 stay)
    - refuses the captain's start with one line when no slot is free, starts it when one is, and never holds the owner's start
- `server/autonomy/spend.test.ts` (1 of 5 stay)
    - holds an org whose cap is reached, holds everything at the day cap, and lifts when the cap is raised
- `server/autonomy/switch.test.ts` (1 of 3 stay)
    - Stop everything halts captain work: no lane, no tools, no start, whatever Auto-pilot says
- `server/backup/backup.test.ts` (3 of 17 stay)
    - leaves no file that looks like a backup when the disk fills mid-write, and keeps the earlier ones
    - changes nothing when the backup is damaged
    - blocks migration when its safety backup cannot be written
- `server/backup/retention.test.ts` (1 of 6 stay)
    - never deletes the only good backup, even when damaged ones are newer and the limits are zero
- `server/backup/swap.test.ts` (1 of 4 stay)
    - leaves the old data exactly as it was when any single step fails
- `server/backup/updateDatabases.test.ts` (1 of 4 stay)
    - restores both databases after destructive migrations, including WAL writes
- `server/browsers/service.test.ts` (unchanged)
- `server/budgets/limit.test.ts` (1 of 2 stay)
    - pauses the runs of the org that is over, and not other orgs
- `server/budgets/monitor.test.ts` (1 of 8 stay)
    - fires 80 and then 100, each once, and runs the 100% action once
- `server/budgets/thresholds.test.ts` (1 of 3 stay)
    - counts input, output and cache write, and leaves cache reads and reasoning out
- `server/captain/keys.test.ts` (1 of 9 stay)
    - lets two connections to one database race: one wins on the unique key
- `server/captain/lane-reads.test.ts` (1 of 2 stay)
    - never show another workspace, for every read command an agent may call
- `server/captain/loop-guard.test.ts` (1 of 5 stay)
    - pauses a task after three answers with no progress, and not before
- `server/captain/ship-decision.test.ts` (1 of 5 stay)
    - never merges when a guard fails, whatever the level says
- `server/chat/isolation.test.ts` (1 of 2 stay)
    - is not read, listed, found or described to a captain lane of this workspace
- `server/chat/rails.test.ts` (1 of 10 stay)
    - never goes out under Tell Ask me, however clear it is
- `server/config/service.test.ts` (1 of 3 stay)
    - refuses to rewrite a file with YAML errors
- `server/connect/cli.test.ts` (1 of 4 stay)
    - gives a run in workspace A only A's folders and the tool's own variables
- `server/connect/connect.test.ts` (1 of 15 stay)
    - refuses a replayed answer: the state works once
- `server/connect/e2e.test.ts` (1 of 2 stay)
    - never puts the refresh token or the access token in a run's environment or mounts
- `server/connect/self-host.test.ts` (1 of 2 stay)
    - never allows a metadata address, not by name and not by number, even when confirmed
- `server/connect/token-connect.test.ts` (1 of 6 stay)
    - the token goes only in an Authorization header, to Linear's host, with no redirect followed, and never into a URL, a log or a state
- `server/connections/access.test.ts` (1 of 6 stay)
    - never gives an org agent another org's connection, even working in that org
- `server/connections/commands.test.ts` (1 of 5 stay)
    - keeps an agent from loosening the gate, even without a secret
- `server/connections/gate.test.ts` (2 of 22 stay)
    - reads inside $(...), backticks, sh -c, eval, watch, xargs and find -exec
    - asks for kubectl delete even when allow holds the exact command
- `server/connections/redact.test.ts` (1 of 2 stay)
    - never reach the room, the audit log, a process's output or the report
- `server/containers/args.test.ts` (1 of 37 stay)
    - never mounts anything of the host, names the socket, ~/.majhi, the key or ~/.ssh
- `server/containers/compose-run.test.ts` (1 of 29 stay)
    - fails closed: no build runs when the guard cannot be set
- `server/containers/environment.test.ts` (2 of 6 stay)
    - share no builder, network, container, volume or image
    - is the only kind `docker compose down -v` removes: the project's shared volume stays
- `server/containers/network.docker.test.ts` (1 of 8 stay)
    - closes the builder's network: RUN steps reach the public internet and nothing private
- `server/containers/service.test.ts` (1 of 13 stay)
    - refuses an image the owner has not allowed, and asks through a card when it can
- `server/editor/allowed.test.ts` (1 of 5 stay)
    - refuses a path outside the roots, including one that climbs out with ..
- `server/fs.test.ts` (1 of 2 stay)
    - path containment (describe)
- `server/git/git.test.ts` (1 of 4 stay)
    - runs none of the commands a repo's config and attributes name
- `server/git/merge.test.ts` (1 of 7 stay)
    - on a conflict changes neither branch and leaves the checkout clean
- `server/handoff/merge-gate.test.ts` (1 of 5 stay)
    - refuses a failed check, cannot be overridden by an agent or a wrong sha, and lets the owner confirm the head
- `server/handoff/secret-scan.test.ts` (1 of 6 stay)
    - names the file, line and rule, and masks the value, so a block is never unexplained
- `server/host/routes.test.ts` (1 of 3 stay)
    - requires the token from host.token
- `server/http/app.test.ts` (1 of 5 stay)
    - blocks commands from other websites and unrelated loopback pages
- `server/http/taskFiles.test.ts` (1 of 4 stay)
    - refuses dot names, escapes and symlinks that leave the folder
- `server/http/wikiFiles.test.ts` (1 of 3 stay)
    - refuses .., absolute paths, symlinks out of the export and backslashes
- `server/inbox/inbox.test.ts` (1 of 9 stay)
    - answers only for the owner: an agent, the captain too, is refused before anything runs
- `server/memory/integration.test.ts` (1 of 2 stay)
    - shows an agent only global, its org and that org's projects, and never another org's facts
- `server/memory/memory.test.ts` (1 of 4 stay)
    - refuses facts that hold a secret
- `server/mrs/push.test.ts` (1 of 3 stay)
    - never forces: a diverged branch is refused
- `server/mrs/ship.test.ts` (1 of 3 stay)
    - refuses to merge and push when the remote branch moved, and changes nothing
- `server/ops/phone.test.ts` (2 of 12 stay)
    - refuses a changed byte, a link that names another reference or action, a forged payload, and a token from another decision
    - approves once, and a replay of the same link is refused
- `server/outcomes/outcomes.test.ts` (1 of 7 stay)
    - holds new starts once spend reaches it, never a turn already running, and asks as a Money decision
- `server/playbooks/service.test.ts` (1 of 12 stay)
    - ends a run that reached its token budget: the turn is cancelled, the run is capped, it backs off
- `server/rooms/access.test.ts` (1 of 4 stay)
    - belong to one task and agent: another task's token never resolves to this one
- `server/rooms/ask.test.ts` (1 of 2 stay)
    - rejects answering twice on the same card
- `server/runs/attribution.test.ts` (1 of 8 stay)
    - cannot move, delete or commit on the owner's branches
- `server/runs/lane-account.test.ts` (1 of 4 stay)
    - refuses another workspace's account, whatever the lane asks
- `server/runs/limits.test.ts` (2 of 14 stay)
    - never lets the machine-wide run total exceed agents_max
    - queues a third start on one account, shows its place, and starts it when a slot frees
- `server/runs/manager.test.ts` (1 of 3 stay)
    - never asks for what stays inside the task, and asks for what leaves it
- `server/runs/permission-flow.test.ts` (2 of 8 stay)
    - %s asks at Ask me: %s, at Routine: %s, at Full: %s
    - keeps one rule for the workspace and the kind, and covers the next task there and no other workspace
- `server/runs/resume.test.ts` (1 of 2 stay)
    - continues a cut turn after a restart, with its work and a checkpoint
- `server/secrets/restore.test.ts` (1 of 8 stay)
    - never replaces a key file that works
- `server/secrets/service.test.ts` (1 of 4 stay)
    - replaces secrets in room.send before the agent or the room see them
- `server/secrets/store.test.ts` (1 of 3 stay)
    - round trips values and keeps them out of the file
- `server/store/store.test.ts` (2 of 7 stay)
    - rolls a failing migration back and does not record it
    - adds the column to an older database and keeps its rows readable
- `server/tasks/cards.test.ts` (unchanged)
- `server/tasks/cleanup.test.ts` (2 of 20 stay)
    - keeps a worktree with uncommitted changes, its branch and its files
    - keeps the branch of a merged MR when it holds commits that were never pushed
- `server/tasks/commands.test.ts` (unchanged)
- `server/tasks/crew.test.ts` (3 of 6 stay)
    - is replaced by the worker with the most headroom, who carries on with the plan
    - pauses the lowest-priority running task for an urgent one, which resumes through the line without a second run
    - pauses at the checkpoint with the exact fix, then resumes by itself on recovery, once
- `server/tasks/gate.test.ts` (2 of 6 stay)
    - starts every origin under the running cap and queues it at and over the cap
    - makes a resume wait in line like a start when the cap is full
- `server/tasks/lifecycle/apply.test.ts` (1 of 8 stay)
    - drains after a crash and a restart, and only once
- `server/tasks/shipped.test.ts` (1 of 4 stay)
    - refuses the owner with what is unshipped, and closes once the owner confirms
- `server/uploads/attach.test.ts` (1 of 8 stay)
    - refuses a file outside the task folder, also through a symlink
- `server/usage/integration.test.ts` (unchanged)
- `server/wiki/ask.test.ts` (1 of 4 stay)
    - never returns a source or page from another workspace, or from a project outside the scope
- `packages/acp/src/env.test.ts` (1 of 5 stay)
    - never copies from process.env
- `packages/acp/src/runner/docker.test.ts` (1 of 26 stay)
    - mounts only the task folder, the repo's .git (config and hooks read-only) and the run's own account home
- `packages/acp/src/runner/netguard.test.ts` (1 of 8 stay)
    - refuses every private range, the LAN, the VPN and link-local ones included
- `packages/shared/src/lifecycle/hold.test.ts` (1 of 15 stay)
    - account-limit clears when the window reset, and never for a signed-out account
- `packages/shared/src/lifecycle/transition.test.ts` (4 of 28 stay)
    - transition table (describe)
    - illegal transitions are refused (describe)
    - by %s is allowed exactly when the table lists them
    - no held task can be started or sent back, from any reachable state
- `packages/shared/src/risk-kinds.test.ts` (1 of 5 stay)
    - never lets secrets, a client's server, deleting outside, going over budget, a new image or the unknown through, at any level
- `packages/shared/src/secrets-detect.test.ts` (1 of 5 stay)
    - finds a long random token and a value after a keyword

## Projected

- Test files: 388 to 90 (delete 298).
- Test cases (`it`/`test` calls): 1841 to about 104. Each guarantee is one `it`/`test` call (a table counts once). 26 guarantees list rows: about 8 are tables today, the rest fold 2 to 5 existing cases into one `it.each`. Plus one opt-in real-Docker case outside the default run.
- Vitest-reported runs (tables expanded): about 2,300 now (2658 on the 400-file run, scaled to 388 files and 1841 cases) to roughly 280 to 340. The big expanders that stay: the transition table in `shared/lifecycle/transition.test.ts` (~50 legal rows plus the illegal event-by-status grid, ~100 to 150 runs together), the 13-row permission table, the 18-row address table, the 8-row path table, and the lifter table.
- Time: the last full run took 212 s, 40% of it importing modules per file. With 90 files and no heavy multi-world suites, expect roughly 25 to 50 s. Import time falls with file count faster than case count.
- e2e specs that stay: none (0 of 3). The opt-in real-Docker file `server/containers/network.docker.test.ts` (needs MAJHI_DOCKER_TESTS=1, skipped by default) keeps one case, 'closes the builder's network: RUN steps reach the public internet and nothing private', as the only proof against a real daemon; its other seven cases go. It is not counted in the 100.

## Guarantees with no existing test (flagged, nothing invented)

- Config writes are atomic (`apps/server/src/config/write.ts` writes a temp file and renames it) but no test kills a write halfway or checks that the old file survives. #66 covers broken YAML only.
- Browser container egress: `server/browsers/service.test.ts` has one test (never shared between workspaces). Nothing tests that a browser container cannot reach private ranges.
- Nothing else found without a test. Every other guarantee above has one test today.
| 104t | The tasks folder is named `.majhi` like majhi's home, but a command that reads inside it (another task's folder, its report, its repo) is a plain read and never asks; majhi's home (`~/.majhi`) and login files (`.ssh`, keys) still count as secrets, inside the tasks folder too. | `server/runs/shell-risk.test.ts` |  |
| 104u | A permission card whose prompt went with an ended or replaced run (a fresh session) closes when the agent's next run starts, and a click on such a card closes it instead of answering. | `server/runs/permission-flow.test.ts`: closes when the agent's next run starts |  |
