import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getTool,
  isAuthFailure,
  type LimitFailure,
  limitFailure,
  limitLine,
  type PermissionAsk,
  type PromptBlock,
  type RuntimeOptions,
  type SessionEvent,
} from "@majhi/acp";
import type {
  AccountLimit,
  Attachment,
  HandoffVia,
  ProcessInfo,
  RoomItem,
  SlotCapacity,
  Task,
} from "@majhi/shared";
import { durationMs, isAutonomyChat } from "@majhi/shared";
import { accountHome } from "../accounts/homes.ts";
import { readModelCatalog } from "../accounts/model-catalog.ts";
import { limitFor } from "../accounts/status.ts";
import type { AdminAccess } from "../admin/access.ts";
import { ADMIN_PREAMBLE, isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import { AUTONOMY_PREAMBLE } from "../autonomy/preamble.ts";
import type { ConfigService } from "../config/service.ts";
import type { GateWrite } from "../connections/gate.ts";
import { type HeldSecret, redactSecrets } from "../connections/redact.ts";
import { type RunConnections, removeRunFiles } from "../connections/run-files.ts";
import type { Decisions } from "../decisions/api.ts";
import { readDecisionSettings } from "../decisions/settings.ts";
import { errorMessage, UserError } from "../errors.ts";
import { noticeText, sameRun, splitCurrent } from "../processes/notices.ts";
import { runningLine } from "../processes/text.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomAccess } from "../rooms/access.ts";
import { handoffPrompt } from "../rooms/handoff.ts";
import { WorktreeLocks } from "../rooms/locks.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import { skillUsed } from "../skills/use.ts";
import type { Store } from "../store/index.ts";
import { sectionOf } from "../tasks/brief.ts";
import { readPrices } from "../usage/prices.ts";
import type { UsageRecorder } from "../usage/recorder.ts";
import { diffStat, headsOf } from "./checkpoint.ts";
import { Compaction } from "./compaction.ts";
import {
  type ContextBudget,
  capUsage,
  estimateText,
  estimateTokens,
  isContextError,
  isRecoveryStop,
  needsCompaction,
  rotationDue,
} from "./context.ts";
import { buildCarry, checkpointRepos, checkpointTurn } from "./durable.ts";
import { BUDGET, freshPrompt, roomLines } from "./handoff.ts";
import { handoffPayload, ItemMapper, ownerPayload, permissionPayload } from "./items.ts";
import { type LaunchDeps, launch, resolveAgent, withAccount, withOverride } from "./launch.ts";
import { handedOffLine, limitPauseText } from "./limit.ts";
import { capacityOf, globalCap, type Limits, runsTotal, Slots } from "./limits.ts";
import { type LivePatch, RunLive, WORKING } from "./live.ts";
import { taskMediaSink } from "./media.ts";
import { looksLikeNetworkError, looksLikeOverload, OVERLOAD_BACKOFF_MS } from "./network.ts";
import { PermissionFlow } from "./permission-flow.ts";
import { pickForSession } from "./pick.ts";
import { briefBlocks, ownerBlocks } from "./prompt.ts";
import { currentModelName, switchAfterRefusal } from "./refusal.ts";
import { AgentRun, type PauseReason, type QueueEntry } from "./run.ts";
import type { SerenaLaunch } from "./serena.ts";
import { type AccountProbe, classifyStartFailure, type StartFailure } from "./start-failure.ts";
import {
  afterLimit,
  type FiredLimit,
  firedLimit,
  limitPhrase,
  MAX_STRIKES,
  type TurnLimits,
  turnLimitsFor,
} from "./turn-limits.ts";
import { wakePlan } from "./wake.ts";

export const BRIEF_ITEM_ID = "brief";

/** How long before a failed resume is tried the second time. */
const RESUME_RETRY_MS = 1_000;
/** `activeAt` goes out at most this often while an agent streams. */
const ACTIVE_EVERY_MS = 5_000;
const CONTINUE_TEXT = "Continue from where you stopped.";
/** The first prompt of the fresh session a turn limit moved the agent to (PRV-96). */
/** Why work moves to another agent: the note's reason, the room's line, and whether a teammate may take it. */
interface Handoff {
  carry: string;
  line: (to: string) => string;
  teammates: boolean;
}

const limitHandoff = (from: string, until: string, now: Date): Handoff => ({
  carry: `@${from}'s account hit its usage limit`,
  line: (to) => handedOffLine(from, to, until, now),
  teammates: false,
});

const signedOutHandoff = (from: string): Handoff => ({
  carry: `@${from}'s account needs a new sign-in`,
  line: (to) => `@${from}'s account needs a new sign-in. @${to} continues from the checkpoint.`,
  teammates: true,
});

const CONTINUE_FROM_NOTE = "Continue from the handoff note.";
/** How often a running turn is checked against its turn limits. */
const LIMIT_CHECK_MS = 15_000;
/** A turn that heard from its agent this recently is streaming fine: going offline does not cut it. */
export const STREAMING_MS = 30_000;

export interface RunDeps {
  store: Store;
  room: RoomService;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  agents: AgentStore;
  config: ConfigService;
  secrets: SecretStore;
  majhiHome: string;
  /** Gives sessions of the captain (and other admin agents) the majhi-admin MCP server. */
  admin?: AdminAccess;
  /** The decision provider: majhi-decide for every session, and model picks for `auto` agents. */
  decisions?: Decisions;
  /** majhi-room for team members and majhi-tasks for leads (Phase 3). */
  rooms?: RoomAccess;
  /** Serena can start in the runner container (5.9 item 6); absent when agents do not run in one. */
  serena?: SerenaLaunch;
  /** Where connections keep their files (5.14). Absent: runs get no connections. */
  connectionFiles?: LaunchDeps["connectionFiles"];
  /** The skills store: runs get their agent's enabled skills (5.2). */
  skills?: LaunchDeps["skills"];
  /** Agents run in runner containers (Claude Code then lists the run's skills itself). */
  containerRunner?: boolean;
  /** Records the tokens and cost of every turn, majhi's own prompts included. */
  usage?: UsageRecorder;
  /** Background processes (5.15): each prompt says what already runs, and an old result is not sent. */
  processes?: {
    running(task: string): ProcessInfo[];
    list(task: string): ProcessInfo[];
    /** The agent already read this end with `output` or `list`: it is not told again. */
    readAfterEnd(p: ProcessInfo): boolean;
  };
  /** Called when the set of working agents of some task changed, so the task list can refresh. */
  onTasksChanged: (task: string, rows: boolean) => void;
  /** A run started with its skills, or an agent used one: the skills lists and run views refresh. */
  onSkillsChanged?: () => void;
  /**
   * An agent ended a turn by itself (stop reason end_turn) with this final message. The room
   * routes its @mentions (5.3) before the task can count as idle, so this is awaited. `refused`:
   * the model's safeguards ended it and no other model is left to try, so the step goes back to
   * the team.
   */
  onTurnEnd?: (turn: { task: string; agent: string; text: string; refused?: boolean }) => Promise<void>;
  /**
   * Called right before a prompt is sent, not for slash commands. A returned text is added after
   * the prompt. `brief` is true when the agent reads TASK.md with this prompt: the first prompt,
   * or a fresh session's first prompt that carries it.
   */
  beforePrompt?: (turn: { task: string; agent: string; brief: boolean }) => Promise<string | undefined>;
  /** After every checkpoint of a task: branches stacked on it may need a rebase. */
  onCheckpoint?: (task: string) => void;
  /**
   * Asked between turns, never during one: a line when a budget holds this agent's task (the org's
   * or the account's weekly budget reached 100%), else undefined. The run then pauses with `limit`.
   */
  limited?: (task: string, agent: string) => Promise<string | undefined>;
  /**
   * Autonomous mode's run gate (PRV-74), asked where `limited` is: `owner` while the mode is paused
   * or stopping, `limit` under a cap, with the line to say. The run then pauses with that reason.
   */
  held?: (task: string, agent: string) => Promise<{ reason: "owner" | "limit"; why: string } | undefined>;
  /**
   * Autonomous mode's say in the line for a slot: `fair` while it is On (slots are shared evenly
   * across workspaces), and `owner` for a task the owner runs, which always goes first (5.18).
   */
  /** The computer's CPU core count, for the default machine-wide run cap. */
  cores?: () => number | undefined;
  slotPolicy?: { fair(): boolean; owner(task: string): boolean };
  /** A run's loop ended: its turn is over and nothing more is sent until something wakes it. */
  onLoopEnd?: (task: string, agent: string) => void;
  /**
   * The account a run uses in place of its agent's own: the captain's lane runs on the account its
   * workspace's "More rules" names (5.18). `refuse` stops the start with the reason.
   */
  accountFor?: (task: string, agent: string) => Promise<{ account?: string; refuse?: string } | undefined>;
  /**
   * Called when an agent finished a turn normally and has nothing queued: the task may be ready for
   * review. `refused`: the turn ended on the model's safeguards, so the task is not finished.
   */
  onIdle?: (task: string, refused: boolean) => void;
  /**
   * An agent paused (offline, or an error it cannot get past): the task pauses too. `why` is the
   * cause in words when the reason alone does not say it (a start that failed).
   */
  onPaused?: (task: string, reason: PauseReason, why?: string) => void;
  /**
   * The account `agent` runs on in this task when a limit error holds it now, with the mark. Asked
   * between turns, before a start.
   */
  accountLimit?: (
    task: string,
    agent: string,
  ) => Promise<{ account: string; limit: AccountLimit } | undefined>;
  /** A turn or a start hit the account's usage limit: marks it `at-limit` and returns the mark that holds. */
  markLimit?: (account: string, failure: LimitFailure) => Promise<AccountLimit | undefined>;
  /**
   * The agent that takes `agent`'s place when its account hit its limit: its `fallback`, when it may
   * work in the task, is signed in and not at a limit, is not on the team, and the org's
   * `resume.handoff` is on. Else undefined.
   */
  fallbackFor?: (task: string, agent: string) => Promise<string | undefined>;
  /**
   * When `agent` is the lead and its account is signed out: the first teammate whose account works,
   * under the same `resume.handoff` switch. Undefined when there is none.
   */
  teammateFor?: (task: string, agent: string) => Promise<string | undefined>;
  /**
   * Puts `to` in `from`'s place in the task's team, same position and overrides. A teammate already
   * on the team takes the lead's place and `from` leaves it. False when it could not.
   */
  takeOver?: (task: string, from: string, to: string) => Promise<boolean>;
  /** A fresh health check of an account, asked after a start failed. Undefined when it cannot be read. */
  checkAccount?: (account: string) => Promise<AccountProbe | undefined>;
  /** A turn failed on its account's sign-in: the account is `needs-login` from now, with `detail` for Accounts. */
  markSignedOut?: (account: string, detail: string) => Promise<void>;
  /** Whether a teammate of `agent` in the task runs on an account that is not known to need a sign-in. */
  teamCanRun?: (task: string, agent: string) => Promise<boolean>;
  /**
   * A turn failed and its step goes back to the team: `signed-out` when the agent's account needs a
   * new sign-in (the lead is woken to give the step to a teammate), `error` for any other failure.
   */
  onTurnFailed?: (turn: {
    task: string;
    agent: string;
    text: string;
    cause: "signed-out" | "error";
    account?: string | undefined;
  }) => void;
  /**
   * Autonomous mode's mid-turn cap check (PRV-74), asked at a running turn's tool calls with what the
   * turn spent so far (USD, from the agent's running cost). A line when a cap is passed by more
   * than its margin: the turn stops there and the run pauses with `limit`.
   */
  overCap?: (task: string, turnCostUsd: number) => Promise<string | undefined>;
  /** A paused or cut agent is resuming: the task runs again. */
  onResumed?: (task: string) => void;
  /** An agent failed in a way that looks like a lost connection: check the network now. */
  onNetworkError?: () => void;
  now?: () => Date;
}

/**
 * One ACP session per (task, agent), started when there is something to send. Runs the queue
 * of prompts, turns session events into room items and live state, and hands permission
 * requests to the permission flow. Each turn ends with a checkpoint and a context budget check
 * (compaction lives in `compaction.ts`). A process holds a slot under the concurrency limits
 * while it runs, and turns pause and resume around restarts, lost connections and sleep
 * (SPEC 5.7, 5.13, 5.17).
 */
export class RunManager {
  private readonly runs = new Map<string, AgentRun>();
  /** Per task: each secret value its runs held, to its `<connection>.<field>` name. */
  private readonly heldSecrets = new Map<string, Map<string, string>>();
  private readonly now: () => Date;
  private readonly slots: Slots;
  private readonly live: RunLive;
  private readonly permissions: PermissionFlow;
  private readonly compaction: Compaction;
  /** One lock per worktree: two agents never edit one worktree at the same time (5.3). */
  readonly locks = new WorktreeLocks();
  /** Per task, the owner messages still on their way to a session (see `inOrder`). */
  private readonly deliveries = new Map<string, Promise<void>>();
  /** Turn limit hits in a row without a new commit, per task (PRV-96). */
  private readonly limitStrikes = new Map<string, number>();
  /** Set by `closeAll`: no session starts after shutdown, and queued prompts wait in the store. */
  private closed = false;
  /** The machine-wide run cap as of the last look, for the line a waiting run shows. */
  private cap = 0;

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? (() => new Date());
    this.live = new RunLive(deps.room, deps.onTasksChanged);
    this.permissions = new PermissionFlow(deps, this.live, this.now);
    this.compaction = new Compaction(deps, this.live, {
      endSession: (run, reason, keepSlot) => this.endSession(run, reason, keepSlot),
      pause: (run, reason, text) => this.pause(run, reason, text),
    });
    this.slots = new Slots({
      limits: () => this.limits(),
      canEvict: (key) => {
        const run = this.runs.get(key);
        return run !== undefined && run.session !== undefined && !run.turning;
      },
      evict: (key) => this.evict(key),
      fair: () => deps.slotPolicy?.fair() ?? false,
      onQueue: (positions) => this.showLine(positions),
      now: () => this.now().getTime(),
    });
    void this.limits().catch(() => undefined);
  }

  /** Runs holding a slot now and the machine-wide cap, for the Machine line. */
  runUse(): { inUse: number; cap: number } {
    return { inUse: this.slots.state().holders.length, cap: this.cap };
  }

  /** The limits now, with the machine-wide run cap resolved from the setting or the core count. */
  private async limits(): Promise<Limits> {
    const { limits } = await this.deps.config.settings();
    const limit = { ...limits, runs_total: runsTotal(limits, this.deps.cores?.()) };
    this.cap = globalCap(limit);
    return limit;
  }

  /** At server start: runs that were live are over, and prompts nobody can answer any more are cancelled. */
  recover(): void {
    const { store, room } = this.deps;
    store.runs.endAllLive("server-restart", this.now().toISOString());
    const told = new Set<string>();
    for (const item of store.room.pendingPermissions()) {
      if (item.type !== "permission") continue;
      room.post(item.task, item.id, permissionPayload(item, { state: "cancelled" }));
      // One line per task: why the request vanished.
      if (told.has(item.task)) continue;
      told.add(item.task);
      room.post(item.task, `restart:${randomUUID()}`, {
        type: "system",
        level: "info",
        text: "majhi restarted, so the open permission request ended. The agent asks again if it still needs it.",
      });
    }
  }

  /** True when the agent is queued, starting, working or waiting in any task. */
  isWorking(agent: string): boolean {
    return [...this.runs.values()].some((r) => r.agent === agent && WORKING.has(r.live.status));
  }

  /**
   * Free slots now, overall and per account (`accounts` are listed even when nothing uses them). The
   * captain's own slot is outside the limits and not counted.
   */
  async capacity(accounts: readonly string[] = []): Promise<SlotCapacity> {
    const limits = await this.limits();
    return capacityOf(this.slots.state(), limits, accounts);
  }

  /**
   * True while something of the task's agents is on its way: one queued for a slot, starting,
   * working or waiting, a loop about to send, or a run a gate holds (a cap, a lost connection) that
   * goes on by itself. A task is stuck only when this is false.
   */
  busy(task: string): boolean {
    return [...this.runs.values()].some(
      (r) =>
        r.task === task &&
        !r.closing &&
        (WORKING.has(r.live.status) ||
          r.turning ||
          r.paused !== undefined ||
          this.slots.position(this.key(r.task, r.agent)) !== undefined),
    );
  }

  /** Agents of the task that are queued, starting, working or waiting, or whose loop is about to send. */
  working(task: string): string[] {
    return [...this.runs.values()]
      .filter(
        (r) => r.task === task && (WORKING.has(r.live.status) || (r.turning && !r.closing && !r.settling)),
      )
      .map((r) => r.agent);
  }

  /**
   * The tasks an agent is working on right now: starting or in a turn. An agent that is queued for a
   * slot or waits on an answer is not working, so its task is not counted here.
   */
  workingTasks(): string[] {
    const out = new Set<string>();
    for (const r of this.runs.values()) {
      const status = r.live.status;
      const idleish = status === "queued" || status === "waiting";
      if (
        status === "starting" ||
        status === "working" ||
        (r.turning && !r.closing && !r.settling && !idleish)
      ) {
        out.add(r.task);
      }
    }
    return [...out];
  }

  /** Agents in the middle of a turn, across majhi. An update waits for these with "when they finish". */
  turnsInFlight(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.turning && r.session !== undefined) n++;
    return n;
  }

  /**
   * Queues the task's first prompt, built from TASK.md, and starts the agent. Does nothing
   * when it was sent before. A paused or cut run continues from where it stopped. Returns at
   * once: the run streams into the room.
   */
  startTask(task: Task, agent: string, options: { ownBrief?: boolean; wake?: boolean } = {}): void {
    const run = this.runFor(task.id, agent);
    this.queueBrief(task, agent, options);
    // Paused by a failed start: the brief is still queued, so it goes on with no "continue" prompt. Starting retries.
    if (run.startFailure !== undefined && run.paused !== undefined && !run.closing) {
      this.resumeQueue(run, "the task was resumed");
      return;
    }
    if (run.paused !== undefined || run.interrupted) {
      this.resumeRun(run, "the task was resumed");
      return;
    }
    // Resume during a turn has nothing to restart: say so, so the owner knows why nothing changes.
    if (run.turning && run.session !== undefined && !run.settling && !run.closing) {
      const waiting = run.queue.some((e) => e.kind === "owner");
      this.live.system(
        run,
        "info",
        `@${agent} is still working on its turn.${waiting ? " Your queued messages go when it ends." : ""}`,
      );
    }
    run.held = false;
    // The brief was sent long ago and nothing is queued (a task the owner was needed on, whose run
    // is gone): without a prompt the task would say running while no agent works. `wake` is false
    // when the caller queues the owner's message itself, so the agent gets that and no extra turn.
    if (options.wake !== false && run.queue.length === 0 && !run.turning && !isBossChat(task))
      run.queue.unshift({ kind: "resume" });
    this.live.refreshQueued(run);
    // Nothing queued: an empty loop would hand the task back for review before the owner's message lands.
    if (run.queue.length > 0) void this.drive(run);
  }

  /** The agent has something to do or is doing it: a turn, a queued prompt, a pause that resumes. */
  hasWork(task: string, agent: string): boolean {
    const run = this.runs.get(this.key(task, agent));
    return run !== undefined && (run.turning || run.queue.length > 0);
  }

  /**
   * Posts the task's brief for `agent` and puts it first in its queue, once. `startTask` does it,
   * and a message that starts the task does it first so the brief comes before the message.
   */
  queueBrief(task: Task, agent: string, options: { ownBrief?: boolean } = {}): void {
    const { room } = this.deps;
    // Several agents start together (a pipeline's first step): each after the first gets its own brief.
    const briefId = options.ownBrief === true ? `${BRIEF_ITEM_ID}:${agent}` : BRIEF_ITEM_ID;
    // The captain chat has no brief to send: the owner's first message starts it.
    if (room.get(task.id, briefId) !== undefined || isBossChat(task)) return;
    const run = this.runFor(task.id, agent);
    room.post(task.id, briefId, {
      type: "owner",
      text: task.brief,
      attachments: task.attachments,
      queued: false,
      to: agent,
    });
    run.queue.unshift({ kind: "brief" });
  }

  /** Stores the owner's message and sends it: now when the agent is idle, else queued, or after a cancel when `interrupt`. */
  async send(
    task: Task,
    agent: string,
    input: {
      text: string;
      attachments: Attachment[];
      mode: "queue" | "interrupt";
      /** More agents the owner addressed: the same message goes to their next turn too. */
      also?: readonly string[];
    },
  ): Promise<RoomItem> {
    const item = this.postOwner(task.id, agent, input);
    await this.deliver(task.id, agent, item.id, input.mode, input.also ?? []);
    return item;
  }

  /**
   * Stores the owner's message in the room without sending it; `deliver` sends it. It shows as
   * queued when the agent is busy or earlier messages of the task are still on their way.
   */
  postOwner(
    task: Task["id"],
    agent: string,
    input: { text: string; attachments: Attachment[]; mode: "queue" | "interrupt" },
  ): RoomItem {
    // The run exists before the item: a run made later reads queued items back from the store.
    const run = this.runFor(task, agent);
    const behind = run.turning || run.queue.length > 0 || this.deliveries.has(task);
    const id = `owner:${randomUUID()}`;
    this.deps.room.post(task, id, {
      type: "owner",
      text: input.text,
      attachments: input.attachments,
      queued: behind && input.mode === "queue",
      to: agent,
    });
    const item = this.deps.room.get(task, id);
    if (item === undefined) throw new Error("The message was not stored");
    return item;
  }

  /**
   * Queues a stored owner message for `agent` (and the same message for `also`) and starts the
   * loop: sent now when the agent is idle, else on its next turn, or after a cancel when
   * `interrupt`. Each agent gets it once, even when its run read it back from the store.
   */
  async deliver(
    task: Task["id"],
    agent: string,
    itemId: string,
    mode: "queue" | "interrupt",
    also: readonly string[],
  ): Promise<void> {
    const run = this.runFor(task, agent);
    if (mode === "interrupt") await this.sendFirst(run, itemId);
    else {
      if (!hasOwnerEntry(run, itemId)) run.queue.push({ kind: "owner", itemId });
      run.held = false;
      this.live.refreshQueued(run);
      void this.drive(run);
    }
    for (const other of also) {
      if (other === agent) continue;
      const extra = this.runFor(task, other);
      if (!hasOwnerEntry(extra, itemId)) extra.queue.push({ kind: "owner", itemId });
      extra.held = false;
      this.live.refreshQueued(extra);
      void this.drive(extra);
    }
  }

  /**
   * "Send now" on a queued owner message: it moves to the front of each queue it waits in, and an
   * agent in the middle of a turn stops it, so the message goes at once. Refused once it was sent.
   */
  async sendNow(task: Task["id"], itemId: string): Promise<RoomItem> {
    const item = this.queuedOwner(task, itemId);
    if (item.to !== undefined) this.runFor(task, item.to);
    const holders = this.holders(task, itemId);
    if (holders.length === 0) throw new UserError("That message is not waiting for any agent.", 409);
    await Promise.all(holders.map((run) => this.sendFirst(run, itemId)));
    return item;
  }

  /** "Remove" on a queued owner message: no agent gets it, and the room shows it as removed. */
  unqueue(task: Task["id"], itemId: string): RoomItem {
    const item = this.queuedOwner(task, itemId);
    if (item.to !== undefined) this.runFor(task, item.to);
    for (const run of this.holders(task, itemId)) {
      run.queue = run.queue.filter((e) => !(e.kind === "owner" && e.itemId === itemId));
      this.live.refreshQueued(run);
    }
    this.deps.room.post(task, itemId, ownerPayload(item, { queued: false, removed: true }));
    const stored = this.deps.room.get(task, itemId);
    if (stored === undefined) throw new Error("The message was not stored");
    return stored;
  }

  /** The owner message, while it still waits for its agent's turn. */
  private queuedOwner(task: Task["id"], itemId: string): Extract<RoomItem, { type: "owner" }> {
    const item = this.deps.room.get(task, itemId);
    if (item === undefined || item.type !== "owner") throw new UserError("That message does not exist.", 404);
    if (item.removed === true) throw new UserError("That message was removed.", 409);
    if (!item.queued) throw new UserError("That message was already sent.", 409);
    return item;
  }

  /** Runs of the task with this owner message in their queue. */
  private holders(task: Task["id"], itemId: string): AgentRun[] {
    return [...this.runs.values()].filter((r) => r.task === task && hasOwnerEntry(r, itemId));
  }

  /**
   * Puts an owner message first in the run's queue and sends it as soon as it can: a turn in
   * progress is cancelled for it. A session still opening sends it first anyway, so nothing is
   * cancelled then (a cancel before the first prompt would hold the queue, this message too).
   */
  private async sendFirst(run: AgentRun, itemId: string): Promise<void> {
    run.queue = run.queue.filter((e) => !(e.kind === "owner" && e.itemId === itemId));
    run.queue.unshift({ kind: "owner", itemId });
    run.held = false;
    run.cancelBeforePrompt = false;
    this.live.refreshQueued(run);
    if (run.turning && run.session !== undefined && !run.settling) await this.cancelRun(run);
    void this.drive(run);
  }

  /**
   * Runs `work` in the background after the task's earlier deliveries, so owner messages reach
   * their agents in the order they were sent while the sender returns at once. `work` reports
   * its own errors; a failed one does not stop the next. `idle` waits for these too.
   */
  inOrder(task: Task["id"], work: () => Promise<void>): void {
    const previous = this.deliveries.get(task) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(work)
      .catch(() => undefined)
      .then(() => {
        if (this.deliveries.get(task) === next) this.deliveries.delete(task);
      });
    this.deliveries.set(task, next);
  }

  /** Lets a run take what is queued: clears a hold and drives it unless it is paused. */
  private letRunTake(run: AgentRun): void {
    run.held = false;
    this.live.refreshQueued(run);
    if (run.paused === undefined) void this.drive(run);
  }

  /**
   * Wakes an agent with a message from majhi, like a background process that ended (5.15): sent
   * now when it is idle, else on its next turn. Starts its session if needed.
   */
  notify(task: string, agent: string, text: string): void {
    const run = this.runFor(task, agent);
    run.queue.push({ kind: "notice", text });
    this.letRunTake(run);
  }

  /**
   * Tells an agent something with its next prompt, like a "not woken" note. Unlike `notify` it
   * starts no turn: an idle agent reads it when something else wakes it.
   */
  note(task: string, agent: string, text: string): void {
    this.runFor(task, agent).notes.push(text);
  }

  /**
   * A background process of `p.agent` ended by itself (5.15). Queued once per run of the process,
   * and every end that waits is sent in one prompt: while the agent works, or is paused, they pile
   * up and go out together, without the ones a newer run replaced by then.
   */
  processEnded(p: ProcessInfo): void {
    const run = this.runFor(p.task, p.agent);
    if (run.processEnds.some((e) => sameRun(e, p))) return;
    run.processEnds.push(p);
    if (!run.queue.some((e) => e.kind === "processes")) run.queue.push({ kind: "processes" });
    this.letRunTake(run);
  }

  /** The owner changed an agent's model or effort for this task: a live session switches now (5.15). */
  async applyOptions(
    task: string,
    agent: string,
    options: { model?: string; effort?: string },
  ): Promise<boolean> {
    const run = this.runs.get(this.key(task, agent));
    const session = run?.session;
    if (run === undefined || session === undefined) return false;
    if (options.model !== undefined) await session.setOption("model", options.model);
    if (options.effort !== undefined) await session.setOption("thought_level", options.effort);
    this.setLive(run, {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    return true;
  }

  /**
   * Wakes `to` with work another agent handed over (5.3): stores a handoff item in the room and
   * queues it, sent now when `to` is idle, else on its next turn. Starts its session if needed.
   */
  handoff(task: Task, input: { from: string; to: string; via: HandoffVia; text: string }): RoomItem {
    const run = this.runFor(task.id, input.to);
    const busy = run.turning;
    const id = `handoff:${randomUUID()}`;
    this.deps.room.post(task.id, id, {
      type: "handoff",
      from: input.from,
      to: input.to,
      via: input.via,
      text: input.text,
      queued: busy,
    });
    const item = this.deps.room.get(task.id, id);
    if (item === undefined) throw new Error("The handoff was not stored");
    run.queue.push({ kind: "handoff", itemId: id });
    this.letRunTake(run);
    return item;
  }

  /**
   * Closes one agent's session in a task, for a team change. Its queue is dropped and returned,
   * with the prompt of the turn it was in first, so a swap can hand them on (`handOn`).
   */
  async remove(task: string, agent: string): Promise<QueueEntry[]> {
    const run = this.runs.get(this.key(task, agent));
    if (run === undefined) return [];
    const sending = run.sending;
    const pending = [
      ...(sending === undefined || run.queue.includes(sending) ? [] : [sending]),
      ...run.queue,
    ];
    run.closing = true;
    run.held = true;
    run.clearTimers();
    run.lockWait?.abort();
    this.permissions.cancelAll(run);
    const session = run.session;
    if (session !== undefined) {
      await session.cancel().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
    await run.drive?.catch(() => undefined);
    await run.session?.close().catch(() => undefined);
    this.endSession(run, "removed");
    this.deps.store.runs.setInFlight(task, agent, 0, false);
    this.live.set(run, { status: "stopped", nowDoing: undefined, slot: undefined });
    this.runs.delete(this.key(task, agent));
    return pending;
  }

  /**
   * Gives `to` what `from` had pending when `remove` closed it for a swap. The brief and the
   * messages for `from` go to `to`; work of its own that was cut (a resume, a notice, ended
   * processes) becomes `note`, so `to` carries on. True when `to` got something and was woken.
   */
  handOn(task: string, from: string, to: string, pending: readonly QueueEntry[], note: string): boolean {
    if (pending.length === 0) return false;
    const next = this.runFor(task, to);
    const carried: QueueEntry[] = [];
    let cut = false;
    for (const entry of pending) {
      if (entry.kind === "brief") {
        if (!next.queue.some((e) => e.kind === "brief") && !carried.some((e) => e.kind === "brief"))
          carried.push(entry);
      } else if (entry.kind === "owner" || entry.kind === "handoff") {
        const id = entry.itemId;
        if (
          [...next.queue, ...carried].some((e) => e.kind === entry.kind && "itemId" in e && e.itemId === id)
        )
          continue;
        this.retarget(task, id, from, to);
        carried.push(entry);
      } else if (entry.kind !== "fresh") {
        cut = true;
      }
    }
    // The brief already tells `to` to start; without it, the note says why it was woken.
    if (cut && !carried.some((e) => e.kind === "brief")) carried.unshift({ kind: "notice", text: note });
    if (carried.length === 0) return false;
    next.queue = [...carried, ...next.queue];
    this.letRunTake(next);
    return true;
  }

  /** Stops the current turn of one agent, or of every agent in the task. Queued messages wait. */
  async cancel(task: string, agent?: string): Promise<string[]> {
    const targets = [...this.runs.values()].filter(
      (r) => r.task === task && (agent === undefined || r.agent === agent) && r.turning,
    );
    for (const run of targets) {
      if (run.queue.length > 0) run.held = true;
      // Between the session opening and the prompt going out there is no turn to cancel yet.
      if (!run.prompting) run.cancelBeforePrompt = true;
    }
    await Promise.all(targets.map((run) => this.cancelRun(run)));
    return targets.map((r) => r.agent);
  }

  /** Cancels every turn and closes every session of the task. The owner stopped it, so nothing resumes by itself. */
  async stop(task: string): Promise<void> {
    const targets = [...this.runs.values()].filter((r) => r.task === task);
    await Promise.all(
      targets.map(async (run) => {
        run.closing = true;
        run.held = true;
        run.clearTimers();
        run.lockWait?.abort();
        this.permissions.cancelAll(run);
        this.slots.release(this.key(run.task, run.agent));
        const session = run.session;
        if (session !== undefined) {
          await session.cancel().catch(() => undefined);
          await session.close().catch(() => undefined);
        }
        await run.drive?.catch(() => undefined);
        // A session that opened while we were stopping.
        await run.session?.close().catch(() => undefined);
        this.endSession(run, "stopped");
        run.paused = undefined;
        run.interrupted = false;
        run.resuming = false;
        run.freshDue = false;
        run.queue = run.queue.filter((e) => e.kind === "owner" || e.kind === "brief" || e.kind === "handoff");
        run.processEnds = [];
        this.deps.store.runs.setInFlight(run.task, run.agent, 0, false);
        this.live.set(run, { status: "stopped", nowDoing: undefined, slot: undefined });
        run.closing = false;
      }),
    );
  }

  /** Answers a pending permission prompt with one of its options, for the owner or the `captain`. */
  answerPermission(task: string, itemId: string, option: string, captain = false): RoomItem {
    const run = [...this.runs.values()].find((r) => r.task === task && r.pending.has(itemId));
    return this.permissions.answer(run, task, itemId, option, captain);
  }

  /**
   * "Fresh session": replaces the agent's session with a new one that carries a handoff note.
   * During a turn it happens when the turn ends; the room says so at once.
   */
  async fresh(task: Task, agent: string): Promise<RoomItem> {
    const run = this.runFor(task.id, agent);
    if (run.turning) {
      run.freshDue = true;
      return this.live.systemItem(run, "info", `@${agent} gets a fresh session when this turn ends.`);
    }
    // Hold the loop so nothing else prompts the agent meanwhile.
    run.turning = true;
    let item: RoomItem;
    try {
      item = await this.compaction.fresh(run);
    } finally {
      run.turning = false;
    }
    if (run.queue.length > 0 && !run.held && run.paused === undefined) void this.drive(run);
    return item;
  }

  /**
   * The agent's task got new read-only mounts. A session already open cannot see them, so an idle
   * one is closed now and the next prompt resumes it with the mounts; a busy one restarts when its
   * turn ends, before the next queued prompt.
   */
  remount(task: string, agent: string): void {
    const run = this.runs.get(this.key(task, agent));
    if (run?.session === undefined) return;
    if (run.turning) run.remountDue = true;
    else this.evict(this.key(task, agent));
  }

  /**
   * The agent's skills or connections changed. Every session it has open, in any task, restarts the
   * way `remount` does, so its next turn has the new skills and MCP tools.
   */
  remountAgent(agent: string): void {
    for (const run of [...this.runs.values()]) if (run.agent === agent) this.remount(run.task, agent);
  }

  /** The skills an open session has: the folder of copies and each skill's name and description. */
  skillsOf(
    task: string,
    agent: string,
  ): { dir: string; items: { name: string; description: string }[] } | undefined {
    const skills = this.runs.get(this.key(task, agent))?.skills;
    return skills === undefined ? undefined : { dir: skills.dir, items: skills.items };
  }

  /** True while an open session holds the connection (5.14), so Connect renews its token ahead of time. */
  holdsConnection(connection: string): boolean {
    for (const run of this.runs.values()) {
      if (run.session !== undefined && run.connections?.uses.some((u) => u.id === connection)) return true;
    }
    return false;
  }

  /**
   * The connection's token was renewed. Every session that holds it restarts the way `remount` does,
   * so its next turn has the new header.
   */
  remountConnection(connection: string): void {
    for (const run of [...this.runs.values()]) {
      if (run.connections?.uses.some((u) => u.id === connection)) this.remount(run.task, run.agent);
    }
  }

  /** The agents that have a session open now, with their task: the ones a new connection can reach at once. */
  openSessions(): { task: string; agent: string }[] {
    return [...this.runs.values()]
      .filter((r) => r.session !== undefined && !r.closing)
      .map((r) => ({ task: r.task, agent: r.agent }));
  }

  /** What the agent's open session holds of its connections (5.14), or undefined. */
  connectionsOf(task: string, agent: string): RunConnections | undefined {
    return this.runs.get(this.key(task, agent))?.connections;
  }

  /**
   * The secret values the task's runs and processes have held (5.14), kept until the task is
   * forgotten, so a late tool update or a process's end is still redacted after its session went.
   */
  secretsOf(task: string): HeldSecret[] {
    return [...(this.heldSecrets.get(task)?.entries() ?? [])].map(([value, name]) => ({ name, value }));
  }

  rememberSecrets(task: string, secrets: readonly HeldSecret[]): void {
    if (secrets.length === 0) return;
    const known = this.heldSecrets.get(task) ?? new Map<string, string>();
    for (const s of secrets) known.set(s.value, s.name);
    this.heldSecrets.set(task, known);
  }

  /**
   * Asks the owner about a connection write majhi runs for the agent, like an ssh command through
   * majhi-connections: a prompt in the room that names the connection. Undefined without a session.
   */
  askConnectionWrite(
    task: string,
    agent: string,
    ask: PermissionAsk,
    writes: readonly GateWrite[],
  ): Promise<string | undefined> | undefined {
    const run = this.runs.get(this.key(task, agent));
    if (run?.session === undefined) return undefined;
    return this.permissions.askWrite(run, ask, writes, new AbortController().signal);
  }

  /** The concurrency limits changed: starts that wait may fit now. */
  async limitsChanged(): Promise<void> {
    await this.limits();
    return this.slots.pump();
  }

  /** Continues a cut turn after a restart or crash (5.7). */
  resumeAfterRestart(task: string, agent: string): void {
    const run = this.runFor(task, agent);
    run.interrupted = true;
    this.resumeRun(run, "majhi restarted during its turn");
  }

  /** The turn was cut and waits for the owner (auto-resume is off). Resume continues it. */
  markInterrupted(task: string, agent: string): void {
    const run = this.runFor(task, agent);
    run.interrupted = true;
    run.paused = "error";
    this.live.set(run, { status: "paused", nowDoing: undefined });
  }

  /**
   * majhi is offline (5.7): turns that went quiet or wait on a permission stop and wait. A turn
   * that heard from its agent in the last `STREAMING_MS` goes on; it pauses by itself if its agent
   * fails on the network, or on a later probe once it goes quiet. Runs still starting, or waiting
   * for a worktree, have sent nothing yet and are left alone.
   */
  async pauseForOffline(): Promise<void> {
    const now = this.now().getTime();
    const targets = [...this.runs.values()].filter(
      (r) =>
        r.prompting &&
        r.paused === undefined &&
        !r.closing &&
        (r.pending.size > 0 || now - r.lastEventAt >= STREAMING_MS),
    );
    await Promise.all(
      targets.map(async (run) => {
        run.interrupted = true;
        this.pause(
          run,
          "offline",
          `majhi is offline. @${run.agent} paused and continues when the connection is back.`,
        );
        await this.cancelRun(run);
      }),
    );
  }

  /** Runs paused because majhi went offline, for the network watch to resume. */
  pausedOffline(): { task: string; agent: string }[] {
    return [...this.runs.values()]
      .filter((r) => r.paused === "offline")
      .map((r) => ({ task: r.task, agent: r.agent }));
  }

  /** Continues a run that is still paused because majhi went offline. Once, however often it is called. */
  resumeOffline(task: string, agent: string, why: string): void {
    const run = this.runs.get(this.key(task, agent));
    if (run?.paused === "offline") this.resumeRun(run, why);
  }

  /** The computer woke from sleep: continue turns that failed while it slept, restart ones that stalled. */
  async wake(): Promise<void> {
    const views = [...this.runs.values()]
      .filter(
        (r) =>
          !r.closing &&
          r.paused !== "offline" &&
          r.paused !== "limit" &&
          r.paused !== "owner" &&
          r.paused !== "signed-out",
      )
      .map((r) => ({
        key: this.key(r.task, r.agent),
        turning: r.turning && r.session !== undefined,
        interrupted: r.interrupted,
        retryable: r.retryable && r.live.status === "error",
        lastEventAt: r.lastEventAt,
      }));
    const plan = wakePlan(views, this.now().getTime());
    for (const key of plan.resume) {
      const run = this.runs.get(key);
      if (run !== undefined) this.resumeRun(run, "the computer woke up");
    }
    await Promise.all(
      plan.restart.map(async (key) => {
        const run = this.runs.get(key);
        if (run === undefined) return;
        run.interrupted = true;
        // Quietly: the resume says what happened.
        run.paused = "offline";
        await this.cancelRun(run);
        this.resumeRun(run, "its turn stalled while the computer slept");
      }),
    );
  }

  /** Resolves when the owner messages sent to the task so far were handed to their agents. */
  async idleDeliveries(task: string): Promise<void> {
    await this.deliveries.get(task);
  }

  /** Resolves when no agent of the task (or of any task) is running a turn. For tests and shutdown. */
  async idle(task?: string): Promise<void> {
    for (;;) {
      const sending = [...this.deliveries].filter(([t]) => task === undefined || t === task);
      if (sending.length > 0) {
        await Promise.all(sending.map(([, p]) => p));
        continue;
      }
      const busy = [...this.runs.values()].filter(
        (r) => (task === undefined || r.task === task) && r.drive !== undefined,
      );
      if (busy.length === 0) return;
      await Promise.all(busy.map((r) => r.drive?.catch(() => undefined)));
    }
  }

  /** Forgets a removed task. Sessions must be stopped first. */
  forget(task: string): void {
    for (const [key, run] of this.runs) {
      if (run.task !== task) continue;
      run.clearTimers();
      this.slots.release(key);
      this.runs.delete(key);
    }
    this.heldSecrets.delete(task);
    this.limitStrikes.delete(task);
    this.deps.room.drop(task);
  }

  /**
   * Server shutdown: closes every session so no agent process outlives majhi, and starts none
   * after. Cut turns, and prompts queued later by a hook or a request, resume after the restart.
   */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        run.closing = true;
        run.clearTimers();
        this.permissions.cancelAll(run);
        await run.session?.close().catch(() => undefined);
        this.endSession(run, "server-stop");
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // The queue

  private key(task: string, agent: string): string {
    return `${task}\u0000${agent}`;
  }

  private runFor(task: Task["id"], agent: string): AgentRun {
    const key = this.key(task, agent);
    let run = this.runs.get(key);
    if (run === undefined) {
      const queued = this.deps.store.room.queuedFor(task, agent);
      run = new AgentRun(task, agent, queued.length);
      run.live.commands = this.deps.room.knownCommands(agent);
      run.queue = queued.map((item) =>
        item.type === "handoff" ? { kind: "handoff", itemId: item.id } : { kind: "owner", itemId: item.id },
      );
      run.held = run.queue.length > 0;
      this.runs.set(key, run);
    }
    return run;
  }

  private setLive(run: AgentRun, patch: LivePatch): void {
    this.live.set(run, patch);
  }

  /** Runs queued prompts one after another. One loop per agent at a time. */
  private drive(run: AgentRun): Promise<void> {
    if (run.turning) return run.drive ?? Promise.resolve();
    if (this.closed) return Promise.resolve();
    run.turning = true;
    const loop = this.loop(run);
    // The loop clears `turning` itself, in the same step as its last check of the queue.
    if (run.turning) run.drive = loop;
    return loop;
  }

  private async loop(run: AgentRun): Promise<void> {
    try {
      await this.runQueue(run);
    } catch (err) {
      // A bug or a closed database must not become an unhandled rejection that ends the server.
      try {
        this.live.system(run, "error", `@${run.agent} stopped: ${errorMessage(err)}`);
      } catch {
        // Nowhere left to say it.
      }
      this.setLive(run, { status: "error", nowDoing: undefined });
    } finally {
      run.turning = false;
      run.settling = false;
      run.cancelBeforePrompt = false;
      run.sending = undefined;
      run.drive = undefined;
      // Idle between turns: a waiting start may stop this process now.
      if (run.session !== undefined && run.live.status === "idle") {
        this.slots.mark(this.key(run.task, run.agent), false);
      }
      // A budget or autonomy pause can last days: the process goes, and the prompts stay queued.
      if ((run.paused === "limit" || run.paused === "owner") && !run.closing) {
        this.evict(this.key(run.task, run.agent));
        this.setLive(run, { status: "paused", nowDoing: undefined });
      }
      if (run.redrive) {
        run.redrive = false;
        if (!run.closing) void this.drive(run);
      }
      if (!run.turning) this.deps.onLoopEnd?.(run.task, run.agent);
    }
  }

  /** Pauses the run when a budget or autonomous mode's gate holds its task. True when it paused. */
  private async pauseIfLimited(run: AgentRun): Promise<boolean> {
    // The agent's own account is at a usage limit: the fallback takes over, or the run waits for the reset.
    const held = await this.deps.accountLimit?.(run.task, run.agent);
    if (held !== undefined && !run.closing) {
      await this.handOffOrPause(run, held.account, held.limit);
      return true;
    }
    const why = await this.deps.limited?.(run.task, run.agent);
    if (run.closing) return false;
    // The paused card carries the cause (a daily cap, a budget, an account limit), not a side line.
    if (why !== undefined) {
      this.pause(run, "limit", why, true);
      return true;
    }
    const gate = await this.deps.held?.(run.task, run.agent);
    if (gate === undefined || run.closing) return false;
    this.pause(run, gate.reason, gate.why, true);
    return true;
  }

  /**
   * A budget reached 100%, or autonomous mode started holding work: runs that wait with prompts
   * queued pause now. A run in the middle of a turn is not touched, and pauses between turns by
   * itself.
   */
  async pauseLimited(): Promise<void> {
    for (const run of [...this.runs.values()]) {
      if (run.turning || run.paused !== undefined || run.closing || run.held || run.queue.length === 0)
        continue;
      // Idle between turns, so nothing else releases the process: a budget pause can last days.
      if ((await this.pauseIfLimited(run)) && !run.turning && !run.closing) {
        this.evict(this.key(run.task, run.agent));
        this.setLive(run, { status: "paused", nowDoing: undefined });
      }
    }
  }

  /** Runs paused by a budget, for the lift to look at. */
  pausedForLimit(): { task: string; agent: string; account?: string }[] {
    return [...this.runs.values()]
      .filter((r) => r.paused === "limit" && !r.closing)
      .map((r) => ({
        task: r.task,
        agent: r.agent,
        ...(r.limitAccount === undefined ? {} : { account: r.limitAccount }),
      }));
  }

  /** Says once, in the room, that a paused run's account limit passed and it waits for the owner. */
  noteLimitReset(task: string, agent: string, text: string): void {
    const run = this.runs.get(this.key(task, agent));
    if (run?.paused !== "limit" || run.closing || run.limitResetSaid) return;
    run.limitResetSaid = true;
    this.live.system(run, "info", text);
  }

  /** Continues a run a budget paused: its queued prompts go on, with no extra "continue" prompt. */
  resumeLimit(task: string, agent: string, why: string): void {
    const run = this.runs.get(this.key(task, agent));
    if (run?.paused !== "limit" || run.closing) return;
    this.resumeQueue(run, why);
  }

  /**
   * Continues every run of the task that autonomous mode's gate held (`owner` or `limit`): their
   * queued prompts go on, with no extra "continue" prompt. Returns how many it resumed.
   */
  resumeHeld(task: string, why: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.task !== task || run.closing || (run.paused !== "owner" && run.paused !== "limit")) continue;
      this.resumeQueue(run, why);
      n++;
    }
    return n;
  }

  private resumeQueue(run: AgentRun, why: string): void {
    run.paused = undefined;
    run.limitAccount = undefined;
    run.limitResetSaid = false;
    this.live.system(run, "info", `Resuming @${run.agent}: ${why}.`);
    this.deps.onResumed?.(run.task);
    if (run.turning) run.redrive = true;
    else void this.drive(run);
  }

  /** True while a run of the task is in its loop: in a turn, or about to send one. */
  inTurn(task: string): boolean {
    return [...this.runs.values()].some((r) => r.task === task && r.turning && !r.closing);
  }

  private async runQueue(run: AgentRun): Promise<void> {
    while (run.queue.length > 0 && !run.held && !run.closing && run.paused === undefined) {
      if (await this.pauseIfLimited(run)) break;
      if (run.session === undefined) {
        if (!(await this.startSession(run))) {
          const failure = run.startFailure;
          // A resume of an agent that ran before tries a crashed adapter once more. A sign-in or a limit does not pass by retrying.
          if (failure !== undefined && !(failure.kind === "error" && run.resuming))
            await this.startFailed(run, failure);
          else this.resumeFailed(run, "the agent could not start");
          return;
        }
        if (this.stoppedBeforePrompt(run)) break;
      }
      if (run.closing || run.paused !== undefined) break;
      // The wait for a slot or the session start may have been long: ask again before the turn.
      if (await this.pauseIfLimited(run)) break;
      const session = run.session;
      const entry = run.queue.shift();
      if (session === undefined || entry === undefined) break;
      run.sending = entry;
      this.live.refreshQueued(run);
      if (entry.kind === "fresh") {
        await this.compaction.fresh(run);
        continue;
      }
      if (entry.kind !== "continue") run.compactions = 0;
      // Read before `blocksFor` resets it: an owner or handoff prompt on a session that has not
      // seen the brief starts with "First read TASK.md".
      const unbriefed = run.needsBrief;
      const brief =
        entry.kind === "brief" ||
        run.carry !== undefined ||
        (unbriefed && (entry.kind === "owner" || entry.kind === "handoff"));
      const raw = await this.withFacts(
        run,
        brief,
        this.withNotes(run, this.withSkills(run, this.withProcesses(run, await this.blocksFor(run, entry)))),
      );
      if (raw === undefined) continue;

      // One read of the settings per turn: before the prompt and after it.
      const budget = await this.compaction.budget(run);
      run.turnLimits = await this.turnLimits(run);
      // Compact first when this prompt would take the session over its budget.
      if (run.carry === undefined && needsCompaction(run.usage, budget, estimateTokens(raw))) {
        const done = await this.compaction.compact(run, "threshold", budget);
        if (done === undefined || run.session === undefined) {
          // Paused, or handed off: the prompt goes to the next session.
          run.queue.unshift(entry);
          continue;
        }
      }
      // Esc while the prompt was being prepared: keep it queued, send nothing.
      if (run.cancelBeforePrompt) {
        run.queue.unshift(entry);
        this.live.refreshQueued(run);
        this.stoppedBeforePrompt(run);
        break;
      }
      const stopReason = await this.turn(
        run,
        session,
        this.withPreamble(run, this.withCarry(run, raw, entry.kind === "owner")),
      );
      run.sending = undefined;
      const fired = run.limitHit;
      run.limitHit = undefined;
      if (stopReason === undefined) {
        // Failed on the sign-in and paused: the same prompt goes out once the account works again.
        if (run.requeue) {
          run.requeue = false;
          run.queue.unshift(entry);
          this.live.refreshQueued(run);
        }
        // The account is signed out: a fallback or a teammate takes the queue over, or the run waits for the sign-in.
        const signedOut = run.signedOutAccount;
        run.signedOutAccount = undefined;
        if (signedOut !== undefined && !(await this.takeOverFor(run, signedOutHandoff(run.agent))))
          this.pauseSignedOut(run, signedOut);
        // The account hit its usage limit: the fallback takes the queue over, or the run waits for the reset.
        const mark = run.limitMark;
        run.limitMark = undefined;
        if (mark !== undefined && run.account !== undefined)
          await this.handOffOrPause(run, run.account, mark);
        return;
      }
      if (stopReason === "recovered") continue;
      if (run.paused !== undefined) break;
      // A turn that ended with the CLI's limit line as its whole answer did not do its work.
      if (stopReason === "end_turn" && run.account !== undefined && run.accountKind !== undefined) {
        const said = limitLine(run.mapper?.finalText() ?? "", run.accountKind.tool, this.now());
        if (said !== undefined) {
          const mark = await this.markAccountLimit(run.account, said);
          this.markTurn(run, false, false);
          run.queue.unshift(entry);
          this.live.refreshQueued(run);
          await this.handOffOrPause(run, run.account, mark);
          return;
        }
      }
      // A turn limit cut it: continue in a fresh session, or pause when it keeps happening.
      if (fired !== undefined && stopReason === "cancelled") {
        if (!(await this.afterLimit(run, fired))) break;
        continue;
      }
      // A turn that ended by itself means the task is not stuck.
      if (stopReason === "end_turn") this.limitStrikes.delete(run.task);
      if (entry.kind === "resume" && stopReason !== "cancelled") {
        run.resuming = false;
        run.resumeFailures = 0;
      }
      run.turns++;
      this.setLive(run, { turns: run.turns });
      const finalText = run.mapper?.finalText() ?? "";
      if (stopReason === "end_turn") run.refusalSwitched = false;
      // Blocked by the model's safeguards: a cheaper model of the same account continues, once.
      const switched = stopReason === "refusal" && (await this.afterRefusal(run));
      if (!(await this.afterTurn(run, stopReason, budget))) break;
      if (switched) continue;
      // The room routes the final message before this agent can count as idle. A refusal with no
      // model left to try ends the turn the same way, so its step goes back to the team.
      if (
        (stopReason === "end_turn" || stopReason === "refusal") &&
        !run.closing &&
        run.paused === undefined
      ) {
        await this.routeTurn(run, finalText, stopReason === "refusal");
      }
    }
    if (run.session !== undefined && !run.exited && !run.closing && run.paused === undefined) {
      this.setLive(run, { status: "idle", nowDoing: undefined });
      this.scheduleIdleStop(run);
      // Only a turn the agent ended itself, or its model's safeguards, hands the task back; Esc and
      // stops keep it with the owner.
      const ended = run.lastStop === "end_turn" || run.lastStop === "refusal";
      if (run.queue.length === 0 && !run.held && ended) {
        // This loop is done sending, so it no longer counts as working.
        run.settling = true;
        this.deps.onIdle?.(run.task, run.lastStop === "refusal");
      }
    }
  }

  /**
   * Sends one prompt and ends the turn: room items, checkpoint, in-flight mark. Returns the stop
   * reason, `recovered` when a full context was handed off and the loop goes on, or undefined
   * when the loop must stop (an error, a lost connection, a pause).
   */
  private async turn(
    run: AgentRun,
    session: NonNullable<AgentRun["session"]>,
    blocks: PromptBlock[],
  ): Promise<string | undefined> {
    const release = await this.lockWorktrees(run);
    if (release === undefined) return undefined;
    try {
      await this.startWatch(run);
      return await this.promptTurn(run, session, blocks);
    } finally {
      this.stopWatch(run);
      release();
    }
  }

  /**
   * Takes the locks of the worktrees the agent may edit, waiting while another agent holds one
   * (5.3). Agents without the edit permission take none. Undefined when stopped while waiting.
   */
  private async lockWorktrees(run: AgentRun): Promise<(() => void) | undefined> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined || !run.perms.includes("edit")) return () => {};
    const repos = task.overrides[run.agent]?.repos;
    const paths = task.repos.flatMap((r) =>
      r.worktree === undefined || (repos !== undefined && !repos.includes(r.project)) ? [] : [r.worktree],
    );
    if (paths.length === 0) return () => {};
    const wait = new AbortController();
    run.lockWait = wait;
    try {
      return await this.locks.acquire(paths, this.key(run.task, run.agent), {
        signal: wait.signal,
        onWait: (path, holder) => {
          const other = holder.split("\u0000")[1] ?? "another agent";
          const repo = task.repos.find((r) => r.worktree === path)?.project ?? path;
          this.setLive(run, { status: "waiting", nowDoing: `Waiting for @${other} to finish in ${repo}` });
        },
      });
    } catch {
      return undefined;
    } finally {
      run.lockWait = undefined;
    }
  }

  private async promptTurn(
    run: AgentRun,
    session: NonNullable<AgentRun["session"]>,
    blocks: PromptBlock[],
  ): Promise<string | undefined> {
    this.setLive(run, { status: "working", nowDoing: undefined, turnAt: this.now().toISOString() });
    run.costAtTurnStart = run.costNow;
    run.mapper?.beginTurn();
    this.markTurn(run, true);
    let stopReason: string;
    run.prompting = true;
    try {
      stopReason = (await session.prompt(blocks)).stopReason;
    } catch (err) {
      run.prompting = false;
      this.deps.room.flush(run.task);
      if (run.closing || run.exited) return undefined;
      const message = errorMessage(err);
      run.mapper?.endTurn(true);
      if (run.paused !== undefined) {
        this.markTurn(run, false, false);
        return undefined;
      }
      // The CLI prints its auth error as the turn's text, then the prompt fails on ACP's auth error.
      const said = run.mapper?.finalText().trim() ?? "";
      if (run.account !== undefined && isAuthFailure(err, said)) {
        this.endSession(run, "error");
        void session.close().catch(() => undefined);
        await this.signedOutMidTurn(run, run.account, said === "" ? message : said);
        return undefined;
      }
      // The account's usage, rate or credit limit: the turn stays in flight and its prompt goes back to the queue.
      const limit =
        run.account === undefined || run.accountKind === undefined
          ? undefined
          : limitFailure(err, said, run.accountKind.tool, this.now());
      if (limit !== undefined && run.account !== undefined) {
        await this.checkpoint(run);
        run.limitMark = await this.markAccountLimit(run.account, limit);
        this.markTurn(run, false, false);
        run.requeue = true;
        return undefined;
      }
      if (looksLikeNetworkError(message)) {
        run.interrupted = true;
        this.markTurn(run, false, false);
        this.pause(
          run,
          "offline",
          `@${run.agent} lost its connection (${message}). It continues when majhi is online.`,
        );
        this.deps.onNetworkError?.();
        return undefined;
      }
      if (looksLikeOverload(message) && run.overloadRetries < OVERLOAD_BACKOFF_MS.length) {
        this.retryAfterOverload(run, message);
        return undefined;
      }
      if (isContextError(message)) {
        await this.checkpoint(run);
        this.markTurn(run, false, false);
        return (await this.compaction.recover(run, message)) ? "recovered" : undefined;
      }
      this.markTurn(run, false, true);
      this.live.system(run, "error", `@${run.agent} failed: ${message}`);
      this.endSession(run, "error");
      void session.close().catch(() => undefined);
      this.setLive(run, { status: "error", nowDoing: undefined });
      // A resume tries once more by itself; anything else is the team's to pick up.
      if (!run.resuming && run.queue.length === 0)
        this.deps.onTurnFailed?.({ task: run.task, agent: run.agent, text: message, cause: "error" });
      this.resumeFailed(run, message);
      return undefined;
    }
    run.prompting = false;
    run.lastStop = stopReason;
    run.overloadRetries = 0;
    this.finishTurn(run, stopReason);
    await this.checkpoint(run);
    // A turn cut by majhi (offline, a stall) keeps its in-flight mark, so it continues later.
    this.markTurn(run, false, run.paused === undefined);
    return stopReason;
  }

  /** Marks the account at its limit and returns the mark that holds, which a running mark can extend. */
  private async markAccountLimit(account: string, failure: LimitFailure): Promise<AccountLimit> {
    const marked = await this.deps.markLimit?.(account, failure).catch(() => undefined);
    return marked ?? limitFor(failure, undefined, this.now());
  }

  /**
   * The run's account is at a usage limit. The agent's fallback takes its place when it can (the
   * room says so in one line); else the run pauses as `limit` with its prompts queued, and the lift
   * resumes it at the reset.
   */
  private async handOffOrPause(run: AgentRun, account: string, mark: AccountLimit): Promise<void> {
    if (await this.takeOverFor(run, limitHandoff(run.agent, mark.until, this.now()))) return;
    this.pauseForAccount(run, account, mark);
  }

  private pauseForAccount(run: AgentRun, account: string, mark: AccountLimit): void {
    this.markTurn(run, false, false);
    run.limitAccount = account;
    run.limitResetSaid = false;
    this.pause(run, "limit", limitPauseText(account, mark.until, this.now()), true);
  }

  /**
   * Gives the run's work to its agent's fallback: the fallback takes its place in the team, gets a
   * handoff note built from saved state and the queue, and the run's session ends. False when no
   * fallback can take over, and nothing changed.
   */
  private async takeOverFor(run: AgentRun, why: Handoff): Promise<boolean> {
    const { deps } = this;
    const to =
      (await deps.fallbackFor?.(run.task, run.agent).catch(() => undefined)) ??
      (why.teammates ? await deps.teammateFor?.(run.task, run.agent).catch(() => undefined) : undefined);
    if (to === undefined || run.closing) return false;
    if (!(await deps.takeOver?.(run.task, run.agent, to).catch(() => false))) return false;
    const task = deps.store.tasks.get(run.task);
    const next = this.runFor(run.task, to);
    if (task !== undefined) {
      try {
        const built = await buildCarry(deps, task, to, undefined, why.carry);
        next.carry = built.carry;
        next.freshNext = true;
      } catch (err) {
        this.live.system(run, "warn", `Could not write the handoff note for @${to}: ${errorMessage(err)}`);
      }
    }
    // The pending prompt goes first, then what the fallback had queued.
    const moved = run.queue.splice(0).filter((e) => e.kind !== "fresh" && e.kind !== "processes");
    const carried: QueueEntry[] = [];
    for (const entry of moved) {
      if (entry.kind === "owner" || entry.kind === "handoff") {
        if (next.queue.some((e) => e.kind === entry.kind && "itemId" in e && e.itemId === entry.itemId))
          continue;
        this.retarget(run.task, entry.itemId, run.agent, to);
      }
      carried.push(entry);
    }
    if (carried.length === 0) carried.push({ kind: "continue" });
    next.queue = [...carried, ...next.queue];
    next.held = false;
    next.paused = undefined;
    this.live.system(run, "warn", why.line(to));
    this.retire(run);
    this.live.refreshQueued(next);
    void this.drive(next);
    return true;
  }

  /** A queued message for `from` now belongs to `to`: the room shows it as waiting for `to`. */
  private retarget(task: string, itemId: string, from: string, to: string): void {
    const item = this.deps.room.get(task, itemId);
    if (item?.type === "owner" && item.queued && item.to === from) {
      this.deps.room.post(task, itemId, { ...ownerPayload(item, {}), to });
    } else if (item?.type === "handoff" && item.queued && item.to === from) {
      this.deps.room.post(task, itemId, { ...handoffPayload(item), to });
    }
  }

  /**
   * Ends a run from inside its own loop, for a team change: what `remove` does, without waiting for
   * the loop that is calling it.
   */
  private retire(run: AgentRun): void {
    run.closing = true;
    run.held = true;
    run.clearTimers();
    run.lockWait?.abort();
    const session = run.session;
    const runId = run.runId ?? 0;
    this.endSession(run, "handoff");
    void session?.close().catch(() => undefined);
    this.deps.store.runs.setInFlight(run.task, run.agent, runId, false);
    this.live.set(run, { status: "stopped", nowDoing: undefined, slot: undefined });
    this.runs.delete(this.key(run.task, run.agent));
  }

  /**
   * A turn failed on the account's sign-in. The account is marked `needs-login` and the room says who
   * cannot run. A teammate's step goes back to the lead, who is woken to give it to a teammate whose
   * account works. When the agent is the lead, or no teammate's account works, the run pauses as
   * `signed-out` with the prompt queued again, and continues once the account is signed in.
   */
  private async signedOutMidTurn(run: AgentRun, account: string, said: string): Promise<void> {
    const line = said.split("\n", 1)[0]?.trim() ?? said;
    const detail = `A run of @${run.agent} could not sign in: ${line} Sign in again from Studio > Accounts.`;
    await this.deps.markSignedOut?.(account, detail).catch(() => undefined);
    const cannot = `@${run.agent} cannot run: its account ${account} needs a new sign-in.`;
    const lead = this.deps.store.tasks.get(run.task)?.team[0];
    const teammates =
      lead !== undefined &&
      lead !== run.agent &&
      (await this.deps.teamCanRun?.(run.task, run.agent).catch(() => false)) === true;
    if (teammates) {
      this.markTurn(run, false, true);
      this.live.system(run, "error", `${cannot} Its step goes back to @${lead}.`);
      this.setLive(run, { status: "error", nowDoing: undefined });
      this.deps.onTurnFailed?.({
        task: run.task,
        agent: run.agent,
        text: said,
        cause: "signed-out",
        account,
      });
      return;
    }
    // Kept in flight: after a restart the turn continues too. The loop hands off or pauses once the prompt is back in the queue.
    this.markTurn(run, false, false);
    run.requeue = true;
    run.signedOutAccount = account;
  }

  /** The run waits for its account's sign-in, with its prompts queued. */
  private pauseSignedOut(run: AgentRun, account: string): void {
    const lead = this.deps.store.tasks.get(run.task)?.team[0];
    run.startFailure = { kind: "signed-out", text: `${account} needs a new sign-in.` };
    const nobody = lead === run.agent ? "" : " No teammate with a working account can take its step.";
    this.pause(
      run,
      "signed-out",
      `@${run.agent} cannot run: its account ${account} needs a new sign-in.${nobody} Sign in ${account} on the Accounts page, then the task continues.`,
      true,
    );
  }

  /**
   * Autonomous mode's cap, inside a turn: at each tool call (one check at a time), asks whether the
   * day's spend with what this turn spent so far passed a cap by more than its margin. When it did,
   * the turn stops there and the run pauses with `limit`; "continue" waits in the queue for the cap
   * to lift.
   */
  private readonly capChecks = new Set<Promise<void>>();

  /** Resolves when no cap check is under way, so a test can spend and then look, with no clock. */
  async capChecked(): Promise<void> {
    while (this.capChecks.size > 0) await Promise.all([...this.capChecks]);
  }

  private async checkCap(run: AgentRun): Promise<void> {
    if (run.capChecking) return;
    if (!run.prompting || run.paused !== undefined || run.closing || run.internal !== undefined) return;
    run.capChecking = true;
    try {
      const spent = run.costNow === undefined ? 0 : Math.max(0, run.costNow - (run.costAtTurnStart ?? 0));
      const why = await this.deps.overCap?.(run.task, spent);
      if (why === undefined || !run.prompting || run.paused !== undefined || run.closing) return;
      run.queue.unshift({ kind: "continue" });
      this.live.refreshQueued(run);
      this.pause(run, "limit", why, true);
      await this.cancelRun(run);
    } catch {
      // A check that fails leaves the turn alone; the gate between turns still holds.
    } finally {
      run.capChecking = false;
    }
  }

  /**
   * The model's safeguards ended the turn. The first refusal in a row moves the agent to the next
   * cheaper model of its account for this task and queues "continue" (true). Otherwise, or when
   * there is no such model, the room says so and the turn ends like one the agent ended (false).
   */
  private async afterRefusal(run: AgentRun): Promise<boolean> {
    if (run.closing || run.paused !== undefined) return false;
    const blocked = currentModelName(run);
    const by = blocked === undefined ? "the model's safeguards" : `${blocked}'s safeguards`;
    const next = run.refusalSwitched ? undefined : await switchAfterRefusal(this.deps, run, this.now());
    if (next === undefined) {
      const why = run.refusalSwitched ? "after the switch too" : "and has no other model to try";
      this.live.system(
        run,
        "warn",
        `@${run.agent} was blocked by ${by} ${why}. Its step goes back to the team.`,
      );
      return false;
    }
    run.refusalSwitched = true;
    this.live.system(run, "warn", `@${run.agent} was blocked by ${by}. Continuing on ${next} for this task.`);
    this.deps.onTasksChanged(run.task, false);
    run.queue.unshift({ kind: "continue" });
    this.live.refreshQueued(run);
    return true;
  }

  private async routeTurn(run: AgentRun, text: string, refused = false): Promise<void> {
    try {
      // Other agents get the message as the room shows it.
      const shown = redactSecrets(text, this.secretsOf(run.task));
      await this.deps.onTurnEnd?.({
        task: run.task,
        agent: run.agent,
        text: shown,
        ...(refused ? { refused: true } : {}),
      });
    } catch (err) {
      this.live.system(run, "warn", `Could not route @${run.agent}'s message: ${errorMessage(err)}`);
    }
  }

  /** The budget check after a turn: recovery, compaction or rotation, then a pending Fresh session. False stops the loop. */
  private async afterTurn(run: AgentRun, stopReason: string, budget: ContextBudget): Promise<boolean> {
    if (stopReason !== "cancelled") {
      if (isRecoveryStop(stopReason)) return this.compaction.recover(run, `it stopped with ${stopReason}`);
      if (needsCompaction(run.usage, budget)) {
        if ((await this.compaction.compact(run, "threshold", budget)) === undefined) return false;
      } else if (rotationDue(run.turns, budget)) {
        await this.compaction.compact(run, "rotation", budget);
      }
    }
    if (run.freshDue) {
      run.freshDue = false;
      await this.compaction.fresh(run);
    }
    if (run.remountDue) {
      run.remountDue = false;
      const session = run.session;
      if (session !== undefined && !run.closing) {
        // The slot stays when a prompt is waiting: it resumes the session at once, with the new mounts.
        this.endSession(run, "mounts", run.queue.length > 0 && !run.held);
        void session.close().catch(() => undefined);
        this.setLive(run, { status: "idle", nowDoing: undefined });
      }
    }
    return true;
  }

  /** The size of TASK.md as the agent is first pointed at it, for the task's token receipt. Recorded once per task. */
  private async noteBrief(run: AgentRun, task: Task): Promise<void> {
    try {
      const md = await readFile(join(task.folder, "TASK.md"), "utf8");
      this.deps.store.usageEvents.recordBrief(
        task.id,
        run.agent,
        this.now().toISOString(),
        estimateText(md),
        estimateText(sectionOf(md, "Memory")),
      );
    } catch {
      // No TASK.md to measure: the receipt shows the brief as not recorded.
    }
  }

  private async blocksFor(run: AgentRun, entry: QueueEntry): Promise<PromptBlock[] | undefined> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return undefined;
    switch (entry.kind) {
      case "brief":
        run.needsBrief = false;
        await this.noteBrief(run, task);
        return briefBlocks({ folder: task.folder, attachments: task.attachments });
      case "resume": {
        const { checkpoint } = this.deps.store.runs.lastCheckpoint(run.task);
        const where =
          checkpoint > 0 ? `The last checkpoint is ${checkpoint}.` : "There is no checkpoint yet.";
        return [{ type: "text", text: `${CONTINUE_TEXT} ${where}` }];
      }
      case "continue":
        return [{ type: "text", text: CONTINUE_TEXT }];
      case "fresh":
        return undefined;
      case "notice":
        return [{ type: "text", text: entry.text }];
      case "processes": {
        const queued = run.processEnds;
        run.processEnds = [];
        // Read while it waited, mostly in the turn that ran when it ended: the agent has it already.
        const read = queued.filter((p) => this.deps.processes?.readAfterEnd(p) === true);
        const ends = queued.filter((p) => !read.includes(p));
        if (read.length > 0) {
          const ids = read.map((p) => p.id).join(", ");
          this.live.system(
            run,
            "info",
            `${ids} ended, but @${run.agent} already read ${read.length === 1 ? "it" : "them"}, so @${run.agent} is not told again.`,
          );
        }
        const { current, replaced } = splitCurrent(ends, this.deps.processes?.list(run.task) ?? []);
        if (replaced.length > 0) {
          const ids = replaced.map((p) => p.id).join(", ");
          this.live.system(
            run,
            "info",
            `${ids} ended, but newer runs replaced ${replaced.length === 1 ? "it" : "them"}, so @${run.agent} is not told.`,
          );
        }
        return current.length === 0 ? undefined : [{ type: "text", text: noticeText(current, replaced) }];
      }
      case "handoff": {
        const item = this.deps.room.get(run.task, entry.itemId);
        if (item === undefined || item.type !== "handoff") return undefined;
        if (item.queued) this.deps.room.post(item.task, item.id, { ...handoffPayload(item), queued: false });
        const stored = await this.deps.agents.get(run.agent);
        const role = stored?.ok ? stored.agent.frontmatter.role : "Builder";
        this.deps.room.flush(run.task);
        const recent = this.deps.store.room
          .page(run.task, 40)
          .items.filter((i) => i.id !== item.id && i.type !== "context");
        const needsBrief = run.needsBrief && run.carry === undefined;
        if (needsBrief) {
          run.needsBrief = false;
          await this.noteBrief(run, task);
        }
        return [
          {
            type: "text",
            text: handoffPrompt({
              task: task.id,
              from: item.from,
              to: { id: run.agent, role },
              via: item.via,
              mode: task.mode,
              text: item.text,
              itemId: item.id,
              room: roomLines(recent, BUDGET.roomSummary, 300),
              diffStat: await diffStat(checkpointRepos(task)).catch(() => ""),
              needsBrief,
            }),
          },
        ];
      }
      case "owner": {
        const item = this.deps.room.get(run.task, entry.itemId);
        if (item === undefined || item.type !== "owner" || item.removed === true) return undefined;
        if (item.queued) this.deps.room.post(item.task, item.id, ownerPayload(item, { queued: false }));
        const built = await ownerBlocks({
          folder: task.folder,
          attachments: item.attachments,
          text: item.text,
          needsBrief: run.needsBrief && run.carry === undefined,
        });
        if (built.briefSent) {
          run.needsBrief = false;
          await this.noteBrief(run, task);
        }
        return built.blocks;
      }
    }
  }

  /** Adds a line about the task's running processes, so the agent does not start a second copy. Not to slash commands. */
  private withProcesses(run: AgentRun, blocks: PromptBlock[] | undefined): PromptBlock[] | undefined {
    const first = blocks?.[0];
    if (blocks === undefined || (first?.type === "text" && first.text.startsWith("/"))) return blocks;
    const line = runningLine(this.deps.processes?.running(run.task) ?? []);
    return line === undefined ? blocks : [...blocks, { type: "text", text: line }];
  }

  /**
   * Names the agent's enabled skills in the first prompt of each session, with the path of each
   * SKILL.md in the run's own copy. Not to slash commands: the note waits for the next prompt.
   */
  private withSkills(run: AgentRun, blocks: PromptBlock[] | undefined): PromptBlock[] | undefined {
    const first = blocks?.[0];
    if (blocks === undefined || run.skills === undefined || !run.skills.due) return blocks;
    if (run.skills.note === "") return blocks;
    if (first?.type === "text" && first.text.startsWith("/")) return blocks;
    run.skills.due = false;
    return [...blocks, { type: "text", text: run.skills.note }];
  }

  /** Adds the notes `note` left after the prompt, once. Not to slash commands, which keep them waiting. */
  private withNotes(run: AgentRun, blocks: PromptBlock[] | undefined): PromptBlock[] | undefined {
    const first = blocks?.[0];
    if (blocks === undefined || run.notes.length === 0) return blocks;
    if (first?.type === "text" && first.text.startsWith("/")) return blocks;
    const text = run.notes.join("\n");
    run.notes = [];
    return [...blocks, { type: "text", text }];
  }

  /** Adds what `beforePrompt` returns after the prompt. Not to slash commands. A failing hook adds nothing. */
  private async withFacts(
    run: AgentRun,
    brief: boolean,
    blocks: PromptBlock[] | undefined,
  ): Promise<PromptBlock[] | undefined> {
    const first = blocks?.[0];
    if (blocks === undefined || this.deps.beforePrompt === undefined) return blocks;
    if (first?.type === "text" && first.text.startsWith("/")) return blocks;
    const text = await this.deps
      .beforePrompt({ task: run.task, agent: run.agent, brief })
      .catch(() => undefined);
    return text === undefined ? blocks : [...blocks, { type: "text", text }];
  }

  /**
   * Puts the admin preamble before a session's first prompt, and in the autonomy chat autonomous
   * mode's after it. Slash commands stay whole and keep it waiting.
   */
  private withPreamble(run: AgentRun, blocks: PromptBlock[]): PromptBlock[] {
    const first = blocks[0];
    if (!run.preambleDue || (first?.type === "text" && first.text.startsWith("/"))) return blocks;
    run.preambleDue = false;
    const task = this.deps.store.tasks.get(run.task);
    const autonomy = task !== undefined && isAutonomyChat(task);
    return [
      { type: "text", text: autonomy ? `${ADMIN_PREAMBLE}\n${AUTONOMY_PREAMBLE}` : ADMIN_PREAMBLE },
      ...blocks,
    ];
  }

  /**
   * The first prompt of a fresh session: prefix, TASK.md, the note, the room, the diff stat,
   * then the prompt itself. A slash command stays whole and the carry waits for the next prompt.
   */
  private withCarry(run: AgentRun, blocks: PromptBlock[], fromOwner: boolean): PromptBlock[] {
    const carry = run.carry;
    if (carry === undefined) return blocks;
    const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
    if (text.startsWith("/")) return blocks;
    run.carry = undefined;
    run.needsBrief = false;
    return [
      { type: "text", text: freshPrompt({ ...carry, pending: text === "" ? undefined : text, fromOwner }) },
      ...blocks.filter((b) => b.type !== "text"),
    ];
  }

  private finishTurn(run: AgentRun, stopReason: string): void {
    this.deps.room.flush(run.task);
    const cancelled = stopReason === "cancelled";
    run.mapper?.endTurn(cancelled);
    this.permissions.cancelAll(run);
    // A turn majhi cut (offline, a stall) says so in its own words.
    if (cancelled && run.paused === undefined && run.limitHit === undefined)
      this.live.system(run, "info", `Stopped @${run.agent}'s turn.`);
    else if (stopReason === "max_tokens")
      this.live.system(run, "warn", `@${run.agent} stopped: it reached its output limit.`);
    else if (stopReason === "max_turn_requests")
      this.live.system(run, "warn", `@${run.agent} stopped: it reached its turn limit.`);
    this.setLive(run, { nowDoing: undefined, turnAt: undefined });
  }

  /** A turn starts (busy) or ends. Ending with `clear` means it finished: nothing to continue after a crash. */
  private markTurn(run: AgentRun, busy: boolean, clear = true): void {
    run.lastEventAt = this.now().getTime();
    if (busy) {
      // The slot turns idle only when the loop does (the end of `loop`), never between turns.
      this.slots.mark(this.key(run.task, run.agent), true);
      if (run.idleTimer !== undefined) clearTimeout(run.idleTimer);
      run.idleTimer = undefined;
      if (run.runId !== undefined) this.deps.store.runs.setInFlight(run.task, run.agent, run.runId, true);
    } else if (clear) {
      this.deps.store.runs.setInFlight(run.task, run.agent, run.runId ?? 0, false);
      run.interrupted = false;
    }
  }

  /** Commits the task's changed worktrees as the next checkpoint. A failure is a warning, never the end of the run. */
  private async checkpoint(run: AgentRun): Promise<void> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return;
    try {
      for (const line of await checkpointTurn(this.deps, task, run.runId, run.agent))
        this.live.system(run, "warn", line);
    } catch (err) {
      this.live.system(run, "warn", `Checkpoint failed: ${errorMessage(err)}`);
    }
    // Branches stacked on this task's branches follow it (5.4a).
    this.deps.onCheckpoint?.(run.task);
  }

  // ---------------------------------------------------------------------------
  // Sessions

  /** Opens the ACP session. On failure posts an error, sets the agent to `error`, and returns false. */
  private async startSession(run: AgentRun): Promise<boolean> {
    if (this.closed) return false;
    const { deps } = this;
    const key = this.key(run.task, run.agent);
    run.startFailure = undefined;
    this.setLive(run, { status: "starting", nowDoing: undefined, couldNotStart: undefined });
    try {
      // The owner's model and effort for this task win over the agent file (5.1).
      const swap = await deps.accountFor?.(run.task, run.agent);
      if (swap?.refuse !== undefined) throw new UserError(swap.refuse, 409);
      const agent = withOverride(
        withAccount(
          await resolveAgent(deps, run.agent),
          swap?.account,
          (await deps.config.sections()).accounts,
          deps.store.tasks.get(run.task)?.org,
        ),
        deps.store.tasks.get(run.task)?.overrides[run.agent],
      );
      const { fm } = agent;
      run.account = fm.account;
      run.accountKind = { tool: agent.account.tool, auth: agent.account.auth };
      run.context = fm.context;
      run.agentTurns = fm.turns;
      // The cap goes to the CLI at launch (mid-turn compaction) and sizes the usage reports.
      await this.compaction.budget(run);
      // A free slot under the concurrency limits first. Stopped while waiting: leave quietly.
      if (!(await this.takeSlot(run))) return false;
      const opened = await launch(deps, run, agent);
      const { session, task, resumed } = opened;

      run.session = session;
      run.exited = false;
      run.freshNext = false;
      run.perms = fm.perms;
      run.adminToken = opened.adminToken;
      run.decideToken = opened.decideToken;
      run.roomTokens = opened.roomTokens;
      run.connections = opened.connections;
      run.skills = opened.skills === undefined ? undefined : { ...opened.skills, due: true };
      this.rememberSecrets(run.task, opened.connections?.secrets ?? []);
      // Shutdown came while the process launched, after `closeAll` passed this run: close it too.
      if (this.closed) {
        await session.close().catch(() => undefined);
        this.endSession(run, "server-stop");
        return false;
      }
      run.turns = 0;
      run.usage = undefined;
      run.native.reset();
      run.runId = deps.store.runs.start({
        task: run.task,
        agent: run.agent,
        sessionId: session.sessionId,
        model: session.models.defaultModel ?? opened.model,
        effort: session.models.defaultEffort ?? opened.effort,
        at: this.now().toISOString(),
      });
      deps.store.runs.setTools(run.runId, opened.tools);
      deps.store.runs.setSkills(
        run.runId,
        (opened.skills?.items ?? []).map((s) => s.name),
      );
      deps.onSkillsChanged?.();
      for (const line of opened.notices) this.live.system(run, "warn", line);
      for (const note of opened.notes) {
        deps.room.post(run.task, `host-service:${note.id}`, {
          type: "system",
          level: "info",
          text: note.text,
        });
      }
      run.mapper = new ItemMapper(
        run.agent,
        run.runId,
        { post: (id, payload, options) => deps.room.post(run.task, id, payload, options) },
        taskMediaSink(run.task, task.folder),
      );
      // Attach before anything else: the session buffers early events, and a crash must not be missed.
      run.unsubscribe = session.onEvent((event) => this.onEvent(run, event));
      session.setPermissionHandler((ask, signal) => this.permissions.ask(run, ask, signal));

      // A new session for an agent that worked here before: its work comes over in a note.
      if (!resumed && opened.ranBefore && run.carry === undefined) await this.compaction.carryOver(run);
      run.needsBrief = !resumed && run.carry === undefined;
      run.preambleDue = opened.adminToken !== undefined && !resumed;

      let pickLine: string | undefined;
      let pickDecision: string | undefined;
      if (fm.model === "auto" || fm.effort === "auto") {
        const sections = await deps.config.sections();
        // A price table that does not parse must not stop the start: picks fall back to tiers or the CLI default.
        const prices = await readPrices(deps.config.file).catch(() => {
          this.live.system(
            run,
            "warn",
            "The price table in majhi.yaml does not parse, so models are not ranked by price.",
          );
          return {};
        });
        const result = await pickForSession({
          decisions: deps.decisions,
          session,
          fm,
          task,
          settings: await readDecisionSettings(deps.config.file),
          prices,
          replaced: await readModelCatalog(
            accountHome(deps.majhiHome, fm.account),
            getTool(agent.account.tool).modelCatalog,
          ),
          hidden: agent.account.hidden_models ?? [],
          orgTiers: task.org === undefined ? undefined : sections.orgs[task.org]?.tiers,
        });
        for (const line of result.warnings) this.live.system(run, "warn", line);
        if (result.applied !== undefined) deps.store.runs.setPick(run.runId, result.applied);
        pickLine = result.line;
        pickDecision = result.decisionId;
      }
      // What the agent runs after the session applied the options: a refused model keeps the default.
      const shownModel = session.models.defaultModel ?? opened.model;
      const shownEffort = session.models.defaultEffort ?? opened.effort;
      this.live.system(
        run,
        "info",
        `@${run.agent} ${resumed ? "resumed" : "started"} on ${fm.account}, model ${shownModel ?? "default"}, effort ${shownEffort ?? "default"}`,
      );
      if (pickLine !== undefined) this.live.system(run, "info", pickLine, pickDecision);
      this.setLive(run, {
        status: "idle",
        slot: undefined,
        couldNotStart: undefined,
        turns: 0,
        usage: undefined,
        ...(shownModel === undefined ? {} : { model: shownModel }),
        ...(shownEffort === undefined ? {} : { effort: shownEffort }),
      });
      return true;
    } catch (err) {
      if (run.session === undefined) this.slots.release(key);
      const message = errorMessage(err);
      run.retryable = looksLikeNetworkError(message) || /timed out/i.test(message);
      // A lost connection passes by itself (a wake retries it): only other failures pause the task.
      run.startFailure = run.retryable ? undefined : await this.classifyStart(run, message);
      if (run.startFailure === undefined || (run.startFailure.kind === "error" && run.resuming))
        this.live.system(run, "error", `@${run.agent} could not start: ${message}`);
      this.setLive(run, { status: "error", nowDoing: undefined, slot: undefined, couldNotStart: true });
      return false;
    }
  }

  /** Asks the account for its state first: the tools word a sign-in or a limit in many ways. */
  private async classifyStart(run: AgentRun, message: string): Promise<StartFailure> {
    const probe =
      run.account === undefined
        ? undefined
        : await this.deps.checkAccount?.(run.account).catch(() => undefined);
    return classifyStartFailure({ account: run.account, message, probe });
  }

  /**
   * A start failed for a reason that retrying does not fix. The task pauses when no other agent of
   * it is up. When one is, the task goes on and the room says which agent is out.
   */
  private async startFailed(run: AgentRun, failure: StartFailure): Promise<void> {
    const up = [...this.runs.values()].some(
      (r) =>
        r.task === run.task &&
        r !== run &&
        r.startFailure === undefined &&
        !r.closing &&
        (r.session !== undefined || WORKING.has(r.live.status)),
    );
    // At its limit: the account is marked, and the fallback takes over, or the run waits for the reset.
    if (failure.kind === "limit" && run.account !== undefined) {
      const mark = await this.markAccountLimit(run.account, {
        detail: failure.text,
        ...(failure.resetsAt === undefined ? {} : { resetsAt: failure.resetsAt }),
      });
      if (run.closing) return;
      if (await this.takeOverFor(run, limitHandoff(run.agent, mark.until, this.now()))) return;
      if (!up) {
        this.pauseForAccount(run, run.account, mark);
        return;
      }
    }
    if (up) {
      this.live.system(run, "warn", `@${run.agent} is out: ${failure.text}`);
      return;
    }
    // Signed out: a fallback or a teammate takes over, as for a limit.
    if (failure.kind === "signed-out" && (await this.takeOverFor(run, signedOutHandoff(run.agent)))) return;
    // The paused card carries the cause and the fix, so the pause adds no line of its own.
    this.pause(run, failure.kind === "signed-out" ? "signed-out" : "error", failure.text, true);
  }

  /** Runs paused because their account is signed out, for the sweep that watches it. */
  pausedSignedOut(): { task: string; agent: string; account: string }[] {
    return [...this.runs.values()].flatMap((r) =>
      r.paused === "signed-out" && !r.closing && r.account !== undefined
        ? [{ task: r.task, agent: r.agent, account: r.account }]
        : [],
    );
  }

  /** The account is healthy again: every agent of the task that could not start tries again. Returns how many. */
  resumeStarts(task: string, why: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.task !== task || run.closing || run.startFailure === undefined) continue;
      n++;
      if (run.paused !== undefined) this.resumeQueue(run, why);
      else if (!run.turning) void this.drive(run);
    }
    return n;
  }

  /** Records a tool call that used one of the run's skills. Returns the skill's name, for the room row. */
  private noteSkillUse(run: AgentRun, event: Extract<SessionEvent, { type: "tool" }>): string | undefined {
    const skills = run.skills;
    if (skills === undefined || run.runId === undefined) return undefined;
    const skill = skillUsed(event, { names: skills.items.map((s) => s.name), dir: skills.dir });
    if (skill === undefined) return undefined;
    const at = this.now().toISOString();
    if (this.deps.store.runs.recordSkillUse(run.runId, event.toolCallId, skill, at))
      this.deps.onSkillsChanged?.();
    return skill;
  }

  private onEvent(run: AgentRun, event: SessionEvent): void {
    run.lastEventAt = this.now().getTime();
    // "Thinking for 2m" in the room panel needs to know the agent is still sending.
    if (run.lastEventAt - run.activeSentAt >= ACTIVE_EVERY_MS) {
      run.activeSentAt = run.lastEventAt;
      this.setLive(run, { activeAt: new Date(run.lastEventAt).toISOString() });
    }
    const internal = run.internal;
    switch (event.type) {
      case "text":
        if (internal !== undefined) internal.text += event.text;
        else run.mapper?.apply(event);
        break;
      case "thought":
      case "media":
        if (internal === undefined) run.mapper?.apply(event);
        break;
      case "plan":
      case "tool": {
        if (internal !== undefined) break;
        const skill = event.type === "tool" ? this.noteSkillUse(run, event) : undefined;
        run.mapper?.apply(event, skill);
        this.setLive(run, { nowDoing: run.mapper?.nowDoing() });
        if (event.type === "tool" && run.prompting && !run.turnTools.has(event.toolCallId)) {
          run.turnTools.add(event.toolCallId);
          if (run.turnLimits?.maxToolCalls !== undefined) this.checkTurnLimit(run);
          if (this.deps.overCap !== undefined) {
            const check = this.checkCap(run).finally(() => this.capChecks.delete(check));
            this.capChecks.add(check);
          }
        }
        break;
      }
      case "usage":
        if (event.cost !== undefined && event.cost.currency.toUpperCase() === "USD")
          run.costNow = event.cost.amount;
        if (event.size > 0) {
          const previous = run.usage?.used;
          const usage = capUsage(event.used, event.size, run.budget?.cap ?? 0);
          run.noteUsage(usage);
          this.setLive(run, { usage });
          if (internal === undefined && !run.selfCompacting) {
            const found = run.native.usage(previous, event.used);
            if (found !== undefined) this.compaction.auto(run, found);
          }
        }
        break;
      case "compaction": {
        // majhi's own `/compact` is recorded where majhi asked for it.
        if (internal !== undefined || run.selfCompacting) break;
        const found = run.native.report(event, run.usage?.used);
        if (found !== undefined) this.compaction.auto(run, found);
        break;
      }
      case "turn":
        if (event.usage.model !== undefined) run.turnModel = event.usage.model;
        if (run.account !== undefined && run.accountKind !== undefined) {
          void this.deps.usage?.record(
            { task: run.task, agent: run.agent, account: run.account, ...run.accountKind, runId: run.runId },
            event.usage,
          );
        }
        break;
      case "commands":
        this.deps.room.rememberCommands(run.agent, event.commands);
        this.setLive(run, { commands: event.commands });
        break;
      case "config":
        this.setLive(run, {
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.effort === undefined ? {} : { effort: event.effort }),
        });
        break;
      case "notice":
        this.live.system(run, event.level, event.text);
        break;
      case "exit": {
        if (run.closing) break;
        run.exited = true;
        // A turn the crash cut continues on resume (a wake, a restart, the owner).
        if (run.prompting) run.interrupted = true;
        run.retryable = looksLikeNetworkError(event.error ?? "");
        this.deps.room.flush(run.task);
        this.live.system(
          run,
          "error",
          `@${run.agent} stopped unexpectedly: ${event.error ?? `exit code ${event.code ?? "unknown"}`}`,
        );
        const session = run.session;
        this.endSession(run, "exit");
        // The process is gone, but its runner container may not be: remove it.
        void session?.close().catch(() => undefined);
        this.setLive(run, { status: "error", nowDoing: undefined });
        break;
      }
    }
  }

  /** Esc came before the first prompt went out: nothing is sent, the queue waits, the room says so. */
  private stoppedBeforePrompt(run: AgentRun): boolean {
    if (!run.cancelBeforePrompt) return false;
    run.cancelBeforePrompt = false;
    if (run.queue.length > 0) run.held = true;
    this.live.system(run, "info", `Stopped @${run.agent}'s turn.`);
    return true;
  }

  private async cancelRun(run: AgentRun): Promise<void> {
    this.permissions.cancelAll(run);
    const session = run.session;
    if (session === undefined) {
      // Still starting: the loop checks this before it sends anything.
      if (run.turning) run.cancelBeforePrompt = true;
      return;
    }
    try {
      await session.cancel();
    } catch (err) {
      this.live.system(
        run,
        "error",
        `@${run.agent} did not stop: ${errorMessage(err)}. Its session was closed.`,
      );
      this.endSession(run, "error");
      void session.close().catch(() => undefined);
      if (run.paused === undefined) this.setLive(run, { status: "error", nowDoing: undefined });
    }
  }

  /** Drops the session, frees its slot (unless a fresh session takes it over) and ends the run row. The queue stays. */
  private endSession(run: AgentRun, reason: string, keepSlot = false): void {
    run.unsubscribe?.();
    run.unsubscribe = undefined;
    if (run.adminToken !== undefined) this.deps.admin?.revoke(run.adminToken);
    run.adminToken = undefined;
    if (run.decideToken !== undefined) this.deps.decisions?.revoke(run.decideToken);
    run.decideToken = undefined;
    if (run.roomTokens !== undefined) this.deps.rooms?.revoke(run.roomTokens);
    run.roomTokens = undefined;
    if (run.connections !== undefined) void removeRunFiles(run.connections.dir).catch(() => undefined);
    run.connections = undefined;
    if (run.skills !== undefined) void removeRunFiles(run.skills.dir).catch(() => undefined);
    run.skills = undefined;
    if (run.idleTimer !== undefined) clearTimeout(run.idleTimer);
    run.idleTimer = undefined;
    this.permissions.cancelAll(run);
    if (run.runId !== undefined) this.deps.store.runs.end(run.runId, reason, this.now().toISOString());
    run.session = undefined;
    run.runId = undefined;
    run.mapper = undefined;
    if (!keepSlot) this.slots.release(this.key(run.task, run.agent));
  }

  // ---------------------------------------------------------------------------
  // Limits and idle stop (5.17)

  /** Waits for a slot. Resolves false when the start was withdrawn (the task stopped). */
  private async takeSlot(run: AgentRun): Promise<boolean> {
    const key = this.key(run.task, run.agent);
    if (this.slots.holds(key)) return true;
    if (await this.ownSlot(run)) {
      if (run.closing) return false;
      run.queuedNoted = false;
      if (run.live.status === "queued") this.setLive(run, { status: "starting", slot: undefined });
      return true;
    }
    const task = this.deps.store.tasks.get(run.task);
    const granted = await this.slots.acquire({
      key,
      task: run.task,
      account: run.account ?? run.agent,
      workspace: task?.org ?? "",
      owner: this.deps.slotPolicy?.owner(run.task) ?? true,
    });
    run.queuedNoted = false;
    if (!granted || run.closing) {
      if (granted) this.slots.release(key);
      return false;
    }
    if (run.live.status === "queued") this.setLive(run, { status: "starting", slot: undefined });
    return true;
  }

  /**
   * The captain in one of its own chats (a lane, the Cmd J chat, a topic chat) has its own run
   * slot: it never waits in line and does not count toward `agents_max` or `per_account` (SPEC
   * 5.16), so the owner's message is answered in seconds. Its turns are short and there is one run
   * per chat, since a (task, agent) has one loop. Its spend is recorded and capped as before. The
   * captain on an ordinary task is a normal agent and takes a slot.
   */
  private async ownSlot(run: AgentRun): Promise<boolean> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined || !isBossChat(task)) return false;
    return run.agent === (await this.deps.config.sections()).boss;
  }

  /**
   * The line a queued run says: its place, which limit is full and which tasks hold the slots, with
   * the ones that wait on the owner marked, since an agent waiting on an answer still holds its slot.
   */
  private queuedLine(run: AgentRun, key: string, slot: number): string {
    const why = this.slots.blockedBy(key);
    const start = `@${run.agent} starts when one frees.`;
    if (why === undefined) return `Queued, #${slot} in line, behind earlier starts. ${start}`;
    const asking = this.deps.store.room.tasksWaitingOnOwner();
    const holders = why.holders.map((h) => {
      const holder = this.runs.get(h.key);
      const mark = asking.has(h.task) ? ", waiting for you" : "";
      return `${h.task} (${holder === undefined ? h.account : `@${holder.agent}`}${mark})`;
    });
    const shown = holders.slice(0, 4).join(", ");
    const more = holders.length > 4 ? ` and ${holders.length - 4} more` : "";
    const full =
      why.limit === "account"
        ? `the limit of ${why.max} at once on ${why.account}`
        : why.limit === "task"
          ? `the limit of ${why.max} agents on one task`
          : `the limit of ${why.max} agents at once`;
    return `Queued, #${slot} in line: ${full} is reached. Holding the slots: ${shown}${more}. ${start}`;
  }

  /** Shows each waiting run's place in line. */
  private showLine(positions: Map<string, number>): void {
    for (const [key, slot] of positions) {
      const run = this.runs.get(key);
      if (run === undefined) continue;
      const inUse = this.slots.state().holders.length;
      this.setLive(run, {
        status: "queued",
        slot,
        ...(this.cap > 0 && inUse >= this.cap
          ? { nowDoing: `Waiting for a free run: ${inUse} of ${this.cap} in use` }
          : {}),
      });
      if (!run.queuedNoted) {
        run.queuedNoted = true;
        this.live.system(run, "info", this.queuedLine(run, key, slot));
      }
    }
  }

  /** Stops an idle process: to make room for a waiting start, or after `idle_timeout`. It resumes from its session later. */
  private evict(key: string): void {
    const run = this.runs.get(key);
    const session = run?.session;
    if (run === undefined || session === undefined || run.turning || run.closing) return;
    this.endSession(run, "idle");
    void session.close().catch(() => undefined);
    this.setLive(run, { status: "idle", nowDoing: undefined });
  }

  /** Stops the process after `idle_timeout` without a turn. The next message resumes the session. */
  private scheduleIdleStop(run: AgentRun): void {
    void this.deps.config
      .settings()
      .then((s) => {
        if (run.idleTimer !== undefined) clearTimeout(run.idleTimer);
        run.idleTimer = setTimeout(() => {
          run.idleTimer = undefined;
          this.evict(this.key(run.task, run.agent));
        }, durationMs(s.limits.idle_timeout));
        run.idleTimer.unref();
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Turn limits (PRV-96)

  /** The turn limits for the run now: majhi's, then the org's, then the agent's, field by field. */
  private async turnLimits(run: AgentRun): Promise<TurnLimits> {
    const [settings, sections] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
    ]);
    const org = this.deps.store.tasks.get(run.task)?.org;
    return turnLimitsFor(
      settings.turns,
      org === undefined ? undefined : sections.orgs[org]?.turns,
      run.agentTurns,
    );
  }

  /** Before a turn is sent: notes the worktrees' HEADs and starts checking the turn's limits. */
  private async startWatch(run: AgentRun): Promise<void> {
    run.limitHit = undefined;
    run.turnTools.clear();
    run.waitSeenAt = 0;
    run.turnStartedAt = this.now().getTime();
    const limits = run.turnLimits;
    if (limits === undefined || (limits.maxMs ?? limits.idleMs ?? limits.maxToolCalls) === undefined) return;
    const task = this.deps.store.tasks.get(run.task);
    run.turnHeads =
      task === undefined ? undefined : await headsOf(checkpointRepos(task)).catch(() => undefined);
    run.turnStartedAt = this.now().getTime();
    if (run.limitTimer !== undefined) clearInterval(run.limitTimer);
    run.limitTimer = setInterval(() => this.checkTurnLimit(run), LIMIT_CHECK_MS);
    run.limitTimer.unref();
  }

  private stopWatch(run: AgentRun): void {
    if (run.limitTimer !== undefined) clearInterval(run.limitTimer);
    run.limitTimer = undefined;
  }

  /** Cancels the turn when it is over a limit. The loop hands off or pauses once the turn has ended. */
  private checkTurnLimit(run: AgentRun): void {
    const limits = run.turnLimits;
    if (limits === undefined || run.limitHit !== undefined || !run.prompting) return;
    if (run.closing || run.paused !== undefined || run.internal !== undefined || run.session === undefined)
      return;
    const now = this.now().getTime();
    const waiting = (this.deps.processes?.running(run.task) ?? []).some(
      (p) => p.wait && p.agent === run.agent,
    );
    const asking = run.pending.size > 0;
    // Waiting on a process or on the owner is not idleness: the quiet time starts when it ends.
    if (waiting || asking) run.waitSeenAt = now;
    const fired = firedLimit(
      {
        now,
        startedAt: run.turnStartedAt,
        activeAt: Math.max(run.turnStartedAt, run.lastEventAt, run.waitSeenAt),
        toolCalls: run.turnTools.size,
        waiting,
        asking,
      },
      limits,
    );
    if (fired === undefined) return;
    run.limitHit = fired;
    this.stopWatch(run);
    void this.cancelRun(run);
  }

  /**
   * After a turn limit cut a turn, with its checkpoint taken: pauses the run when this task hit a
   * limit `MAX_STRIKES` times in a row without a new commit (false), else hands off to a fresh
   * session that continues from the note (true).
   */
  private async afterLimit(run: AgentRun, fired: FiredLimit): Promise<boolean> {
    const limits = run.turnLimits ?? { maxMs: undefined, idleMs: undefined, maxToolCalls: undefined };
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return false;
    const heads = await headsOf(checkpointRepos(task)).catch(() => undefined);
    // Unknown either way: count it as progress, so a git hiccup never pauses a task.
    const progressed = heads === undefined || run.turnHeads === undefined || heads !== run.turnHeads;
    const decision = afterLimit(this.limitStrikes.get(run.task) ?? 0, progressed);
    this.limitStrikes.set(run.task, decision.strikes);
    const what = limitPhrase(run.agent, fired, limits);
    if (decision.action === "pause") {
      this.pause(
        run,
        "error",
        `${what} ${MAX_STRIKES} times in a row with no new commits, so it paused instead of continuing. Read the room, then resume the task or send new directions.`,
      );
      return false;
    }
    try {
      // An idle agent may be stuck: majhi writes its note from saved state instead of asking it.
      await this.compaction.afterTurnLimit(run, fired !== "idle", what.replace(/^@\S+ /, "the agent "));
    } catch (err) {
      this.live.system(
        run,
        "warn",
        `Could not hand @${run.agent} over to a fresh session: ${errorMessage(err)}`,
      );
      return false;
    }
    run.queue.unshift({ kind: "notice", text: CONTINUE_FROM_NOTE });
    this.live.refreshQueued(run);
    this.live.system(run, "info", `${what}. Continued in a fresh session with a handoff note.`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pause and resume (5.7)

  /** `carded`: the task's paused card says why (given to `onPaused`), so no line is posted here. */
  private pause(run: AgentRun, reason: PauseReason, text: string, carded = false): void {
    run.paused = reason;
    run.clearTimers();
    if (!carded) this.live.system(run, reason === "error" ? "error" : "warn", text);
    this.setLive(run, { status: "paused", nowDoing: undefined });
    this.deps.onPaused?.(run.task, reason, carded ? text : undefined);
  }

  /** Queues "continue from where you stopped" and starts the loop, or restarts it once the current one ends. */
  private resumeRun(run: AgentRun, why: string): void {
    if (run.closing) return;
    run.paused = undefined;
    run.retryable = false;
    // A cancel that waited for the session to open was for the turn this resume replaces.
    run.cancelBeforePrompt = false;
    if (run.retryTimer !== undefined) clearTimeout(run.retryTimer);
    run.retryTimer = undefined;
    if (!run.queue.some((e) => e.kind === "resume")) run.queue.unshift({ kind: "resume" });
    run.interrupted = false;
    run.resuming = true;
    run.held = false;
    this.live.system(run, "info", `Resuming @${run.agent}: ${why}.`);
    this.deps.onResumed?.(run.task);
    if (run.turning) run.redrive = true;
    else void this.drive(run);
  }

  /**
   * The model's API said it is overloaded: keep the session, and continue the turn after a wait
   * that grows each time. After the last wait, the turn fails as any other error does.
   */
  private retryAfterOverload(run: AgentRun, message: string): void {
    const wait = OVERLOAD_BACKOFF_MS[run.overloadRetries] ?? OVERLOAD_BACKOFF_MS[0];
    run.overloadRetries++;
    run.interrupted = true;
    this.markTurn(run, false, false);
    const seconds = Math.round(wait / 1000);
    const when =
      seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minute${seconds >= 120 ? "s" : ""}`;
    const first = message.split("\n", 1)[0] ?? message;
    this.live.system(
      run,
      "warn",
      `The model's API is overloaded (${first.slice(0, 120)}). @${run.agent} tries again in ${when} (${run.overloadRetries} of ${OVERLOAD_BACKOFF_MS.length}).`,
    );
    this.setLive(run, { status: "waiting", nowDoing: `API overloaded, retrying in ${when}` });
    if (run.retryTimer !== undefined) clearTimeout(run.retryTimer);
    run.retryTimer = setTimeout(() => {
      run.retryTimer = undefined;
      this.resumeRun(run, "the API was overloaded");
    }, wait);
    run.retryTimer.unref();
  }

  /** A resume did not work: try once more, then pause with reason error. */
  private resumeFailed(run: AgentRun, message: string): void {
    if (!run.resuming || run.closing) return;
    run.resumeFailures++;
    if (run.resumeFailures < 2) {
      run.retryTimer = setTimeout(() => {
        run.retryTimer = undefined;
        this.resumeRun(run, "trying again");
      }, RESUME_RETRY_MS);
      run.retryTimer.unref();
      return;
    }
    run.resuming = false;
    run.resumeFailures = 0;
    run.interrupted = true;
    this.pause(
      run,
      "error",
      `Could not resume @${run.agent} after two tries: ${message}. Resume the task to try again.`,
    );
  }
}

/** True when the run already has this owner message queued. */
function hasOwnerEntry(run: AgentRun, itemId: string): boolean {
  return run.queue.some((e) => e.kind === "owner" && e.itemId === itemId);
}
