import { randomUUID } from "node:crypto";
import type { PermissionAsk } from "@majhi/acp";
import {
  type AllowRule,
  type AuthorityLevel,
  type CommandMeta,
  caseOf,
  currentRules,
  DEFAULT_LEVEL,
  isAlwaysKind,
  isCaptainLane,
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
import { isRootChat } from "../captain/tell.ts";
import type { ConfigService } from "../config/service.ts";
import type { DeferredResult, DeferredResults } from "../connections/deferred.ts";
import type { GateWrite } from "../connections/gate.ts";
import { redactSecrets } from "../connections/redact.ts";
import { errorMessage, UserError } from "../errors.ts";
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

/** A permission card in the room. */
type PermissionItem = Extract<RoomItem, { type: "permission" }>;

/** The options majhi adds to a card, beside the agent's own. */
const TASK_OPTION = `${MAJHI_OPTION_PREFIX}task`;
const ALWAYS_OPTION = `${MAJHI_OPTION_PREFIX}always`;
const READS_OPTION = `${MAJHI_OPTION_PREFIX}reads`;

/** How long the owner's Allow on a captain's card lets the same command through once. */
const GRANT_MS = 60 * 60_000;

/** A card the captain does not wait on: the owner's answer reaches the captain's next turn. */
interface CaptainCard {
  task: string;
  agent: string;
  /** The command the captain asked to run, as the owner's Allow names it. */
  command: string;
  ask: PermissionAsk;
  risk: RiskKind;
  /** What the captain was told when the call was refused: dropped once the answer says it all. */
  told: DeferredResult | undefined;
  /** Set for a write to a connection: what the gate found, and the one MCP tool when it is one. */
  writes?: readonly GateWrite[] | undefined;
  tool?: ToolWrite | undefined;
}

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
 * The captain itself never waits on a card (`askCaptain`): its call is refused at once and says so, the card stays
 * for the owner, and the owner's answer wakes the captain. An Allow lets that same command run once when the
 * captain asks again, so it runs in the captain's own sandbox and not in majhi.
 */
export class PermissionFlow {
  private readonly sandbox: SandboxLog;
  /** Cards of the captain that wait for the owner, by item id. Lost with a restart, which ends the cards too. */
  private readonly captainCards = new Map<string, CaptainCard>();
  /** Commands the owner allowed on a captain's card, until the captain asks again: `task agent command` to when. */
  private readonly grants = new Map<string, number>();
  /** Requests the restart ended, until their agents are woken. */
  private readonly restarted: PermissionItem[] = [];

  constructor(
    private readonly deps: {
      store: Store;
      room: RoomService;
      connections?: ConnectionToolRules | undefined;
      /** Where the level, the incident switches and the saved Always rules are read, and where Always is saved. */
      config?: ConfigService | undefined;
      /** A card for the owner appeared or went: the captain's status (what a waiting message waits on) is read again. */
      onCardChange?: (() => void) | undefined;
      /** What the owner said on a captain's card, for the captain's next tool call or turn. */
      deferred?: DeferredResults | undefined;
      /**
       * Runs a command the owner allowed in the agent's own sandbox, as a background process the agent is woken
       * about when it ends. Resolves with the process id; rejects when it cannot start.
       */
      runAllowed?: ((task: string, agent: string, command: string) => Promise<string>) | undefined;
      /**
       * A better way to do what a raw command asks, in a sentence, when the project has one: a push or a job play
       * where majhi deploys the whole task with one click. Shown on the card and told to the captain.
       */
      deployWay?:
        | ((task: string, command: string) => Promise<{ card: string; captain: string } | undefined>)
        | undefined;
      /** Wakes an agent with a message from majhi (`RunManager.notify`). */
      notify?: ((task: string, agent: string, text: string, claim?: () => boolean) => void) | undefined;
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
    const task = store.tasks.get(run.task);
    const boss = (await this.deps.config?.sections())?.boss;
    const captains =
      task !== undefined &&
      task.team[0] === run.agent &&
      (isCaptainLane(task) || (boss !== undefined && isRootChat(task, boss)));
    if (verdict.kind === "write") return this.askWrite(run, ask, verdict.writes, signal, captains);
    const once = ask.options.find((o) => o.kind === "allow_once");
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
    const way =
      ask.kind === "execute" && ask.command !== undefined
        ? await this.deps.deployWay?.(run.task, ask.command).catch(() => undefined)
        : undefined;
    const hint = way?.card;
    const base = {
      type: "permission" as const,
      agent: run.agent,
      title: ask.title,
      ...(ask.toolCallId === undefined ? {} : { toolCallId: ask.toolCallId }),
      risk: kind,
      options: ask.options,
      ...(hint === undefined ? {} : { hint }),
    };
    if (once !== undefined && !go.go && !keptForTask && this.takeGrant(run, ask)) {
      room.post(run.task, id, { ...base, state: "auto", chosen: once.id });
      this.log(run, ask, "allow", "owner", "The owner allowed it on its card");
      return Promise.resolve(once.id);
    }
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
    if (captains) return this.askCaptain(run, { ...ask, options }, id, kind, undefined, way?.captain);
    this.live.set(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask: { ...ask, options }, resolve, risk: kind });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
  }

  /**
   * The captain never waits on a card: its call is refused at once with the reject option, and the next majhi
   * call it makes says why. The card stays for the owner and is not tied to this run, so the end of the turn, a
   * fresh session or a stop does not take it away. `answerCaptainCard` wakes the captain with the answer.
   */
  private askCaptain(
    run: AgentRun,
    ask: PermissionAsk,
    id: string,
    kind: RiskKind,
    write?: { writes: readonly GateWrite[]; tool: ToolWrite | undefined },
    hint?: string,
  ): Promise<string | undefined> {
    const command = ask.command ?? ask.title;
    const shown = redactSecrets(command, run.connections?.secrets ?? []);
    const told = this.deps.deferred?.add(
      run.task,
      run.agent,
      `\`${shown}\` needs the owner, so it did not run. The owner was asked with a card, and you are woken with their answer. Go on with whatever does not need it; do not ask for it again until then.${hint === undefined ? "" : ` ${hint}`}`,
    );
    this.captainCards.set(id, {
      task: run.task,
      agent: run.agent,
      command,
      ask,
      risk: kind,
      told,
      ...(write === undefined ? {} : { writes: write.writes, tool: write.tool }),
    });
    const no =
      ask.options.find((o) => o.kind === "reject_once") ??
      ask.options.find((o) => o.kind === "reject_always");
    return Promise.resolve(no?.id);
  }

  /** Whether the owner's answer on this card is still to come, though no run waits on it. */
  keeps(itemId: string): boolean {
    return this.captainCards.has(itemId);
  }

  /** The command the owner allowed runs once, when the captain asks for it again. */
  private takeGrant(run: AgentRun, ask: PermissionAsk): boolean {
    const key = grantKey(run.task, run.agent, ask.command ?? ask.title);
    const until = this.grants.get(key);
    if (until === undefined) return false;
    this.grants.delete(key);
    return until > this.now().getTime();
  }

  /**
   * The owner answered a card the captain does not wait on. Allow lets the same command through once when the
   * captain asks again, and both answers wake the captain with a line that says so.
   */
  private answerCaptainCard(held: CaptainCard, itemId: string, option: string): RoomItem {
    const { store, room } = this.deps;
    const item = room.get(held.task, itemId);
    if (item === undefined || item.type !== "permission") throw new UserError("That card is gone.", 404);
    const chosen = held.ask.options.find((o) => o.id === option);
    if (chosen === undefined) {
      throw new UserError(
        `"${option}" is not one of the options: ${held.ask.options.map((o) => o.id).join(", ")}.`,
      );
    }
    const allowed = chosen.kind === "allow_once" || chosen.kind === "allow_always";
    this.captainCards.delete(itemId);
    const decision = allowed ? "allow" : "deny";
    for (const write of held.writes ?? [undefined]) {
      store.permissions.log({
        task: held.task,
        agent: held.agent,
        kind: write === undefined ? (held.ask.kind ?? "other") : "connection-write",
        title: redactSecrets(write === undefined ? held.ask.title : write.action, []),
        decision,
        by: "owner",
        at: this.now().toISOString(),
      });
    }
    // majhi's own choices on a tool write: this task's memory, or the connection's own lists.
    if (allowed && held.tool !== undefined && chosen.id.startsWith(MAJHI_OPTION_PREFIX)) {
      this.remember(held.task, held.tool, chosen.id);
    }
    if (allowed && isAlwaysKind(held.risk)) {
      if (chosen.id === ALWAYS_OPTION) this.keepRule(held.task, held.risk);
      else if (chosen.kind === "allow_always") store.permissions.allow(held.task, riskAllowKey(held.risk));
    }
    room.post(item.task, itemId, permissionPayload(item, { state: "answered", chosen: option }));
    if (allowed) void this.runAllowed(held);
    else
      this.tellCaptain(
        held,
        `The owner did not allow \`${held.command}\`. It did not run. Go on without it.`,
      );
    this.deps.onCardChange?.();
    const updated = room.get(held.task, itemId);
    if (updated === undefined) throw new Error("The prompt was not stored");
    return updated;
  }

  /**
   * The owner allowed the command: it runs in the captain's own sandbox as a background process, and the captain is
   * woken with its output when it ends, like any process it started. When majhi cannot start it there, the same
   * command goes through once when the captain asks again, and the captain is told so.
   */
  private async runAllowed(held: CaptainCard): Promise<void> {
    const { runAllowed, deferred } = this.deps;
    const shown = redactSecrets(held.command, []);
    // majhi runs a command line; a call of an MCP tool has no line (and no arguments) here, so the captain makes it again.
    if (held.ask.kind !== "execute" || held.ask.command === undefined) {
      this.grants.set(grantKey(held.task, held.agent, held.command), this.now().getTime() + GRANT_MS);
      this.tellCaptain(
        held,
        `The owner allowed \`${shown}\`. Make the call again now: it goes ahead once without asking.`,
      );
      return;
    }
    try {
      if (runAllowed === undefined) throw new Error("majhi cannot run it for you here");
      const id = await runAllowed(held.task, held.agent, held.command);
      if (held.told !== undefined) deferred?.discard(held.task, held.agent, held.told);
      // The process's end wakes the captain with the output; this line is for a captain that is mid-turn.
      deferred?.add(
        held.task,
        held.agent,
        `The owner allowed \`${shown}\`. It runs now as ${id}, and you are woken with its output when it ends.`,
      );
    } catch (err) {
      this.grants.set(grantKey(held.task, held.agent, held.command), this.now().getTime() + GRANT_MS);
      this.tellCaptain(
        held,
        `The owner allowed \`${shown}\`, but majhi could not start it for you (${errorMessage(err)}). Run it again now: it goes ahead once without asking.`,
      );
    }
  }

  /** The captain hears it with its next majhi call, or in a message of its own, whichever comes first. */
  private tellCaptain(held: CaptainCard, text: string): void {
    const { deferred, notify } = this.deps;
    if (held.told !== undefined) deferred?.discard(held.task, held.agent, held.told);
    const result = deferred?.add(held.task, held.agent, text);
    notify?.(held.task, held.agent, text, result?.claim);
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
    captains = false,
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
    if (captains && once !== undefined && this.takeGrant(run, ask)) {
      room.post(run.task, id, { ...base, options: ask.options, state: "auto", chosen: once.id });
      this.logWrites(run, writes, "allow", "owner");
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
    // The captain does not wait on it, as on any card: its call is refused now and the owner's answer wakes it.
    if (captains) {
      return this.askCaptain(run, { ...ask, options }, id, "client-server-write", { writes, tool });
    }
    this.live.set(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask: { ...ask, options }, resolve, writes });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
  }

  /** The owner picked one of the prompt's options. */
  answer(run: AgentRun | undefined, task: string, itemId: string, option: string, captain = false): RoomItem {
    const { store, room } = this.deps;
    const held = this.captainCards.get(itemId);
    if (held !== undefined && held.task === task) {
      // A card is there because the workspace's level does not cover the action: the owner answers it.
      if (captain)
        throw new UserError("This is above the workspace's level. Only the owner answers it.", 409);
      return this.answerCaptainCard(held, itemId, option);
    }
    const pending = run?.pending.get(itemId);
    const item = room.get(task, itemId);
    if (run === undefined || pending === undefined || item === undefined || item.type !== "permission") {
      // A card left from a run that ended or was replaced: close it, so it does not stay to be clicked again.
      if (item?.type === "permission" && item.state === "pending") {
        room.post(item.task, item.id, permissionPayload(item, { state: "cancelled" }));
        this.deps.onCardChange?.();
        this.wake([item], "its run had ended");
      }
      throw new UserError("That question ended: the agent moved on. The card is closed.", 409);
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
    if (tool !== undefined) this.remember(run.task, tool, chosen.id);
    if (pending.writes !== undefined) {
      this.logWrites(run, pending.writes, allowed ? "allow" : "deny", "owner");
    } else {
      this.log(run, pending.ask, allowed ? "allow" : "deny", "owner");
      if (allowed && kind !== undefined && isAlwaysKind(kind)) {
        if (chosen.id === ALWAYS_OPTION) this.keepRule(task, kind);
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
  private keepRule(task: string, kind: RiskKind): void {
    const config = this.deps.config;
    if (config === undefined || !isAlwaysKind(kind)) return;
    const org = this.deps.store.tasks.get(task)?.org ?? PRIVATE;
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
            task,
          },
          summary: `always ${RISK_LABEL[kind]} in ${org}`,
        },
      );
    })().catch(() => undefined);
  }

  /** What one of majhi's choices on a tool write keeps: this task's memory, or the connection's own lists. */
  private remember(task: string, tool: ToolWrite, choice: string): void {
    if (choice === TASK_OPTION) {
      this.deps.store.permissions.allow(task, toolKey(tool));
      return;
    }
    const as = choice === ALWAYS_OPTION ? "allow" : choice === READS_OPTION ? "read" : undefined;
    if (as === undefined) return;
    const meta: CommandMeta = {
      actor: { kind: "owner" },
      reason:
        as === "allow" ? "Owner chose Always allow this tool on a card" : "Owner said a tool only reads",
      task,
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
  /**
   * Cards of this agent in this task that no prompt of this run waits on: their prompt went with a run that ended
   * or was replaced (a fresh session). They are closed so the owner never answers a question nobody asks.
   */
  dropOrphans(run: AgentRun): void {
    const { store, room } = this.deps;
    const dropped: PermissionItem[] = [];
    for (const item of store.room.pendingPermissions()) {
      if (item.type !== "permission" || item.task !== run.task || item.agent !== run.agent) continue;
      if (run.pending.has(item.id) || this.captainCards.has(item.id)) continue;
      room.post(item.task, item.id, permissionPayload(item, { state: "cancelled" }));
      dropped.push(item);
    }
    if (dropped.length === 0) return;
    this.deps.onCardChange?.();
    this.wake(dropped, "its session was replaced");
  }

  /**
   * At server start: requests nobody can answer any more end, with one line per task in the room. The agents that
   * asked are woken by `wakeAfterRestart` once everything is built.
   */
  recover(): void {
    const { store, room } = this.deps;
    const told = new Set<string>();
    for (const item of store.room.pendingPermissions()) {
      if (item.type !== "permission") continue;
      room.post(item.task, item.id, permissionPayload(item, { state: "cancelled" }));
      this.restarted.push(item);
      // One line per task: why the request vanished.
      if (told.has(item.task)) continue;
      told.add(item.task);
      room.post(item.task, `restart:${randomUUID()}`, {
        type: "system",
        level: "info",
        text: "majhi restarted, so the open permission request ended. The agent is told to ask again if it still needs it.",
      });
    }
  }

  /** Wakes the agents whose request the restart ended, once each. */
  wakeAfterRestart(): void {
    this.wake(this.restarted.splice(0), "majhi restarted");
  }

  /**
   * An open request ended and nobody answered it: the agent that asked is woken with one line, through the same
   * `notify` as any other wake. Once per agent and task; the cards are closed first, so a request is never woken
   * twice. Not for a task that is done or paused. The agent may no longer need it, and majhi's rules may have changed, so
   * the command may now run without asking.
   */
  private wake(items: readonly PermissionItem[], why: string): void {
    const { store, notify } = this.deps;
    const seen = new Set<string>();
    for (const { task: id, agent } of items) {
      const key = `${id}\u0000${agent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const task = store.tasks.get(id);
      // A paused task goes on from its own resume, with the agent told then; a done one has nothing left to ask.
      if (task === undefined || task.status === "done" || task.status === "paused") continue;
      if (!task.team.includes(agent)) continue;
      notify?.(id, agent, endedRequestLine(why));
    }
  }

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

/** What an agent is told when its open request ended without an answer. */
export const endedRequestLine = (why: string): string =>
  `Your open permission request ended without an answer (${why}). Run it again if you still need it: majhi's rules may have changed, so it may now run without asking. If you no longer need it, answer in a line.`;

const grantKey = (task: string, agent: string, command: string): string =>
  `${task}\u0000${agent}\u0000${command}`;
