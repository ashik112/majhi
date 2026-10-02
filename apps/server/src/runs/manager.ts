import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getTool,
  type PermissionAsk,
  type PromptBlock,
  type RuntimeOptions,
  type SessionEvent,
} from "@majhi/acp";
import type { Attachment, HandoffVia, ProcessInfo, RoomItem, Task } from "@majhi/shared";
import { durationMs, isAutonomyChat } from "@majhi/shared";
import { accountHome } from "../accounts/homes.ts";
import { readModelCatalog } from "../accounts/model-catalog.ts";
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
import type { Store } from "../store/index.ts";
import { sectionOf } from "../tasks/brief.ts";
import { readPrices } from "../usage/prices.ts";
import type { UsageRecorder } from "../usage/recorder.ts";
import { diffStat } from "./checkpoint.ts";
import { Compaction } from "./compaction.ts";
import {
  type ContextBudget,
  estimateText,
  estimateTokens,
  isContextError,
  isRecoveryStop,
  needsCompaction,
  rotationDue,
} from "./context.ts";
import { checkpointRepos, checkpointTurn } from "./durable.ts";
import { BUDGET, freshPrompt, roomLines } from "./handoff.ts";
import { handoffPayload, ItemMapper, ownerPayload, permissionPayload } from "./items.ts";
import { type LaunchDeps, launch, resolveAgent, withOverride } from "./launch.ts";
import { Slots } from "./limits.ts";
import { type LivePatch, RunLive, WORKING } from "./live.ts";
import { taskMediaSink } from "./media.ts";
import { looksLikeNetworkError, looksLikeOverload, OVERLOAD_BACKOFF_MS } from "./network.ts";
import { PermissionFlow } from "./permission-flow.ts";
import { pickForSession } from "./pick.ts";
import { briefBlocks, ownerBlocks } from "./prompt.ts";
import { currentModelName, switchAfterRefusal } from "./refusal.ts";
import { AgentRun, type PauseReason, type QueueEntry } from "./run.ts";
import type { SerenaLaunch } from "./serena.ts";
import { wakePlan } from "./wake.ts";

export const BRIEF_ITEM_ID = "brief";

/** How long before a failed resume is tried the second time. */
const RESUME_RETRY_MS = 1_000;
/** `activeAt` goes out at most this often while an agent streams. */
const ACTIVE_EVERY_MS = 5_000;
const CONTINUE_TEXT = "Continue from where you stopped.";
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
  /** Gives sessions of the boss (and other admin agents) the majhi-admin MCP server. */
  admin?: AdminAccess;
  /** The decision provider: majhi-decide for every session, and model picks for `auto` agents. */
  decisions?: Decisions;
  /** majhi-room for team members and majhi-tasks for leads (Phase 3). */
  rooms?: RoomAccess;
  /** Serena can start in the runner container (5.9 item 6); absent when agents do not run in one. */
  serena?: SerenaLaunch;
  /** Where connections keep their files (5.14). Absent: runs get no connections. */
  connectionFiles?: LaunchDeps["connectionFiles"];
  /** Records the tokens and cost of every turn, majhi's own prompts included. */
  usage?: UsageRecorder;
  /** Background processes (5.15): each prompt says what already runs, and an old result is not sent. */
  processes?: { running(task: string): ProcessInfo[]; list(task: string): ProcessInfo[] };
  /** Called when the set of working agents of some task changed, so the task list can refresh. */
  onTasksChanged: () => void;
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
  /** A run's loop ended: its turn is over and nothing more is sent until something wakes it. */
  onLoopEnd?: (task: string, agent: string) => void;
  /**
   * Called when an agent finished a turn normally and has nothing queued: the task may be ready for
   * review. `refused`: the turn ended on the model's safeguards, so the task is not finished.
   */
  onIdle?: (task: string, refused: boolean) => void;
  /** An agent paused (offline, or an error it cannot get past): the task pauses too. */
  onPaused?: (task: string, reason: PauseReason) => void;
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

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? (() => new Date());
    this.live = new RunLive(deps.room, deps.onTasksChanged);
    this.permissions = new PermissionFlow(deps, this.live, this.now);
    this.compaction = new Compaction(deps, this.live, {
      endSession: (run, reason, keepSlot) => this.endSession(run, reason, keepSlot),
      pause: (run, reason, text) => this.pause(run, reason, text),
    });
    this.slots = new Slots({
      limits: async () => (await deps.config.settings()).limits,
      canEvict: (key) => {
        const run = this.runs.get(key);
        return run !== undefined && run.session !== undefined && !run.turning;
      },
      evict: (key) => this.evict(key),
      onQueue: (positions) => this.showLine(positions),
      now: () => this.now().getTime(),
    });
  }

  /** At server start: runs that were live are over, and prompts nobody can answer any more are cancelled. */
  recover(): void {
    const { store, room } = this.deps;
    store.runs.endAllLive("server-restart", this.now().toISOString());
    for (const item of store.room.pendingPermissions()) {
      if (item.type === "permission")
        room.post(item.task, item.id, permissionPayload(item, { state: "cancelled" }));
    }
  }

  /** True when the agent is queued, starting, working or waiting in any task. */
  isWorking(agent: string): boolean {
    return [...this.runs.values()].some((r) => r.agent === agent && WORKING.has(r.live.status));
  }

  /** Agents of the task that are queued, starting, working or waiting, or whose loop is about to send. */
  working(task: string): string[] {
    return [...this.runs.values()]
      .filter(
        (r) => r.task === task && (WORKING.has(r.live.status) || (r.turning && !r.closing && !r.settling)),
      )
      .map((r) => r.agent);
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
  startTask(task: Task, agent: string, options: { ownBrief?: boolean } = {}): void {
    const run = this.runFor(task.id, agent);
    this.queueBrief(task, agent, options);
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
    this.live.refreshQueued(run);
    // Nothing queued: an empty loop would hand the task back for review before the owner's message lands.
    if (run.queue.length > 0) void this.drive(run);
  }

  /**
   * Posts the task's brief for `agent` and puts it first in its queue, once. `startTask` does it,
   * and a message that starts the task does it first so the brief comes before the message.
   */
  queueBrief(task: Task, agent: string, options: { ownBrief?: boolean } = {}): void {
    const { room } = this.deps;
    // Several agents start together (a pipeline's first step): each after the first gets its own brief.
    const briefId = options.ownBrief === true ? `${BRIEF_ITEM_ID}:${agent}` : BRIEF_ITEM_ID;
    // The boss chat has no brief to send: the owner's first message starts it.
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

  /**
   * Wakes an agent with a message from majhi, like a background process that ended (5.15): sent
   * now when it is idle, else on its next turn. Starts its session if needed.
   */
  notify(task: string, agent: string, text: string): void {
    const run = this.runFor(task, agent);
    run.queue.push({ kind: "notice", text });
    run.held = false;
    this.live.refreshQueued(run);
    if (run.paused === undefined) void this.drive(run);
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
    run.held = false;
    this.live.refreshQueued(run);
    if (run.paused === undefined) void this.drive(run);
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
    run.held = false;
    this.live.refreshQueued(run);
    if (run.paused === undefined) void this.drive(run);
    return item;
  }

  /** Closes one agent's session in a task, for a team change. Its queue is dropped. */
  async remove(task: string, agent: string): Promise<void> {
    const run = this.runs.get(this.key(task, agent));
    if (run === undefined) return;
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
  }

  /** Stops the current turn of one agent, or of every agent in the task. Queued messages wait. */
  async cancel(task: string, agent?: string): Promise<string[]> {
    const targets = [...this.runs.values()].filter(
      (r) => r.task === task && (agent === undefined || r.agent === agent) && r.turning,
    );
    for (const run of targets) if (run.queue.length > 0) run.held = true;
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

  /** Answers a pending permission prompt with one of its options. */
  answerPermission(task: string, itemId: string, option: string): RoomItem {
    const run = [...this.runs.values()].find((r) => r.task === task && r.pending.has(itemId));
    return this.permissions.answer(run, task, itemId, option);
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
  limitsChanged(): Promise<void> {
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

  /** The Mac woke from sleep: continue turns that failed while it slept, and restart ones that stalled. */
  async wake(): Promise<void> {
    const views = [...this.runs.values()]
      .filter((r) => !r.closing && r.paused !== "offline" && r.paused !== "limit" && r.paused !== "owner")
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
      if (run !== undefined) this.resumeRun(run, "the Mac woke up");
    }
    await Promise.all(
      plan.restart.map(async (key) => {
        const run = this.runs.get(key);
        if (run === undefined) return;
        run.interrupted = true;
        // Quietly: the resume says what happened.
        run.paused = "offline";
        await this.cancelRun(run);
        this.resumeRun(run, "its turn stalled while the Mac slept");
      }),
    );
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
    this.deps.room.drop(task);
  }

  /** Server shutdown: closes every session so no agent process outlives majhi. Cut turns resume after the restart. */
  async closeAll(): Promise<void> {
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
    const why = await this.deps.limited?.(run.task, run.agent);
    if (run.closing) return false;
    if (why !== undefined) {
      this.pause(run, "limit", why);
      return true;
    }
    const held = await this.deps.held?.(run.task, run.agent);
    if (held === undefined || run.closing) return false;
    this.pause(run, held.reason, held.why);
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
      if ((await this.pauseIfLimited(run)) && !run.turning) {
        this.evict(this.key(run.task, run.agent));
        this.setLive(run, { status: "paused", nowDoing: undefined });
      }
    }
  }

  /** Runs paused by a budget, for the lift to look at. */
  pausedForLimit(): { task: string; agent: string }[] {
    return [...this.runs.values()]
      .filter((r) => r.paused === "limit" && !r.closing)
      .map((r) => ({ task: r.task, agent: r.agent }));
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
          this.resumeFailed(run, "the agent could not start");
          return;
        }
        if (run.cancelBeforePrompt) {
          run.cancelBeforePrompt = false;
          if (run.queue.length > 0) run.held = true;
          break;
        }
      }
      if (run.closing || run.paused !== undefined) break;
      // The wait for a slot or the session start may have been long: ask again before the turn.
      if (await this.pauseIfLimited(run)) break;
      const session = run.session;
      const entry = run.queue.shift();
      if (session === undefined || entry === undefined) break;
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
      const raw = await this.withFacts(run, brief, this.withProcesses(run, await this.blocksFor(run, entry)));
      if (raw === undefined) continue;

      // One read of the settings per turn: before the prompt and after it.
      const budget = await this.compaction.budget(run);
      // Compact first when this prompt would take the session over its budget.
      if (run.carry === undefined && needsCompaction(run.usage, budget, estimateTokens(raw))) {
        const done = await this.compaction.compact(run, "threshold", budget);
        if (done === undefined || run.session === undefined) {
          // Paused, or handed off: the prompt goes to the next session.
          run.queue.unshift(entry);
          continue;
        }
      }
      const stopReason = await this.turn(run, session, this.withPreamble(run, this.withCarry(run, raw)));
      if (stopReason === undefined) return;
      if (stopReason === "recovered") continue;
      if (run.paused !== undefined) break;
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
      return await this.promptTurn(run, session, blocks);
    } finally {
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
    this.deps.onTasksChanged();
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
        const ends = run.processEnds;
        run.processEnds = [];
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
  private withCarry(run: AgentRun, blocks: PromptBlock[]): PromptBlock[] {
    const carry = run.carry;
    if (carry === undefined) return blocks;
    const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
    if (text.startsWith("/")) return blocks;
    run.carry = undefined;
    run.needsBrief = false;
    return [
      { type: "text", text: freshPrompt({ ...carry, pending: text === "" ? undefined : text }) },
      ...blocks.filter((b) => b.type !== "text"),
    ];
  }

  private finishTurn(run: AgentRun, stopReason: string): void {
    this.deps.room.flush(run.task);
    const cancelled = stopReason === "cancelled";
    run.mapper?.endTurn(cancelled);
    this.permissions.cancelAll(run);
    // A turn majhi cut (offline, a stall) says so in its own words.
    if (cancelled && run.paused === undefined) this.live.system(run, "info", `Stopped @${run.agent}'s turn.`);
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
    const { deps } = this;
    const key = this.key(run.task, run.agent);
    this.setLive(run, { status: "starting", nowDoing: undefined });
    try {
      // The owner's model and effort for this task win over the agent file (5.1).
      const agent = withOverride(
        await resolveAgent(deps, run.agent),
        deps.store.tasks.get(run.task)?.overrides[run.agent],
      );
      const { fm } = agent;
      run.account = fm.account;
      run.accountKind = { tool: agent.account.tool, auth: agent.account.auth };
      run.compactAt = fm.context?.compact_at;
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
      this.rememberSecrets(run.task, opened.connections?.secrets ?? []);
      run.turns = 0;
      run.usage = undefined;
      run.runId = deps.store.runs.start({
        task: run.task,
        agent: run.agent,
        sessionId: session.sessionId,
        model: session.models.defaultModel ?? opened.model,
        effort: session.models.defaultEffort ?? opened.effort,
        at: this.now().toISOString(),
      });
      deps.store.runs.setTools(run.runId, opened.tools);
      for (const line of opened.notices) this.live.system(run, "warn", line);
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
      }
      // What the agent runs after the session applied the options: a refused model keeps the default.
      const shownModel = session.models.defaultModel ?? opened.model;
      const shownEffort = session.models.defaultEffort ?? opened.effort;
      this.live.system(
        run,
        "info",
        `@${run.agent} ${resumed ? "resumed" : "started"} on ${fm.account}, model ${shownModel ?? "default"}, effort ${shownEffort ?? "default"}`,
      );
      if (pickLine !== undefined) this.live.system(run, "info", pickLine);
      this.setLive(run, {
        status: "idle",
        slot: undefined,
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
      this.live.system(run, "error", `@${run.agent} could not start: ${message}`);
      this.setLive(run, { status: "error", nowDoing: undefined, slot: undefined });
      return false;
    }
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
      case "tool":
        if (internal !== undefined) break;
        run.mapper?.apply(event);
        this.setLive(run, { nowDoing: run.mapper?.nowDoing() });
        break;
      case "usage":
        if (event.size > 0) {
          run.noteUsage({ used: event.used, size: event.size });
          this.setLive(run, { usage: { used: event.used, size: event.size } });
        }
        break;
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
    const granted = await this.slots.acquire({ key, task: run.task, account: run.account ?? run.agent });
    run.queuedNoted = false;
    if (!granted || run.closing) {
      if (granted) this.slots.release(key);
      return false;
    }
    if (run.live.status === "queued") this.setLive(run, { status: "starting", slot: undefined });
    return true;
  }

  /** Shows each waiting run's place in line. */
  private showLine(positions: Map<string, number>): void {
    for (const [key, slot] of positions) {
      const run = this.runs.get(key);
      if (run === undefined) continue;
      this.setLive(run, { status: "queued", slot });
      if (!run.queuedNoted) {
        run.queuedNoted = true;
        this.live.system(
          run,
          "info",
          `Queued, #${slot} in line: majhi is running as many agents as the limits allow. @${run.agent} starts when a slot is free.`,
        );
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
  // Pause and resume (5.7)

  private pause(run: AgentRun, reason: PauseReason, text: string): void {
    run.paused = reason;
    run.clearTimers();
    this.live.system(run, reason === "error" ? "error" : "warn", text);
    this.setLive(run, { status: "paused", nowDoing: undefined });
    this.deps.onPaused?.(run.task, reason);
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
