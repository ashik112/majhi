import type { AutonomyMode, RoomItem, Task } from "@majhi/shared";
import type { EventHub } from "../events/hub.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { answerableText, digest } from "./digest.ts";
import type { AutonomyService } from "./service.ts";

/**
 * The driver (PRV-74, rule 8): wakes the boss in its autonomy chat with a tick when something it
 * should decide happened. Events are batched for `DEBOUNCE_MS`; at most one tick waits at a time;
 * while the boss is in a turn, the next tick goes when the turn ends. Nothing ticks unless the mode
 * is on.
 */

export const DEBOUNCE_MS = 20_000;
/** A check while nothing autonomous runs, so the boss picks the next work. */
export const HEARTBEAT_MS = 60 * 60_000;
/** A burst of task changes is looked at once. */
const WATCH_MS = 1_000;
const REASONS_MAX = 50;
/** How long a tick waits for backlog sizes to be rated before it goes with what is known. */
const SIZE_FILL_MS = 30_000;
const SEEN_MAX = 2_000;

export interface DriverDeps {
  autonomy: AutonomyService;
  tasks: Pick<TaskService, "tellAgent">;
  runs: Pick<RunManager, "working">;
  room: Pick<RoomService, "onWrite">;
  store: Store;
  events: EventHub;
  now?: () => Date;
  /** For tests: the debounce. */
  debounceMs?: number;
}

export class AutonomyDriver {
  private reasons: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** A tick waits for the boss's turn to end. */
  private afterTurn = false;
  private sending: Promise<void> | undefined;
  private lastTickAt: number;
  /** Each autonomous task's status as last seen, to tell what changed. */
  private readonly statuses = new Map<string, string>();
  private readonly seenCards = new Set<string>();
  private watchTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: DriverDeps) {
    const last = deps.autonomy.repo.state().lastTick;
    this.lastTickAt = last === undefined ? 0 : Date.parse(last);
    deps.room.onWrite((task, item) => this.cardWritten(task, item));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Watches task changes. The first look only learns the statuses. */
  start(): void {
    this.checkTasks();
    this.unsubscribe ??= this.deps.events.subscribe((e) => {
      if (e.type === "changed" && e.topics.includes("tasks")) this.scheduleWatch();
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.watchTimer);
    this.timer = undefined;
    this.watchTimer = undefined;
  }

  /** Something the boss should look at happened: batched into the next tick. */
  wake(line: string): void {
    if (this.deps.autonomy.mode() !== "on") return;
    this.reasons.push(line);
    if (this.reasons.length > REASONS_MAX) this.reasons.splice(0, this.reasons.length - REASONS_MAX);
    if (this.timer !== undefined || this.afterTurn) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.fire().catch(() => undefined);
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
    this.timer.unref();
  }

  /** Paused, stopping or off: no tick waits. */
  onMode(mode: AutonomyMode): void {
    if (mode === "on") return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.afterTurn = false;
    this.reasons = [];
  }

  /**
   * A run's loop ended. The boss's: a tick that waited goes now. An autonomous task's that is
   * still running with nobody working: the boss looks.
   */
  loopEnded(task: string): void {
    if (task === this.deps.autonomy.chat()) {
      if (!this.afterTurn) return;
      this.afterTurn = false;
      void this.fire().catch(() => undefined);
      return;
    }
    if (!this.deps.autonomy.isAutonomous(task)) return;
    const found = this.deps.store.tasks.get(task);
    if (found?.status === "running" && this.deps.runs.working(task).length === 0) {
      this.wake(`${task} is running, but no agent is working on it`);
    }
  }

  /** Sends the batch now, or after the boss's turn. One send at a time. */
  async fire(): Promise<void> {
    if (this.sending !== undefined) return this.sending;
    const { autonomy } = this.deps;
    if (autonomy.mode() !== "on" || this.reasons.length === 0) return;
    // Under the day cap the boss is not woken: only the owner's own messages reach it.
    if (autonomy.dayCapped()) {
      this.reasons = [];
      return;
    }
    this.sending = this.deliver().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private async deliver(): Promise<void> {
    // A chat that was removed or closed is made again first: a tick never goes into nothing.
    const chat = await this.deps.autonomy.tickChat();
    if (chat === undefined) return;
    if (this.deps.runs.working(chat).length > 0) {
      this.afterTurn = true;
      return;
    }
    const reasons = this.reasons.splice(0);
    if (reasons.length > 0) await this.send(chat, reasons);
  }

  private async send(chat: string, reasons: string[]): Promise<void> {
    const { autonomy } = this.deps;
    const status = await autonomy.status();
    const boss = status.boss?.id;
    if (boss === undefined) return;
    // Sizes not known yet are rated first, so the size rule and the digest can use them.
    const pick = await autonomy.pickable(SIZE_FILL_MS);
    const text = digest({
      now: this.now(),
      tz: status.spend.tz,
      reasons,
      spend: status.spend,
      holds: status.holds,
      accounts: status.accounts,
      instructions: status.settings.instructions,
      tasks: status.now,
      cards: autonomy.answerable(),
      waiting: status.waiting,
      backlog: pick.backlog,
      leftOut: pick.leftOut,
      rules: pick.rules,
      queue: status.queue,
    });
    await this.deps.tasks.tellAgent({
      task: chat,
      agent: boss,
      text,
      settled: "Autonomous mode woke the boss",
    });
    this.lastTickAt = this.now().getTime();
    autonomy.ticked(reasons);
  }

  /** The minute sweep: the hourly heartbeat while nothing autonomous runs, and missed task changes. */
  sweep(): void {
    this.checkTasks();
    if (this.deps.autonomy.mode() !== "on") return;
    if (this.now().getTime() - this.lastTickAt < HEARTBEAT_MS) return;
    const chat = this.deps.autonomy.chat();
    const busy = [
      ...this.deps.autonomy.openTasks().map((t) => t.id),
      ...(chat === undefined ? [] : [chat]),
    ].some((id) => this.deps.runs.working(id).length > 0);
    if (!busy) this.wake("Hourly check: nothing autonomous is running");
  }

  private scheduleWatch(): void {
    if (this.watchTimer !== undefined) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.checkTasks();
    }, WATCH_MS);
    this.watchTimer.unref();
  }

  /** Writes a `task` event for each autonomous task that changed status, and wakes the boss for the ones it should see. */
  checkTasks(): void {
    let ids: Set<string>;
    let all: ReturnType<Store["tasks"]["list"]>;
    try {
      ids = new Set(this.deps.autonomy.repo.tasks().map((r) => r.task));
      if (ids.size === 0) return;
      all = this.deps.store.tasks.list(true);
    } catch {
      // The database closed under a shutdown.
      return;
    }
    for (const t of all) {
      if (!ids.has(t.id)) continue;
      const key = `${t.status}:${t.pausedReason ?? ""}`;
      const before = this.statuses.get(t.id);
      this.statuses.set(t.id, key);
      if (before === undefined || before === key) continue;
      const change = changeOf(t);
      if (change === undefined) continue;
      this.deps.autonomy.event({
        kind: "task",
        text: change.text,
        task: t.id,
        ...(t.org === undefined ? {} : { org: t.org }),
        status: t.status,
      });
      if (change.wake) this.wake(change.text);
    }
  }

  /** A card the boss may answer was posted in an autonomous task. */
  private cardWritten(task: string, item: RoomItem): void {
    const text = answerableText(item);
    if (text === undefined) return;
    const key = `${task}:${item.id}`;
    if (this.seenCards.has(key)) return;
    try {
      if (!this.deps.autonomy.isAutonomous(task)) return;
    } catch {
      return;
    }
    this.seenCards.add(key);
    if (this.seenCards.size > SEEN_MAX) this.seenCards.delete(this.seenCards.values().next().value as string);
    this.wake(`${task}: ${text}`);
  }
}

/** What a status change says, and whether the boss should look now. */
function changeOf(
  t: Pick<Task, "id" | "title" | "status" | "pausedReason">,
): { text: string; wake: boolean } | undefined {
  switch (t.status) {
    case "review":
      return { text: `${t.id} is ready for review: ${t.title}`, wake: true };
    case "mr":
      return { text: `${t.id} has a merge request open: ${t.title}`, wake: true };
    case "done":
      return { text: `${t.id} is done: ${t.title}`, wake: true };
    case "running":
      return { text: `${t.id} is running: ${t.title}`, wake: false };
    case "paused": {
      const reason = t.pausedReason ?? "owner";
      const stuck = reason === "error" || reason === "loop" || reason === "blocked";
      return { text: `${t.id} paused (${reason}): ${t.title}`, wake: stuck };
    }
    default:
      return undefined;
  }
}
