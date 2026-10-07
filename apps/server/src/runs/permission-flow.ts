import type { PermissionAsk } from "@majhi/acp";
import { type CommandMeta, MAJHI_OPTION_PREFIX, type RoomItem } from "@majhi/shared";
import type { GateWrite } from "../connections/gate.ts";
import { redactSecrets } from "../connections/redact.ts";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { permissionPayload } from "./items.ts";
import type { RunLive } from "./live.ts";
import {
  connectionToolKey,
  connectionVerdict,
  decidePermission,
  toolAllowKey,
  withoutUnaskedModes,
} from "./permissions.ts";
import type { AgentRun } from "./run.ts";

/** The options majhi adds to the card of a non-destructive MCP tool write, beside the agent's own. */
const TASK_OPTION = `${MAJHI_OPTION_PREFIX}task`;
const ALWAYS_OPTION = `${MAJHI_OPTION_PREFIX}always`;
const READS_OPTION = `${MAJHI_OPTION_PREFIX}reads`;

/** The part of the connections service a card's "Always allow" and "It only reads" use. */
export interface ConnectionToolRules {
  addTool(id: string, tool: string, as: "allow" | "read", command: string, meta: CommandMeta): Promise<void>;
}

/**
 * Permission requests from agents (SPEC 5.15): allowed by the agent's perms or an earlier "Allow
 * for this task", else a prompt in the room that waits for the owner. Every decision is logged.
 * For a run that holds connections the gate comes first (5.14): reads of them run, and a write runs
 * only when the connection's `allow` holds it or the owner says so, once. Perms and remembered
 * choices never cover a connection write, and each one is an audit row of kind `connection-write`.
 * The exception is a call of an MCP tool that is not destructive: its card also offers "Allow in this
 * task" (kept for that connection and tool in this task only), and, to the owner alone, "Always allow
 * this tool" (the tool joins the connection's `allow`) and "It only reads" (it joins the connection's
 * read tools). A destructive write is never allowed by `allow` or a remembered choice, its card offers
 * only Allow once and Deny, and the captain cannot approve it: only the owner. The captain may pick
 * Allow once or Allow in this task, never the other two.
 */
export class PermissionFlow {
  constructor(
    private readonly deps: { store: Store; room: RoomService; connections?: ConnectionToolRules | undefined },
    private readonly live: RunLive,
    private readonly now: () => Date,
  ) {}

  /** The session's permission handler. Resolves with the option id, or undefined when cancelled. */
  ask(run: AgentRun, request: PermissionAsk, signal: AbortSignal): Promise<string | undefined> {
    const { store, room } = this.deps;
    const held = run.connections?.gate ?? [];
    // A run that holds connections never lets the CLI stop asking.
    const ask = held.length === 0 ? request : { ...request, options: withoutUnaskedModes(request.options) };
    const verdict = connectionVerdict(ask, held, (id) => run.mapper?.toolTitle(id));
    if (verdict.kind === "write") return this.askWrite(run, ask, verdict.writes, signal);
    const once = ask.options.find((o) => o.kind === "allow_once");
    const decision =
      verdict.kind === "read" && once !== undefined
        ? ({ action: "allow", option: once.id, via: "perms" } as const)
        : decidePermission(ask, {
            perms: run.perms,
            rememberedFor: (k) => store.permissions.allowed(run.task, k),
          });
    const id = `perm:${run.runId ?? "x"}:${++run.permSeq}`;
    const base = {
      type: "permission" as const,
      agent: run.agent,
      title: ask.title,
      ...(ask.toolCallId === undefined ? {} : { toolCallId: ask.toolCallId }),
      options: ask.options,
    };
    if (decision.action === "allow") {
      room.post(run.task, id, { ...base, state: "auto", chosen: decision.option });
      this.log(run, ask, "allow", "rule");
      return Promise.resolve(decision.option);
    }
    room.post(run.task, id, { ...base, state: "pending" });
    this.live.set(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask, resolve });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
  }

  /** A connection write: allowed by the connection's `allow`, else a prompt that names the connection. */
  askWrite(
    run: AgentRun,
    ask: PermissionAsk,
    writes: readonly GateWrite[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const { room } = this.deps;
    const id = `perm:${run.runId ?? "x"}:${++run.permSeq}`;
    const once = ask.options.find((o) => o.kind === "allow_once");
    const first = writes[0];
    const name = run.connections?.uses.find((u) => u.id === first?.connection)?.name;
    const connection = {
      ...(first?.connection === undefined ? {} : { id: first.connection }),
      name: name ?? first?.connection ?? "a connection",
      action: writes.map((w) => w.action).join("; "),
      why: first?.why ?? "it may change something",
      ...(writes.some((w) => w.destructive) ? { destructive: true } : {}),
    };
    const base = {
      type: "permission" as const,
      agent: run.agent,
      title: ask.title,
      ...(ask.toolCallId === undefined ? {} : { toolCallId: ask.toolCallId }),
      connection,
    };
    const tool = toolWriteOf(writes);
    const remembered = tool !== undefined && this.deps.store.permissions.allowed(run.task, toolKey(tool));
    if (once !== undefined && (writes.every((w) => w.allowed) || remembered)) {
      room.post(run.task, id, { ...base, options: ask.options, state: "auto", chosen: once.id });
      this.logWrites(run, writes, "allow", "rule");
      return Promise.resolve(once.id);
    }
    // The agent's own "allow always" is dropped: it would let the CLI run the call again without asking.
    // A tool write gets majhi's own choices instead, which majhi keeps and enforces.
    const kept = once === undefined ? ask.options : ask.options.filter((o) => o.kind !== "allow_always");
    const options =
      once === undefined || tool === undefined
        ? kept
        : kept.flatMap((o) => (o.id === once.id ? [o, ...TOOL_OPTIONS] : [o]));
    room.post(run.task, id, { ...base, options, state: "pending" });
    this.live.set(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask: { ...ask, options }, resolve, writes });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
  }

  /** The owner picked one of the prompt's options. */
  answer(run: AgentRun | undefined, task: string, itemId: string, option: string, captain = false): RoomItem {
    const { store, room } = this.deps;
    const pending = run?.pending.get(itemId);
    const item = room.get(task, itemId);
    if (run === undefined || pending === undefined || item === undefined || item.type !== "permission") {
      throw new UserError("That prompt is not waiting for an answer any more.", 409);
    }
    const chosen = pending.ask.options.find((o) => o.id === option);
    if (chosen === undefined) {
      throw new UserError(
        `"${option}" is not one of the options: ${pending.ask.options.map((o) => o.id).join(", ")}.`,
      );
    }
    const allowed = chosen.kind === "allow_once" || chosen.kind === "allow_always";
    const mine = chosen.id.startsWith(MAJHI_OPTION_PREFIX);
    const tool = mine ? toolWriteOf(pending.writes ?? []) : undefined;
    // majhi's own choices are only on a tool write, and the permanent ones are the owner's.
    if (mine && tool === undefined) throw new UserError("That choice does not fit this prompt.", 409);
    if (mine && captain && chosen.id !== TASK_OPTION) {
      throw new UserError("Only the owner can make that choice.", 409);
    }
    if (captain && allowed && pending.writes?.some((w) => w.destructive) === true) {
      throw new UserError("This deletes or destroys something. Only the owner can approve it.", 409);
    }
    // majhi's choices all let this one call through: the agent is told the once-option.
    const resolveWith = mine
      ? (pending.ask.options.find((o) => o.kind === "allow_once")?.id ?? chosen.id)
      : chosen.id;
    run.pending.delete(itemId);
    const by = captain ? "captain" : "owner";
    if (tool !== undefined) this.remember(run, tool, chosen.id);
    if (pending.writes !== undefined) {
      this.logWrites(run, pending.writes, allowed ? "allow" : "deny", by);
    } else {
      this.log(run, pending.ask, allowed ? "allow" : "deny", by);
      // The captain's Allow for this task covers the one tool it was asked about; the owner's covers its kind.
      if (chosen.kind === "allow_always") {
        store.permissions.allow(
          task,
          captain ? toolAllowKey(pending.ask.title) : (pending.ask.kind ?? "other"),
        );
      }
    }
    room.post(item.task, itemId, {
      ...permissionPayload(item, { state: "answered", chosen: option }),
      ...(captain ? { by: "captain" as const } : {}),
    });
    pending.resolve(resolveWith);
    this.backToWork(run);
    const updated = room.get(task, itemId);
    if (updated === undefined) throw new Error("The prompt was not stored");
    return updated;
  }

  /** What one of majhi's choices on a tool write keeps: this task's memory, or the connection's own lists. */
  private remember(run: AgentRun, tool: ToolWrite, choice: string): void {
    if (choice === TASK_OPTION) {
      this.deps.store.permissions.allow(run.task, toolKey(tool));
      return;
    }
    const as = choice === ALWAYS_OPTION ? "allow" : choice === READS_OPTION ? "read" : undefined;
    if (as === undefined) return;
    const meta: CommandMeta = {
      actor: { kind: "owner" },
      reason:
        as === "allow" ? "Owner chose Always allow this tool on a card" : "Owner said a tool only reads",
      task: run.task,
    };
    // The call is already let through. If the list cannot be saved, the next call asks again.
    void this.deps.connections
      ?.addTool(
        tool.connection,
        tool.name,
        as,
        as === "allow" ? "connections.allow" : "connections.edit",
        meta,
      )
      .catch(() => undefined);
  }

  /** Withdraws every prompt of the run that still waits. */
  cancelAll(run: AgentRun): void {
    for (const id of [...run.pending.keys()]) this.cancelOne(run, id);
  }

  /** Marks one pending prompt cancelled and releases the agent's wait. */
  private cancelOne(run: AgentRun, id: string): void {
    const pending = run.pending.get(id);
    if (pending === undefined) return;
    run.pending.delete(id);
    const item = this.deps.room.get(run.task, id);
    if (item !== undefined && item.type === "permission") {
      this.deps.room.post(item.task, id, permissionPayload(item, { state: "cancelled" }));
    }
    if (pending.writes !== undefined) this.logWrites(run, pending.writes, "cancelled", "owner");
    else this.log(run, pending.ask, "cancelled", "owner");
    pending.resolve(undefined);
    this.backToWork(run);
  }

  private backToWork(run: AgentRun): void {
    if (run.pending.size === 0 && run.live.status === "waiting") this.live.set(run, { status: "working" });
  }

  /** One `connection-write` row per write, under the connection's own org. */
  private logWrites(
    run: AgentRun,
    writes: readonly GateWrite[],
    decision: "allow" | "deny" | "cancelled",
    by: "owner" | "rule" | "captain",
  ): void {
    for (const write of writes) {
      const org = run.connections?.uses.find((u) => u.id === write.connection)?.org;
      this.deps.store.permissions.log({
        task: run.task,
        agent: run.agent,
        kind: "connection-write",
        title: redactSecrets(write.action, run.connections?.secrets ?? []),
        decision,
        by,
        at: this.now().toISOString(),
        ...(org === undefined ? {} : { org }),
        detail: redactSecrets(
          `${write.connection ?? "a connection"}: ${write.action}`,
          run.connections?.secrets ?? [],
        ),
      });
    }
  }

  private log(
    run: AgentRun,
    ask: PermissionAsk,
    decision: "allow" | "deny" | "cancelled",
    by: "owner" | "rule" | "captain",
  ): void {
    this.deps.store.permissions.log({
      task: run.task,
      agent: run.agent,
      kind: ask.kind ?? "other",
      title: redactSecrets(ask.title, run.connections?.secrets ?? []),
      decision,
      by,
      at: this.now().toISOString(),
    });
  }
}

const TOOL_OPTIONS = [
  { id: TASK_OPTION, name: "Allow in this task", kind: "allow_always" as const },
  { id: ALWAYS_OPTION, name: "Always allow this tool", kind: "allow_always" as const },
  { id: READS_OPTION, name: "It only reads", kind: "allow_always" as const },
];

interface ToolWrite {
  connection: string;
  name: string;
}

/** The one MCP tool a prompt is about, when it is a write that is not destructive. Else undefined. */
function toolWriteOf(writes: readonly GateWrite[]): ToolWrite | undefined {
  const [only] = writes;
  if (writes.length !== 1 || only === undefined) return undefined;
  if (only.tool === undefined || only.connection === undefined || only.destructive) return undefined;
  return { connection: only.connection, name: only.tool };
}

const toolKey = (tool: ToolWrite): string => connectionToolKey(tool.connection, tool.name);
