# Decisions

Record every decision the spec does not cover: date, decision, reason, alternatives considered.

| Date | Decision | Reason | Alternatives |
|---|---|---|---|
| 2026-09-29 | Build our own hub instead of forking an existing orchestrator | Owner wants full ownership of the core | Fork Open Session, Emdash or Vibe Kanban |
| 2026-09-29 | Drive agents over ACP | One protocol for Claude, Codex and Kimi, no terminal scraping | Wrapping each CLI's own non-interactive mode |
| 2026-09-29 | Local memory store that never calls a model | Company accounts are CLI subscriptions, not API keys | Mem0, Graphiti (both need an API key for extraction) |
| 2026-09-29 | v1 supports Claude Code and Codex only. Kimi removed. Tools are entries in a registry | Owner uses Claude and Codex now; may add OpenCode, Cursor or others later without touching the rest of the hub | Keep Kimi; hardcode each tool |
| 2026-09-29 | Accounts sign in with the tool's login or with an API key. Keys live in `secrets.age` and go only to runs on that account | Owner may use API keys when needed | Subscription logins only |
| 2026-09-29 | Several workspace roots picked by the owner, not a fixed `~/Work`. One `tasks_dir` (default `<first root>/.hub`) holds all task folders | Owner keeps projects in more than one place. One tasks folder keeps a task whose repos span roots in one home | Single fixed root; task folder per root |
| 2026-09-29 | Roots are mounted through a generated `docker-compose.override.yml`. Changing roots needs `make up` again | Compose cannot loop over a list and mounts are fixed at start. Mounting only the roots keeps agents away from the rest of the disk | Mount all of `$HOME` once (instant changes, wider exposure) |
| 2026-09-29 | Root agents can create tasks, use any attached MCP server, edit `hub.yaml`, and move or rename project folders. Every change is a proposal the owner approves | Owner wants root agents to organize projects, with approval | Read-only root agents; auto-apply |
| 2026-09-29 | Optional decision provider (rules, Laya, Jev) for typed decisions: routing, model picking for `model: auto` agents, memory dedupe, injection warnings | Jev and Laya answer typed questions fast and cheap, but cannot write code or speak ACP, so they sit beside agents, not in place of them | Use an LLM agent for every small decision; skip decision models |
| 2026-09-29 | Jev is off by default | It is a hosted API, so task text leaves the machine | On by default when a key is present |
| 2026-09-29 | The product is called majhi | Owner's choice | Work Hub |
| 2026-09-29 | Models and effort levels are read from each agent over ACP session config options (`model`, `thought_level`), never hardcoded. Agents can set `auto` for either | Model names and effort levels change often. ACP already exposes both | Hardcoded model lists per tool |
| 2026-09-29 | Use `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` | The `@zed-industries` packages are deprecated or replaced (checked on npm, 2026-09-29) | The old Zed packages |
| 2026-09-29 | Decision provider defaults to Laya running locally, then an ACP agent simulating it, then rules. Jev stays opt-in | Owner wants Laya local and a fallback when Laya or Jev is not available | Rules only by default |
| 2026-09-29 | First workspace root is `~/Work` | Owner's answer | |
| 2026-09-29 | Every agent session has a context budget: compact at 80% of the window (ACP `usage_update`), first with the agent's native `compact` command, then by handoff to a fresh session if that fails or does not bring usage under 40%. Also rotate after 40 turns | Owner does not want context to pile up and burn tokens. block/buzz gates on provider-reported usage (its fix #821), caps compactions per turn (#4805), and rotates external ACP agents' sessions (`BUZZ_ACP_MAX_TURNS_PER_SESSION`, recommended 50). Both adapters already expose `usage_update` and a `compact` command | Let each CLI compact on its own (buzz-acp's approach, no control over when); rotation only (loses in-session understanding every time) |
| 2026-09-29 | Connections (kubectl, MCP, SSH, env, mail) per org. Org agents use their org's; root agents can use all. Secrets in `secrets.age`, injected per run, removed after | Owner debugs servers, reads observability and mail across orgs from the hub | Put credentials in agent config homes; one global set for everyone |
| 2026-09-29 | Connection writes always ask the owner unless the org policy allows that exact action; unclassified commands count as writes. The primary guard is a least-privilege credential | MCP read-only flags have been bypassed (containers/kubernetes-mcp-server #1415) and agents with a shell can call CLIs directly | Trust MCP read-only modes; parse and block commands only |
| 2026-09-29 | Task kinds `code`, `ops`, `chat`; ops tasks write `REPORT.md` and create linked fix tasks. Live control (stream, Esc to stop, queue or interrupt) in Phase 2 | majhi must replace the CLIs entirely, including debugging and reporting | Repo tasks only |
| 2026-09-29 | New Phase 4 "Connections and ops tasks"; later phases renumbered 5 to 10. `hub-tasks` moves to Phase 4 | Incident work is daily work and should not wait for the root agent phase | Fold into the root agents phase |
| 2026-09-29 | Config folder is `~/.majhi` | Matches the product name. Owner's choice | `~/.work` |
| 2026-09-29 | Tech stack and memory design approved as proposed (versions checked on npm and PyPI on 2026-09-29) | Owner's answer | |
| 2026-09-29 | Hub listens on `127.0.0.1:7070` | Owner's answer | |
| 2026-09-29 | Decision models are a tool any agent can call (`hub-decide`, on by default), plus the owner from the palette | Owner wants agents to use Jev or Laya for any quick decision, not only the hub's internal routing | Hub-internal use only |
