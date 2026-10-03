import { type AutonomyMode, PRIVATE, type RoomItem, type Task } from "@majhi/shared";
import type { EventHub } from "../events/hub.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { answerableText, digest } from "./digest.ts";
import type { AutonomyService } from "./service.ts";

/**
 * The driver (PRV-74, rule 8; 5.18 lanes): wakes the captain with a tick in the lane of each
 * workspace set to "Runs it" when something it should decide happened there. Each lane has its own
 * batch: events are batched for `DEBOUNCE_MS`, at most one tick waits per lane, and while the captain
 * is in a turn in that lane the next tick goes when the turn ends. A tick holds only its workspace's
 * tasks, cards, backlog and spend. Nothing ticks unless the mode is on.
 */

export const DEBOUNCE_MS = 20_000;
/** A check while nothing autonomous runs in a workspace, so the captain picks the next work. */
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
  runs: Pick<RunManager, "working" | "busy">;
  room: Pick<RoomService, "onWrite">;
  /**
   * A running task where nothing waits: no owner card, no background process, no subtask that moves
   * (the idle watch's own check). Absent: only the runs are looked at.
   */
  quiet?: (task: string) => boolean;
  store: Store;
  events: EventHub;
  now?: () => Date;
  /** For tests: the debounce. */
  debounceMs?: number;
}

/** One lane's batch. */
interface Lane {
  reasons: string[];
  timer: NodeJS.Timeout | undefined;
  /** A tick waits for the captain's turn in this lane to end. */
  afterTurn: boolean;
  sending: Promise<void> | undefined;
  lastTickAt: number;
}

export class AutonomyDriver {
  private readonly lanes = new Map<string, Lane>();
  private readonly firstTick: number;
  /** Each autonomous task's status as last seen, to tell what changed. */
  private readonly statuses = new Map<string, string>();
  private readonly seenCards = new Set<string>();
  private watchTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Moves on every mode change that is not `on`, so a wake that was on its way is dropped. */
  private generation = 0;

  constructor(private readonly deps: DriverDeps) {
    const last = deps.autonomy.repo.state().lastTick;
    this.firstTick = last === undefined ? 0 : Date.parse(last);
    deps.room.onWrite((task, item) => this.cardWritten(task, item));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private lane(org: string): Lane {
    let lane = this.lanes.get(org);
    if (lane === undefined) {
      lane = {
        reasons: [],
        timer: undefined,
        afterTurn: false,
        sending: undefined,
        lastTickAt: this.firstTick,
      };
      this.lanes.set(org, lane);
    }
    return lane;
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
    for (const lane of this.lanes.values()) clearTimeout(lane.timer);
    this.lanes.clear();
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
  }

  /**
   * Something the captain should look at happened in a workspace: batched into that lane's next
   * tick. Without a workspace it goes to every lane of a workspace set to "Runs it".
   */
  wake(line: string, org?: string): void {
    if (this.deps.autonomy.mode() !== "on") return;
    if (org === undefined) {
      const generation = this.generation;
      void this.deps.autonomy
        .runsOrgs()
        .then((orgs) => {
          if (generation !== this.generation || this.deps.autonomy.mode() !== "on") return;
          for (const o of orgs) this.wakeLane(o, line);
        })
        .catch(() => undefined);
      return;
    }
    this.wakeLane(org, line);
  }

  private wakeLane(org: string, line: string): void {
    const lane = this.lane(org);
    lane.reasons.push(line);
    if (lane.reasons.length > REASONS_MAX) lane.reasons.splice(0, lane.reasons.length - REASONS_MAX);
    if (lane.timer !== undefined || lane.afterTurn) return;
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      void this.fire(org).catch(() => undefined);
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
    lane.timer.unref();
  }

  /** Paused, stopping or off: no tick waits in any lane. */
  onMode(mode: AutonomyMode): void {
    if (mode === "on") return;
    this.generation += 1;
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer);
      lane.timer = undefined;
      lane.afterTurn = false;
      lane.reasons = [];
    }
  }

  /**
   * A run's loop ended. The captain's in a lane: a tick that waited there goes now. An autonomous
   * task's that is still running with nobody working, queued or starting, and nothing pending: the
   * captain looks, in its workspace's lane.
   */
  loopEnded(task: string): void {
    const laneOrg = this.deps.autonomy.laneOrg(task);
    if (laneOrg !== undefined) {
      const lane = this.lane(laneOrg);
      if (!lane.afterTurn) return;
      lane.afterTurn = false;
      void this.fire(laneOrg).catch(() => undefined);
      return;
    }
    if (!this.deps.autonomy.isAutonomous(task)) return;
    const found = this.deps.store.tasks.get(task);
    // Stuck only when nobody works, nobody waits for a slot or a gate, and nothing is pending.
    if (found?.status !== "running" || this.deps.runs.busy(task)) return;
    if (this.deps.quiet !== undefined && !this.deps.quiet(task)) return;
    this.wake(`${task} is running, but no agent is working on it`, found.org ?? PRIVATE);
  }

  /** Sends a lane's batch now, or after the captain's turn there. One send per lane at a time. */
  async fire(org: string): Promise<void> {
    const lane = this.lane(org);
    if (lane.sending !== undefined) return lane.sending;
    const { autonomy } = this.deps;
    if (autonomy.mode() !== "on" || lane.reasons.length === 0) return;
    // Under the day cap the captain is not woken: only the owner's own messages reach it.
    if (autonomy.dayCapped()) {
      lane.reasons = [];
      return;
    }
    lane.sending = this.deliver(org, lane).finally(() => {
      lane.sending = undefined;
    });
    return lane.sending;
  }

  private async deliver(org: string, lane: Lane): Promise<void> {
    // A lane's chat that was removed or closed is made again first: a tick never goes into nothing.
    const chat = await this.deps.autonomy.laneChat(org);
    if (chat === undefined) {
      lane.reasons = [];
      return;
    }
    if (this.deps.runs.working(chat).length > 0) {
      lane.afterTurn = true;
      return;
    }
    const reasons = lane.reasons.splice(0);
    if (reasons.length > 0) await this.send(org, chat, reasons, lane);
  }

  private async send(org: string, chat: string, reasons: string[], lane: Lane): Promise<void> {
    const { autonomy } = this.deps;
    const status = await autonomy.status();
    const boss = status.boss?.id;
    if (boss === undefined) return;
    const inOrg = (o: string | undefined) => (o ?? PRIVATE) === org;
    const workspace = status.lanes.find((l) => l.org === org)?.name ?? org;
    // Sizes not known yet are rated first, so the size rule and the digest can use them.
    const pick = await autonomy.pickable(SIZE_FILL_MS, org);
    const tasksOf = new Map(status.now.map((t) => [t.task, t.org]));
    const text = digest({
      workspace,
      now: this.now(),
      tz: status.spend.tz,
      reasons,
      // The day total is a count the lanes share; per workspace, only this one's.
      spend: { ...status.spend, orgs: status.spend.orgs.filter((o) => o.org === org) },
      holds: status.holds.filter((h) => h.kind === "day-cap" || (h.kind === "org-cap" && h.id === org)),
      accounts: status.accounts.filter((a) => a.org === org || a.org === PRIVATE),
      instructions: status.settings.instructions,
      tasks: status.now.filter((t) => inOrg(t.org)),
      cards: autonomy.answerable(org),
      waiting: status.waiting.filter((w) =>
        inOrg(tasksOf.get(w.task) ?? this.deps.store.tasks.get(w.task)?.org),
      ),
      backlog: pick.backlog,
      leftOut: pick.leftOut,
      rules: pick.rules,
      queue: status.queue.filter((q) => inOrg(q.org)),
    });
    await this.deps.tasks.tellAgent({
      task: chat,
      agent: boss,
      text,
      settled: "Autonomous mode woke the captain",
      by: "majhi",
    });
    lane.lastTickAt = this.now().getTime();
    autonomy.ticked(reasons, org, chat);
  }

  /** The minute sweep: the hourly heartbeat per lane while nothing autonomous runs there, and missed task changes. */
  sweep(): void {
    this.checkTasks();
    if (this.deps.autonomy.mode() !== "on") return;
    const now = this.now().getTime();
    void this.deps.autonomy
      .runsOrgs()
      .then((orgs) => {
        for (const org of orgs) {
          if (now - this.lane(org).lastTickAt < HEARTBEAT_MS) continue;
          const chat = this.deps.autonomy.laneChats().find((c) => this.deps.autonomy.laneOrg(c) === org);
          const busy = [
            ...this.deps.autonomy
              .openTasks()
              .filter((t) => (t.org ?? PRIVATE) === org)
              .map((t) => t.id),
            ...(chat === undefined ? [] : [chat]),
          ].some((id) => this.deps.runs.working(id).length > 0);
          if (!busy) this.wakeLane(org, "Hourly check: nothing autonomous is running here");
        }
      })
      .catch(() => undefined);
  }

  private scheduleWatch(): void {
    if (this.watchTimer !== undefined) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.checkTasks();
    }, WATCH_MS);
    this.watchTimer.unref();
  }

  /** Writes a `task` event for each autonomous task that changed status, and wakes its lane for the ones it should see. */
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
      if (change.wake) this.wake(change.text, t.org ?? PRIVATE);
    }
  }

  /** A card the captain may answer was posted in an autonomous task: its workspace's lane hears of it. */
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
    this.wake(`${task}: ${text}`, this.deps.store.tasks.get(task)?.org ?? PRIVATE);
  }
}

/** What a status change says, and whether the captain should look now. */
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
