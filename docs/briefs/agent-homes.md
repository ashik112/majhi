# Brief: each workspace gets its own agent home; only the sign-in file is shared

Owner asked, 2026-10-21. One branch (`fix/agent-homes`), one worktree, one builder.

## The problem

An agent session's `HOME` and its CLI's config home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) are both the account's own folder, `~/.majhi/accounts/<id>` (`packages/acp/src/env.ts` sets both; `runner/docker.ts` `runMounts` mounts it read-write). One account serves many workspaces (a Private account serves every org). So whatever an agent writes there reaches every other workspace that uses the account:

- **Behaviour that loads at the next start:** Codex `config.toml` (MCP servers, `notify`, profiles), `AGENTS.md`, `rules/`, `prompts/`, `skills/`; Claude `settings.json` (hooks, permissions, env), `CLAUDE.md`, `.claude.json` (user MCP servers), `agents/`, `commands/`, `skills/`, `plugins/`; and the shell's `.profile`, `.bashrc`, `.gitconfig`, `.npmrc` and `.ssh/config`. A prompt-injected agent in one client's workspace can plant any of these, and they then run in another client's sessions.
- **Data:** Claude `projects/` (every transcript), Codex `sessions/` and `memories_1.sqlite`. An agent in one workspace can read another workspace's transcripts with `cat`.

"Work is kept apart per org" (SPEC) does not hold for agents today.

## Decision

Every session that runs in a runner gets a home of its own workspace: `~/.majhi/agent-homes/<org>/<account>/`. That folder is both `HOME` and the CLI's config home. Only one file is shared across workspaces: the sign-in file. It is mounted on its own, from the account folder into the workspace home: Codex `auth.json`, Claude `.credentials.json`.

- **Codex** writes `auth.json` in place (`codex-rs/login/src/auth/storage.rs`, `FileAuthStorage::save`: open with truncate, write, flush; no rename). So a refresh inside a runner lands in the shared file, as it does today.
- **Claude:** evidence only. A single bind-mounted `.claude.json` was updated in place by the Claude CLI (2.1.284, same inode, new content). That shows how its config writer behaves; it does not prove a credential refresh does the same. A refresh can only be proven with a token near expiry, so say so in the report.

The account folder (`accounts/<id>`) keeps sign-in, probes and usage reads. Nothing else uses it. A run never mounts it again.

## What to build

1. **Workspace homes.** `agentHome(majhiHome, org, account)` next to `accountHome`. `HOME` and the config home of every runner session point at it: runs, chats, the captain, the Housekeeper and the decisions stand-in. A session that belongs to no workspace (a job with no org, or the captain across all workspaces) gets one internal home, `agent-homes/_majhi/<account>/`, never a workspace's and never the account folder. Write down, in PROGRESS, where each kind of session gets its org.
2. **Mounts.** In `runMounts`, the own-home rule becomes "exactly this session's (org, account) home". Add one narrow exception: a read-write single-file mount whose source is exactly the run's account sign-in file (`accounts/<id>/auth.json` or `accounts/<id>/.credentials.json`), with that same filename inside the session's own home as its target. Nothing else from `accounts/` is ever mounted. An API-key account has no sign-in file and gets no such mount. Docker creates a folder when a mount's source is missing, so check that the file exists before mounting it.
3. **Census of what majhi writes into the account folder.** Find every write majhi makes there for a session and move it to the workspace home: `prepareHome` (the Codex `cli_auth_credentials_store` line), skills, plugins, `runEnv` and `mcp-env` files, and anything else `grep account.home` and `accountHome(` find. Sign-in, probes and usage reads stay where they are.
4. **Seed a new workspace home with only what the CLI needs to start.** Take the needed fields from the account folder through a zod schema that allowlists them. Claude, for example, may need `.claude.json`'s `oauthAccount`, `userID` and `hasCompletedOnboarding`. Never copy `mcpServers`, settings, hooks, instructions, skills or plugins: the account folder may already hold planted ones. Find out what each CLI needs by reading its behaviour (the fake agent cannot tell you). Report what you seed and why.
5. **Identity pin.** At sign-in, majhi records who the account is, from the same CLI calls the account status already makes in the account folder: Claude's `auth status` JSON (email or org name), and Codex's account read (email or account id). Store it in majhi's own config or database, never in an agent-writable place. Before starting a session, if the sign-in file's content hash differs from the last one checked, read the identity again in the account folder. If it differs, refuse new sessions on that account and raise the existing signed-out item ("Sign in again"), with the reason. The same path must show in Needs you when a session loses its sign-in mid-run; check that it does.
6. **Resume.** Old transcripts stay in the account folder. Check what happens when a task resumes a session whose transcript is not in its new home. If majhi falls back cleanly to a new session with its handoff, migrate nothing. If it hangs, loops or loses the task, copy that workspace's own transcripts into its home on first use, matched by the task folders the workspace owns.
7. **Disk.** Check what a workspace home weighs after a few sessions. Caches that can be shared read-only stay shared only if that cannot carry behaviour from one workspace to another.

## Tests (only these; add each as a row in `docs/briefs/test-guarantees.md`)

- `runMounts` refuses another workspace's home, the account folder, and any other file of `accounts/<id>`. It allows only the run's own home and that account's sign-in file, at its own filename inside that home.
- The identity pin: a changed sign-in file whose identity no longer matches refuses the next session on that account and raises Sign in again. A refreshed file of the same identity passes.
- Seeding never copies `mcpServers`, hooks, settings or instructions from the account folder.

Run typecheck and only the touched tests while working. Run the unit and e2e suites once, at the end.

## Done means

- A throwaway majhi (never the live one, never port 7070) with the fake agent: sessions of two workspaces on one account get two homes. A file one session writes into its home is absent from the other's. Both see the same sign-in file, and a change to it shows in both.
- A real runner: list the mounts of a run (`docker inspect`). Show that only the own home and the sign-in file come from `~/.majhi`.
- `docs/DECISIONS.md` row: per-workspace agent homes, with only the sign-in file shared and pinned to the account's identity. Reason: one account serves many workspaces. Alternatives: read-only overlays of known config files (misses new extension points and leaves transcripts readable); a copy of the sign-in file per workspace (refresh tokens rotate, so copies sign each other out).
- `docs/PROGRESS.md` updated.
- The lead runs a real Claude and a real Codex session afterwards. The builder does not.

Rules: `CLAUDE.md`. Never touch the live majhi or `~/.majhi`. Generic sample names only. No regex for decisions. Commit messages never mention an AI assistant. Never push or merge. One heavy job at a time.
