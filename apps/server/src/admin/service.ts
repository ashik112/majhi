import { randomUUID } from "node:crypto";
import {
  type AllowRule,
  type CommandMeta,
  type CommandName,
  commands,
  IdSchema,
  isDestructiveCommand,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import { auditDetail } from "../audit.ts";
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
 * What the boss (or any agent with majhi tools) can do: runs its tool calls through the command
 * dispatcher under the approval policy, posts an approval card for every change, and carries out
 * the owner's decision later (SPEC 5.16).
 */
export class AdminService {
  private dispatch: Dispatch | undefined;
  /** Inputs of pending calls, unredacted. A restart drops them; the card then cannot run secrets it hid. */
  private readonly pending = new Map<string, unknown>();
  private readonly deciding = new Set<string>();
  private readonly tools = new Map(adminTools().map((t) => [t.name, t]));

  constructor(private readonly deps: AdminDeps) {}

  /** The dispatcher is built after the handlers, which need this service. */
  bind(dispatch: Dispatch): void {
    this.dispatch = dispatch;
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
      return await this.callCommand(caller, spec.command, input, {
        ownerAsked: ownerAsked === true,
        reason: typeof reason === "string" ? reason.trim().slice(0, 500) : "",
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
    const done = await this.execute(command, input, metaFor(caller.agent, ask.reason, caller.task));
    const held = !done.ok && ask.accept?.(done.error) === true;
    this.deps.room.post(caller.task as TaskId, `approval:${randomUUID()}`, {
      ...cardOf(caller.agent, command, input, ask.reason),
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
    const { policy } = await this.deps.config.settings();
    const mode = ask.confirm === true ? "confirm" : modeFor(policy, command, def.risk);
    const meta = metaFor(caller.agent, ask.reason, caller.task);
    // A saved rule turns a card that would wait into a run. It is looked up only then.
    const decision = decideMode(mode, ask.ownerAsked);
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
          ...(rule === undefined
            ? {}
            : { rule: rule.task === undefined ? ("org" as const) : ("task" as const) }),
          state: done.ok ? "applied" : "failed",
          ...(done.commit === undefined ? {} : { commit: done.commit }),
          result: done.ok ? lineOf(done.output) : done.error,
        });
      }
      return done.ok ? { text: textOf(done.output), isError: false } : error(done.error);
    }
    const id = `approval:${randomUUID()}`;
    this.pending.set(id, input);
    this.deps.room.post(caller.task as TaskId, id, {
      ...cardOf(caller.agent, command, input, ask.reason),
      state: "pending",
    });
    return { text: WAITING_TEXT, isError: false };
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
    by: "owner" | "rule",
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
