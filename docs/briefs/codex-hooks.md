# Brief: Codex runs in the container sandbox, gated by a majhi hook

Owner approved, 2026-10-21. One branch (`feat/codex-hooks`), one worktree, one builder.

## The problem

Every Codex agent in majhi fails to run any shell command, on every OS:

```
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.
```

Since 0.115 Codex wraps each command in bubblewrap, which needs user namespaces. Docker's default seccomp profile blocks them, and Ubuntu 24.04 hosts block them again through AppArmor. Codex's old Landlock fallback panics in 0.158 ("requires bubblewrap"). There is no upstream fix (openai/codex #15678, open). OpenAI's guidance for containers: run Codex in full access and let the container be the sandbox.

Codex starts in its default `agent` mode today (workspace-write sandbox, approval on-request). majhi never switches Codex modes.

## What was already proven (2026-10-21, real Codex 0.158.0 in `majhi-runner:dev`, majhi's container flags)

- `codex-acp` with `INITIAL_AGENT_MODE=agent-full-access` starts in that mode and runs shell commands. No bwrap error.
- A managed hook from `/etc/codex/requirements.toml` loads with no trust prompt:

  ```toml
  allow_managed_hooks_only = true
  [features]
  hooks = true
  [hooks]
  managed_dir = "/etc/codex/hooks"
  [[hooks.PreToolUse]]
  matcher = ".*"
  [[hooks.PreToolUse.hooks]]
  type = "command"
  command = "node /etc/codex/hooks/<script>.mjs"
  timeout = 30
  ```

- PreToolUse fires before every shell command in full-access mode. The stdin payload holds `tool_name` (`Bash`), `tool_input.command`, `cwd`, `session_id`, `turn_id`, `tool_use_id` and `permission_mode` (`bypassPermissions`).
- A hook that prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` stops the call, and the agent sees the reason.

From the docs, not yet tested: PreToolUse also fires for `apply_patch` and MCP tools (named like `mcp__server__tool`). On a hook timeout, crash or malformed output, Codex **lets the call run** (fails open). `ask` is not a supported decision and also fails open.

## What to build

1. **Codex starts in full access.** Set `INITIAL_AGENT_MODE=agent-full-access` in the Codex tool's environment (`packages/acp/src/tools/codex.ts`, next to `codexCapEnv`). Take a census of every path that starts or changes a Codex session (runs, captain, sign-in, probe, usage read), so that none lands in a sandboxed mode.
2. **The hook lives in the runner image** under `docker/codex/`: `requirements.toml` as above, with `matcher = ".*"` so shell, file edits and MCP calls all pass through it, plus one small hook script. Copy both into the runner stage of `Dockerfile`, and say in a comment why (bwrap cannot run in a runner).
3. **The agent cannot change the hook.** The agent process must not be able to write `/etc/codex` or the script. Check the uid the agent runs as and the runner's capabilities (`CAPS` in `containers/args.ts` holds `DAC_OVERRIDE`, `FOWNER`). If root in the runner can write image files, find the smallest way to make them unwritable (for example a read-only mount) without loosening the runner's flags. Prove it in a real runner.
4. **The hook asks majhi; majhi decides with what it already has.** The script sends the payload to majhi's server and prints majhi's allow or deny. Give it the address and a per-run credential through the adapter's environment, the way `mcp-env.ts` keeps MCP values off command lines. Check that Codex passes that environment to hook commands. On the server, one endpoint:
   - parses the payload with a zod schema in `packages/shared`;
   - turns it into the same `PermissionAsk` the ACP path builds (`execute` with the command line, `edit` for `apply_patch`, the MCP server and tool for an MCP call);
   - sends it through the **same** decision code as an ACP permission request (`runs/permissions.ts`: `connectionVerdict`, authority, destructive asks, Always rules, Needs you rows). Write no second classifier. If the ACP handler's decision is tangled with ACP reply plumbing, pull the decision out into one function that both paths call.
   - waits for the owner when the decision needs the owner, then answers allow or deny.
5. **Fail closed in the script.** Any error (server unreachable, bad response, unknown tool shape, its own deadline) prints a deny with a plain reason. The script's deadline is shorter than the `timeout` in `requirements.toml`, because Codex lets the call run on a timeout. Find Codex's largest allowed hook `timeout` from its source (openai/codex tag `rust-v0.158.0`) and use it, so an ask can wait for the owner as long as Codex allows. If the owner has not answered by the deadline, deny with "Waiting for the owner's answer in majhi." The Needs you row stays. When the owner approves, the same exact command in the same run is allowed the next time the agent tries it.
6. **Speed.** The script runs before every command. Keep it to node built-ins, with one HTTP call. Measure p50 and p95 per command, and note them in the report.

The Claude path does not change.

## Tests (only these; add each one as a row in `docs/briefs/test-guarantees.md`)

- A connection write sent through the hook endpoint asks the owner, and the endpoint answers deny when the owner refuses (guarantees #40, #43, #44 for Codex).
- A destructive command through the hook endpoint asks even when an Always rule or `allow` covers it.
- The hook script fails closed: server down, garbage response, deadline reached. Each prints a deny.
- The endpoint refuses a missing or wrong per-run credential, and a credential from another run.

Run typecheck and only the touched tests while working. Run the unit and e2e suites once, at the end.

## Done means

- A throwaway majhi (never the live one) with the fake agent: the hook endpoint asks, waits and answers, checked by posting a hook payload from inside a real runner container on the task network.
- A real runner built from this branch: the agent's uid cannot change `/etc/codex`. Show the failed write.
- `docs/DECISIONS.md` row: Codex runs in full access inside the runner and is gated by a managed PreToolUse hook. Reason: bwrap cannot run in an unprivileged container. Alternatives: a custom seccomp profile plus AppArmor off (weakens isolation, host-specific); Codex disabled on Linux.
- `docs/PROGRESS.md` updated.
- The lead runs one real Codex session through the built image. The builder does not.

Rules: `CLAUDE.md`. Never touch the live majhi or `~/.majhi`. Generic sample names only. No regex for decisions. Commit messages never mention an AI assistant. Never push or merge. One heavy job at a time: one docker build, one suite run.
