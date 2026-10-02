import { randomUUID } from "node:crypto";
import {
  type AllowRule,
  AUTONOMY_BOSS_COMMANDS,
  type AutonomyMode,
  type CommandMeta,
  type CommandName,
  commands,
  IdSchema,
  isDestructiveCommand,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import { auditDetail } from "../audit.ts";
import type { AutonomyVerdict } from "../autonomy/policy.ts";
import type { Dispatch } from "../commands/dispatch.ts";
import type { ChangeRecord, ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { decide as decideMode, matchRule, modeFor, redact, redactText, sameRule } from "./policy.ts";
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
  private readonly tools = new Map(adminTools().map((t) => [t.name, t]));
  private autonomy: AutonomyGate | undefined;

  constructor(private readonly deps: AdminDeps) {}

  /** The dispatcher is built after the handlers, which need this service. */
  bind(dispatch: Dispatch): void {
    this.dispatch = dispatch;
  }

  /** Autonomous mode is built after this service, which it decides for. */
  useAutonomy(gate: AutonomyGate): void {
    this.autonomy = gate;
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
      const spec = this.tools.get(tool);
      if (spec?.command === undefined) return error(`Unknown tool: ${tool}`);
      const { ownerAsked, reason, ...input } = args;
      const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
      // The captain's own tools in autonomous mode: no policy and no card, like a secret request.
      if (BOSS_TOOLS.has(spec.command)) {
        return (
          (await this.autonomy?.bossTool(caller, spec.command, input, why)) ??
          error("Autonomous mode is off.")
        );
      }
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
        (await this.autonomy.heldStart(caller, command, parsed, input));
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
    }
    const { policy } = await this.deps.config.settings();
    const mode = ask.confirm === true ? "confirm" : modeFor(policy, command, def.risk);
    const meta = metaFor(caller.agent, ask.reason, caller.task);
    // An agent's word that the owner asked counts only for low-risk changes, and for nothing in
    // autonomous mode: the owner is away.
    const ownerAsked = auto === undefined && ask.ownerAsked && !this.alwaysAsks(command, checked.data);
    // A saved rule turns a card that would wait into a run. It is looked up only then.
    const decision = decideMode(mode, ownerAsked);
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
    if (autonomy === undefined) return error("Autonomous mode is not available.");
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

  // ---------------------------------------------------------------------------
  // The owner's answers

  /** Approve or reject a pending approval card. Rejecting a secret request cancels it. */
  async decide(
    taskId: TaskId,
    itemId: string,
    decision: "approve" | "reject",
    always?: { scope: "task" | "org"; change: ChangeRecord },
  ): Promise<RoomItem> {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type === "secret-request") return this.cancelSecret(item, decision);
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
        return rejected;
      }
      const input = this.inputOf(item);
      if (always !== undefined) await this.saveRule(item, always.scope, always.change);
      const done = await this.execute(
        item.command as CommandName,
        input,
        metaFor(item.agent, item.reason ?? "", item.task),
      );
      this.pending.delete(item.id);
      this.audit(item, "allow", "owner", done.ok ? undefined : `Failed: ${done.error}`);
      // The owner approved what the captain or an autonomous task's agent asked: its tasks join.
      const auto = this.autonomy === undefined ? undefined : await this.autonomy.callerKind(item);
      if (done.ok && auto !== undefined)
        this.autonomy?.adopt(auto, item.command as CommandName, done.output, item.reason ?? "");
      const applied = this.update(item, {
        state: done.ok ? "applied" : "failed",
        ...(done.commit === undefined ? {} : { commit: done.commit }),
        result: done.ok ? lineOf(done.output) : done.error,
      });
      // The agent gets the command's output to work with; the room gets the decision in words.
      await this.notify(
        item.task,
        item.agent,
        done.ok
          ? {
              text: `The owner approved: ${item.summary}. Result: ${lineOf(done.output)}`,
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

  /**
   * Saves "always allow" for the agent and command of this card, as a config commit. Refused for a
   * destructive command while `allow_destructive_rules` is off, and for an org rule on a task with
   * no org. Runs before the command, so a refusal leaves the card pending.
   */
  private async saveRule(item: ApprovalItem, scope: "task" | "org", change: ChangeRecord): Promise<void> {
    const { policy } = await this.deps.config.settings();
    if (isDestructiveCommand(item.command) && !policy.allow_destructive_rules) {
      throw new UserError(
        "Destructive commands cannot be auto-allowed. Turn on auto-approve for destructive actions in Hub setup first.",
        409,
      );
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
  async answerSecret(taskId: TaskId, itemId: string, value: string): Promise<RoomItem> {
    const item = this.deps.room.get(taskId, itemId);
    if (item?.type !== "secret-request" || item.state !== "pending") {
      throw new UserError("That request is not waiting for a secret.", 409);
    }
    await this.deps.secrets.set(item.name, value);
    this.deps.room.post(item.task, item.id, secretPayload(item, "saved"));
    await this.notify(item.task, item.agent, {
      text: `Saved as secret:${item.name}`,
      shown: `You gave ${item.label}, kept as secret:${item.name}`,
    });
    return this.mustGet(item.task, item.id);
  }

  private async cancelSecret(item: SecretRequestItem, decision: "approve" | "reject"): Promise<RoomItem> {
    if (decision === "approve") throw new UserError("Paste the secret into the field and press Save.", 409);
    if (item.state !== "pending") throw new UserError("That request was already answered.", 409);
    this.deps.room.post(item.task, item.id, secretPayload(item, "cancelled"));
    await this.notify(item.task, item.agent, {
      text: `The owner did not provide ${item.name}.`,
      shown: `You did not provide ${item.label}`,
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
    by: "owner" | "rule" | "autonomy",
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
    const history = this.deps.config.history;
    const before = await history.head();
    const result = await dispatch(command, input, JSON.stringify(meta));
    if (!result.ok) {
      const parts = [result.error.error, ...(result.error.details ?? [])];
      return { ok: false, error: redactText(parts.join(". ")) };
    }
    if (commands[command].risk === "read") return { ok: true, output: result.output };
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
  private async notify(
    task: string,
    agent: string,
    message: { text: string; shown: string; level?: "info" | "warn" },
  ): Promise<void> {
    this.deps.room.post(task as TaskId, `info:${randomUUID()}`, {
      type: "system",
      level: message.level ?? "info",
      text: redactText(message.shown),
    });
    try {
      await this.deps.tasks.tellAgent({ task, agent, text: message.text, settled: message.shown });
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
 * uncommitted changes takes the owner's typed confirmation.
 */
export function refuseForAgents(command: CommandName, input: Record<string, unknown>): string | undefined {
  if (command === "tasks.merge" && input.push !== undefined && input.push !== false) {
    return "Agents never push. Merge without push; the owner pushes from Ship.";
  }
  if (command === "tasks.remove" && (input.force !== undefined || input.confirm !== undefined)) {
    return "Agents cannot remove a task with force. Say in the room what should go; the owner removes it.";
  }
  return undefined;
}

function error(text: string): ToolResult {
  return { text, isError: true };
}

/** The whole output for the agent, without secrets, cut at a limit. */
function textOf(output: unknown): string {
  const text = JSON.stringify(redact(output), null, 2) ?? "ok";
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n... (cut)` : text;
}

/** "Mark PRV-38 done" reads as "mark PRV-38 done" after "You approved:"; "PRV-38 ..." keeps its case. */
function lowerFirst(text: string): string {
  const [first, second] = text;
  if (first === undefined || second === undefined || second !== second.toLowerCase()) return text;
  return first.toLowerCase() + text.slice(1);
}

/** One short line for the card. */
function lineOf(output: unknown): string {
  const text = JSON.stringify(redact(output)) ?? "ok";
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 3)}...` : text;
}
