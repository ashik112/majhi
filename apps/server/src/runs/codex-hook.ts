import { resolve } from "node:path";
import type { PermissionAsk } from "@majhi/acp";
import { CodexHookCommandInputSchema, type CodexHookPayload, type CodexHookVerdict } from "@majhi/shared";
import type { GateConnection } from "../connections/gate.ts";
import type { ToolCaller } from "../rooms/access.ts";
import { mcpToolOf } from "./permissions.ts";
import type { AgentRun } from "./run.ts";

/**
 * Codex in a runner has no sandbox of its own (bubblewrap cannot start there), so it runs in full access and a
 * managed PreToolUse hook (docker/codex/) asks majhi before every tool call. This reads one hook payload as the
 * `PermissionAsk` an ACP permission request of the same call would have been, and hands it to the same
 * `PermissionFlow.ask`: the connection gate, the destructive asks, the workspace's level, the Always rules and
 * the Needs you cards are the ones the other agents have. Nothing here decides anything.
 */

const ALLOW = "allow";
const DENY = "deny";
const OPTIONS: PermissionAsk["options"] = [
  { id: ALLOW, name: "Allow once", kind: "allow_once" },
  { id: DENY, name: "Deny", kind: "reject_once" },
];

/**
 * Codex's own tools (codex-rs/core/src/tools/handlers, tag rust-v0.158.0) that are neither a shell, a file edit nor
 * an MCP call. A session over ACP never asks about them, and they run inside Codex. Check this list again when the
 * Codex version in the Dockerfile moves: a tool that is not here is refused, never let through.
 */
const CODEX_OWN_TOOLS: ReadonlySet<string> = new Set([
  "update_plan",
  "view_image",
  "request_user_input",
  "request_user_input_async",
  "get_context_remaining",
  "curr_time",
  "new_context",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "sleep",
  "send_message_to_user_async",
  "wait_for_environment",
  "request_permissions",
  "request_plugin_install",
  "list_available_plugins_to_install",
  "tool_search",
  "spawn_agent",
  "send_input",
  "send_message",
  "followup_task",
  "resume_agent",
  "wait_agent",
  "list_agents",
  "close_agent",
  "interrupt_agent",
]);

/** What a hook payload is to majhi: a question for the flow, a call that needs none, or one majhi cannot read. */
export type HookRead =
  | { kind: "ask"; ask: PermissionAsk }
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

/** What the run holds that names an MCP server or tool, as majhi spells it. Codex spells `-` and `.` as `_`. */
export interface HookKnown {
  servers: readonly string[];
  connections: readonly GateConnection[];
}

/** Codex's spelling of a name in an MCP tool name: every character but ASCII letters, digits and `_` becomes `_`. */
function codexSpelling(name: string): string {
  let out = "";
  for (const ch of name) {
    const word = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
    out += word || ch === "_" ? ch : "_";
  }
  return out === "" ? "_" : out;
}

function trimEnd(text: string, ch: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ch) end--;
  return text.slice(0, end);
}

function trimStart(text: string, ch: string): string {
  let start = 0;
  while (start < text.length && text[start] === ch) start++;
  return text.slice(start);
}

/** The tool names a held connection has an opinion about, as the owner and the server spelled them. */
function toolsOf(connection: GateConnection | undefined): string[] {
  if (connection === undefined) return [];
  return [
    ...(connection.readTools ?? []),
    ...(connection.writeTools ?? []),
    ...connection.allow,
    ...Object.keys(connection.toolAnnotations ?? {}),
  ];
}

/**
 * `mcp__acme_obs__run_query` back to the server and tool the run was given (`acme-obs`, `run-query`), so the
 * connection gate finds the connection and its tool lists. A server the run does not hold keeps Codex's spelling.
 */
export function mcpNamesOf(hookName: string, known: HookKnown): { server: string; tool: string } | undefined {
  let best: { server: string; tool: string } | undefined;
  let bestLength = -1;
  for (const server of new Set([...known.servers, ...known.connections.flatMap((c) => c.server ?? [])])) {
    const prefix = `mcp__${trimEnd(codexSpelling(server), "_")}__`;
    if (!hookName.startsWith(prefix) || prefix.length <= bestLength) continue;
    const rest = hookName.slice(prefix.length);
    const spelled = toolsOf(known.connections.find((c) => c.server === server)).find(
      (t) => trimStart(codexSpelling(t), "_") === rest,
    );
    best = { server, tool: spelled ?? rest };
    bestLength = prefix.length;
  }
  return best ?? mcpToolOf(hookName);
}

const PATCH_HEADERS = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];

/** The files a patch changes, each as an absolute path (a patch names them relative to the session's folder). */
export function patchPaths(patch: string, cwd: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const header = PATCH_HEADERS.find((h) => line.startsWith(h));
    if (header === undefined) continue;
    const path = line.slice(header.length).trim();
    if (path !== "") paths.add(resolve(cwd, path));
  }
  return [...paths];
}

/** Reads one hook payload. A call majhi cannot read is denied, never let through. */
export function readHook(payload: CodexHookPayload, known: HookKnown): HookRead {
  const { tool_name: name } = payload;
  const toolCallId = payload.tool_use_id === undefined ? {} : { toolCallId: payload.tool_use_id };
  if (name === "Bash" || name === "apply_patch") {
    const input = CodexHookCommandInputSchema.safeParse(payload.tool_input);
    if (!input.success) {
      return { kind: "deny", reason: `majhi could not read the input of ${name}, so the call did not run.` };
    }
    const { command } = input.data;
    if (name === "Bash") {
      return {
        kind: "ask",
        ask: { ...toolCallId, title: command, kind: "execute", command, options: OPTIONS },
      };
    }
    const locations = patchPaths(command, payload.cwd);
    if (locations.length === 0) {
      return {
        kind: "deny",
        reason: "majhi could not tell which files this patch changes, so it did not run.",
      };
    }
    return {
      kind: "ask",
      ask: {
        ...toolCallId,
        title: `Edit ${locations.join(", ")}`,
        kind: "edit",
        locations,
        options: OPTIONS,
      },
    };
  }
  if (name.startsWith("mcp__")) {
    const tool = mcpNamesOf(name, known);
    if (tool === undefined) {
      return {
        kind: "deny",
        reason: `majhi could not read the MCP tool name ${name}, so the call did not run.`,
      };
    }
    return {
      kind: "ask",
      ask: { ...toolCallId, title: `mcp__${tool.server}__${tool.tool}`, options: OPTIONS },
    };
  }
  if (CODEX_OWN_TOOLS.has(name)) return { kind: "allow" };
  return { kind: "deny", reason: `majhi does not know the Codex tool ${name}, so it did not run.` };
}

const refused = (reason: string): CodexHookVerdict => ({ decision: "deny", reason });

/** Never aborts: a card stays in the room when the hook that asked gave up waiting. */
const STAYS = new AbortController().signal;

/**
 * Answers Codex's hook with what the owner and the workspace's rules say. The hook script gives up after its own
 * deadline (docker/codex/hook.mjs), because Codex lets a call run when its hook times out: the script denies, and
 * the card stays. The owner's answer waits here for the same call, so the next try of the exact same call gets it
 * without a second card: allowed once, or refused once.
 */
export class CodexHookGate {
  /** The questions still open or answered and not yet collected, by agent and exact call. */
  private readonly waiting = new Map<string, Promise<CodexHookVerdict>>();

  constructor(
    private readonly deps: {
      run(task: string, agent: string): AgentRun | undefined;
      ask(run: AgentRun, ask: PermissionAsk, signal: AbortSignal): Promise<string | undefined>;
    },
  ) {}

  /** Resolves with the verdict, or undefined when `signal` aborts first: the hook went away and the card stays. */
  async decide(
    caller: ToolCaller,
    payload: CodexHookPayload,
    signal?: AbortSignal,
  ): Promise<CodexHookVerdict | undefined> {
    const run = this.deps.run(caller.task, caller.agent);
    if (run?.session === undefined) {
      return refused("majhi has no live run for this agent, so the call did not run.");
    }
    const read = readHook(payload, { servers: run.tools, connections: run.connections?.gate ?? [] });
    if (read.kind === "allow") return { decision: "allow" };
    if (read.kind === "deny") return refused(read.reason);
    const key = JSON.stringify([caller.task, caller.agent, payload.tool_name, payload.tool_input]);
    let entry = this.waiting.get(key);
    if (entry === undefined) {
      entry = this.open(run, read.ask);
      this.waiting.set(key, entry);
    }
    const verdict = await untilAborted(entry, signal);
    if (verdict !== undefined && this.waiting.get(key) === entry) this.waiting.delete(key);
    return verdict;
  }

  /** The session ended: its open questions and uncollected answers go with it. */
  forget(task: string, agent: string): void {
    const prefix = `${JSON.stringify([task, agent]).slice(0, -1)},`;
    for (const key of [...this.waiting.keys()]) if (key.startsWith(prefix)) this.waiting.delete(key);
  }

  private open(run: AgentRun, ask: PermissionAsk): Promise<CodexHookVerdict> {
    return this.deps.ask(run, ask, STAYS).then(
      (option): CodexHookVerdict => {
        if (option === ALLOW) return { decision: "allow" };
        return refused(
          option === DENY
            ? "The owner denied this in majhi."
            : "majhi withdrew the question, because the run ended or the owner stopped it.",
        );
      },
      () => refused("majhi could not ask the owner, so the call did not run."),
    );
  }
}

/** The promise's value, or undefined when the signal aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((done) => {
    const gone = () => done(undefined);
    signal.addEventListener("abort", gone, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", gone);
      done(value);
    });
  });
}
