# Brief: Phase 2b, wave 2 (the run manager)

You are building the rest of Phase 2b of majhi, inside majhi itself. You own `apps/server/src/runs/` (the run manager) for this work. Another agent builds the decision provider (Laya, `majhi-decide`) at the same time on another branch; you only call it through the interface in `apps/server/src/decisions/api.ts`.

## Read first

- `CLAUDE.md`: code standards, the rules that must never be broken, owner preferences (plain copy, no em dashes; no manual work outside majhi).
- `SPEC.md`: 5.1, 5.7, 5.13, 5.15, 5.17, and 7 (Phase 2b, including its "Done when").
- `docs/DECISIONS.md`: the rows dated 2026-09-30 (checkpoints, offline detection, settings, the boss's MCP tools).
- The contract: `packages/shared/src/settings.ts` (context, limits, resume), `tasks.ts` (`AgentLive` states `queued`/`paused` with `slot` and `turns`, the `context` room item), `commands.ts` (`room.fresh`), `packages/acp/src/session.ts` (events: `usage`, `commands`, `config`; `prompt`, `cancel`, `close`, `resume`).
- The current run manager: `apps/server/src/runs/manager.ts`, `items.ts`, `permissions.ts`, `prompt.ts`, and how `tasks/service.ts` and `admin/` use it.

## Build

1. **Context budget (5.13).**
   - Track `used / size` from `usage` events per session, and show it in `AgentLive.usage` (the task view's "In this room" panel should show a thin meter per agent: used of size).
   - At the end of every turn, and before sending a prompt whose estimated size would cross the line, compact when usage reaches `compact_at`. The merge order is majhi default, then org `context.compact_at`, then the agent's `context.compact_at`.
   - Native compaction first: send the agent's advertised `/compact` command (`commands` event) with a one-line note on what to keep. Then wait for the next `usage` and check it fell under `compact_target`.
   - Otherwise hand off. Ask the agent for a handoff note with the fixed template in 5.13 and save it to `<task>/.handoffs/<agent>-<n>.md`. Close the session, then open a fresh one with: a short fixed prefix, TASK.md, the note, a short room summary, the diff stat, and the pending prompt.
   - If the agent cannot write the note, build it from durable state without a model: TASK.md, the last checkpoint, the room since the checkpoint (newest first, within a budget), and the diff.
   - Rotate after `max_turns` (0 turns it off), and on `room.fresh` (a "Fresh session" button on each agent in "In this room").
   - Recover right away on stop reason `max_tokens` or `max_turn_requests`, or on a context-window error. At most 2 compactions per turn; after that, pause with reason `error` and say why in the room.
   - Every compaction posts a `context` room item (`native`, `handoff`, `rotation`, `fresh`, `recovery`) with tokens before and after, and the note path. Render it in the room as one quiet line, for example "@builder compacted: 164k to 18k tokens (native)", with a link that opens the note in the file viewer.
2. **Checkpoints (5.7).**
   - After every turn that changed files in a worktree, commit them on the task branch: `wip(<TASK-ID>): checkpoint N`.
   - Use the org's commit identity (`orgs.<id>.identity`). With none, use `majhi <majhi@majhi.local>` and post a one-time room hint saying where to set it.
   - Store the ACP session id and checkpoint number on the run. Never push. Skip worktrees with no changes.
3. **Automatic resume (5.7).** `resume.auto` is on by default, and orgs can turn it off.
   - **Restart and crash:** on server start, tasks that were `running` with a turn in flight resume. Load the ACP session when the agent supports it, then send "Continue from where you stopped. The last checkpoint is N." If that fails twice, pause with reason `error` and a clear room item. Also call `services.tasks.statusChanged(taskId)` for done tasks at startup (see the notes below).
   - **Offline:** a probe every 20 s (a HEAD request to the tools' API hosts; for tests, make the probe injectable) plus agent errors that look like network failures. When offline, pause running turns with reason `offline`: the agents show `paused` and the banner says majhi is offline. When the network is back, resume them the same way.
   - **Wake:** the host helper already detects a wake from sleep (clock-gap detector in `apps/host/src/ssh.ts`). Make the helper tell the server (a new host info field or job reply, whichever fits `packages/shared/src/host.ts`). On wake, check each live session. Resume turns that failed or stalled while the Mac slept.
4. **Agents on demand and limits (5.17).**
   - Stop an idle agent process after `limits.idle_timeout`. Its next message resumes it (session load, else a fresh session with a handoff note).
   - Enforce `agents_max`, `per_account` and `per_task` when starting a process. Extra starts wait in a queue in request order; `AgentLive` shows `queued` with its `slot`, and the room shows "Queued, #2 in line". Settings changes apply live.
5. **Decision hooks** (the interface is in `apps/server/src/decisions/api.ts`; the implementation arrives separately, so use `noDecisions` in tests and keep it optional in the run deps):
   - For every agent session, call `decisions.attachTool(task, agent)`. If it returns a server, add it to `mcpServers` next to majhi-admin. Revoke the token when the session ends.
   - At session start, for an agent whose `model` or `effort` is `auto`, call `decisions.pickModel(...)` with the offered options (narrowed to the agent's `models` list). Apply the pick with `setOption`. Post a system item with the reason, for example "Laya picked sonnet, effort medium (0.82)". Record the choice and the decision id on the run. Without a pick, keep the ACP default and say so.
6. **Two agents on one account (5.2).** Using the fake adapter, run two sessions on the same account at once through the run manager and prove neither breaks the other. Write in `docs/DECISIONS.md` how the owner can confirm it with a real account, and what the result means for the "one config home per account" decision.

## Things other agents left for you

- **From the task links work:**
  - Whenever a task's status changes outside `TaskService`, call `await services.tasks.statusChanged(taskId)` afterwards. It starts waiting tasks, closes a finished parent, refreshes TASK.md and emits the event.
  - `TaskService.start()` throws 409 while dependencies are unmet. Auto-resume must handle that.
  - Migration id 10 is taken; pick a new one.
- **From the boss work:**
  - Keep the boss's changes in `runs/manager.ts`: `RunDeps.admin`, `AgentRun.adminToken` and `preambleDue`, skipping the brief for the boss chat, `attach()` at session start, `withPreamble()` in `blocksFor`, and revoking in `endSession`.
  - A fresh, rotated or resumed session must call `attach()` again and set `preambleDue`.
  - Pass `mcpServers` on `session/load` too.

## Test

- Unit tests for the logic: thresholds and merge order, compaction decisions, the handoff note template and the durable-state note, the limit queue order, offline and wake decisions, checkpoint commit rules.
- Integration tests with the fake adapter in `packages/acp/testing`. Extend the fake with a flag that reports rising usage per turn, and a `/compact` that lowers it (or a flag that makes `/compact` do nothing), so all three compaction paths run.
  - The done-when test: a fake agent pushed past 80% gets compacted, with the event in the room.
  - A task keeps its work across a simulated restart and a simulated network drop.
  - A third agent queues under `per_account: 2`.
- E2E: one spec `e2e/phase2b-runs.spec.ts` with the context event in the room, "Fresh session", the queued state, and offline pause and resume (with the injectable probe).
- **How to run tests in this container:**
  - `pnpm install` first, in your worktree.
  - Unit tests: `npx vitest run <paths>`. Run only the tests for what you changed while working.
  - E2E: `MAJHI_E2E_PORT=7095 npx playwright test e2e/phase2b-runs.spec.ts` (and the phase specs it needs before it).
  - Run `sh scripts/ci.sh` once, at the end.

## Rules

- **The majhi you are running inside is live. Never stop, kill or restart processes you did not start** (no `pkill node`, no killing by port), never use port 7070, never touch `~/.majhi`, Docker or the host helper. Work only in your task worktree.
- Never push. Commit on your task branch in small commits with messages like `feat(runs): compact at the threshold`.
- TypeScript strict, zod at every boundary, no `any` without a comment. Small modules. Plain copy, no em dashes.
- Never spend real tokens in tests; use the fake adapter.
- When done, write a short report in the room: what changed, test results, anything left.
