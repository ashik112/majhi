import { type AutonomyMode, PRIVATE, type RoomItem, type Task } from "@majhi/shared";
import { authorityOf } from "../captain/levels.ts";
import type { EventHub } from "../events/hub.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { answerableText, type DigestInput, digest, factsKey } from "./digest.ts";
import type { AutonomyService } from "./service.ts";

/**
 * The driver (PRV-74, rule 8; 5.18 lanes): wakes the captain with a tick in the lane of each
 * workspace where the captain starts work when something it should decide happened there. Each lane has its own
 * batch: events are batched for `DEBOUNCE_MS`, at most one tick waits per lane, and while the captain
 * is in a turn in that lane the next tick goes when the turn ends. A tick holds only its workspace's
 * tasks, cards, backlog and spend. Nothing ticks unless the mode is on.
 *
 * A tick carries news only (SPEC 5.18, "Wakes carry news"). Each wake is `news` (a task finished, a
 * finding or backlog task appeared, a cap lifted, an account changed) or `soft` (a stall alarm, a
 * restart). Just before a tick goes, the facts it would show are keyed
 * (`factsKey`) and compared with the facts of the captain's last turn in the lane: a batch of soft
 * wakes goes only when the facts changed, and a batch of news only when a line is new or the facts
 * changed. Wakes that arrive together are one tick with all their reasons, repeats counted.
 */

export const DEBOUNCE_MS = 20_000;
/** A burst of task changes is looked at once. */
const WATCH_MS = 1_000;
const REASONS_MAX = 50;

/** `news`: something the captain can act on. `soft`: an alarm that matters only if the facts changed. */
export type WakeKind = "news" | "soft";
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
  /**
   * Why a running task with no agent working is nothing to wake the captain for: it waits for a
   * slot, a cap, or the owner. Absent: nothing is explained.
   */
  explained?: (task: string) => string | undefined;
  /** One line per open finding of a workspace for the digest. */
  findingLines?: (org: string) => string[];
  /** One line per open incident or failing watch of a workspace, unacknowledged first. */
  incidentLines?: (org: string) => string[];
  /** One line per project of a workspace for the digest: its knowledge card in brief. */
  projectLines?: (org: string) => string[];
  store: Store;
  events: EventHub;
  now?: () => Date;
  /** For tests: the debounce. */
  debounceMs?: number;
}

/** One lane's batch. */
interface Lane {
  /** The distinct lines of the batch, in order of first arrival, with how often each came. */
  reasons: string[];
  counts: Map<string, number>;
  /** Lines of the batch that are news. */
  news: Set<string>;
  /** The facts and the news lines of the last tick, or of the captain's last turn after it. */
  lastFacts: string | undefined;
  lastNews: Set<string>;
  timer: NodeJS.Timeout | undefined;
  /** A tick waits for the captain's turn in this lane to end. */
  afterTurn: boolean;
  sending: Promise<void> | undefined;
}

export class AutonomyDriver {
  private readonly lanes = new Map<string, Lane>();
  /** Each autonomous task's status as last seen, to tell what changed. */
  private readonly statuses = new Map<string, string>();
  private readonly seenCards = new Set<string>();
  /** Every other task's status as last seen (see `watchOther`), and whether the first look is done. */
  private readonly others = new Map<string, string>();
  private learned = false;
  private watchTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Moves on every mode change that is not `on`, so a wake that was on its way is dropped. */
  private generation = 0;

  constructor(private readonly deps: DriverDeps) {
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
        counts: new Map(),
        news: new Set(),
        lastFacts: undefined,
        lastNews: new Set(),
        timer: undefined,
        afterTurn: false,
        sending: undefined,
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
   * tick. Without a workspace it goes to every lane of a workspace where the captain starts work.
   */
  wake(line: string, org?: string, kind: WakeKind = "news"): void {
    if (this.deps.autonomy.mode() !== "on") return;
    if (org === undefined) {
      const generation = this.generation;
      void this.deps.autonomy
        .runsOrgs()
        .then((orgs) => {
          if (generation !== this.generation || this.deps.autonomy.mode() !== "on") return;
          for (const o of orgs) this.wakeLane(o, line, kind);
        })
        .catch(() => undefined);
      return;
    }
    this.wakeLane(org, line, kind);
  }

  /** Adds a line to the lane's batch; a line that is there already is counted, not repeated. */
  private wakeLane(org: string, line: string, kind: WakeKind = "news"): void {
    const lane = this.lane(org);
    if (lane.counts.has(line)) {
      // Seen again: counted, and moved to the end, where the digest shows the newest.
      lane.counts.set(line, (lane.counts.get(line) ?? 0) + 1);
      lane.reasons.splice(lane.reasons.indexOf(line), 1);
    } else lane.counts.set(line, 1);
    lane.reasons.push(line);
    if (kind === "news") lane.news.add(line);
    if (lane.reasons.length > REASONS_MAX) {
      for (const dropped of lane.reasons.splice(0, lane.reasons.length - REASONS_MAX)) {
        lane.counts.delete(dropped);
        lane.news.delete(dropped);
      }
    }
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
      this.clearBatch(lane);
    }
  }

  private clearBatch(lane: Lane): void {
    lane.reasons = [];
    lane.counts.clear();
    lane.news.clear();
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
      // What the captain did in its turn is not news to it: the next wake is compared with the facts after it.
      if (lane.lastFacts !== undefined) void this.rebase(laneOrg, lane).catch(() => undefined);
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
    // A queue for a slot, a cap with its question to the owner, or a card for the owner explains it.
    if (this.deps.explained?.(task) !== undefined) return;
    this.wake(`${task} is running, but no agent is working on it`, found.org ?? PRIVATE, "soft");
  }

  /** Sends a lane's batch now, or after the captain's turn there. One send per lane at a time. */
  async fire(org: string): Promise<void> {
    const lane = this.lane(org);
    if (lane.sending !== undefined) return lane.sending;
    const { autonomy } = this.deps;
    if (autonomy.mode() !== "on" || lane.reasons.length === 0) return;
    // Under the day cap the captain is not woken: only the owner's own messages reach it.
    if (autonomy.dayCapped()) {
      this.clearBatch(lane);
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
      this.clearBatch(lane);
      return;
    }
    if (this.deps.runs.working(chat).length > 0) {
      lane.afterTurn = true;
      return;
    }
    const reasons = lane.reasons.splice(0);
    const counts = new Map(lane.counts);
    const news = new Set(lane.news);
    this.clearBatch(lane);
    if (reasons.length > 0) await this.send(org, chat, reasons, lane, counts, news);
  }

  /**
   * The digest input for a lane's workspace. `undefined` when the captain has no boss agent. Sizes
   * are rated first only when `fill` is set (a tick), not for a look at the facts.
   */
  private async build(
    org: string,
    reasons: string[],
    fill: boolean,
  ): Promise<{ input: DigestInput; boss: string } | undefined> {
    const { autonomy } = this.deps;
    const status = await autonomy.status();
    const boss = status.boss?.id;
    if (boss === undefined) return undefined;
    const inOrg = (o: string | undefined) => (o ?? PRIVATE) === org;
    const workspace = status.lanes.find((l) => l.org === org)?.name ?? org;
    // Sizes not known yet are rated first, so the size rule and the digest can use them.
    const pick = await autonomy.pickable(fill ? SIZE_FILL_MS : 0, org);
    const tasksOf = new Map(status.now.map((t) => [t.task, t.org]));
    const input: DigestInput = {
      workspace,
      now: this.now(),
      tz: status.spend.tz,
      reasons,
      // The day total is a count the lanes share; per workspace, only this one's.
      spend: { ...status.spend, orgs: status.spend.orgs.filter((o) => o.org === org) },
      holds: status.holds.filter((h) => h.kind === "day-cap" || (h.kind === "org-cap" && h.id === org)),
      accounts: status.accounts.filter((a) => a.org === org || a.org === PRIVATE),
      instructions: status.settings.instructions.filter((i) => i.org === undefined || i.org === org),
      tasks: status.now.filter((t) => inOrg(t.org)),
      cards: autonomy.answerable(org),
      waiting: status.waiting.filter((w) =>
        inOrg(tasksOf.get(w.task) ?? this.deps.store.tasks.get(w.task)?.org),
      ),
      backlog: pick.backlog,
      leftOut: pick.leftOut,
      rules: pick.rules,
      queue: status.queue.filter((q) => inOrg(q.org)),
      projects: this.deps.projectLines?.(org) ?? [],
      accountStatus: Object.fromEntries(status.accounts.map((a) => [a.id, a.status])),
      findings: this.deps.findingLines?.(org) ?? [],
      incidents: this.deps.incidentLines?.(org) ?? [],
      ...this.deskTasks(org, new Set(status.now.map((t) => t.task))),
      secretRequests: this.secretLines(org),
      starts: authorityOf(status.settings, org).start === "decide",
      machine: machineOf(autonomy),
    };
    return { input, boss };
  }

  /** Pending secret requests of the workspace's tasks, one line each, oldest first. */
  private secretLines(org: string): string[] {
    try {
      return this.deps.store.room
        .waitingDecisions()
        .flatMap((item) =>
          item.type === "secret-request" && (this.deps.store.tasks.get(item.task)?.org ?? PRIVATE) === org
            ? [`${item.task} item ${item.id}: @${item.agent} asks for ${item.label} (as secret:${item.name})`]
            : [],
        );
    } catch {
      return [];
    }
  }

  /** The workspace's tasks in review and paused that the digest's own task list does not show. */
  private deskTasks(org: string, listed: ReadonlySet<string>): { review: string[]; paused: string[] } {
    let all: ReturnType<Store["tasks"]["list"]>;
    try {
      all = this.deps.store.tasks.list(true);
    } catch {
      return { review: [], paused: [] };
    }
    const mine = all.filter((t) => t.kind !== "chat" && (t.org ?? PRIVATE) === org);
    return {
      review: mine.filter((t) => t.status === "review").map((t) => `${t.id} ${t.title}`),
      paused: mine
        .filter((t) => t.status === "paused" && !listed.has(t.id))
        .map((t) => {
          const owner = t.pausedBy === undefined && (t.pausedReason ?? "owner") === "owner";
          return `${t.id} ${t.title} (${pauseWhy(t)}${owner ? ": the owner's, leave it paused" : ""})`;
        }),
    };
  }

  /** After the captain's turn in a lane: the facts as they stand now are what it has seen. */
  private async rebase(org: string, lane: Lane): Promise<void> {
    if (this.deps.autonomy.mode() !== "on") return;
    const built = await this.build(org, [], false);
    if (built === undefined) return;
    const after = factsKey(built.input);
    lane.lastFacts = after;
  }

  private async send(
    org: string,
    chat: string,
    reasons: string[],
    lane: Lane,
    counts: ReadonlyMap<string, number>,
    news: ReadonlySet<string>,
  ): Promise<void> {
    const { autonomy } = this.deps;
    const shown = reasons.map((r) => ((counts.get(r) ?? 1) > 1 ? `${r} (x${counts.get(r)})` : r));
    const built = await this.build(org, shown, true);
    if (built === undefined) return;
    const { boss } = built;
    const facts = factsKey(built.input);
    // Nothing changed since the captain's last turn here: no tick. Soft wakes need a baseline to differ from.
    const fresh = [...news].some((line) => !lane.lastNews.has(line));
    const unchanged = lane.lastFacts === undefined ? news.size === 0 : facts === lane.lastFacts && !fresh;
    if (unchanged) {
      autonomy.skipped?.(reasons, org);
      return;
    }
    const text = digest(built.input);
    await this.deps.tasks.tellAgent({
      task: chat,
      agent: boss,
      text,
      settled: "Auto-pilot mode woke the captain",
      by: "majhi",
    });
    lane.lastFacts = facts;
    lane.lastNews = new Set(news);
    autonomy.ticked(reasons, org, chat);
  }

  /** The minute sweep: task changes the watch missed. */
  sweep(): void {
    this.checkTasks();
  }

  private scheduleWatch(): void {
    if (this.watchTimer !== undefined) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.checkTasks();
    }, WATCH_MS);
    this.watchTimer.unref();
  }

  /**
   * A finding appeared or came back in a workspace. The lane of every workspace hears of it, where
   * Start is You too: it files a proposal, and starts nothing.
   */
  findingNews(org: string, line: string): void {
    this.wake(line, org, "news");
  }

  /** Writes a `task` event for each autonomous task that changed status, and wakes its lane for the ones it should see. */
  checkTasks(): void {
    let ids: Set<string>;
    let all: ReturnType<Store["tasks"]["list"]>;
    try {
      ids = new Set(this.deps.autonomy.repo.tasks().map((r) => r.task));
      all = this.deps.store.tasks.list(true);
    } catch {
      // The database closed under a shutdown.
      return;
    }
    for (const t of all) {
      if (t.kind === "chat") continue;
      if (!ids.has(t.id)) {
        this.watchOther(t);
        continue;
      }
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
      if (change.wake) this.wake(change.wakeText, t.org ?? PRIVATE);
    }
    this.learned = true;
  }

  /**
   * A task the captain did not start: one that is new to the backlog, or reached review, is news to
   * the lane of its workspace. It is how a lane where Start is You hears of ship and review, and how
   * a lane that starts work hears of new backlog without an hourly check. The first look only learns.
   */
  private watchOther(t: Pick<Task, "id" | "title" | "status" | "org" | "pausedReason" | "pausedBy">): void {
    const before = this.others.get(t.id);
    this.others.set(t.id, t.status);
    if (before === undefined || before === t.status) {
      if (before === undefined && this.learned && (t.status === "inbox" || t.status === "ready")) {
        this.backlogNews(t.org ?? PRIVATE, `New in the backlog: ${t.id} ${t.title}`);
      }
      return;
    }
    // Review and a stuck pause of any task of the workspace are the captain's to look at, whoever started it.
    const org = t.org ?? PRIVATE;
    if (t.status === "review") this.wake(`${t.id} is ready for review: ${t.title}`, org, "news");
    else if (t.status === "paused") {
      const change = changeOf(t);
      if (change?.wake === true) this.wake(change.wakeText, org, "news");
    }
  }

  /**
   * A new backlog task is news where the captain decides when work starts, unless the captain is in
   * its turn there (it made the task, or sees it in the digest it was given).
   */
  private backlogNews(org: string, line: string): void {
    const generation = this.generation;
    void this.deps.autonomy
      .runsOrgs()
      .then((orgs) => {
        if (generation !== this.generation || !orgs.includes(org)) return;
        const chat = this.deps.autonomy.laneChats().find((c) => this.deps.autonomy.laneOrg(c) === org);
        if (chat !== undefined && this.deps.runs.working(chat).length > 0) return;
        this.wake(line, org, "news");
      })
      .catch(() => undefined);
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

/** Why a task paused, in words for the log. The owner is named only when the owner did it. */
function pauseWhy(t: Pick<Task, "pausedReason" | "pausedBy">): string {
  if (t.pausedBy === "autonomy-off") return "because Auto-pilot was turned off";
  if (t.pausedBy === "captain") return "by Captain";
  switch (t.pausedReason ?? "owner") {
    case "owner":
      return "by you";
    case "error":
      return "because the agent hit an error";
    case "loop":
      return "because the agent was going in circles";
    case "blocked":
      return "because it is blocked";
    case "limit":
      return "because an account limit was reached";
    case "offline":
      return "because the agent went offline";
    default:
      return "because the agent signed out";
  }
}

/**
 * What a status change says, and whether the captain should look now. `text` is for the log, in
 * plain words with the title; `wakeText` is for the lane agent and names the task by id.
 */
export function changeOf(
  t: Pick<Task, "id" | "title" | "status" | "pausedReason" | "pausedBy">,
): { text: string; wakeText: string; wake: boolean } | undefined {
  const title = `'${t.title}'`;
  switch (t.status) {
    case "review":
      return {
        text: `${title} is ready for review`,
        wakeText: `${t.id} is ready for review: ${t.title}`,
        wake: true,
      };
    case "mr":
      return {
        text: `${title} has a merge request open`,
        wakeText: `${t.id} has a merge request open: ${t.title}`,
        wake: true,
      };
    case "done":
      return { text: `${title} is done`, wakeText: `${t.id} is done: ${t.title}`, wake: true };
    case "running":
      return { text: `Started ${title}`, wakeText: `${t.id} is running: ${t.title}`, wake: false };
    case "paused": {
      const reason = t.pausedReason ?? "owner";
      // A pause the owner made is not news; a stuck, failing or limited run is, for the captain to resume or explain.
      const stuck = reason !== "owner" && t.pausedBy !== "captain" && t.pausedBy !== "autonomy-off";
      return {
        text: `Paused ${title} ${pauseWhy(t)}`,
        wakeText: `${t.id} paused (${t.pausedBy === undefined ? reason : "by the system"}): ${t.title}`,
        wake: stuck,
      };
    }
    default:
      return undefined;
  }
}

function machineOf(autonomy: AutonomyService): DigestInput["machine"] {
  const line = autonomy.machineLine();
  return line === undefined ? undefined : { line, busy: autonomy.machineBusy() };
}
