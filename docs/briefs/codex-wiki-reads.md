# Brief: Codex wiki sessions read repos through majhi's files tools

Owner asked, 2026-10-21. One branch (`fix/codex-wiki-reads`), one worktree, one builder. Read `docs/briefs/codex-hooks.md` first: this builds on it.

## The problem

The Housekeeper writes wiki pages in a read-only session (`memory/housekeeper.ts`, `SessionMode` `repo`). The repo's clean export is mounted read-only, and `readOnlyHandler` (`memory/read-only.ts`) allows only ACP `read` and `search` asks inside the export. Claude reads with its own Read and Grep tools, so this works. Codex has no read tool: it reads with shell commands (`sed -n`, `rg`, `cat`). Those are `execute` asks, which a read-only session refuses. Since `feat/codex-hooks`, every Housekeeper session on Codex also has no hook token, so the hook denies every call ("This Codex session has no way to ask majhi"). So a workspace whose wiki writer runs on a Codex account gets no pages.

## Decision

Do not classify shell commands as read-only. The hook endpoint runs on the server and cannot see runner-only paths (`/proc/self/environ` holds the hook token and any API key; the account home is mounted in the runner), so a shell allowlist could only judge paths by their text. Reads stay inside majhi's own process instead, where `readOnlyDecision` already checks real paths.

## What to build

1. **A `files` MCP server, served by majhi** (HTTP, like the room tools in `rooms/mcp.ts`, with a per-session bearer token kept off command lines as `mcp-env.ts` does). It has three tools, all limited to the session's read roots (`root` and `also`):
   - `read`: path, optional first line and line count. Answers with numbered lines in the shape of Claude's Read (`cat -n`: right-aligned number, a tab, the line), so the model cites real line numbers. Caps output size and says when it cut.
   - `list`: the entries of one folder, folders marked.
   - `search`: literal text (with a case option) under a path, answering `path:line: text`, capped, skipping binary files. No user-supplied regex.

   Containment: resolve every path against the root, take its real path, and refuse anything outside the roots. That covers `..`, absolute paths and symlinks leading out. Reuse the containment of `readOnlyDecision` (`isInside`, real paths); do not write a second one.
2. **Every Codex session in a runner gets a hook token, bound to that session's own decision.** Today `CodexHookGate.decide` (`runs/codex-hook.ts`) needs a live run and refuses otherwise. Give a token a second kind of binding: a session's own permission handler (the one `setPermissionHandler` gets), fed with the same `PermissionAsk` that `readHook` builds. A run keeps going through `PermissionFlow.ask`. Do not special-case the Housekeeper in the gate.
3. **The read-only handler allows the files tools.** `readOnlyDecision` allows an MCP ask for the session's own `files` server; containment is the server's job. Everything else stays refused. A refused `Bash` gets a reason that names the tools: "No shell in this session. Read with the files tools: read, list, search."
4. **The Housekeeper's Codex sessions get the `files` server and the hook token.** That covers repo mode and notes mode, and the decisions stand-in too: those refuse every tool, but with the session's own reason instead of "no way to ask". Claude's Housekeeper sessions stay as they are: they keep Read and Grep and get no `files` server.
5. If a prompt tells the model how to read, it says to use the read and search tools, not a shell.

## Tests (only these; add each as a row in `docs/briefs/test-guarantees.md`)

- The `files` tools refuse a path outside the roots: `..`, an absolute path, a symlink inside the root that leads out, and `/proc/self/environ`. Each read inside the roots answers with the right numbered lines.
- A `files` token answers only for its own session's roots; another session's token and a revoked token are refused.
- Through the hook endpoint, a Housekeeper Codex session gets `Bash` and `apply_patch` denied and a `files` tool allowed.

Run typecheck and only the touched tests while working. Run the unit and e2e suites once, at the end.

## Done means

- A throwaway majhi (never the live one, never port 7070) with the fake agent: a repo-mode Housekeeper session's `files` calls answer from the export, and a hook payload for `Bash` gets the deny with the reason. Check this by posting from inside a real runner container.
- `docs/DECISIONS.md` row: Codex wiki sessions read through majhi's `files` MCP server. Reason: the server cannot judge shell paths it cannot see. Alternative: a read-only shell allowlist, judged by text only.
- `docs/PROGRESS.md` updated.
- The lead runs one real Codex wiki session afterwards. The builder does not.

Rules: `CLAUDE.md`. Never touch the live majhi or `~/.majhi`. Generic sample names only. No regex for decisions. Commit messages never mention an AI assistant. Never push or merge. One heavy job at a time.
