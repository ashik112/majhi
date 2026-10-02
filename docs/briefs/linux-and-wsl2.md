# Brief: majhi on Linux, and on Windows through WSL2 (PRV-97)

The server, web, runners and agents already run in Docker. This work makes the host helper, `make up`, updates and the copy work on Linux and in WSL2, with macOS behaving exactly as before.

One task, one branch, one worktree. Three parts, built one after another, because a worktree takes one editor at a time:

1. **Host helper per OS** (`apps/host`): @private-claude-idz-pm.
2. **Install, update, compose and docs** (`scripts/`, `Makefile`, compose, `genOverride`, README, SPEC): @private-claude-idz-hardware.
3. **Copy, and the server and web per OS** (`apps/server`, `apps/web`, `packages/shared` text): @private-claude-idz-pm.

Then the lead reviews and does the Linux run. A part never edits a file another part owns without saying so in the room.

## Read first

- `CLAUDE.md`: never push or merge, no secrets in logs or fixtures, generic sample names only (`/home/owner`, `/Users/owner`, Acme), plain copy with no em dashes, tests only for crucial logic, typecheck plus touched tests only.
- SPEC 4.2 (host helper), 4.5 (Docker details, SSH forwarding), 5.12 (Laya).
- The contract, already on the branch:
  - `apps/host/src/platform/os.ts`: `detectOs`, `isWsl`, `toolDirs`.
  - `apps/host/src/platform/types.ts`: `Platform` and its parts (`Keyring`, `SshAgentPlatform`, `Notifier`, `EditorPlatform`, `DockerPlatform`, `FolderRules`), `SECRETS_KEY_ITEM`, `sshPassphraseItem`.
  - `packages/shared/src/host.ts`: `HostOs`, `KeyringState`, `keyringName`, `rootExample`, `HostInfo.os` and `HostInfo.keyring`, `hostOsOf`, `HOST_SSH_AGENT_SOCKET`, `sshUnlockCommand(key, os)`.

Change the contract only when a part cannot be built without it, and say so in the room.

## What each OS does

| | macOS (unchanged) | Linux | WSL2 |
|---|---|---|---|
| Start at login | LaunchAgent `dev.majhi.host` | systemd user unit `majhi-host.service`, enabled for `default.target` | Same unit, plus `loginctl enable-linger`, since WSL has no login of its own |
| Restart after `update` or `restart` | launchd `KeepAlive` | `Restart=always` | Same |
| Secrets key copy | login Keychain through `security` | Secret Service through `secret-tool` | Same as Linux; usually none is running |
| No keyring | n/a | `keyring: none` with the reason; the export is the only other copy | Same |
| SSH agent the helper loads keys into | its `SSH_AUTH_SOCK`, else `launchctl getenv` | its `SSH_AUTH_SOCK`, else `systemctl --user show-environment`, else majhi's own agent `~/.majhi/run/agent.sock` (`majhi-ssh-agent.service`) | Same as Linux |
| Agent socket in the server container | `/run/host-services/ssh-auth.sock` (Docker Desktop, OrbStack) mounted at `/run/ssh-agent.sock` | `~/.majhi/run/ssh-agent.sock`, a forwarder the helper serves, seen through the `~/.majhi` mount | Same as Linux |
| SSH key passphrases | Apple's `ssh-add --apple-use-keychain`, reloaded with `--apple-load-keychain` | kept in the keyring (`sshPassphraseItem`) and given to `ssh-add` through the throwaway askpass at each check; without a keyring, kept nowhere | Same as Linux |
| Notifications | terminal-notifier (clickable), else osascript | `notify-send` (not clickable) | Windows toast through `powershell.exe` (clickable); else in-app only |
| Open a URL | `open` | `xdg-open` | `wslview`, else `explorer.exe` |
| Open in editor | `code`/`cursor` CLI, the CLI inside the app, then `open -a` | `code`/`cursor` on PATH (with `/snap/bin`, `~/.local/bin`) | `code`/`cursor` on PATH, else the Windows install's `bin` under `/mnt/c/Users/<user>/AppData/Local/Programs` |
| Docker runtime | OrbStack, Docker Desktop | Docker Engine (rootful). Docker Desktop for Linux and rootless Docker: `make up` stops with a message | Docker Desktop with WSL integration on |
| Start Docker when down | `open -a OrbStack`, else Docker Desktop | nothing to start (a root service); the notification says `sudo systemctl enable --now docker` | starts `Docker Desktop.exe` through `powershell.exe` |
| Laya | native MLX on Apple silicon, else Docker CPU | Docker, CPU, or NVIDIA when the runtime has it | Docker Desktop, CPU, or NVIDIA when Windows has the driver |
| Folder defaults | `~/Work`; skips Library, Applications, Movies, Music, Pictures, Public, OrbStack | `~/code`; skips Music, Pictures, Public, Templates, Videos, snap | Same as Linux |

## Decisions and why

Record each in `docs/DECISIONS.md` in the part that builds it (Part 2 writes the install and compose ones, Part 1 the helper ones).

1. **The agent socket moves out of the base compose file into the generated override.** On Docker Engine a missing bind source becomes a root-owned folder, and a socket bind-mounted as a file goes stale when its agent restarts. So `docker-compose.yml` loses `SSH_AUTH_SOCK` and the agent volume, and `renderOverride` adds them from `MAJHI_SSH_AGENT`:
   - unset or empty: `/run/host-services/ssh-auth.sock`, as today, so an older helper that runs the first update to this version keeps macOS working;
   - a path under `MAJHI_HOME`: only `SSH_AUTH_SOCK: <path>`, since the container already sees it through the `~/.majhi` mount;
   - `off`: no agent at all;
   - any other absolute path: the same short-form volume `<path>:/run/ssh-agent.sock` and `SSH_AUTH_SOCK: /run/ssh-agent.sock` as today.
   `make up` sets `MAJHI_SSH_AGENT` per OS (an old `SSH_AGENT_SOCK` still wins on macOS), and the helper sets it in its compose env from `platform.sshAgent.composeSocket` unless its environment already has one. `gen-override` gets it with `-e MAJHI_SSH_AGENT` in both the Makefile and `remount.ts`.
2. **On Linux and WSL2 the helper serves a fixed socket and forwards it.** `~/.majhi/run/ssh-agent.sock` (folder 0700, socket 0600) pipes each connection to the upstream agent, looked up again when it fails. The container's path never changes when the desktop's agent restarts or appears after login. Runners never see it: they mount nothing of `~/.majhi` but their own account folder. Part 2 adds `~/.majhi/run` to the runner isolation check (`apps/server/src/runner/check.ts`).
3. **majhi's own agent when the session has none.** `majhi-ssh-agent.service` runs `ssh-agent -D -a ~/.majhi/run/agent.sock`, so keys stay loaded across helper restarts. The desktop's agent wins when there is one, so keys the owner already unlocked work in majhi. The terminal fallback is `SSH_AUTH_SOCK=~/.majhi/run/ssh-agent.sock ssh-add <key>` (`sshUnlockCommand`).
4. **The keyring is probed without a prompt.** `secret-tool` on a locked collection pops an unlock dialog, which a login service must never cause. So `check()` asks D-Bus first: `busctl --user get-property org.freedesktop.secrets /org/freedesktop/secrets/aliases/default org.freedesktop.Secret.Collection Locked`. `b false` is `secret-service`; `b true` is `none` ("The keyring is locked."); an error is `none` ("No keyring is running."); no `secret-tool` is `none` ("secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch)."). `read`, `write` and `remove` run only after a `secret-service` answer, with a timeout.
5. **SSH passphrases on Linux go in the keyring**, as the Keychain holds them on macOS. A kept passphrase that no longer unlocks its key is removed and the key shows as needing one again. With no keyring the unlock still works, until the agent stops.
6. **Docker Desktop for Linux and rootless Docker are refused by `make up` for now.** Both map container uids through a user namespace: the server runs as the owner's uid inside, which lands on a subordinate uid outside, so worktrees and `~/.majhi` would stop belonging to the owner. The check names the fix (`docker context use default` with Docker Engine installed). Running the containers as uid 0 where uid 0 maps to the owner is a follow-up task. The lead asks the owner about this; follow the answer.
7. **On WSL2 the helper finds `docker` again after starting Docker Desktop.** Docker Desktop puts the CLI into the distro only while it runs, so at login `docker` may be a dangling link. Remount, update and the Docker facts start working once it appears.
8. **The WSL2 toast is clickable.** A toast with `activationType="protocol"` opens its `launch` URL in the default browser. The script goes to `powershell.exe` as `-EncodedCommand` (UTF-16LE, base64), with title, message and URL XML-escaped and inside a single-quoted PowerShell string, so nothing in them can run.
9. **NVIDIA for Laya rides the same override.** `MAJHI_LAYA_GPU=nvidia` (set by `make up` when found, passed through the helper) makes `renderOverride` add a GPU reservation and `LAYA_DEVICE: cuda` to the `laya` service, and the build uses PyTorch's CUDA index. SPEC 5.12 plans CPU only today; Part 2 updates it.
10. **`HostInfo.platform` stays Node's `process.platform`.** `os` is new and optional, because older helpers do not send it; read `hostOsOf(info)`.

## Part 1: host helper per OS (@private-claude-idz-pm)

You own `apps/host/src` except `remount.ts` (Part 2). Nothing outside `apps/host/src/platform/` may read `process.platform` or name an OS program when you are done, except `e2e.ts` (`taskpolicy` or `nice`) and `laya.ts` (native Laya is macOS only and stays as is).

Build:

1. `platform/index.ts`: `createPlatform(os, deps)` and a helper that builds `PlatformDeps` from the real process (`runCommand`, `findExecutable`, `toolPath`). `platform/macos.ts`, `platform/linux.ts`, `platform/wsl.ts` (WSL2 is Linux with the Windows overrides). Split keyring, forwarder and toast into their own files (`platform/secretService.ts`, `platform/sshForwarder.ts`, `platform/toast.ts`).
2. **macOS moves, it does not change.** The Keyring wraps today's `security` calls: `find-generic-password` (exit 44 is not found), `security -i` with `add-generic-password -U` on stdin, read back, `delete-generic-password`. SSH stays Apple's: `passphrases()` is `apple`, `socket()` is today's lookup, `composeSocket` is `/run/host-services/ssh-auth.sock`, `serve()` does nothing. Notifier, `open -a`, and `DOCKER_APPS` move as they are.
3. **Keyring on Linux and WSL2** as in decision 4. `secret-tool lookup service <s> account <a>` prints the secret with no newline when piped; exit 1 with empty stderr is not found. `secret-tool store --label=<label> service <s> account <a>` reads the secret from stdin; send it with no trailing newline. `secret-tool clear service <s> account <a>`. Env: PATH, HOME, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` from `desktopEnv()` (with `unix:path=$XDG_RUNTIME_DIR/bus` when the address is missing and that socket exists).
4. `keychain.ts` becomes the secrets key backup over `Keyring` and `SECRETS_KEY_ITEM` (rename to `keyBackup.ts` if you like). `ensure`, `save`, `read` and `status` behave as today where the keyring is `keychain` or `secret-service`. With `none`, `status()` is undefined, `ensure()` does nothing, `save()` throws "No keyring is running on this computer: <reason>". Keep the identity-format check before any write.
5. `ssh.ts` takes the `SshAgentPlatform` and `Keyring`. Drop `--apple-load-keychain` and `--apple-use-keychain` unless `passphrases()` is `apple`. With `keyring`, `unlock` stores the passphrase after `ssh-add` took it, and each check loads waiting keys with their kept passphrase through the same throwaway askpass, removing one that fails. Find `ssh-add` and `ssh-keygen` on PATH off macOS. No "Mac" in errors ("The SSH agent is not running, so there is nothing to load keys into.").
6. The forwarder (decision 2): `net` server on `composeSocket`, started from `main.ts` through `serve()`. Create `~/.majhi/run` as 0700, remove a stale socket file before listening (never a folder or a plain file: log and stop), chmod the socket 0600. Look up the upstream with `socket()`, cache it, look again when a connect fails. Close the client when there is no upstream. Log failures, never bytes.
7. `desktopEnv()`: PATH and HOME, plus `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `BROWSER`, `WSL_DISTRO_NAME`, `WSL_INTEROP` from the helper's env, filled in from `systemctl --user show-environment` (read only those names, never log the output). On WSL2 with no `WSL_INTEROP`, use the newest socket in `/run/WSL/*_interop`.
8. Notifier: macOS as today. Linux: `notify-send --app-name=majhi <title> <message>` with `desktopEnv()`; missing or failing throws "This computer did not show the notification. Install libnotify-bin (Debian, Ubuntu) or libnotify." WSL2: decision 8, with `powershell.exe` from PATH, else `wslpath -u 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'`. Use PowerShell's own app id so no registration is needed. `startup.ts` posts its one notice through the same notifier.
9. `startup.ts`: `openDocker` becomes `platform.docker.start()`, and both failure messages come from `platform.docker.help(reason)`. The last message becomes "majhi could not start. Open a terminal in the majhi folder and run make up." WSL2 `start()`: `Docker Desktop.exe` under `C:\Program Files\Docker\Docker` (path through `wslpath -u`) exists, then `powershell.exe -NoProfile -NonInteractive -EncodedCommand` with `Start-Process`.
10. `editor.ts` takes `EditorPlatform`; `openUrl.ts` becomes the platforms' `openUrl` (keep its tests passing). WSL2 finds the Windows user folder by listing `/mnt/c/Users` (skip Public, Default, Default User, All Users) or `cmd.exe /c echo %USERPROFILE%` plus `wslpath`.
11. `suggestRoots.ts` takes `folders.skippedAtHome`; `paths.ts` uses `toolDirs(os, home)`.
12. `main.ts`: detect the OS once (exit with "majhi's host helper runs on macOS, Linux and WSL2." when there is none), build the platform, send `os` and the last `keyring` check in `HostInfo` (check at start and with the key backup every 10 minutes), set `MAJHI_SSH_AGENT` in the compose env (decision 1), start the forwarder, and handle `docker` appearing late (decision 7): the poll loop starts at once as today; remount, update and facts start once `docker` is found, looked for again after `docker.start()` and every minute. Fix comments that say Mac or launchd where they mean any OS.

Tests (vitest, next to the code), with each OS faked through `run`, `find`, `exists` and env:

- Keyring per OS: macOS `security` calls; Linux probe answers (unlocked, locked, no service, no `secret-tool`); read, write with read-back, remove. The secret is only ever in `input`, never in args, logs or errors.
- `SshAgentPlatform.socket()` order on Linux (own env, systemd env, majhi's agent, skipping non-sockets and `composeSocket`), and `composeSocket` per OS.
- The forwarder with real sockets in a temp folder: bytes both ways, a stale socket replaced, mode 0600, no upstream closes the client, a new upstream after the old one went away.
- Passphrases on Linux: kept after unlock, used at the next check, removed when wrong; no keyring keeps nothing; macOS keeps the Apple flags.
- Notifier: Linux args; WSL2 `-EncodedCommand` decodes to a script where hostile title, message and URL text stays inside the string.
- `docker.start()` and `help()` per OS through `startup.test.ts`; editor candidates per OS; `detectOs` (done).

## Part 2: install, update, compose and docs (@private-claude-idz-hardware)

You own `scripts/`, `Makefile`, `docker-compose.yml`, `docker/laya.Dockerfile`, `apps/server/src/cli/genOverride.ts` and its CLI entry, `apps/host/src/remount.ts` (only the `-e` flags), `apps/server/src/runner/check.ts` (one path), `README.md`, `SPEC.md`, `docs/DECISIONS.md` rows for these.

Build:

1. `scripts/check.sh`, run first by `make up`. Fail (exit 1) with one plain line and the exact step: no `docker`; `docker info` fails (permission denied: `sudo usermod -aG docker $USER`, then log out and in; not running: per OS); no `docker compose` v2; Docker Desktop on Linux outside WSL; rootless Docker (`docker info` security options contain `rootless`). Warn and go on: no git (updates from majhi are off); no Node 20+ (the host helper is off, and what that turns off); no keyring (`secret-tool` missing or locked, with the export as the copy); no systemd user manager (WSL2: `[boot] systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` in Windows). On WSL2 with no `docker`, say to turn on Settings > Resources > WSL integration for the distro (`$WSL_DISTRO_NAME`) in Docker Desktop.
2. `scripts/host.sh` on Linux and WSL2 (detect WSL2 like `isWsl`: kernel release or `WSL_DISTRO_NAME`):
   - `install`: write `majhi-host.service` and `majhi-ssh-agent.service` to `${MAJHI_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}`, `daemon-reload`, `enable` both, `start` the agent (a restart would drop its keys), `restart` the helper (new bundle). The helper unit gets `Restart=always`, its log appended to `~/.majhi/logs/host.out`, and its environment from an `EnvironmentFile` the script writes (the same variables as the plist, plus `MAJHI_SSH_AGENT` and `MAJHI_LAYA_GPU` in the passthrough). Values with spaces must survive: WSL2's PATH holds `/mnt/c/Program Files/...`. Quote `ExecStart` paths and escape `%`. WSL2 also runs `loginctl enable-linger "$USER"`; when that fails, print the `sudo` line. No systemd: print what is off and how to turn it on, and exit 0 as today.
   - `uninstall` stops, disables and removes both units. `pubkeys` runs on every OS. `find_node` also tries `/usr/bin/node`, `~/.volta/bin/node`, `~/.local/share/fnm` and mise or asdf shims.
3. `Makefile`: `MAJHI_SSH_AGENT` per OS (decision 1); `MAJHI_TZ` also from `timedatectl show -p Timezone --value` when `/etc/localtime` is not a link; the secrets key restore also from `secret-tool lookup` (only when `secret-tool` exists, with a timeout); NVIDIA detection when `LAYA=docker` and `LAYA_GPU` is not `off` (`docker info` runtimes include `nvidia`, or `/usr/lib/wsl/lib/nvidia-smi` exists on WSL2), exporting `MAJHI_LAYA_GPU=nvidia` and the CUDA build args; pass `-e MAJHI_SSH_AGENT -e MAJHI_LAYA_GPU` to `gen-override`.
4. `docker-compose.yml`: remove `SSH_AUTH_SOCK` and the agent volume from `server` (decision 1); `laya` build args for the torch index and device, CPU by default. `docker/laya.Dockerfile`: the matching `ARG`s. Check that the pinned torch version has wheels on the CUDA index you pick for amd64 and arm64, and that `laya-serve` accepts `LAYA_DEVICE=cuda`.
5. `renderOverride(state, keys, dockerGid, options)` with the agent socket and the GPU (decisions 1 and 9). `remount.ts` passes the two `-e` flags.
6. `runner/check.ts`: add `<majhiHome>/run` to the paths a run must not see.
7. README Install: three sections, macOS, Linux, Windows (WSL2), each with the prerequisites, the commands and what starts at login. SPEC 4.2 (host helper per OS), 4.5 (agent socket per OS), 5.12 (NVIDIA). DECISIONS rows for decisions 1, 2, 3, 6 and 9.

Tests: `genOverride.test.ts` for each agent case and the GPU; a vitest in `apps/host/src` that runs `scripts/host.sh install` and `uninstall` with fake `uname`, `systemctl`, `loginctl`, `docker` and `node` on PATH and checks the unit files (quoting, a PATH with spaces) and the calls; `check.sh` with a fake `docker` for each fail line.

## Part 3: copy, and the server and web per OS (@private-claude-idz-pm)

You own `apps/server/src` (except the files Part 2 owns), `apps/web/src`, and the text in `packages/shared/src` (command summaries, approval labels).

1. Every "this Mac", "the Mac", "your Mac", "the Mac's" in UI, server and command text becomes "this computer" (or the plain equivalent). Comments only where they are wrong now.
2. Keychain wording through `keyringName(hostOsOf(info))`. The git login copy says "saved login (git credential helper or gh)" instead of naming the Keychain.
3. `health/checks.ts`: the secrets key copy check uses `hostOsOf` and `info.keyring`: `keychain` and `secret-service` as today with the right name; `none` warns with the reason and that the export is the only other copy. The SSH notice passes the OS to `sshUnlockCommand`.
4. `notify/service.ts`: rename `MacNotice` and `mac` in code to desktop. The config key `notifications.mac` stays (renaming it would break every majhi.yaml); record that in DECISIONS.
5. Web: root placeholders and the tasks folder hint use `rootExample(os)`; the protected-folder warning shows on macOS only; the native Laya install shows on macOS only, elsewhere Laya reads as running in Docker; the palette hint uses the same modifier helper as the rest (`lib/format.ts`).
6. Make sure the web gets `os` (and `keyring`) from the host status it already reads.

Tests: none for copy. Typecheck server and web; run the touched server tests.

## The Linux run (lead)

This runner is Linux (Debian, arm64) without Docker. The lead runs: typecheck and the touched tests; the helper bundle on Linux against a dev server from the worktree (OS detection, keyring `none`, forwarder, folder jobs); `check.sh` and `host.sh` with fakes; the smoke e2e (`pnpm e2e:smoke`). A real `make up` on Docker Engine is an owner check unless a Linux VM with Docker is reachable.

## Owner-only checks

- macOS after the update: Keychain copy, SSH keys and agent socket, notifications, start at login, update and rollback, all as before.
- A Linux desktop with Docker Engine: `make up`, the helper starting at login, the keyring copy, `notify-send`, opening URLs and the editor, update and rollback.
- Windows 11 with WSL2 and Docker Desktop: `make up` in the distro; majhi starting after a Windows sign-in with no terminal open (Docker Desktop booting the distro, linger, `WSL_INTEROP` for the service); the server reaching `~/.majhi/run/ssh-agent.sock`; the toast and its click; the browser; the editor through Windows VS Code.
- A machine with an NVIDIA GPU: Laya on `cuda`.

## Done when

- macOS behaves as before, and every helper module reaches the OS only through `Platform`.
- `make up` runs or stops with a clear line on Linux and WSL2, and installs the helper at login.
- Updates and rollback run through the helper on all three.
- No "this Mac" in UI or server text; README and SPEC cover the three systems.
- Platform tests with each OS faked pass; the Linux run is reported in the room; owner-only checks are listed in `docs/PROGRESS.md`.
