import type { PermissionAsk } from "@majhi/acp";
import {
  type AllowRule,
  type AuthorityLevel,
  type CommandMeta,
  caseOf,
  currentRules,
  DEFAULT_LEVEL,
  isAlwaysKind,
  MAJHI_OPTION_PREFIX,
  PRIVATE,
  RISK_LABEL,
  type RiskKind,
  type RoomItem,
  riskVerdict,
  ruleCovers,
  withRule,
} from "@majhi/shared";
import { incidentShipsOf, levelOf } from "../captain/levels.ts";
import type { ConfigService } from "../config/service.ts";
import type { GateWrite } from "../connections/gate.ts";
import { redactSecrets } from "../connections/redact.ts";
import { UserError } from "../errors.ts";
import { isIncidentTask } from "../incident/engine.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomPayload, Store } from "../store/index.ts";
import { permissionPayload } from "./items.ts";
import type { RunLive } from "./live.ts";
import { connectionToolKey, connectionVerdict, riskAllowKey, withoutUnaskedModes } from "./permissions.ts";
import { requestRisk } from "./request-risk.ts";
import type { AgentRun } from "./run.ts";
import { SandboxLog } from "./sandbox-log.ts";
import { riskScopeOfTask } from "./shell-risk.ts";

/** The options majhi adds to a card, beside the agent's own. */
const TASK_OPTION = `${MAJHI_OPTION_PREFIX}task`;
const ALWAYS_OPTION = `${MAJHI_OPTION_PREFIX}always`;
const READS_OPTION = `${MAJHI_OPTION_PREFIX}reads`;

/** The part of the connections service a card's "Always allow" and "It only reads" use. */
export interface ConnectionToolRules {
  addTool(id: string, tool: string, as: "allow" | "read", command: string, meta: CommandMeta): Promise<void>;
}

/**
 * Permission requests from agents (SPEC 5.15, docs/briefs/workflow-reset.md step 1b): each request has a risk
 * kind, read from its typed parts (`request-risk.ts`), and the workspace's one authority level says which
 * kinds go ahead. What is inside the task never asks and leaves one log row per kind per minute. A kind the
 * level does not allow waits in the room for the owner, who can allow it once, for this task, or "Always" in
 * this workspace for the kinds that can be saved. Kinds that always ask (deleting outside the task, secrets, a
 * client's server) offer Allow once and Deny only.
 * For a run that holds connections the gate comes first (5.14): reads of them run, and a write runs only
 * when the connection's `allow` holds it or the owner says so, once. Each is an audit row of kind
 * `connection-write`. A call of an MCP tool that is not destructive also offers "Allow in this task" (kept for
 * that connection and tool in this task only), and, to the owner alone, "Always allow this tool" (the tool
 * joins the connection's `allow`) and "It only reads" (it joins the connection's read tools). A destructive
 * write is never allowed by `allow` or a remembered choice, its card offers only Allow once and Deny.
 * The captain answers no permission card: a card exists because the level does not cover it.
 */
export class PermissionFlow {
  private readonly sandbox: SandboxLog;

  constructor(
    private readonly deps: {
      store: Store;
      room: RoomService;
      connections?: ConnectionToolRules | undefined;
      /** Where the level, the incident switches and the saved Always rules are read, and where Always is saved. */
      config?: ConfigService | undefined;
      /** A card for the owner appeared or went: the captain's status (what a waiting message waits on) is read again. */
      onCardChange?: (() => void) | undefined;
    },
    private readonly live: RunLive,
    private readonly now: () => Date,
  ) {
    this.sandbox = new SandboxLog((row) => deps.store.permissions.log(row), now);
  }

  /** The session's permission handler. Resolves with the option id, or undefined when cancelled. */
  async ask(run: AgentRun, request: PermissionAsk, signal: AbortSignal): Promise<string | undefined> {
    const { store, room } = this.deps;
    const held = run.connections?.gate ?? [];
    // A run that holds connections never lets the CLI stop asking.
    const ask = held.length === 0 ? request : { ...request, options: withoutUnaskedModes(request.options) };
    const verdict = connectionVerdict(ask, held, (id) => run.mapper?.toolTitle(id));
    if (verdict.kind === "write") return this.askWrite(run, ask, verdict.writes, signal);
    const once = ask.options.find((o) => o.kind === "allow_once");
    const task = store.tasks.get(run.task);
    const org = task?.org ?? PRIVATE;
    const kind = requestRisk(ask, riskScopeOfTask(task));
    const { level, rules, incident } = await this.policyOf(org);
    const go = riskVerdict(level, rules, org, kind, {
      incident,
      incidentFix: task !== undefined && isIncidentTask(task),
    });
    const keptForTask =
      !go.go && isAlwaysKind(kind) && store.permissions.allowed(run.task, riskAllowKey(kind));
    const id = `perm:${run.runId ?? "x"}:${++run.permSeq}`;
    const base = {
      type: "permission" as const,
      agent: run.agent,
      title: ask.title,
      ...(ask.toolCallId === undefined ? {} : { toolCallId: ask.toolCallId }),
      risk: kind,
      options: ask.options,
    };
    if (once !== undefined && (go.go || keptForTask)) {
      if (kind === "sandbox") {
        this.sandbox.note({
          task: run.task,
          agent: run.agent,
          kind: ask.kind ?? "other",
          title: redactSecrets(ask.title, run.connections?.secrets ?? []),
          org,
        });
      } else {
        room.post(run.task, id, { ...base, state: "auto", chosen: once.id });
        this.log(run, ask, "allow", "rule", go.go && go.by === "rule" ? "Always" : "level");
      }
      return Promise.resolve(once.id);
    }
    const refused = this.refusedInCase(run, ask, id, base);
    if (refused !== undefined) return refused;
    const options = this.cardOptions(ask.options, once?.id, kind);
    room.post(run.task, id, { ...base, options, state: "pending" });
    this.deps.onCardChange?.();
    this.live.set(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask: { ...ask, options }, resolve, risk: kind });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
  }

  /**
   * A helper in a client case never asks the owner (docs/briefs/instructions.md): what the level does not allow is
   * refused, with the card left as a line that says so, and the captain decides what to do about it. Resolves with
   * the refusing option, or undefined when the run is not a case's.
   */
  private refusedInCase(
    run: AgentRun,
    ask: PermissionAsk,
    id: string,
    base: Omit<Extract<RoomPayload, { type: "permission" }>, "state" | "options" | "chosen">,
  ): Promise<string | undefined> | undefined {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined || caseOf(task) === undefined) return undefined;
    const no = ask.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
    this.deps.room.post(run.task, id, {
      ...base,
      options: ask.options,
      state: "auto",
      ...(no === undefined ? {} : { chosen: no.id }),
    });
    this.deps.room.post(run.task, `case-no:${id}`, {
      type: "system",
      level: "info",
      text: `@${run.agent} asked for "${ask.title}", which the workspace's level does not allow. A helper in a case does not ask the owner: it was refused. The captain decides.`,
    });
    return Promise.resolve(no?.id);
  }

  /** The workspace's level, its saved Always rules and its incident switches, from the cached settings. */
  private async policyOf(org: string): Promise<{
    level: AuthorityLevel;
    rules: AllowRule[];
    incident: ReturnType<typeof incidentShipsOf>;
  }> {
    const config = this.deps.config;
    if (config === undefined) return { level: DEFAULT_LEVEL, rules: [], incident: {} };
    const { autonomy, policy } = await config.settings();
    return {
      level: levelOf(autonomy, org),
      rules: currentRules(policy),
      incident: incidentShipsOf(autonomy, org),
    };
  }

  /**
   * The options of a card for a kind the level does not allow. The kinds that can be saved offer Allow in
   * this task and Always in this workspace; the others offer the agent's own Allow once and Deny only, because
   * the agent's own "allow always" would let its CLI stop asking where majhi cannot see.
   */
  private cardOptions(
    own: PermissionAsk["options"],
    onceId: string | undefined,
    kind: RiskKind,
  ): PermissionAsk["options"] {
    if (onceId === undefined) return own;
    const kept = own.filter((o) => o.kind !== "allow_always");
    if (!isAlwaysKind(kind)) return kept;
    return kept.flatMap((o) =>
      o.id === onceId
        ? [
            o,
            { id: TASK_OPTION, name: "Allow in this task", kind: "allow_always" as const },
            {
              id: ALWAYS_OPTION,
              name: `Always ${RISK_LABEL[kind]} in this workspace`,
              kind: "allow_always" as const,
            },
          ]
        : [o],
    );
  }

  /** A connection write: allowed by the connection's `allow`, else a prompt that names the connection. */
  async askWrite(
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
      risk: "client-server-write" as const,
      connection,
    };
    const tool = toolWriteOf(writes);
    const remembered = tool !== undefined && this.deps.store.permissions.allowed(run.task, toolKey(tool));
    if (once !== undefined && (writes.every((w) => w.allowed) || remembered)) {
      room.post(run.task, id, { ...base, options: ask.options, state: "auto", chosen: once.id });
      this.logWrites(run, writes, "allow", "rule");
      return Promise.resolve(once.id);
    }
    const refused = this.refusedInCase(run, ask, id, base);
    if (refused !== undefined) return refused;
    // The agent's own "allow always" is dropped: it would let the CLI run the call again without asking.
    // A tool write gets majhi's own choices instead, which majhi keeps and enforces.
    const kept = once === undefined ? ask.options : ask.options.filter((o) => o.kind !== "allow_always");
    const options =
      once === undefined || tool === undefined
        ? kept
        : kept.flatMap((o) => (o.id === once.id ? [o, ...TOOL_OPTIONS] : [o]));
    room.post(run.task, id, { ...base, options, state: "pending" });
    this.deps.onCardChange?.();
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
    // A card is there because the workspace's level does not cover the action: the owner answers it.
    if (captain) throw new UserError("This is above the workspace's level. Only the owner answers it.", 409);
    const chosen = pending.ask.options.find((o) => o.id === option);
    if (chosen === undefined) {
      throw new UserError(
        `"${option}" is not one of the options: ${pending.ask.options.map((o) => o.id).join(", ")}.`,
      );
    }
    const allowed = chosen.kind === "allow_once" || chosen.kind === "allow_always";
    const mine = chosen.id.startsWith(MAJHI_OPTION_PREFIX);
    const tool = mine ? toolWriteOf(pending.writes ?? []) : undefined;
    const kind = pending.risk;
    // majhi's own choices are only on a tool write or on a kind that can be saved.
    if (mine && tool === undefined && (kind === undefined || !isAlwaysKind(kind))) {
      throw new UserError("That choice does not fit this prompt.", 409);
    }
    // majhi's choices all let this one call through: the agent is told the once-option.
    const resolveWith = mine
      ? (pending.ask.options.find((o) => o.kind === "allow_once")?.id ?? chosen.id)
      : chosen.id;
    run.pending.delete(itemId);
    if (tool !== undefined) this.remember(run, tool, chosen.id);
    if (pending.writes !== undefined) {
      this.logWrites(run, pending.writes, allowed ? "allow" : "deny", "owner");
    } else {
      this.log(run, pending.ask, allowed ? "allow" : "deny", "owner");
      if (allowed && kind !== undefined && isAlwaysKind(kind)) {
        if (chosen.id === ALWAYS_OPTION) this.keepRule(run, kind);
        else if (chosen.kind === "allow_always") store.permissions.allow(task, riskAllowKey(kind));
      }
    }
    room.post(item.task, itemId, permissionPayload(item, { state: "answered", chosen: option }));
    pending.resolve(resolveWith);
    this.backToWork(run);
    this.deps.onCardChange?.();
    const updated = room.get(task, itemId);
    if (updated === undefined) throw new Error("The prompt was not stored");
    return updated;
  }

  /** Saves "Always" for the kind in the task's workspace: one rule per workspace and kind. If it cannot be saved, the next one asks again. */
  private keepRule(run: AgentRun, kind: RiskKind): void {
    const config = this.deps.config;
    if (config === undefined || !isAlwaysKind(kind)) return;
    const org = this.deps.store.tasks.get(run.task)?.org ?? PRIVATE;
    void (async () => {
      const { policy } = await config.settings();
      const rules = currentRules(policy);
      if (ruleCovers(rules, org, kind)) return;
      await config.setSettings(
        { policy: { rules: withRule(rules, { org, kind }) } },
        {
          command: "policy.set",
          meta: {
            actor: { kind: "owner" },
            reason: "Owner chose Always on a card",
            task: run.task,
          },
          summary: `always ${RISK_LABEL[kind]} in ${org}`,
        },
      );
    })().catch(() => undefined);
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
    this.deps.onCardChange?.();
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
    detail?: string,
  ): void {
    this.deps.store.permissions.log({
      task: run.task,
      agent: run.agent,
      kind: ask.kind ?? "other",
      title: redactSecrets(ask.title, run.connections?.secrets ?? []),
      decision,
      by,
      at: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
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
