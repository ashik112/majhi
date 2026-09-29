import { randomUUID } from "node:crypto";
import type { PermissionAsk, PromptBlock, RuntimeOptions, SessionEvent } from "@majhi/acp";
import type { AgentLive, Attachment, RoomItem, Task } from "@majhi/shared";
import { durationMs } from "@majhi/shared";
import { accountRuntime, secretName } from "../accounts/homes.ts";
import type { AdminAccess } from "../admin/access.ts";
import { ADMIN_PREAMBLE, isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Decisions } from "../decisions/api.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { RoomPayload, Store } from "../store/index.ts";
import {
  budgetFor,
  COMPACT_NOTE,
  type ContextBudget,
  compactCommand,
  estimateText,
  estimateTokens,
  isContextError,
  isRecoveryStop,
  MAX_COMPACTIONS_PER_TURN,
  needsCompaction,
  reachedTarget,
  rotationDue,
} from "./context.ts";
import { buildCarry, checkpointTurn } from "./durable.ts";
import { freshPrompt, HANDOFF_REQUEST, looksLikeNote } from "./handoff.ts";
import { ItemMapper, ownerPayload, permissionPayload } from "./items.ts";
import { Slots } from "./limits.ts";
import { taskMediaSink } from "./media.ts";
import { looksLikeNetworkError } from "./network.ts";
import { decidePermission } from "./permissions.ts";
import { pickForSession } from "./pick.ts";
import { briefBlocks, ownerBlocks } from "./prompt.ts";
import { AgentRun, type PauseReason, type QueueEntry } from "./run.ts";
import { wakePlan } from "./wake.ts";

export const BRIEF_ITEM_ID = "brief";

/** How long native compaction waits for the agent's next usage report. */
const USAGE_WAIT_MS = 5_000;
/** How long before a failed resume is tried the second time. */
const RESUME_RETRY_MS = 1_000;
const CONTINUE_TEXT = "Continue from where you stopped.";

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
  /** Called when the set of working agents of some task changed, so the task list can refresh. */
  onTasksChanged: () => void;
  /** Called when an agent finished a turn normally and has nothing queued: the task may be ready for review. */
  onIdle?: (task: string) => void;
  /** An agent paused (offline, or an error it cannot get past): the task pauses too. */
  onPaused?: (task: string, reason: PauseReason) => void;
  /** A paused or cut agent is resuming: the task runs again. */
  onResumed?: (task: string) => void;
  /** An agent failed in a way that looks like a lost connection: check the network now. */
  onNetworkError?: () => void;
  now?: () => Date;
}

/** A change to an agent's live state. `undefined` clears a field. */
type LivePatch = { [K in keyof Omit<AgentLive, "agent">]?: AgentLive[K] | undefined };

/** Busy with the task, including waiting in line for a slot: never "your turn". */
const WORKING: ReadonlySet<AgentLive["status"]> = new Set(["queued", "starting", "working", "waiting"]);

/**
 * One ACP session per (task, agent), started when there is something to send. Runs the queue
 * of prompts, turns session events into room items and live state, and answers permission
 * requests from the agent's perms or from the owner. Keeps each session inside its context
 * budget, commits a checkpoint after every turn, holds a slot under the concurrency limits
 * while its process runs, and pauses and resumes turns around restarts, lost connections and
 * sleep (SPEC 5.7, 5.13, 5.17).
 */
export class RunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly now: () => Date;
  private readonly slots: Slots;

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? (() => new Date());
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

  /** Agents of the task that are queued, starting, working or waiting. */
  working(task: string): string[] {
    return [...this.runs.values()]
      .filter((r) => r.task === task && WORKING.has(r.live.status))
      .map((r) => r.agent);
  }

  /** Agents in the middle of a turn, across majhi. An update waits for these with "when they finish". */
  turnsInFlight(): number {
    return [...this.runs.values()].filter((r) => r.turning && r.session !== undefined).length;
  }

  /**
   * Queues the task's first prompt, built from TASK.md, and starts the agent. Does nothing
   * when it was sent before. A paused or cut run continues from where it stopped. Returns at
   * once: the run streams into the room.
   */
  startTask(task: Task, agent: string): void {
    const run = this.runFor(task.id, agent);
    const { room } = this.deps;
    // The boss chat has no brief to send: the owner's first message starts it.
    if (room.get(task.id, BRIEF_ITEM_ID) === undefined && !isBossChat(task)) {
      room.post(task.id, BRIEF_ITEM_ID, {
        type: "owner",
        text: task.brief,
        attachments: task.attachments,
        queued: false,
        to: agent,
      });
      run.queue.unshift({ kind: "brief" });
    }
    if (run.paused !== undefined || run.interrupted) {
      this.resumeRun(run, "the task was resumed");
      return;
    }
    run.held = false;
    this.refreshQueued(run);
    // Nothing queued: an empty loop would hand the task back for review before the owner's message lands.
    if (run.queue.length > 0) void this.drive(run);
  }

  /** Stores the owner's message and sends it: now when the agent is idle, else queued, or after a cancel when `interrupt`. */
  async send(
    task: Task,
    agent: string,
    input: { text: string; attachments: Attachment[]; mode: "queue" | "interrupt" },
  ): Promise<RoomItem> {
    const run = this.runFor(task.id, agent);
    const busy = run.turning;
    const queued = busy && input.mode === "queue";
    const id = `owner:${randomUUID()}`;
    this.deps.room.post(task.id, id, {
      type: "owner",
      text: input.text,
      attachments: input.attachments,
      queued,
      to: agent,
    });
    const item = this.deps.room.get(task.id, id);
    if (item === undefined) throw new Error("The message was not stored");
    if (busy && input.mode === "interrupt") run.queue.unshift({ kind: "owner", itemId: id });
    else run.queue.push({ kind: "owner", itemId: id });
    run.held = false;
    this.refreshQueued(run);
    if (busy && input.mode === "interrupt") await this.cancelRun(run);
    void this.drive(run);
    return item;
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
        this.cancelPending(run);
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
        run.queue = run.queue.filter((e) => e.kind === "owner" || e.kind === "brief");
        this.deps.store.runs.setInFlight(run.task, run.agent, 0, false);
        this.setLive(run, { status: "stopped", nowDoing: undefined, slot: undefined });
        run.closing = false;
      }),
    );
  }

  /** Answers a pending permission prompt with one of its options. */
  answerPermission(task: string, itemId: string, option: string): RoomItem {
    const run = [...this.runs.values()].find((r) => r.task === task && r.pending.has(itemId));
    const pending = run?.pending.get(itemId);
    const item = this.deps.room.get(task, itemId);
    if (run === undefined || pending === undefined || item === undefined || item.type !== "permission") {
      throw new UserError("That prompt is not waiting for an answer any more.", 409);
    }
    const chosen = pending.ask.options.find((o) => o.id === option);
    if (chosen === undefined) {
      throw new UserError(
        `"${option}" is not one of the options: ${pending.ask.options.map((o) => o.id).join(", ")}.`,
      );
    }
    run.pending.delete(itemId);
    const allowed = chosen.kind === "allow_once" || chosen.kind === "allow_always";
    const kind = pending.ask.kind ?? "other";
    this.deps.store.permissions.log({
      task,
      agent: run.agent,
      kind,
      title: pending.ask.title,
      decision: allowed ? "allow" : "deny",
      by: "owner",
      at: this.now().toISOString(),
    });
    if (chosen.kind === "allow_always") this.deps.store.permissions.allow(task, kind);
    this.deps.room.post(item.task, itemId, permissionPayload(item, { state: "answered", chosen: option }));
    pending.resolve(option);
    if (run.pending.size === 0 && run.live.status === "waiting") this.setLive(run, { status: "working" });
    const updated = this.deps.room.get(task, itemId);
    if (updated === undefined) throw new Error("The prompt was not stored");
    return updated;
  }

  /**
   * "Fresh session": replaces the agent's session with a new one that carries a handoff note.
   * During a turn it happens when the turn ends; the room says so at once.
   */
  async fresh(task: Task, agent: string): Promise<RoomItem> {
    const run = this.runFor(task.id, agent);
    if (run.turning) {
      run.freshDue = true;
      return this.postSystem(run, "info", `@${agent} gets a fresh session when this turn ends.`);
    }
    // Hold the loop so nothing else prompts the agent meanwhile.
    run.turning = true;
    let item: RoomItem;
    try {
      item = await this.freshNow(run);
    } finally {
      run.turning = false;
    }
    if (run.queue.length > 0 && !run.held && run.paused === undefined) void this.drive(run);
    return item;
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
    this.setLive(run, { status: "paused", nowDoing: undefined });
  }

  /** majhi is offline: every agent in a turn stops it and waits (5.7). */
  async pauseForOffline(): Promise<void> {
    const targets = [...this.runs.values()].filter((r) => r.turning && r.paused === undefined && !r.closing);
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

  /** Continues a paused or cut run. */
  resume(task: string, agent: string, why: string): void {
    const run = this.runs.get(this.key(task, agent));
    if (run !== undefined) this.resumeRun(run, why);
  }

  /** The Mac woke from sleep: continue turns that failed while it slept, and restart ones that stalled. */
  async wake(): Promise<void> {
    const now = this.now().getTime();
    const views = [...this.runs.values()]
      .filter((r) => !r.closing && r.paused !== "offline")
      .map((r) => ({
        key: this.key(r.task, r.agent),
        turning: r.turning && r.session !== undefined,
        interrupted: r.interrupted,
        retryable: r.retryable && r.live.status === "error",
        lastEventAt: r.lastEventAt,
      }));
    const plan = wakePlan(views, now);
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
    this.deps.room.drop(task);
  }

  /** Server shutdown: closes every session so no agent process outlives majhi. Cut turns resume after the restart. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        run.closing = true;
        run.clearTimers();
        this.cancelPending(run);
        await run.session?.close().catch(() => undefined);
        this.endSession(run, "server-stop");
      }),
    );
  }

  // ---------------------------------------------------------------------------

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
      run.queue = queued.map((item) => ({ kind: "owner", itemId: item.id }));
      run.held = run.queue.length > 0;
      this.runs.set(key, run);
    }
    return run;
  }

  private setLive(run: AgentRun, patch: LivePatch): void {
    const wasWorking = WORKING.has(run.live.status);
    const merged: Record<string, unknown> = { ...run.live, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
    // Every key comes from AgentLive or a LivePatch of it, so the merge is an AgentLive.
    const next = merged as unknown as AgentLive;
    if (JSON.stringify(next) === JSON.stringify(run.live)) return;
    run.live = next;
    this.deps.room.setLive(run.task, next);
    if (wasWorking !== WORKING.has(next.status)) this.deps.onTasksChanged();
  }

  /** The owner's messages waiting for the agent's next turn. majhi's own entries do not count. */
  private refreshQueued(run: AgentRun): void {
    const queued = run.queue.filter((e) => e.kind === "owner" || e.kind === "brief").length;
    if (run.live.queued !== queued) this.setLive(run, { queued });
  }

  private post(run: AgentRun, payload: RoomPayload, options?: { defer?: boolean }): string {
    const id = `${run.agent}:${run.runId ?? "x"}:${randomUUID()}`;
    this.deps.room.post(run.task, id, payload, options);
    return id;
  }

  private system(run: AgentRun, level: "info" | "warn" | "error", text: string): void {
    this.post(run, { type: "system", level, text, agent: run.agent });
  }

  private postSystem(run: AgentRun, level: "info" | "warn" | "error", text: string): RoomItem {
    const id = this.post(run, { type: "system", level, text, agent: run.agent });
    const item = this.deps.room.get(run.task, id);
    if (item === undefined) throw new Error("The item was not stored");
    return item;
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
        this.system(run, "error", `@${run.agent} stopped: ${errorMessage(err)}`);
      } catch {
        // Nowhere left to say it.
      }
      this.setLive(run, { status: "error", nowDoing: undefined });
    } finally {
      run.turning = false;
      run.drive = undefined;
      // Idle between turns: a waiting start may stop this process now.
      if (run.session !== undefined && run.live.status === "idle") {
        this.slots.mark(this.key(run.task, run.agent), false);
      }
      if (run.redrive) {
        run.redrive = false;
        if (!run.closing) void this.drive(run);
      }
    }
  }

  private async runQueue(run: AgentRun): Promise<void> {
    while (run.queue.length > 0 && !run.held && !run.closing && run.paused === undefined) {
      if (run.session === undefined) {
        const started = await this.startSession(run);
        if (!started) {
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
      const session = run.session;
      const entry = run.queue.shift();
      if (session === undefined || entry === undefined) break;
      this.refreshQueued(run);
      if (entry.kind === "fresh") {
        await this.freshNow(run);
        continue;
      }
      if (entry.kind !== "continue") run.compactions = 0;
      const raw = await this.blocksFor(run, entry);
      if (raw === undefined) continue;

      // Compact first when this prompt would take the session over its budget.
      if (
        run.carry === undefined &&
        needsCompaction(run.usage, await this.budget(run), estimateTokens(raw))
      ) {
        const ok = await this.compact(run, "threshold");
        if (!ok || run.session === undefined) {
          // Paused, or handed off: the prompt goes to the next session.
          run.queue.unshift(entry);
          continue;
        }
      }
      const blocks = this.withPreamble(run, this.withCarry(run, raw));

      this.setLive(run, { status: "working", nowDoing: undefined });
      run.mapper?.beginTurn();
      this.markTurn(run, true);
      let stopReason: string;
      try {
        stopReason = (await session.prompt(blocks)).stopReason;
      } catch (err) {
        this.deps.room.flush(run.task);
        if (run.closing || run.exited) return;
        const message = errorMessage(err);
        run.mapper?.endTurn(true);
        if (run.paused !== undefined) {
          this.markTurn(run, false, false);
          return;
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
          return;
        }
        if (isContextError(message)) {
          await this.checkpoint(run);
          this.markTurn(run, false, false);
          if (await this.recoverContext(run, message)) continue;
          return;
        }
        this.markTurn(run, false, true);
        this.system(run, "error", `@${run.agent} failed: ${message}`);
        this.endSession(run, "error");
        void session.close().catch(() => undefined);
        this.setLive(run, { status: "error", nowDoing: undefined });
        this.resumeFailed(run, message);
        return;
      }
      run.lastStop = stopReason;
      this.finishTurn(run, stopReason);
      await this.checkpoint(run);
      // A turn cut by majhi (offline, a stall) keeps its in-flight mark, so it continues later.
      this.markTurn(run, false, run.paused === undefined);
      if (run.paused !== undefined) break;
      if (entry.kind === "resume" && stopReason !== "cancelled") {
        run.resuming = false;
        run.resumeFailures = 0;
      }
      run.turns++;
      this.setLive(run, { turns: run.turns });
      if (stopReason === "cancelled") {
        if (run.freshDue) await this.freshDueNow(run);
        continue;
      }
      if (isRecoveryStop(stopReason)) {
        if (await this.recoverContext(run, `it stopped with ${stopReason}`)) continue;
        break;
      }
      const budget = await this.budget(run);
      if (needsCompaction(run.usage, budget)) {
        if (!(await this.compact(run, "threshold"))) break;
      } else if (rotationDue(run.turns, budget)) {
        await this.compact(run, "rotation");
      }
      if (run.freshDue) await this.freshDueNow(run);
    }
    if (run.session !== undefined && !run.exited && !run.closing && run.paused === undefined) {
      this.setLive(run, { status: "idle", nowDoing: undefined });
      this.scheduleIdleStop(run);
      // Only a turn the agent ended itself hands the task back; Esc and stops keep it with the owner.
      if (run.queue.length === 0 && !run.held && run.lastStop === "end_turn") this.deps.onIdle?.(run.task);
    }
  }

  private async blocksFor(run: AgentRun, entry: QueueEntry): Promise<PromptBlock[] | undefined> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return undefined;
    switch (entry.kind) {
      case "brief":
        run.needsBrief = false;
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
      case "owner": {
        const item = this.deps.room.get(run.task, entry.itemId);
        if (item === undefined || item.type !== "owner") return undefined;
        if (item.queued) this.deps.room.post(item.task, item.id, ownerPayload(item, { queued: false }));
        const built = await ownerBlocks({
          folder: task.folder,
          attachments: item.attachments,
          text: item.text,
          needsBrief: run.needsBrief && run.carry === undefined,
        });
        if (built.briefSent) run.needsBrief = false;
        return built.blocks;
      }
    }
  }

  /** Puts the admin preamble before a session's first prompt. Slash commands stay whole and keep it waiting. */
  private withPreamble(run: AgentRun, blocks: PromptBlock[]): PromptBlock[] {
    const first = blocks[0];
    if (!run.preambleDue || (first?.type === "text" && first.text.startsWith("/"))) return blocks;
    run.preambleDue = false;
    return [{ type: "text", text: ADMIN_PREAMBLE }, ...blocks];
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
    this.cancelPending(run);
    // A turn majhi cut (offline, a stall) says so in its own words.
    if (cancelled && run.paused === undefined) this.system(run, "info", `Stopped @${run.agent}'s turn.`);
    else if (stopReason === "max_tokens")
      this.system(run, "warn", `@${run.agent} stopped: it reached its output limit.`);
    else if (stopReason === "max_turn_requests")
      this.system(run, "warn", `@${run.agent} stopped: it reached its turn limit.`);
    else if (stopReason === "refusal") this.system(run, "warn", `@${run.agent} declined to continue.`);
    this.setLive(run, { nowDoing: undefined });
  }

  /** A turn starts (busy) or ends. Ending with `clear` means it finished: nothing to continue after a crash. */
  private markTurn(run: AgentRun, busy: boolean, clear = true): void {
    const key = this.key(run.task, run.agent);
    run.lastEventAt = this.now().getTime();
    // The slot turns idle only when the loop does (the end of runQueue), never between turns.
    if (busy) this.slots.mark(key, true);
    if (busy) {
      if (run.idleTimer !== undefined) clearTimeout(run.idleTimer);
      run.idleTimer = undefined;
      if (run.runId !== undefined) this.deps.store.runs.setInFlight(run.task, run.agent, run.runId, true);
    } else if (clear) {
      this.deps.store.runs.setInFlight(run.task, run.agent, run.runId ?? 0, false);
      run.interrupted = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions

  /** Opens the ACP session. On failure posts an error, sets the agent to `error`, and returns false. */
  private async startSession(run: AgentRun): Promise<boolean> {
    const { deps } = this;
    const key = this.key(run.task, run.agent);
    this.setLive(run, { status: "starting", nowDoing: undefined });
    try {
      const stored = await deps.agents.get(run.agent);
      if (stored === undefined) throw new UserError(`Agent "${run.agent}" does not exist.`);
      if (!stored.ok) throw new UserError(`Agent "${run.agent}" is invalid: ${stored.errors.join("; ")}`);
      const fm = stored.agent.frontmatter;
      const { accounts, boss } = await deps.config.sections();
      const account = accounts[fm.account];
      if (account === undefined) throw new UserError(`Account "${fm.account}" is not in majhi.yaml.`);
      if (fm.scope !== "root" && account.org !== fm.scope && account.org !== "private") {
        throw new UserError(
          `@${fm.id} works in "${fm.scope}" and cannot use the account of "${account.org}".`,
        );
      }
      run.account = fm.account;
      run.compactAt = fm.context?.compact_at;
      // A free slot under the concurrency limits first. Stopped while waiting: leave quietly.
      if (!(await this.takeSlot(run))) return false;

      let apiKey: string | undefined;
      if (account.auth === "api-key" && account.key !== undefined) {
        apiKey = await deps.secrets.get(secretName(account.key));
        if (apiKey === undefined)
          throw new UserError(`The API key of ${fm.account} is missing. Add the account again.`);
      }
      const runtimeAccount = accountRuntime(deps.majhiHome, fm.account, account, apiKey);
      await deps.runtime.prepareHome(runtimeAccount);
      const task = deps.store.tasks.get(run.task);
      if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`);

      const model = fm.model === "auto" ? undefined : fm.model;
      const effort = fm.effort === "auto" ? undefined : fm.effort;
      const resume = run.freshNext ? undefined : deps.store.runs.lastSessionId(run.task, run.agent);
      const hadRuns =
        resume !== undefined || deps.store.runs.forTask(run.task).some((r) => r.agent === run.agent);
      const admin = deps.admin?.attach({ task: run.task, agent: run.agent }, fm, boss);
      const decide = deps.decisions?.attachTool(run.task, run.agent);
      const mcpServers = [admin?.server, decide?.server].flatMap((s) => (s === undefined ? [] : [s]));
      const session = await deps.runtime
        .startSession({
          account: runtimeAccount,
          options: deps.options,
          cwd: task.folder,
          ...(resume === undefined ? {} : { resume }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
        })
        .catch((err: unknown) => {
          if (admin !== undefined) deps.admin?.revoke(admin.token);
          if (decide !== undefined) deps.decisions?.revoke(decide.token);
          throw err;
        });

      const resumed = resume !== undefined && session.sessionId === resume;
      run.session = session;
      run.exited = false;
      run.freshNext = false;
      run.perms = fm.perms;
      run.adminToken = admin?.token;
      run.decideToken = decide?.token;
      run.turns = 0;
      run.usage = undefined;
      run.runId = deps.store.runs.start({
        task: run.task,
        agent: run.agent,
        sessionId: session.sessionId,
        model: session.models.defaultModel ?? model,
        effort: session.models.defaultEffort ?? effort,
        at: this.now().toISOString(),
      });
      run.mapper = new ItemMapper(
        run.agent,
        run.runId,
        { post: (id, payload, options) => deps.room.post(run.task, id, payload, options) },
        taskMediaSink(run.task, task.folder),
      );
      // Attach before anything else: the session buffers early events, and a crash must not be missed.
      run.unsubscribe = session.onEvent((event) => this.onEvent(run, event));
      session.setPermissionHandler((ask, signal) => this.onPermission(run, ask, signal));

      // A new session for a pair that worked before: carry the work over with a note built from saved state.
      if (!resumed && hadRuns && run.carry === undefined) {
        const built = await buildCarry(
          this.deps,
          task,
          run.agent,
          undefined,
          "the previous session could not be loaded",
        );
        run.carry = built.carry;
        this.postContext(run, {
          method: "recovery",
          note: built.path,
          after: estimateText(freshPrompt(built.carry)),
        });
      }
      run.needsBrief = !resumed && run.carry === undefined;
      run.preambleDue = admin !== undefined && !resumed;

      let pickLine: string | undefined;
      if (fm.model === "auto" || fm.effort === "auto") {
        const result = await pickForSession({
          decisions: deps.decisions,
          session,
          fm,
          instructions: stored.agent.instructions,
          task,
        });
        for (const line of result.warnings) this.system(run, "warn", line);
        if (result.pick !== undefined && run.runId !== undefined) {
          const { model: picked, effort: level, decisionId } = result.pick;
          deps.store.runs.setPick(run.runId, { model: picked, effort: level, decisionId });
        }
        pickLine = result.line;
      }
      // What the agent runs after the session applied the options: a refused model keeps the default.
      const shownModel = session.models.defaultModel ?? model;
      const shownEffort = session.models.defaultEffort ?? effort;
      this.system(
        run,
        "info",
        `@${run.agent} ${resumed ? "resumed" : "started"} on ${fm.account}, model ${shownModel ?? "default"}, effort ${shownEffort ?? "default"}`,
      );
      if (pickLine !== undefined) this.system(run, "info", pickLine);
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
      this.system(run, "error", `@${run.agent} could not start: ${message}`);
      this.setLive(run, { status: "error", nowDoing: undefined, slot: undefined });
      return false;
    }
  }

  private onEvent(run: AgentRun, event: SessionEvent): void {
    run.lastEventAt = this.now().getTime();
    const internal = run.internal;
    switch (event.type) {
      case "text":
        if (internal !== undefined) internal.text += event.text;
        else run.mapper?.apply(event);
        break;
      case "thought":
      case "media":
      case "plan":
        if (internal === undefined) run.mapper?.apply(event);
        break;
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
        this.system(run, event.level, event.text);
        break;
      case "exit":
        if (run.closing) break;
        run.exited = true;
        run.retryable = looksLikeNetworkError(event.error ?? "");
        this.deps.room.flush(run.task);
        this.system(
          run,
          "error",
          `@${run.agent} stopped unexpectedly: ${event.error ?? `exit code ${event.code ?? "unknown"}`}`,
        );
        this.endSession(run, "exit");
        this.setLive(run, { status: "error", nowDoing: undefined });
        break;
    }
    if (event.type === "plan" && internal === undefined)
      this.setLive(run, { nowDoing: run.mapper?.nowDoing() });
  }

  private async onPermission(
    run: AgentRun,
    ask: PermissionAsk,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const { store } = this.deps;
    const kind = ask.kind ?? "other";
    const decision = decidePermission(ask, {
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
      this.deps.room.post(run.task, id, { ...base, state: "auto", chosen: decision.option });
      store.permissions.log({
        task: run.task,
        agent: run.agent,
        kind,
        title: ask.title,
        decision: "allow",
        by: "rule",
        at: this.now().toISOString(),
      });
      return decision.option;
    }
    this.deps.room.post(run.task, id, { ...base, state: "pending" });
    this.setLive(run, { status: "waiting" });
    return new Promise<string | undefined>((resolve) => {
      run.pending.set(id, { ask, resolve });
      signal.addEventListener("abort", () => this.cancelOne(run, id), { once: true });
    });
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
    this.deps.store.permissions.log({
      task: run.task,
      agent: run.agent,
      kind: pending.ask.kind ?? "other",
      title: pending.ask.title,
      decision: "cancelled",
      by: "owner",
      at: this.now().toISOString(),
    });
    pending.resolve(undefined);
    if (run.pending.size === 0 && run.live.status === "waiting") this.setLive(run, { status: "working" });
  }

  private cancelPending(run: AgentRun): void {
    for (const id of [...run.pending.keys()]) this.cancelOne(run, id);
  }

  private async cancelRun(run: AgentRun): Promise<void> {
    this.cancelPending(run);
    const session = run.session;
    if (session === undefined) {
      // Still starting: the loop checks this before it sends anything.
      if (run.turning) run.cancelBeforePrompt = true;
      return;
    }
    try {
      await session.cancel();
    } catch (err) {
      this.system(run, "error", `@${run.agent} did not stop: ${errorMessage(err)}. Its session was closed.`);
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
    if (run.idleTimer !== undefined) clearTimeout(run.idleTimer);
    run.idleTimer = undefined;
    this.cancelPending(run);
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
        this.system(
          run,
          "info",
          `Queued, #${slot} in line: majhi is running as many agents as the limits allow. @${run.agent} starts when a slot is free.`,
        );
      }
    }
  }

  /** Stops an idle process to make room for a waiting start. It resumes from its session later. */
  private evict(key: string): void {
    const run = this.runs.get(key);
    const session = run?.session;
    if (run === undefined || session === undefined || run.turning) return;
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
          const session = run.session;
          if (session === undefined || run.turning || run.closing) return;
          this.endSession(run, "idle");
          void session.close().catch(() => undefined);
        }, durationMs(s.limits.idle_timeout));
        run.idleTimer.unref();
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Context budget (5.13)

  private async budget(run: AgentRun): Promise<ContextBudget> {
    const [settings, sections] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
    ]);
    const org = this.deps.store.tasks.get(run.task)?.org;
    return budgetFor(
      settings.context,
      org === undefined ? undefined : sections.orgs[org]?.context,
      run.compactAt === undefined ? undefined : { compact_at: run.compactAt },
    );
  }

  /**
   * Brings the session back under its budget: native `/compact` first (threshold only), else a
   * handoff note from the agent, else one majhi builds. Handoffs close the session; the next
   * prompt opens a fresh one with the note. Returns false when the run paused instead (the cap).
   */
  private async compact(
    run: AgentRun,
    why: "threshold" | "rotation" | "fresh" | "recovery",
  ): Promise<boolean> {
    if (why !== "fresh" && run.compactions >= MAX_COMPACTIONS_PER_TURN) {
      this.pause(
        run,
        "error",
        `@${run.agent} is still over its context budget after ${MAX_COMPACTIONS_PER_TURN} compactions in one turn, so it paused. Use Fresh session, then resume the task.`,
      );
      return false;
    }
    if (why !== "fresh") run.compactions++;
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return true;
    const before = run.usage?.used;
    this.setLive(run, { nowDoing: "Compacting its context" });

    if (why === "threshold") {
      const command = compactCommand(run.live.commands);
      if (command !== undefined && run.session !== undefined) {
        const seq = run.usageSeq;
        const res = await this.internalPrompt(run, `${command} ${COMPACT_NOTE}`);
        if (res.ok) await run.waitUsage(seq, USAGE_WAIT_MS);
        if (res.ok && run.usageSeq > seq && reachedTarget(run.usage, await this.budget(run))) {
          this.postContext(run, { method: "native", before, after: run.usage?.used });
          this.setLive(run, { nowDoing: undefined });
          return true;
        }
      }
    }

    // Hand off. The agent writes the note unless its session is past saving.
    let note: string | undefined;
    if (why !== "recovery" && run.session !== undefined && !run.exited) {
      const res = await this.internalPrompt(run, HANDOFF_REQUEST);
      if (res.ok && looksLikeNote(res.text)) note = res.text.trim();
    }
    const built = await buildCarry(
      this.deps,
      task,
      run.agent,
      note,
      why === "recovery" ? "the session hit its limit" : "the agent did not write a note",
    );
    const session = run.session;
    if (session !== undefined) {
      // The fresh session takes over the slot.
      this.endSession(run, "handoff", true);
      void session.close().catch(() => undefined);
    }
    run.freshNext = true;
    run.carry = built.carry;
    run.turns = 0;
    run.usage = undefined;
    this.setLive(run, { usage: undefined, turns: 0, nowDoing: undefined });
    this.postContext(run, {
      method: why === "threshold" ? "handoff" : why,
      before,
      after: estimateText(freshPrompt(built.carry)),
      note: built.path,
    });
    return true;
  }

  /** Recovery after a stop reason or error that means the window is full: hand off with majhi's note, then continue. */
  private async recoverContext(run: AgentRun, why: string): Promise<boolean> {
    this.system(run, "warn", `@${run.agent} ran out of room (${why}). Moving it to a fresh session.`);
    if (!(await this.compact(run, "recovery"))) return false;
    run.queue.unshift({ kind: "continue" });
    return true;
  }

  /** The owner's "Fresh session". Returns the room item that says what happened. */
  private async freshNow(run: AgentRun): Promise<RoomItem> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) throw new UserError(`Task ${run.task} does not exist.`, 404);
    if (run.session !== undefined) {
      await this.compact(run, "fresh");
    } else {
      const worked = this.deps.store.runs.forTask(run.task).some((r) => r.agent === run.agent);
      if (!worked)
        return this.postSystem(
          run,
          "info",
          `@${run.agent} has no session yet. Its first message starts one.`,
        );
      const built = await buildCarry(
        this.deps,
        task,
        run.agent,
        undefined,
        "the owner asked for a fresh session",
      );
      run.carry = built.carry;
      run.freshNext = true;
      this.postContext(run, {
        method: "fresh",
        after: estimateText(freshPrompt(built.carry)),
        note: built.path,
      });
    }
    const last = this.deps.store.room.page(run.task, 1).items[0];
    if (last === undefined) throw new Error("The item was not stored");
    return last;
  }

  private async freshDueNow(run: AgentRun): Promise<void> {
    run.freshDue = false;
    await this.freshNow(run);
  }

  /** Sends majhi's own prompt (compact, handoff request). The reply is collected, not shown in the room. */
  private async internalPrompt(run: AgentRun, text: string): Promise<{ ok: boolean; text: string }> {
    const session = run.session;
    if (session === undefined) return { ok: false, text: "" };
    const internal = { text: "" };
    run.internal = internal;
    try {
      const res = await session.prompt([{ type: "text", text }]);
      return { ok: res.stopReason === "end_turn", text: internal.text };
    } catch {
      return { ok: false, text: internal.text };
    } finally {
      run.internal = undefined;
    }
  }

  private postContext(
    run: AgentRun,
    event: {
      method: "native" | "handoff" | "rotation" | "fresh" | "recovery";
      before?: number | undefined;
      after?: number | undefined;
      note?: string | undefined;
    },
  ): void {
    this.deps.room.post(run.task, `context:${randomUUID()}`, {
      type: "context",
      agent: run.agent,
      method: event.method,
      ...(event.before === undefined ? {} : { before: event.before }),
      ...(event.after === undefined ? {} : { after: event.after }),
      ...(event.note === undefined ? {} : { note: event.note }),
    });
  }

  // ---------------------------------------------------------------------------
  // Checkpoints (5.7)

  /** Commits the task's changed worktrees as the next checkpoint. A failure is a warning, never the end of the run. */
  private async checkpoint(run: AgentRun): Promise<void> {
    const task = this.deps.store.tasks.get(run.task);
    if (task === undefined) return;
    try {
      for (const line of await checkpointTurn(this.deps, task, run.runId)) this.system(run, "warn", line);
    } catch (err) {
      this.system(run, "warn", `Checkpoint failed: ${errorMessage(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Pause and resume (5.7)

  private pause(run: AgentRun, reason: PauseReason, text: string): void {
    run.paused = reason;
    run.clearTimers();
    this.system(run, reason === "offline" ? "warn" : "error", text);
    this.setLive(run, { status: "paused", nowDoing: undefined });
    this.deps.onPaused?.(run.task, reason);
  }

  /** Queues "continue from where you stopped" and starts the loop, or restarts it once the current one ends. */
  private resumeRun(run: AgentRun, why: string): void {
    if (run.closing) return;
    run.paused = undefined;
    run.retryable = false;
    if (run.retryTimer !== undefined) clearTimeout(run.retryTimer);
    run.retryTimer = undefined;
    if (!run.queue.some((e) => e.kind === "resume")) run.queue.unshift({ kind: "resume" });
    run.interrupted = false;
    run.resuming = true;
    run.held = false;
    this.system(run, "info", `Resuming @${run.agent}: ${why}.`);
    this.deps.onResumed?.(run.task);
    if (run.turning) run.redrive = true;
    else void this.drive(run);
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
