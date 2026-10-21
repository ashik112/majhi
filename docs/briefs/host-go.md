# Brief: the host helper in Go (step 2c)

Owner approved, 2026-10-19 (workflow reset, step 2c), go-ahead 2026-10-21. One branch (`feat/host-go`), one worktree, one builder.

## Why

The host helper (`apps/host`, about 8.4k lines of TypeScript on Node) runs on the owner's computer, outside Docker. It does what a container cannot: folders, git with the owner's logins, the ssh agent, the keyring, CLI sign-ins, notifications, the editor, the clipboard, updates, disk cleanup, Laya and start at login. Today the owner's machine needs Node 20+ just for it, and it holds about 50 MB of memory. The goal is one small Go binary with no runtime to install. It must behave exactly as the Node helper does. The server and the web app do not change.

## Read first

- `apps/host/src/main.ts`, `client.ts`, `jobs.ts`: the lifecycle, the poll loop and the job dispatch.
- `packages/shared/src/host.ts`: the protocol (`HostJobSchema`, `HostResultSchemas`, `HostReplySchema`, `HostProgressSchema`, `HostInfo`), plus the other shared schemas the helper uses (`cli-tools.ts`, `remote-repos.ts`, `git-signin.ts`, `machine.ts`, `decisions.ts`, `settings.ts`, `release-package.ts`, `paths.ts`, `UpdateStatusSchema`).
- `apps/server/src/host/` (`routes.ts`, `link.ts`, `token.ts`): the server side, which validates every result with zod.
- `scripts/host.sh`, `scripts/up.sh`, `scripts/lib.sh`, `install.sh`, `Dockerfile`: how the helper is built, copied out of the image and installed as a LaunchAgent or systemd user unit.
- The inventory below.

## Inventory (from the 2026-10-21 survey)

- **Protocol.** These are all the job methods, each with its timeout on the server side:
  - Folders and machine: `listDirs`, `fs.mkdir`, `suggestRoots`, `machine.read`, `remount`.
  - SSH: `ssh.reload`, `ssh.unlock`, `ssh.keygen`.
  - Updates: `version.changes`, `update`, `restart`.
  - Laya: `decisions.status`, `decisions.install`, `decide`.
  - Desktop: `editor.open`, `notify`, `notify.openSettings`, `openUrl`, `clipboard.copy`.
  - Git: `git.logins`, `git.token`, `git.credential`, `git.push`, `git.clone` (with clone progress), `git.lsRemote`, `git.cliLogin` and `git.cliLoginCancel` (with login progress).
  - CLI sign-ins: `cli.login`, `cli.loginCancel`, `cli.check`, `cli.logout`.
  - Secrets key: `secretsKey.save`, `secretsKey.restore`.
- **Polling.** `POST /api/host/poll` sends the `x-majhi-host` header, which holds `HostInfo` as JSON with non-ASCII escaped. The server answers 200 with a job or 204 after 25 s. The client timeout is 35 s. Backoff starts at 250 ms and doubles to 5 s. Jobs run concurrently. Replies go to `POST /api/host/reply`, progress to `POST /api/host/progress`. The token is `<MAJHI_HOME>/host.token`, sent as `Authorization: Bearer`. It is read again before every request.
- **Per OS.** macOS, Linux and WSL2 today, through the `Platform` in `apps/host/src/platform/`: keyring (`security` or `secret-tool`), ssh agent and forwarder, notifier (the Swift `majhi.app` built with swiftc, or terminal-notifier pinned by SHA-256; `notify-send`; a Windows toast through `powershell.exe`), editor, starting Docker, folder rules, clipboard and URLs.
- **Commands** go through `runCommand.ts`: no shell, an exact environment, stdin closed, a new process group killed as a whole on timeout, and output capped at 64 KB.
- **Security logic to keep exactly.**
  - `gitGuard.ts`: neutralised hooks, fsmonitor, ext protocol, proxy and filter drivers; pinned upload-pack and receive-pack; the push guard (https only, no signing, the repo's askpass and alternateRefsCommand replaced, no `insteadOf` around the push URL, plain branch names, no force, no delete).
  - Git tokens in a mode 600 file in a mode 700 folder for each job, read by majhi's askpass and removed afterwards; never in argv, env, a URL or a log.
  - Clone into a temporary sibling, then rename into place.
  - CLI sign-ins in isolated profiles; a new profile replaces the old one only after its check passes.
  - `keyBackup.ts` and `keyRestore.ts`: the age identity, its fingerprint, never replacing a different key, the `.old-<UTC>` move.
  - `durableFile.ts`: tmp with `wx`, fsync, rename, fsync of the folder.
  - `update.ts` with `updateJournal.ts`: the transaction with phases `prepared`, `snapshotting`, `starting` and `committed`, recovery at start, and rollback.
  - `download.ts`: https only, size and time caps, SHA-256 pins.

## What to build

1. **A Go module at `apps/host`**, replacing the TypeScript there in the same branch. Use the newest stable Go (check the tag on Docker Hub; do not guess) and as few dependencies as possible. Use `filippo.io/age` for the age identity and `secrets.age` checks, and a YAML parser for gh and glab config. Write the rest with the standard library.
   - One package per area: protocol, client, jobs, git, ssh, keyring, notify, update, laya, platform.
   - Same environment variables, same files, same modes and same log file as the Node helper.
   - `py/layad.py` stays as it is.
2. **The protocol stays byte-compatible.** Go types mirror the zod schemas of `packages/shared/src/host.ts`.
   - **One contract test** checks the Go side against the zod schemas themselves, which stay the single source of truth. For example: a vitest test runs the Go binary against a fake server, sends each job method, and parses every reply with `HostResultSchemas[method]` and `HostReplySchema`. It also parses the `x-majhi-host` header with the `HostInfo` schema.
   - Each method uses a fake platform, so the test touches no real keyring, git remote or Docker.
   - Any schema mismatch fails the test.
3. **Build and ship.**
   - The `Dockerfile` cross-compiles the binary for darwin and linux, on amd64 and arm64, in a Go build stage. Add windows/amd64 and windows/arm64 now, even though nothing runs it yet.
   - The image holds the binaries at a known path, where `scripts/host.sh` copies the right one out with `docker cp`, as it does with `majhi-host.mjs` today. `update` replaces the binary the same way and exits for the service manager to restart it.
   - On macOS, sign the binary ad hoc with `codesign -s -`, like the notifier, when `codesign` is there. Developer ID signing needs the owner's certificate, so record it as a later step.
   - `scripts/host.sh` and `scripts/lib.sh` stop looking for Node for the helper. The LaunchAgent and the systemd unit run the binary.
4. **Windows native is not in this branch.** The binary builds for Windows, and `detectOs` still refuses `win32` with today's message. Record in DECISIONS what Windows native will need (askpass, process groups, file modes, services).
5. **Delete the TypeScript helper** once the Go one passes the contract test and the walk. Remove its build from `package.json`, the workspace and the Dockerfile. Nothing may still refer to `majhi-host.mjs`.

## Tests (only these; each a row in `docs/briefs/test-guarantees.md`)

Keep or restore one Go test for each guarantee the helper holds. Several rows point at TypeScript tests that were deleted; give them Go tests:

- #4: a git token is never in argv, env, a URL or a log, and its folder is gone after the job.
- #54: an update goes back to the previous version with the reason when the new one does not start, including recovery after an interrupted update at start.
- The git push guard: no force, no delete, https only, the repo's own hooks, askpass, `insteadOf` and filter drivers ignored.
- Release and download checks: a checksum mismatch is refused, and so is a terminal-notifier binary whose SHA-256 differs.
- The keyring: a secret never on a command line, and a different key already there is never replaced.
- The ssh askpass folder is removed after the job.
- Durable writes and the update journal: a crash between steps leaves the old file or the new one, never half of one.
- The contract test above.

Run `go vet`, `go test` and the touched vitest tests while working. Run the unit and e2e suites once, at the end.

## Done means

- A throwaway majhi (`e2e/start-server.ts`, never port 7070) with the Go helper instead of the Node one, built in a container. In a browser:
  - add a workspace root (folders listed, suggestions shown);
  - make a folder;
  - read machine facts;
  - send a notification (at least the call answers);
  - check git logins;
  - clone the fixture repo;
  - and the helper shows connected in Health with its version.
- Measure the binary's size and its idle memory against the Node helper's, and report both.
- `docs/DECISIONS.md` row, and `docs/PROGRESS.md` updated, including what only the owner can check: a real update on the Mac, a real push, the Keychain, notifications on the Mac, and a Linux machine.
- Do not install the binary as the owner's LaunchAgent. The lead installs it on the owner's Mac after review.

Rules: `CLAUDE.md`. Never touch the live majhi, `~/.majhi`, the owner's LaunchAgent or the owner's keyring. Generic sample names only. No regex for decisions: parse with real parsers and typed data (for example, check an age identity with `age.ParseX25519Identity`, not a pattern). Commit messages never mention an AI assistant. Never push or merge. One heavy job at a time: one docker build, one suite.
