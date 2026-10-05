import { randomUUID } from "node:crypto";
import {
  type AllowRule,
  AUTONOMY_BOSS_COMMANDS,
  type AutonomyMode,
  type CommandMeta,
  type CommandName,
  type ConnectionTestResult,
  commands,
  effectiveMode,
  IdSchema,
  isDestructiveCommand,
  McpInstallResultSchema,
  PERMISSION_COMMANDS,
  PRIVATE,
  type RoomItem,
  type ShipFix,
  scriptProblem,
  type TaskId,
} from "@majhi/shared";
import { z } from "zod";
import { auditDetail } from "../audit.ts";
import type { AutonomyVerdict } from "../autonomy/policy.ts";
import { authorityOf, keptRowOf } from "../captain/levels.ts";
import type { Dispatch } from "../commands/dispatch.ts";
import type { ChangeRecord, ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import { FINDINGS_TOOL_COMMANDS } from "../findings/handlers.ts";
import { HANDOFF_TOOL_COMMANDS } from "../handoff/handlers.ts";
import { OUTCOMES_TOOL_COMMANDS } from "../outcomes/handlers.ts";
import { PLAYBOOK_TOOL_COMMANDS, playbookLimitRefusal } from "../playbooks/handlers.ts";
import type { RoomService } from "../room/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";
import { startingBranches } from "../tasks/brief.ts";
import type { TaskService } from "../tasks/service.ts";
import {
  fetchedValue,
  SAVE_FROM_SCRIPT_TOOL,
  SaveFromScriptInputSchema,
  type ScriptFetch,
  WITHDRAW_SECRET_TOOL,
  WithdrawSecretInputSchema,
} from "./fetch-secret.ts";
import {
  CLIPBOARD_COPY_TOOL,
  ClipboardCopyInputSchema,
  type ClipboardCopier,
  pickValue,
  readInRoots,
} from "./clipboard-copy.ts";
import { decide as decideMode, matchRule, redact, redactOutput, redactText, sameRule } from "./policy.ts";
import { summarize } from "./summary.ts";
import type { AdminCaller } from "./tokens.ts";
import { adminTools, REQUEST_SECRET_TOOL } from "./tools.ts";

export interface ToolResult {
  text: string;
  isError: boolean;
}

export const WAITING_TEXT =
  "Waiting for the owner to approve in the room. You will get a message with the decision.";

/** Autonomous mode's tools for the captain (PRV-74, rule 9). */
const BOSS_TOOLS: ReadonlySet<string> = new Set(AUTONOMY_BOSS_COMMANDS);

/** How much of a command's output an agent gets back. */
const RESULT_MAX = 20_000;
/** How much of it a card shows. */
const LINE_MAX = 240;

type ApprovalItem = Extract<RoomItem, { type: "approval" }>;
type SecretRequestItem = Extract<RoomItem, { type: "secret-request" }>;

/** Who ends a secret request without an answer, and the one line they gave. */
export interface Dismissal {
  by: "owner" | "captain";
  reason?: string | undefined;
}

export interface AdminDeps {
  config: ConfigService;
  room: RoomService;
  store: Store;
  secrets: SecretStore;
  tasks: TaskService;
}

/**
 * What autonomous mode (PRV-74) sees and decides of agents' calls: whether a caller acts for it,
 * the hard limits, the self-approval of cards within its limits, and the feed.
 */
export interface AutonomyGate {
  callerKind(caller: AdminCaller): Promise<"boss" | "agent" | undefined>;
  mode(): AutonomyMode;
  refusal(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<string | undefined>;
  blockedStart(command: string, input: Record<string, unknown>): string | undefined;
  heldStart(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    raw: Record<string, unknown>,
  ): Promise<string | undefined>;
  /**
   * The captain's call that would start a task while no agent slot is free for its accounts: the
   * line that says so, ending with what happens to the task. Undefined when there is room, or the
   * call is no captain's start.
   */
  noRoom(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
  ): Promise<string | undefined>;
  /**
   * The captain's create or start that names no team: the input with the team staffing picked, the
   * same input when the team was set on the task already, or undefined when staffing does not apply.
   */
  staffCall(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  decide(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    raw: Record<string, unknown>,
    ask: { confirm: boolean; reason: string },
  ): Promise<AutonomyVerdict>;
  ran(caller: AdminCaller, command: CommandName, input: unknown, reason: string, done: Outcome): void;
  approved(
    caller: AdminCaller,
    command: CommandName,
    input: unknown,
    why: string,
    reason: string,
    item: string,
    done: Outcome,
  ): void;
  left(
    caller: AdminCaller,
    command: CommandName,
    input: unknown,
    why: string,
    reason: string,
    item: string,
  ): void;
  adopt(caller: "boss" | "agent", command: CommandName, output: unknown, reason?: string): void;
  bossTool(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<ToolResult>;
  /** What a captain lane may read (5.18): undefined when the task is no lane. */
  laneScope(task: string): Promise<LaneReads | undefined>;
}

/** One lane's reads: refused when they ask about another workspace, narrowed to its own rows. */
export interface LaneReads {
  refusal(input: Record<string, unknown>): string | undefined;
  input(command: CommandName, input: Record<string, unknown>): Record<string, unknown>;
  output(value: unknown): { value: unknown; refused?: string };
}

type Outcome = { ok: boolean; error?: string | undefined };

/**
 * What the captain (or any agent with majhi tools) can do: runs its tool calls through the command
 * dispatcher under the approval policy, posts an approval card for every change, and carries out
 * the owner's decision later (SPEC 5.16).
 */
export class AdminService {
  private dispatch: Dispatch | undefined;
  /** Inputs of pending calls, unredacted. A restart drops them; the card then cannot run secrets it hid. */
  private readonly pending = new Map<string, unknown>();
  private readonly deciding = new Set<string>();
  /** Cards the owner asked for in the room: they run as the owner, not as the agent they name. */
  private readonly ownerCards = new Set<string>();
  private readonly tools = new Map(adminTools().map((t) => [t.name, t]));
  private autonomy: AutonomyGate | undefined;
  private script: ScriptFetch | undefined;
  private clipboard: ClipboardCopier | undefined;

  constructor(private readonly deps: AdminDeps) {}

  /** The dispatcher is built after the handlers, which need this service. */
  bind(dispatch: Dispatch): void {
    this.dispatch = dispatch;
  }

  /** Autonomous mode is built after this service, which it decides for. */
  useAutonomy(gate: AutonomyGate): void {
    this.autonomy = gate;
  }

  /** The runner a captain's secret fetch uses: built after this service, from the connections. */
  useScript(script: ScriptFetch): void {
    this.script = script;
  }

  /** The host helper's clipboard: built after this service, from the helper link and the config. */
  useClipboard(clipboard: ClipboardCopier): void {
    this.clipboard = clipboard;
  }

  // ---------------------------------------------------------------------------
  // Agent calls

  /** One MCP tool call. Never throws: problems come back as an error result the agent can read. */
  async call(
    caller: AdminCaller,
    tool: string,
    args: Record<string, unknown>,
    /** `confirm`: always wait for the owner's click, whatever the policy, a saved rule or `ownerAsked` say. */
    options: { confirm?: boolean } = {},
  ): Promise<ToolResult> {
    try {
      if (tool === REQUEST_SECRET_TOOL) return this.requestSecret(caller, args);
      if (tool === SAVE_FROM_SCRIPT_TOOL) return await this.saveFromScript(caller, args);
      if (tool === CLIPBOARD_COPY_TOOL) return await this.copyToClipboard(caller, args);
      if (tool === WITHDRAW_SECRET_TOOL) return await this.withdrawRequest(caller, args);
      const spec = this.tools.get(tool);
      if (spec?.command === undefined) return error(`Unknown tool: ${tool}`);
      const { ownerAsked, reason, ...input } = args;
      const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
      // The captain's own tools in autonomous mode: no policy and no card, like a secret request.
      if (BOSS_TOOLS.has(spec.command)) {
        return (
          (await this.autonomy?.bossTool(caller, spec.command, input, why)) ?? error("Auto-pilot is off.")
        );
      }
      // Findings stay in the caller's own workspace (the handler scopes them), so no card waits for them.
      if (
        FINDINGS_TOOL_COMMANDS.has(spec.command) ||
        PLAYBOOK_TOOL_COMMANDS.has(spec.command) ||
        OUTCOMES_TOOL_COMMANDS.has(spec.command) ||
        HANDOFF_TOOL_COMMANDS.has(spec.command)
      ) {
        const checked = commands[spec.command].input.safeParse(input);
        if (!checked.success) {
          const details = checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
          return error(`Invalid input for ${spec.command}.\n${details.join("\n")}`);
        }
        const done = await this.execute(spec.command, input, metaFor(caller.agent, why, caller.task));
        return done.ok ? { text: textOf(done.output), isError: false } : error(done.error);
      }
      // The captain's note to a lead: no card waits for it. The handler checks who and where, and the
      // limit per task; the autonomy limits (workspace, secrets) hold for the captain first.
      if (spec.command === "tasks.tell") return await this.tell(caller, input, why);
      const refused = refuseForAgents(spec.command, input);
      if (refused !== undefined) return error(refused);
      return await this.callCommand(caller, spec.command, input, {
        ownerAsked: ownerAsked === true,
        reason: why,
        confirm: options.confirm === true,
      });
    } catch (err) {
      return error(errorMessage(err));
    }
  }

  /** `tasks.tell` from an agent's tool call. Only the captain in its lane gets as far as the handler. */
  private async tell(caller: AdminCaller, input: Record<string, unknown>, why: string): Promise<ToolResult> {
    const checked = commands["tasks.tell"].input.safeParse(input);
    if (!checked.success) {
      const details = checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return error(`Invalid input for tasks.tell.\n${details.join("\n")}`);
    }
    const auto = this.autonomy === undefined ? undefined : await this.autonomy.callerKind(caller);
    if (auto !== "boss" || this.autonomy === undefined) {
      return error(
        "tasks.tell is the captain's tool, in its workspace lane. Tell the lead through your own room instead.",
      );
    }
    const refused = await this.autonomy.refusal(caller, "tasks.tell", input, why);
    if (refused !== undefined) return error(refused);
    const done = await this.execute("tasks.tell", input, metaFor(caller.agent, why, caller.task));
    // A note that was not sent (a repeat) is no decision: nothing is logged as sent.
    if (!(done.ok && NotTold.safeParse(done.output).success)) {
      this.autonomy.ran(caller, "tasks.tell", input, why, done);
    }
    return done.ok ? { text: textOf(done.output), isError: false } : error(done.error);
  }

  /**
   * A command that majhi itself asks for on an agent's behalf, like allowing an image a service
   * needs. It goes through the approval policy as any call of that agent: a rule or an `auto`
   * mode runs it at once, otherwise a card waits (the text is `WAITING_TEXT`).
   */
  request(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<ToolResult> {
    return this.callCommand(caller, command, input, { ownerAsked: false, reason });
  }

  /**
   * Runs a command for an agent at once, whatever the approval policy says, because the caller
   * checked a rule the owner set (a lead starting a task under `lead_start`). It still leaves an
   * `applied` card in the agent's room. `accept` names a failure that is not one (a task that
   * waits on a dependency): the card shows it as applied and the agent gets `accepted` back.
   */
  async runAllowed(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    ask: { reason: string; accept?: (error: string) => boolean; accepted?: string },
  ): Promise<ToolResult> {
    const def = commands[command];
    const checked = def.input.safeParse(input);
    if (!checked.success) {
      const details = checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return error(`Invalid input for ${command}.\n${details.join("\n")}`);
    }
    const auto = this.autonomy === undefined ? undefined : await this.autonomy.callerKind(caller);
    if (auto !== undefined && this.autonomy !== undefined) {
      const parsed = checked.data as Record<string, unknown>;
      const refused =
        (await this.autonomy.refusal(caller, command, input, ask.reason)) ??
        this.autonomy.blockedStart(command, parsed) ??
        (await this.autonomy.heldStart(caller, command, parsed, input)) ??
        (await this.autonomy.noRoom(caller, command, input));
      if (refused !== undefined) return error(refused);
    }
    const done = await this.execute(command, input, metaFor(caller.agent, ask.reason, caller.task));
    const held = !done.ok && ask.accept?.(done.error) === true;
    this.deps.room.post(caller.task as TaskId, `approval:${randomUUID()}`, {
      ...cardOf(caller.agent, command, input, ask.reason),
      alone: true,
      state: done.ok || held ? "applied" : "failed",
      ...(done.commit === undefined ? {} : { commit: done.commit }),
      result: done.ok ? lineOf(done.output) : done.error,
    });
    if (held) return { text: ask.accepted ?? done.error, isError: false };
    return done.ok ? { text: textOf(done.output), isError: false } : error(done.error);
  }

  /**
   * Whether the owner gave the captain full access in the workspace of the caller's task, for this
   * command: merging and pushing still follow their own row.
   */
  private async fullAccess(caller: AdminCaller, command: string): Promise<boolean> {
    const org = this.deps.store.tasks.get(caller.task)?.org;
    if (org === undefined) return false;
    const { autonomy } = await this.deps.config.settings();
    if (autonomy.orgs[org]?.fullAccess !== true) return false;
    const row = keptRowOf(command);
    return row === undefined || authorityOf(autonomy, org)[row] === "decide";
  }

  private async callCommand(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    ask: { ownerAsked: boolean; reason: string; confirm?: boolean },
  ): Promise<ToolResult> {
    const def = commands[command];
    const checked = def.input.safeParse(input);
    if (!checked.success) {
      const details = checked.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return error(`Invalid input for ${command}.\n${details.join("\n")}`);
    }
    // A bad attachment fails now, not after the owner approved the card.
    await this.deps.tasks.checkAttachments(attachmentsOf(command, checked.data), caller.task);
    const parsed = checked.data as Record<string, unknown>;
    // The captain in its autonomy chat, or an agent of an autonomous task: the hard limits hold in
    // every mode, whatever a rule or an `auto` mode says (PRV-74).
    const autonomy = this.autonomy;
    const auto = autonomy === undefined ? undefined : await autonomy.callerKind(caller);
    if (auto !== undefined && autonomy !== undefined) {
      const refused =
        (await autonomy.refusal(caller, command, input, ask.reason)) ??
        autonomy.blockedStart(command, parsed);
      if (refused !== undefined) return error(refused);
      // The captain starts work only where a slot is free (5.17): a start would only wait in line.
      // A task it files stays in the backlog instead of starting.
      const full = await autonomy.noRoom(caller, command, input);
      if (full !== undefined) {
        if (command === "tasks.start") return error(full);
        const filed = await this.callCommand(caller, command, { ...input, start: false }, ask);
        return filed.isError ? filed : { ...filed, text: `${filed.text}\n${full}` };
      }
    }
    // The captain names no team: staffing weighs the agents and accounts of the workspace and picks one.
    if (autonomy !== undefined && auto === "boss") {
      const staffed = await autonomy.staffCall(caller, command, input);
      if (staffed !== undefined && staffed !== input) return this.callCommand(caller, command, staffed, ask);
    }
    const { policy } = await this.deps.config.settings();
    const mode = ask.confirm === true ? "confirm" : effectiveMode(policy, command, def.risk);
    const meta = metaFor(caller.agent, ask.reason, caller.task);
    // An agent's word that the owner asked counts only for low-risk changes, and for nothing in
    // autonomous mode: the owner is away.
    const ownerAsked = auto === undefined && ask.ownerAsked && !this.alwaysAsks(command, checked.data);
    // Full access in the caller's workspace: the captain's calls run without a card, except a change to
    // anyone's permissions and anything destructive, which follow the policy as always.
    const full =
      auto === "boss" &&
      ask.confirm !== true &&
      mode !== "confirm" &&
      !PERMISSION_COMMANDS.has(command) &&
      !isDestructiveCommand(command) &&
      (await this.fullAccess(caller, command));
    // A saved rule turns a card that would wait into a run. It is looked up only then.
    const decision = full ? "run" : decideMode(mode, ownerAsked);
    const rule =
      decision === "run" || ask.confirm === true
        ? undefined
        : matchRule(policy, {
            agent: caller.agent,
            command,
            task: caller.task,
            org: this.deps.store.tasks.get(caller.task)?.org,
          });
    if (decision === "run" || rule !== undefined) {
      // The owner's rule or `auto` mode runs it, but no cap or floor of autonomous mode is skipped.
      const held =
        auto === undefined || autonomy === undefined
          ? undefined
          : await autonomy.heldStart(caller, command, parsed, input);
      if (held !== undefined) return error(held);
      const done = await this.execute(command, input, meta);
      if (def.risk !== "read" && rule !== undefined) {
        this.log(
          caller.task,
          caller.agent,
          command,
          summarize(command, input),
          "allow",
          "rule",
          done.ok ? undefined : done.error,
        );
      }
      if (def.risk !== "read") {
        this.deps.room.post(caller.task as TaskId, `approval:${randomUUID()}`, {
          ...cardOf(caller.agent, command, input, ask.reason),
          alone: true,
          ...(rule === undefined
            ? {}
            : { rule: rule.task === undefined ? ("org" as const) : ("task" as const) }),
          state: done.ok ? "applied" : "failed",
          ...(done.commit === undefined ? {} : { commit: done.commit }),
          result: done.ok ? lineOf(done.output) : done.error,
        });
      }
      if (auto !== undefined && autonomy !== undefined) {
        autonomy.ran(caller, command, input, ask.reason, done);
        if (done.ok) autonomy.adopt(auto, command, done.output, ask.reason);
      }
      return done.ok ? { text: textOf(done.output), isError: false } : error(done.error);
    }
    // The owner is away: autonomous mode decides what would wait for them, within its limits.
    if (auto !== undefined && autonomy !== undefined && autonomy.mode() === "on") {
      return this.decideAutonomously(caller, auto, command, input, parsed, meta, ask);
    }
    const id = `approval:${randomUUID()}`;
    this.pending.set(id, input);
    this.deps.room.post(caller.task as TaskId, id, {
      ...cardOf(caller.agent, command, input, ask.reason),
      state: "pending",
    });
    return { text: WAITING_TEXT, isError: false };
  }

  /**
   * Autonomous mode's verdict on a call that would wait (PRV-74, rule 4). Approved: it runs, its card
   * is posted applied with the one-line why, and the audit says `autonomy`. Left: the card waits for
   * the owner with the why, and the caller hears it was left.
   */
  private async decideAutonomously(
    caller: AdminCaller,
    auto: "boss" | "agent",
    command: CommandName,
    input: Record<string, unknown>,
    parsed: Record<string, unknown>,
    meta: CommandMeta,
    ask: { reason: string; confirm?: boolean },
  ): Promise<ToolResult> {
    const autonomy = this.autonomy;
    if (autonomy === undefined) return error("Auto-pilot is not available.");
    const verdict = await autonomy.decide(caller, command, parsed, input, {
      confirm: ask.confirm === true,
      reason: ask.reason,
    });
    if (verdict.decision === "refused") return error(verdict.why);
    const id = `approval:${randomUUID()}`;
    const marker = { decision: verdict.decision, why: verdict.why };
    if (verdict.decision === "left") {
      this.pending.set(id, input);
      this.deps.room.post(caller.task as TaskId, id, {
        ...cardOf(caller.agent, command, input, ask.reason),
        state: "pending",
        autonomy: marker,
      });
      autonomy.left(caller, command, input, verdict.why, ask.reason, id);
      return { text: `Left for the owner: ${verdict.why}.`, isError: false };
    }
    const done = await this.execute(command, input, meta);
    this.log(
      caller.task,
      caller.agent,
      command,
      summarize(command, input),
      "allow",
      "autonomy",
      done.ok ? verdict.why : `${verdict.why}. Failed: ${done.error}`,
    );
    this.deps.room.post(caller.task as TaskId, id, {
      ...cardOf(caller.agent, command, input, ask.reason),
      alone: true,
      state: done.ok ? "applied" : "failed",
      autonomy: marker,
      ...(done.commit === undefined ? {} : { commit: done.commit }),
      result: done.ok ? lineOf(done.output) : done.error,
    });
    autonomy.approved(caller, command, input, verdict.why, ask.reason, id, done);
    if (done.ok) autonomy.adopt(auto, command, done.output, ask.reason);
    return done.ok ? { text: textOf(done.output), isError: false } : error(done.error);
  }

  /**
   * True for a call whose card shows even when the agent says the owner asked for it (`when-asked`):
   * see `ALWAYS_ASK`, and a task that attaches repos (`repos` on create or a split's child; for
   * `tasks.start`, a task that has repos or read mounts). Only the owner's own settings (an `auto` mode, a saved rule) skip the card.
   */
  private alwaysAsks(command: CommandName, input: unknown): boolean {
    if (ALWAYS_ASK.has(command)) return true;
    const fields = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (command === "orgs.update") return SENSITIVE_ORG_FIELDS.some((f) => fields[f] !== undefined);
    if (command === "tasks.start") {
      const task = typeof fields.id === "string" ? this.deps.store.tasks.get(fields.id) : undefined;
      return task === undefined || task.repos.length > 0 || (task.readMounts ?? []).length > 0;
    }
    const listsRepos = (value: unknown) =>
      typeof value === "object" && value !== null && Array.isArray((value as { repos?: unknown }).repos)
        ? (value as { repos: unknown[] }).repos.length > 0
        : false;
    if (command === "tasks.create") return listsRepos(fields);
    if (command === "tasks.split") return Array.isArray(fields.children) && fields.children.some(listsRepos);
    return false;
  }

  /**
   * A card for something the owner asked for in the room ("@agent install this skill ..."). It waits
   * like any other card. `input` is what runs on approval, as the owner; `details` is what the card
   * shows under Input, with no secrets.
   */
  offer(offer: {
    task: TaskId;
    agent: string;
    command: CommandName;
    input: Record<string, unknown>;
    summary: string;
    details: unknown;
    reason: string;
  }): RoomItem {
    const id = `approval:${randomUUID()}`;
    this.pending.set(id, offer.input);
    this.ownerCards.add(id);
    this.deps.room.post(offer.task, id, {
      type: "approval",
      agent: offer.agent,
      command: offer.command,
      risk: commands[offer.command].risk,
      summary: redactText(offer.summary),
      input: JSON.stringify(redact(offer.details), null, 2),
      reason: redactText(offer.reason),
      state: "pending",
    });
    return this.mustGet(offer.task, id);
  }

  private requestSecret(caller: AdminCaller, args: Record<string, unknown>): ToolResult {
    const name = IdSchema.safeParse(args.name);
    const label = typeof args.label === "string" ? args.label.trim().slice(0, 200) : "";
    if (!name.success) return error("name must be a lowercase id like newrelic-acme.");
    if (label === "") return error("label is required: say what the owner should paste.");
    this.deps.room.post(caller.task as TaskId, `secret:${randomUUID()}`, {
      type: "secret-request",
      agent: caller.agent,
      name: name.data,
      label: redactText(label),
      state: "pending",
    });
    return {
      text: `Asked the owner for ${label}. You will get a message when it is saved as secret:${name.data}.`,
      isError: false,
    };
  }

  /** The workspace the captain's lane works in, or why the caller is no captain in a lane. */
  private async laneOf(caller: AdminCaller, tool: string): Promise<{ org: string } | { problem: string }> {
    if ((await this.autonomy?.callerKind(caller)) !== "boss") {
      return { problem: `${tool} is the captain's tool, in its workspace lane.` };
    }
    return { org: this.deps.store.tasks.get(caller.task)?.org ?? PRIVATE };
  }

  /**
   * Fetches a secret through the workspace's connections: a read-only script runs in the runner with
   * them, and what it prints goes straight into the secret store. The value is never returned, put in
   * the room, the audit log or an error. The script is shown in the room and kept in the audit log.
   */
  private async saveFromScript(caller: AdminCaller, args: Record<string, unknown>): Promise<ToolResult> {
    const lane = await this.laneOf(caller, SAVE_FROM_SCRIPT_TOOL);
    if ("problem" in lane) return error(lane.problem);
    const parsed = SaveFromScriptInputSchema.safeParse(args);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return error(`Invalid input.\n${details.join("\n")}`);
    }
    const input = parsed.data;
    const script = this.script;
    if (script === undefined) return error("majhi problem: Docker is not available, so a script cannot run.");
    let request: SecretRequestItem | undefined;
    if (input.task !== undefined && input.item !== undefined) {
      const found = this.deps.room.get(input.task as TaskId, input.item);
      if (found?.type !== "secret-request" || found.state !== "pending") {
        return error("That request is not waiting for a secret.");
      }
      if ((this.deps.store.tasks.get(found.task)?.org ?? PRIVATE) !== lane.org) {
        return error("That request belongs to another workspace. Only its own captain fetches for it.");
      }
      if (found.bind !== undefined) {
        return error("That secret goes into a connection's own entry. The owner gives it on the card.");
      }
      request = found;
    }
    const name = request?.name ?? input.name;
    if (name === undefined) return error("Give the request or a name.");
    if ((await this.deps.secrets.get(name)) !== undefined) {
      return error(`secret:${name} exists already. Use it, or pick another name.`);
    }
    const guard = scriptProblem(input.script, input.network);
    if (guard !== undefined) return error(guard.replace("A watch only reads", "A fetch only reads"));
    for (const id of input.connections) {
      if (!(await script.holds(lane.org, id))) {
        return error(
          `This workspace has no connection ${id}. Only its own connections and Global ones are used.`,
        );
      }
    }
    let out: string;
    try {
      out = await script.run({
        org: lane.org,
        script: input.script,
        connections: input.connections,
        network: input.network,
      });
    } catch (err) {
      return error(`The script failed: ${redactText(errorMessage(err)).slice(0, 300)}`);
    }
    const got = fetchedValue(out);
    if ("problem" in got) return error(got.problem);
    const used = input.connections.length === 0 ? "" : ` with ${input.connections.join(", ")}`;
    this.log(
      caller.task,
      caller.agent,
      "secrets.saveFromScript",
      `fetch secret:${name}${used}`,
      "allow",
      "captain",
      input.script,
    );
    this.deps.room.post(caller.task as TaskId, `info:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: `Fetched secret:${name} with a script${used}. The value was saved, not shown. Script:\n${redactText(input.script)}`,
    });
    if (request !== undefined) {
      await this.answerSecret(
        request.task,
        request.id,
        got.value,
        "the captain fetched it through a connection",
      );
    } else {
      await this.deps.secrets.set(name, got.value);
    }
    return { text: `Saved as secret:${name}. The value is not shown.`, isError: false };
  }

  /**
   * Puts a saved secret, or one line of a file in the workspace's projects, on the owner's clipboard
   * through the host helper. The value is never returned, put in the room, the audit log or an error.
   */
  private async copyToClipboard(caller: AdminCaller, args: Record<string, unknown>): Promise<ToolResult> {
    const lane = await this.laneOf(caller, CLIPBOARD_COPY_TOOL);
    if ("problem" in lane) return error(lane.problem);
    const parsed = ClipboardCopyInputSchema.safeParse(args);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return error(`Invalid input.\n${details.join("\n")}`);
    }
    const input = parsed.data;
    if (input.ownerAsked !== true) {
      return error("Copy to the clipboard only when the owner asked for it in the conversation.");
    }
    const clipboard = this.clipboard;
    if (clipboard === undefined || !clipboard.available()) {
      return error("majhi problem: the host helper is not connected, so there is no clipboard to copy to.");
    }
    let value: string;
    let from: string;
    if (input.secret !== undefined) {
      const name = input.secret.replace(/^secret:/, "");
      const secret = await this.deps.secrets.get(name);
      if (secret === undefined) return error(`There is no secret:${name}.`);
      value = secret;
      from = `secret:${name}`;
    } else {
      const file = input.file as string;
      const line = input.line as number;
      const read = await readInRoots(file, await clipboard.roots(lane.org));
      if ("problem" in read) return error(read.problem);
      const picked = pickValue(read.text, line, input.part);
      if ("problem" in picked) return error(picked.problem);
      value = picked.value;
      from = `${file} line ${line}`;
    }
    const copied = await clipboard.copy(value).catch(() => false);
    if (!copied) {
      return error(
        "majhi problem: no clipboard program worked on the owner's computer, so nothing was copied.",
      );
    }
    this.log(caller.task, caller.agent, "clipboard.copy", `copy ${from}`, "allow", "captain");
    this.deps.room.post(caller.task as TaskId, `info:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: `Copied ${from} to the owner's clipboard. The value was not shown.`,
    });
    return {
      text: `Copied ${from} (${value.length} characters) to the owner's clipboard. The value is not shown.`,
      isError: false,
    };
  }

  /** The captain withdraws a pending secret request of its workspace, and the asking agent hears why. */
  private async withdrawRequest(caller: AdminCaller, args: Record<string, unknown>): Promise<ToolResult> {
    const lane = await this.laneOf(caller, WITHDRAW_SECRET_TOOL);
    if ("problem" in lane) return error(lane.problem);
    const parsed = WithdrawSecretInputSchema.safeParse(args);
    if (!parsed.success) return error("Give task, item and reason.");
    const { task, item, reason } = parsed.data;
    const found = this.deps.room.get(task as TaskId, item);
    if (found?.type !== "secret-request" || found.state !== "pending") {
      return error("That request is not waiting for a secret.");
    }
    if ((this.deps.store.tasks.get(found.task)?.org ?? PRIVATE) !== lane.org) {
      return error("That request belongs to another workspace.");
    }
    await this.cancelSecret(found, "reject", { by: "captain", reason });
    return { text: `Withdrew the request for secret:${found.name}.`, isError: false };
  }

  // ---------------------------------------------------------------------------
  // The owner's answers

  /** Approve or reject a pending approval card. Rejecting a secret request cancels it. */
  async decide(
    taskId: TaskId,
    itemId: string,
    decision: "approve" | "reject",
    always?: { scope: "task" | "org"; change: ChangeRecord },
    dismissal: Dismissal = { by: "owner" },
  ): Promise<RoomItem> {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type === "secret-request") return this.cancelSecret(item, decision, dismissal);
    if (item?.type !== "approval") throw new UserError("That is not something to approve.", 409);
    if (item.state !== "pending" || this.deciding.has(item.id)) {
      throw new UserError("That request was already decided.", 409);
    }
    this.deciding.add(item.id);
    try {
      if (decision === "reject") {
        const rejected = this.update(item, { state: "rejected" });
        this.audit(item, "deny", "owner");
        await this.notify(item.task, item.agent, {
          text: `The owner rejected: ${item.summary}.`,
          shown: `You rejected: ${lowerFirst(item.summary)}`,
        });
        this.pending.delete(item.id);
        this.ownerCards.delete(item.id);
        return rejected;
      }
      const input = this.inputOf(item);
      if (always !== undefined) await this.saveRule(item, always.scope, always.change);
      const done = await this.execute(item.command as CommandName, input, this.metaOf(item));
      this.pending.delete(item.id);
      this.ownerCards.delete(item.id);
      this.audit(item, "allow", "owner", done.ok ? undefined : `Failed: ${done.error}`);
      // The owner approved what the captain or an autonomous task's agent asked: its tasks join.
      const auto = this.autonomy === undefined ? undefined : await this.autonomy.callerKind(item);
      if (done.ok && auto !== undefined)
        this.autonomy?.adopt(auto, item.command as CommandName, done.output, item.reason ?? "");
      const installed = done.ok ? this.afterInstall(item, done.output) : undefined;
      const line = done.ok ? (installed?.line ?? lineOf(done.output)) : "";
      const applied = this.update(item, {
        state: done.ok ? "applied" : "failed",
        ...(done.commit === undefined ? {} : { commit: done.commit }),
        result: done.ok ? line : done.error,
      });
      // The agent gets the command's output to work with; the room gets the decision in words.
      await this.notify(
        item.task,
        item.agent,
        done.ok
          ? {
              text: `The owner approved: ${item.summary}. Result: ${line}`,
              shown: `You approved: ${lowerFirst(item.summary)}`,
            }
          : {
              text: `The owner approved: ${item.summary}, but it failed: ${done.error}`,
              shown: `You approved: ${lowerFirst(item.summary)}. It failed: ${done.error}`,
              level: "warn",
            },
      );
      return applied;
    } finally {
      this.deciding.delete(item.id);
    }
  }

  /** Rows an agent read outside the command layer, narrowed to its lane's workspace when it is in one. */
  async narrowForLane<T>(task: string, rows: T[]): Promise<T[]> {
    const lane = await this.autonomy?.laneScope(task);
    if (lane === undefined) return rows;
    const out = lane.output(rows).value;
    return Array.isArray(out) ? (out as T[]) : [];
  }

  /** A pending card's call, unredacted while majhi holds it, for the captain's approval rules. */
  cardCall(
    taskId: string,
    itemId: string,
  ): { command: CommandName; input: Record<string, unknown>; parsed: Record<string, unknown> } | undefined {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type !== "approval" || item.state !== "pending") return undefined;
    if (!Object.hasOwn(commands, item.command)) return undefined;
    const command = item.command as CommandName;
    let input: unknown;
    try {
      input = this.inputOf(item);
    } catch {
      return undefined;
    }
    const parsed = commands[command].input.safeParse(input);
    if (!parsed.success || typeof input !== "object" || input === null) return undefined;
    return {
      command,
      input: input as Record<string, unknown>,
      parsed: parsed.data as Record<string, unknown>,
    };
  }

  /**
   * The captain's upkeep decides a pending card (SPEC 5.18, "Approval cards"). `approved` runs it as
   * the owner's click would, audited `captain`; `left` keeps it pending with the captain's line why.
   * The verdict comes from the owner's approval rules, never from the card's own words.
   */
  async captainDecide(
    taskId: string,
    itemId: string,
    verdict: { decision: "approved" | "left"; why: string; fix?: ShipFix | undefined },
    captain: string,
  ): Promise<{ ok: boolean; error?: string; commit?: string }> {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type !== "approval" || item.state !== "pending" || this.deciding.has(item.id)) {
      return { ok: false, error: "The card is no longer waiting" };
    }
    const marker = {
      decision: verdict.decision,
      why: verdict.why,
      by: "captain" as const,
      ...(verdict.fix === undefined ? {} : { fix: verdict.fix }),
    };
    if (verdict.decision === "left") {
      this.update(item, { autonomy: marker });
      return { ok: true };
    }
    this.deciding.add(item.id);
    try {
      const done = await this.execute(
        item.command as CommandName,
        this.inputOf(item),
        metaFor(item.agent, item.reason ?? "", item.task),
      );
      this.pending.delete(item.id);
      this.log(
        item.task,
        captain,
        item.command,
        item.summary,
        "allow",
        "captain",
        done.ok ? verdict.why : `${verdict.why}. Failed: ${done.error}`,
      );
      this.update(item, {
        state: done.ok ? "applied" : "failed",
        autonomy: marker,
        ...(done.commit === undefined ? {} : { commit: done.commit }),
        result: done.ok ? lineOf(done.output) : done.error,
      });
      await this.notify(
        item.task,
        item.agent,
        done.ok
          ? {
              text: `The captain approved: ${item.summary}. Result: ${lineOf(done.output)}`,
              shown: `Captain approved: ${lowerFirst(item.summary)}. ${verdict.why}`,
            }
          : {
              text: `The captain approved: ${item.summary}, but it failed: ${done.error}`,
              shown: `Captain approved: ${lowerFirst(item.summary)}. It failed: ${done.error}`,
              level: "warn",
            },
        captain,
      );
      return done.ok
        ? { ok: true, ...(done.commit === undefined ? {} : { commit: done.commit }) }
        : { ok: false, error: done.error };
    } finally {
      this.deciding.delete(item.id);
    }
  }

  /**
   * The captain answers a card with something that does what it was for (a merge card, answered by
   * opening the merge request): the card settles with the line, and the lead is told.
   */
  async captainInstead(taskId: string, itemId: string, line: string, captain: string): Promise<void> {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type !== "approval" || item.state !== "pending" || this.deciding.has(item.id)) return;
    this.pending.delete(item.id);
    this.update(item, {
      state: "applied",
      autonomy: { decision: "approved", why: line, by: "captain" },
      result: line,
    });
    this.log(item.task, captain, item.command, item.summary, "allow", "captain", line);
    await this.notify(
      item.task,
      item.agent,
      {
        text: `The captain did not run: ${item.summary}. ${line}. Do not push or ask to merge again: say when the work is done and the checks pass.`,
        shown: `Captain: ${line}`,
      },
      captain,
    );
  }

  /**
   * Saves "always allow" for the agent and command of this card, as a config commit. Refused for a
   * destructive command, which only the owner's click approves, and for an org rule on a task with
   * no org. Runs before the command, so a refusal leaves the card pending.
   */
  private async saveRule(item: ApprovalItem, scope: "task" | "org", change: ChangeRecord): Promise<void> {
    const { policy } = await this.deps.config.settings();
    if (isDestructiveCommand(item.command)) {
      throw new UserError("This deletes or removes something. Only you can approve it, each time.", 409);
    }
    let rule: AllowRule = { agent: item.agent, command: item.command, task: item.task };
    if (scope === "org") {
      const org = this.deps.store.tasks.get(item.task)?.org;
      if (org === undefined) throw new UserError("This task has no org, so it has no org to allow in.", 409);
      rule = { agent: item.agent, command: item.command, org };
    }
    if (policy.rules.some((r) => sameRule(r, rule))) return;
    await this.deps.config.setSettings(
      { policy: { rules: [...policy.rules, rule] } },
      {
        ...change,
        summary: `always allow @${rule.agent} to run ${rule.command} for ${rule.task ?? `org ${rule.org}`}`,
      },
    );
  }

  /** Stores the pasted value under the requested name, marks the card saved and tells the agent. */
  async answerSecret(
    taskId: TaskId,
    itemId: string,
    value: string,
    /** Set when the captain fetched the value through a connection: the owner gave nothing. */
    fetchedBy?: string,
  ): Promise<RoomItem> {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type !== "secret-request" || item.state !== "pending") {
      throw new UserError("That request is not waiting for a secret.", 409);
    }
    if (item.bind !== undefined) return this.answerBound(item, item.bind, value);
    await this.deps.secrets.set(item.name, value);
    this.deps.room.post(item.task, item.id, secretPayload(item, "saved"));
    await this.notify(
      item.task,
      item.agent,
      {
        text: `Saved as secret:${item.name}`,
        shown:
          fetchedBy === undefined
            ? `You gave ${item.label}, kept as secret:${item.name}`
            : `Saved ${item.label} as secret:${item.name}: ${fetchedBy}`,
      },
      fetchedBy === undefined ? "owner" : "captain",
    );
    return this.mustGet(item.task, item.id);
  }

  /**
   * A secret an installed MCP server needs: it goes into that connection's entry, as the owner. When
   * the last missing value is in, the server is tested and the agent hears the result.
   */
  private async answerBound(
    item: SecretRequestItem,
    bind: NonNullable<SecretRequestItem["bind"]>,
    value: string,
  ): Promise<RoomItem> {
    const meta: CommandMeta = { actor: { kind: "owner" }, task: item.task };
    const set = await this.execute(
      "connections.setSecret",
      { id: bind.connection, list: bind.list, field: bind.field, value },
      meta,
    );
    if (!set.ok) throw new UserError(set.error, 409);
    this.deps.room.post(item.task, item.id, secretPayload(item, "saved"));
    const problems = (set.output as { problems?: string[] }).problems ?? [];
    if (problems.length > 0) {
      this.say(item.task, `You gave ${item.label}.`);
      return this.mustGet(item.task, item.id);
    }
    const tested = await this.execute("connections.test", { id: bind.connection }, meta);
    const result = tested.ok ? (tested.output as ConnectionTestResult) : undefined;
    const outcome =
      result === undefined
        ? `could not be tested: ${tested.ok ? "" : tested.error}`
        : result.ok
          ? `passes Test (${result.detail})${result.tools === undefined ? "" : `. Tools: ${result.tools.join(", ")}`}`
          : `failed Test: ${result.detail}`;
    const good = result?.ok === true;
    await this.notify(item.task, item.agent, {
      text: `${bind.connection} ${outcome}. ${good ? "Its tools are in your next session." : "Tell the owner what to fix."}`,
      shown: `You gave ${item.label}. ${bind.connection} ${outcome}`,
      ...(good ? {} : { level: "warn" as const }),
    });
    return this.mustGet(item.task, item.id);
  }

  /**
   * After an install card ran: one secret request per secret the server still needs, in the
   * room, never in chat. Returns the line the card and the agent get instead of the raw output.
   */
  private afterInstall(item: ApprovalItem, output: unknown): { line: string } | undefined {
    if (item.command === "skills.install") {
      const names = (output as { skills?: { name: string }[] }).skills?.map((s) => s.name) ?? [];
      return names.length === 0 ? undefined : { line: `Installed ${names.join(", ")}` };
    }
    if (item.command !== "mcp.install") return undefined;
    const done = McpInstallResultSchema.safeParse(output);
    if (!done.success || done.data.status !== "installed") return undefined;
    const { connection, needs, test } = done.data;
    for (const need of needs) {
      const where = need.list === "headers" ? "header" : "variable";
      this.deps.room.post(item.task, `secret:${randomUUID()}`, {
        type: "secret-request",
        agent: item.agent,
        name: `${connection.id}-${need.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
          .slice(0, 63)
          .replace(/-+$/, ""),
        label: redactText(
          `The ${need.name} ${where} of ${connection.name}${need.description ? `: ${need.description}` : ""}`.slice(
            0,
            200,
          ),
        ),
        bind: { connection: connection.id, list: need.list, field: need.name },
        state: "pending",
      });
    }
    const on =
      connection.agents.length > 0 ? `, on for ${connection.agents.map((a) => `@${a}`).join(", ")}` : "";
    if (needs.length > 0) {
      return {
        line: `Installed ${connection.id}${on}. Waiting for the owner to enter ${needs.map((n) => n.name).join(", ")}`,
      };
    }
    return {
      line: `Installed ${connection.id}${on}. ${test === undefined ? "Not tested" : test.ok ? `Test passed: ${test.detail}` : `Test failed: ${test.detail}`}`,
    };
  }

  private metaOf(item: ApprovalItem): CommandMeta {
    return this.ownerCards.has(item.id)
      ? {
          actor: { kind: "owner" },
          task: item.task,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        }
      : metaFor(item.agent, item.reason ?? "", item.task);
  }

  /** A quiet line in the room. */
  private say(task: string, text: string): void {
    this.deps.room.post(task as TaskId, `info:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: redactText(text),
    });
  }

  /** Dismiss (the owner) or withdraw (the captain's upkeep) a secret request, and tell the asking agent so it stops waiting. */
  private async cancelSecret(
    item: SecretRequestItem,
    decision: "approve" | "reject",
    dismissal: Dismissal,
  ): Promise<RoomItem> {
    if (decision === "approve") throw new UserError("Paste the secret into the field and press Save.", 409);
    if (item.state !== "pending") throw new UserError("That request was already answered.", 409);
    this.deps.room.post(item.task, item.id, secretPayload(item, "cancelled"));
    const reason = redactText(dismissal.reason?.trim() ?? "");
    const tail = reason === "" ? "" : `: ${reason}`;
    const owner = dismissal.by === "owner";
    await this.notify(item.task, item.agent, {
      text: `${owner ? "The owner dismissed" : "The captain withdrew"} the request for ${item.name}${tail}. Do not wait for it: find another way.`,
      shown: owner ? `You dismissed ${item.label}${tail}` : `Withdrawn: ${item.label}${tail}`,
    });
    return this.mustGet(item.task, item.id);
  }

  /** The owner's answer to an approval card: every approval and rejection is in the audit log. */
  private audit(item: ApprovalItem, decision: "allow" | "deny", by: "owner", detail?: string): void {
    this.log(item.task, item.agent, item.command, item.summary, decision, by, detail);
  }

  private log(
    task: string,
    agent: string,
    kind: string,
    title: string,
    decision: "allow" | "deny",
    by: "owner" | "rule" | "autonomy" | "captain",
    detail?: string,
  ): void {
    this.deps.store.permissions.log({
      task,
      agent,
      kind,
      title,
      decision,
      by,
      at: new Date().toISOString(),
      detail: detail === undefined ? undefined : auditDetail(detail),
    });
  }

  /** Marks the approval cards that ran this commit as undone. */
  markUndone(commit: string): void {
    for (const item of this.deps.store.room.approvalsByCommit(commit)) {
      if (item.type === "approval" && item.state === "applied") this.update(item, { state: "undone" });
    }
  }

  // ---------------------------------------------------------------------------

  private inputOf(item: ApprovalItem): unknown {
    if (this.pending.has(item.id)) return this.pending.get(item.id);
    if (item.input.includes("[redacted]")) {
      throw new UserError(
        "This request held a secret that majhi no longer has, because it restarted. Ask the agent to try again.",
        409,
      );
    }
    return JSON.parse(item.input) as unknown;
  }

  private async execute(
    command: CommandName,
    input: unknown,
    meta: CommandMeta,
  ): Promise<{ ok: true; output: unknown; commit?: string } | { ok: false; error: string; commit?: never }> {
    const dispatch = this.dispatch;
    if (dispatch === undefined) throw new Error("The admin service is not connected to the commands");
    // A captain lane reads its own workspace only, whatever the command (5.18).
    const lane =
      commands[command].risk === "read" && meta.task !== undefined
        ? await this.autonomy?.laneScope(meta.task)
        : undefined;
    let sent = input;
    if (lane !== undefined) {
      const fields = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      const refused = lane.refusal(fields);
      if (refused !== undefined) return { ok: false, error: refused };
      sent = lane.input(command, fields);
    }
    const history = this.deps.config.history;
    const before = await history.head();
    const result = await dispatch(command, sent, JSON.stringify(meta));
    if (!result.ok) {
      const parts = [result.error.error, ...(result.error.details ?? [])];
      return { ok: false, error: redactText(parts.join(". ")) };
    }
    if (commands[command].risk === "read") {
      if (lane === undefined) return { ok: true, output: result.output };
      const narrowed = lane.output(result.output);
      return narrowed.refused === undefined
        ? { ok: true, output: narrowed.value }
        : { ok: false, error: narrowed.refused };
    }
    const made = (await history.since(before)).filter(
      (c) => c.subject.startsWith(`${command}:`) || c.subject.startsWith("undo:"),
    );
    const commit = made.at(-1)?.commit;
    return { ok: true, output: result.output, ...(commit === undefined ? {} : { commit }) };
  }

  private update(item: ApprovalItem, patch: Partial<ApprovalItem>): ApprovalItem {
    const { id: _id, task: _task, seq: _seq, at: _at, ...payload } = item;
    this.deps.room.post(item.task, item.id, { ...payload, ...patch } as ApprovalPayload);
    const next = this.mustGet(item.task, item.id);
    if (next.type !== "approval") throw new Error("The card changed type");
    return next;
  }

  private mustGet(task: string, id: string): RoomItem {
    const item = this.deps.room.get(task, id);
    if (item === undefined) throw new Error("The item was not stored");
    return item;
  }

  /**
   * The owner's answer: `shown` as a quiet line in the room, `text` to the agent in its session
   * (queued when it is busy; it wakes an idle agent).
   */
  /** `by`: who decided, `owner` unless the captain did (its agent id). */
  private async notify(
    task: string,
    agent: string,
    message: { text: string; shown: string; level?: "info" | "warn" },
    by = "owner",
  ): Promise<void> {
    this.deps.room.post(task as TaskId, `info:${randomUUID()}`, {
      type: "system",
      level: message.level ?? "info",
      text: redactText(message.shown),
    });
    try {
      await this.deps.tasks.tellAgent({ task, agent, text: message.text, settled: message.shown, by });
    } catch (err) {
      this.deps.room.post(task as TaskId, `warn:${randomUUID()}`, {
        type: "system",
        level: "warn",
        text: `Could not tell @${agent}: ${errorMessage(err)}`,
      });
    }
  }
}

/** The `attachments` a command's input carries, for the check before its card is posted. */
function attachmentsOf(command: CommandName, input: unknown): string[] {
  const data = input as { attachments?: string[]; children?: { attachments?: string[] }[] };
  if (command === "tasks.create" || command === "room.send") return data.attachments ?? [];
  if (command === "tasks.split") return (data.children ?? []).flatMap((c) => c.attachments ?? []);
  return [];
}

type ApprovalPayload = Parameters<RoomService["post"]>[2];

function metaFor(agent: string, reason: string, task: string): CommandMeta {
  return { actor: { kind: "agent", id: agent }, task, ...(reason === "" ? {} : { reason }) };
}

function cardOf(agent: string, command: CommandName, input: unknown, reason: string) {
  return {
    type: "approval" as const,
    agent,
    command,
    risk: commands[command].risk,
    summary: summarize(command, input),
    input: JSON.stringify(redact(input), null, 2),
    ...(reason === "" ? {} : { reason: redactText(reason) }),
  };
}

function secretPayload(item: SecretRequestItem, state: SecretRequestItem["state"]): ApprovalPayload {
  return { type: "secret-request", agent: item.agent, name: item.name, label: item.label, state };
}

/**
 * Commands whose card always shows for an agent, whatever it says about the owner asking: they change
 * where code goes or as whom (git accounts, tokens, identity, remotes), which repos and folders agents
 * can reach (projects, workspace roots), or another task's branch.
 */
const ALWAYS_ASK: ReadonlySet<CommandName> = new Set<CommandName>([
  "projects.register",
  "projects.update",
  "projects.remove",
  "projects.clone",
  "projects.create",
  "projects.publish",
  "projects.connectRemote",
  "orgs.useGitLogin",
  "orgs.useSavedLogin",
  "orgs.setGitAccount",
  "orgs.removeGitAccount",
  "workspaces.set",
  "tasks.changeBranch",
]);

/** Fields of `orgs.update` that change git accounts, tokens, identity or what agents may do alone. */
const SENSITIVE_ORG_FIELDS = [
  "identity",
  "commits",
  "mr_tokens",
  "git_accounts",
  "merge",
  "lead_start",
] as const;

/**
 * Why an agent may not make this call at all, or undefined. Agents never push: the owner pushes from
 * Ship, or an org policy does. Nor do they throw away uncommitted work: removing a task with
 * uncommitted changes takes the owner's typed confirmation. Nor do they raise a playbook's limits:
 * no card is posted that would only fail once approved.
 */
export function refuseForAgents(command: CommandName, input: Record<string, unknown>): string | undefined {
  if (command === "tasks.merge" && input.push !== undefined && input.push !== false) {
    return "Agents never push. Merge without push; the owner pushes from Ship.";
  }
  if (command === "tasks.merge" && input.confirmChecks !== undefined) {
    return "Agents cannot merge past a failed check. Fix the check and merge again.";
  }
  if (command === "tasks.remove" && (input.force !== undefined || input.confirm !== undefined)) {
    return "Agents cannot remove a task with force. Say in the room what should go; the owner removes it.";
  }
  return playbookLimitRefusal(command, input);
}

function error(text: string): ToolResult {
  return { text, isError: true };
}

/** The whole output for the agent, without secrets, cut at a limit. */
function textOf(output: unknown): string {
  const text = JSON.stringify(redactOutput(reposFirst(output)), null, 2) ?? "ok";
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n... (cut)` : text;
}

/** The output of `tasks.tell` when nothing was sent. */
const NotTold = z.object({ told: z.literal(false) });

/** A result that is one task with repos (tasks.create, tasks.update). */
const TaskWithRepos = z.object({
  id: z.string(),
  brief: z.string(),
  repos: z.array(z.object({ project: z.string(), base: z.string() })).min(1),
});

/**
 * A task's repos, with their starting branch, right after its id and title: after the brief they
 * are easy to miss, or cut. Still the task's JSON.
 */
function reposFirst(output: unknown): unknown {
  if (!TaskWithRepos.safeParse(output).success) return output;
  const { id, title, repos, ...rest } = output as Record<string, unknown>;
  return { id, title, repos, ...rest };
}

/** "Starting branch: main. " for one task with repos, else nothing: the line's JSON cuts the repos. */
function branchesOf(output: unknown): string {
  const task = TaskWithRepos.safeParse(output);
  return task.success ? `${startingBranches(task.data.repos)} ` : "";
}

/** "Mark PRV-38 done" reads as "mark PRV-38 done" after "You approved:"; "PRV-38 ..." keeps its case. */
function lowerFirst(text: string): string {
  const [first, second] = text;
  if (first === undefined || second === undefined || second !== second.toLowerCase()) return text;
  return first.toLowerCase() + text.slice(1);
}

/** One short line for the card. */
function lineOf(output: unknown): string {
  const text = `${branchesOf(output)}${JSON.stringify(redactOutput(output)) ?? "ok"}`;
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 3)}...` : text;
}
