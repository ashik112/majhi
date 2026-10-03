import { randomBytes, randomUUID } from "node:crypto";
import {
  type AccountView,
  type AutonomyAccount,
  AutonomyAnswerInputSchema,
  type AutonomyBacklogItem,
  type AutonomyEvent,
  type AutonomyHold,
  type AutonomyInstruction,
  type AutonomyLane,
  type AutonomyMode,
  AutonomyNoteInputSchema,
  type AutonomyNow,
  type AutonomyPatch,
  AutonomyPlanInputSchema,
  type AutonomySettings,
  type AutonomySpend,
  type AutonomyStatus,
  type AutonomySummary,
  type AutonomyWaiting,
  type Budget,
  type CapUse,
  type CommandMeta,
  type CommandName,
  commands,
  detectSecrets,
  type GitLoginsResult,
  isCaptainLane,
  PRIVATE,
  type RoomItem,
  type Spend,
  type Task,
  type TaskId,
  ToolIdSchema,
} from "@majhi/shared";
import type { z } from "zod";
import { redact, redactText } from "../admin/policy.ts";
import type { LaneReads } from "../admin/service.ts";
import { summarize } from "../admin/summary.ts";
import type { AdminCaller } from "../admin/tokens.ts";
import type { AgentStore } from "../agents/store.ts";
import { forceOrg, narrow, readRefusal, type ScopeWorld } from "../captain/lane-scope.ts";
import type { Lanes } from "../captain/lanes.ts";
import { levelOf, workspaceIds } from "../captain/levels.ts";
import { presenceWhy, restWhy } from "../captain/rules.ts";
import type { ConfigSections } from "../config/sections.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import { captainAnsweredLine } from "../tasks/cards.ts";
import type { TaskService } from "../tasks/service.ts";
import { addDays, dayStart, defaultTimeZone, localDay } from "../usage/ranges.ts";
import { describePatch, mergePatch, toFile } from "./configure.ts";
import { type AnswerableCard, answerableText, type BacklogTask, backlogOrder } from "./digest.ts";
import {
  callOrg,
  connectionOwner,
  hardLimit,
  type LimitAgent,
  type LimitWorld,
  type OrgLookup,
  textLimit,
} from "./limits.ts";
import { leftOutWhy, levelProblem, type OrgNames, orgName, pickLines } from "./pick.ts";
import { type AutonomyVerdict, decideAutonomously, startsWork } from "./policy.ts";
import { AutonomyRepo, type HeldReason, STOPPED_NOW } from "./repo.ts";
import { type SizeOf, type SizeRater, sizeProblem, TaskSizes } from "./sizes.ts";
import {
  accountsOf,
  capHoldFor,
  capPassed,
  capScope,
  dayWindow,
  diffHolds,
  holdCovering,
  holdsOf,
  spendOf,
} from "./spend.ts";
import { buildSummary, summaryLine } from "./summary.ts";

/** Who the pause is credited to: the labels read "Paused when Autonomous was turned off". */
const OFF_BY = "autonomy-off";

const OFF_WHY =
  "Autonomous was turned off, so this task paused. Resume it, or turn Autonomous on and resume the tasks it paused.";

/** How often holds, a graceful stop and the driver's clock are checked. */
export const SWEEP_MS = 60_000;

export interface AutonomyDeps {
  store: Store;
  config: ConfigService;
  tasks: TaskService;
  runs: RunManager;
  room: RoomService;
  accounts: { list(): Promise<AccountView[]> };
  agents: AgentStore;
  events: EventHub;
  /** This computer's git logins, to tell whose a gh or glab login is. */
  gitLogins?: { list(refresh?: boolean): Promise<GitLoginsResult> };
  /** Tells the owner the daily summary is ready (notify kind `autonomy`). */
  notify?: (summary: AutonomySummary, line: string) => void;
  /** The kind of action a schedule or trigger has now, for an update that leaves it as it is. */
  automationAction?: (kind: "schedule" | "trigger", id: string) => string | undefined;
  /** Rates how much work a task is (the decision provider), for the size rule. */
  rateSize?: SizeRater;
  /** The captain's lanes (5.18): autonomous mode wakes the captain in each "Runs it" workspace's own. */
  lanes: Lanes;
  /** When the owner last acted in a task: the captain keeps out for 10 minutes. */
  ownerAt?: (task: string) => string | undefined;
  now?: () => Date;
}

/** What the service tells the driver (part B, `driver.ts`). */
export interface DriverHooks {
  /** For one workspace, or every "Runs it" workspace when `org` is absent. */
  wake(line: string, org?: string): void;
  onMode(mode: AutonomyMode): void;
  loopEnded(task: string): void;
  sweep(): void;
  start(): void;
  close(): void;
}

/** Who acts for autonomous mode: the captain in its autonomy chat, or an agent of an autonomous task. */
export type AutonomyCaller = "boss" | "agent";

/** Today's numbers, read once for the status and the holds. */
interface Measure {
  settings: AutonomySettings;
  spend: AutonomySpend;
  accounts: AutonomyAccount[];
  names: Record<string, string>;
}

/** A command's result for an agent. */
export interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * Autonomous mode (PRV-74): its state machine (off, on, paused, stopping), the tasks it runs, the
 * run gate, spend and holds, the self-approval of cards within limits, the hard limits, the feed and
 * the owner's settings. The rules are in docs/PROGRESS.md under PRV-74.
 */
export class AutonomyService {
  readonly repo: AutonomyRepo;
  /** Each backlog task's size, for the pick rules. */
  readonly sizes: TaskSizes;
  /** Sizes are being rated in the background for the page. */
  private filling = false;
  private holds: AutonomyHold[];
  private holdsQueue: Promise<unknown> = Promise.resolve();
  private finishing = false;
  /** Stop now is stopping tasks one by one: the graceful finish stays out of it. */
  private stoppingNow = false;
  private sweep: NodeJS.Timeout | undefined;
  /** Wakes the captain with ticks, and hears every mode change. */
  private driver: DriverHooks | undefined;

  constructor(private readonly deps: AutonomyDeps) {
    this.repo = new AutonomyRepo(deps.store.raw);
    this.sizes = new TaskSizes(deps.store.raw, deps.rateSize, () => this.now());
    this.holds = this.repo.state().holds;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  mode(): AutonomyMode {
    return this.repo.state().mode;
  }

  /** The autonomy chat from before lanes, when it is still there. Readable; nothing wakes it. */
  chat(): string | undefined {
    const chat = this.repo.state().chat;
    return chat !== undefined && this.deps.store.tasks.get(chat) !== undefined ? chat : undefined;
  }

  isAutonomous(task: string): boolean {
    return this.repo.isAutonomous(task);
  }

  /** The workspaces set to "Runs it", Private first. */
  async runsOrgs(): Promise<string[]> {
    const [sections, settings] = await Promise.all([
      this.deps.config.sections(),
      this.deps.config.settings(),
    ]);
    return workspaceIds(sections.orgs).filter((org) => levelOf(settings.autonomy, org) === "runs");
  }

  /** The lanes' chats that exist now. */
  laneChats(): string[] {
    return this.deps.lanes.all().map((l) => l.chat);
  }

  /** The workspace of a lane's chat. */
  laneOrg(task: string): string | undefined {
    return this.deps.lanes.orgOf(task);
  }

  /**
   * The lane a tick goes to, while the mode is on and the workspace is set to "Runs it". When the
   * lane's chat was removed or closed, majhi makes or reopens it first and says so in the feed.
   * Undefined: the mode is not on, the workspace does not run, or there is no captain.
   */
  async laneChat(org: string): Promise<string | undefined> {
    if (this.repo.state().mode !== "on") return undefined;
    if (!(await this.runsOrgs()).includes(org)) return undefined;
    // Outside the workspace's hours or on a freeze date the captain is not woken there.
    const settings = (await this.deps.config.settings()).autonomy;
    const rules = settings.orgs[org];
    if (restWhy(rules, this.now(), zoneOr(rules?.tz ?? settings.tz)) !== undefined) return undefined;
    const before = this.deps.lanes.chat(org);
    const found = before === undefined ? undefined : this.deps.store.tasks.get(before);
    const boss = await this.bossId();
    if (boss === undefined) return undefined;
    if (found !== undefined && found.status !== "done" && found.team[0] === boss) return found.id;
    try {
      const chat = await this.deps.lanes.ensure(org);
      const name = await this.orgName(org);
      this.event({
        kind: "mode",
        text:
          found === undefined
            ? `The captain works in ${name} in its lane ${chat.id}`
            : found.status === "done"
              ? `Reopened the captain's lane in ${name}, ${chat.id}: it was closed`
              : `The captain works in ${name} in a new lane, ${chat.id}: ${found.id} belongs to another captain`,
        ...(org === PRIVATE ? {} : { org }),
      });
      return chat.id;
    } catch {
      return undefined;
    }
  }

  private async orgName(org: string): Promise<string> {
    if (org === PRIVATE) return "Private";
    return (await this.deps.config.sections()).orgs[org]?.name ?? org;
  }

  /**
   * The owner closes or removes a task: while the mode is not off, a lane of the captain stays,
   * because autonomous mode wakes the captain there. Off, it may go; the next tick makes a new one.
   */
  guardChat(task: Pick<Task, "id" | "kind" | "brief">, action: "close" | "remove"): void {
    let mode: AutonomyMode;
    let lane: string | undefined;
    try {
      mode = this.repo.state().mode;
      lane = this.deps.lanes.orgOf(task.id);
    } catch {
      // The database closed under a shutdown.
      return;
    }
    if (mode === "off" || lane === undefined || !isCaptainLane(task)) return;
    throw new UserError(
      `${task.id} is the captain's lane autonomous mode works in, so it cannot be ${action === "close" ? "closed" : "removed"} while autonomous mode is ${mode}. Stop autonomous mode first; the next start makes a new lane.`,
      409,
    );
  }

  useDriver(driver: DriverHooks): void {
    this.driver = driver;
  }

  /** A line on why the captain should look again: it goes into the next tick of that workspace's lane, or every lane. */
  private wake(line: string, org?: string): void {
    this.driver?.wake(line, org);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** After a restart: in `on`, the captain is woken once; in `stopping`, the stop finishes. */
  async boot(): Promise<void> {
    const { mode } = this.repo.state();
    if (mode === "stopping") await this.maybeFinishStop();
    else if (mode !== "off") await this.refreshHolds();
    if (mode === "on") this.wake("majhi restarted");
  }

  startSweep(): void {
    if (this.sweep !== undefined) return;
    this.driver?.start();
    this.sweep = setInterval(() => void this.sweepNow().catch(() => undefined), SWEEP_MS);
    this.sweep.unref();
  }

  close(): void {
    if (this.sweep !== undefined) clearInterval(this.sweep);
    this.sweep = undefined;
    this.driver?.close();
  }

  /**
   * The minute sweep: the day's end, a window's reset and a graceful stop are noticed here, and
   * the driver's heartbeat and the daily summary are due here.
   */
  async sweepNow(): Promise<void> {
    await this.noteCaps();
    const { mode } = this.repo.state();
    if (mode !== "off") await this.refreshHolds();
    if (mode === "stopping") await this.maybeFinishStop();
    this.driver?.sweep();
    await this.dailySummary();
  }

  /** A turn was recorded: an autonomous one may have reached a cap. */
  async afterTurn(turn: { task: string }): Promise<void> {
    if (this.repo.state().mode === "off") return;
    if (this.laneOrg(turn.task) === undefined && !this.repo.isAutonomous(turn.task)) return;
    await this.refreshHolds();
  }

  /** A run's loop ended: a graceful stop may finish now. Never throws into the run loop. */
  loopEnded(task: string): void {
    try {
      this.driver?.loopEnded(task);
      const state = this.repo.state();
      if (state.mode !== "stopping") return;
      if (this.laneOrg(task) === undefined && !this.repo.isAutonomous(task)) return;
      void this.maybeFinishStop().catch(() => undefined);
    } catch {
      // The database closed under a shutdown: nothing to finish.
    }
  }

  // ---------------------------------------------------------------------------
  // The mode (rule 1)

  /** Turn on, or resume when paused or stopping. Refused without a captain. */
  async start(resumeStopped = false): Promise<AutonomyStatus> {
    const { mode } = this.repo.state();
    if (mode === "on") return this.status();
    if ((await this.bossId()) === undefined) {
      throw new UserError(
        "There is no captain yet. Make a root agent the captain first, then turn Autonomous on.",
        409,
      );
    }
    if (mode === "off") {
      // Holds from an earlier run are news again.
      this.repo.setHolds([]);
      this.holds = [];
      this.setMode(
        "on",
        "owner",
        "Turned on",
        "Autonomous mode is on. The captain picks the work from here.",
      );
      // The tasks Stop now paused restart only when the owner asks; else they stay the owner's.
      for (const row of this.repo.tasks()) {
        if (row.held !== "owner" || row.heldScope !== STOPPED_NOW) continue;
        if (resumeStopped) await this.resumeTask(row.task, "autonomous mode turned on");
        else this.repo.release(row.task);
      }
      await this.refreshHolds();
      this.wake("Autonomous mode turned on");
      return this.status();
    }
    this.setMode("on", "owner", "Resumed", "Autonomous mode resumed.");
    for (const row of this.repo.tasks()) {
      if (row.held === "owner") await this.resumeTask(row.task, "autonomous mode resumed");
    }
    await this.refreshHolds();
    await this.liftCaps();
    this.wake("Autonomous mode resumed");
    return this.status();
  }

  /**
   * Pause was a state of its own. It is gone from the owner's switch (On or Off): the old command
   * turns Autonomous off and pauses its tasks, the nearest thing to what it did.
   */
  async pause(): Promise<AutonomyStatus> {
    return this.stop("now");
  }

  async stop(how: "now" | "graceful"): Promise<AutonomyStatus> {
    const { mode } = this.repo.state();
    if (mode === "off") return this.status();
    if (how === "now") {
      await this.stopNow();
      return this.status();
    }
    if (mode !== "stopping") {
      this.setMode(
        "stopping",
        "owner",
        "Stopping after the current turns",
        "Autonomous mode is stopping. Current turns finish, and nothing new starts.",
      );
      await this.deps.runs.pauseLimited();
    }
    await this.maybeFinishStop();
    return this.status();
  }

  /** Stop now: every autonomous task with a live run stops, and the captain's turn ends. */
  private async stopNow(why = OFF_WHY): Promise<void> {
    this.stoppingNow = true;
    try {
      await this.stopEachNow(why);
    } finally {
      this.stoppingNow = false;
    }
  }

  private async stopEachNow(why: string): Promise<void> {
    // Held at every boundary while the runs stop; the event comes once, for `off`.
    this.repo.setMode("stopping", this.now().toISOString(), "owner", undefined);
    // The captain first, in every lane, so it calls no more tools while its tasks stop.
    for (const chat of this.laneChats()) await this.deps.tasks.cancel(chat, undefined).catch(() => undefined);
    const stopped: string[] = [];
    for (const task of this.openTasks()) {
      // A task in review can still have a turn in flight.
      if (!this.stoppable(task) && !this.deps.runs.inTurn(task.id)) continue;
      const done = await this.deps.tasks.stop(task.id, "owner", why, OFF_BY).catch(() => undefined);
      if (done?.status === "paused") stopped.push(task.id);
    }
    this.repo.releaseAll();
    // Remembered, so turning on again can resume exactly these.
    for (const id of stopped) this.repo.hold(id, "owner", STOPPED_NOW);
    this.setMode("off", "owner", "Turned off", "Autonomous is off. The tasks it started are paused.");
  }

  /** Stop gracefully: once no autonomous run is in a turn, majhi turns the mode off. */
  private async maybeFinishStop(): Promise<void> {
    // Stop now holds the mode at stopping while it stops each task itself: a second stop would race it.
    if (this.finishing || this.stoppingNow || this.repo.state().mode !== "stopping") return;
    const ids = [...this.openTasks().map((t) => t.id), ...this.laneChats()];
    if (ids.some((id) => this.deps.runs.inTurn(id))) return;
    this.finishing = true;
    try {
      // Nothing is in a turn: tasks that would wake again (a process, a handoff) stop for the owner.
      const stopped: string[] = [];
      for (const task of this.openTasks()) {
        if (!this.stoppable(task)) continue;
        const done = await this.deps.tasks.stop(task.id, "owner", OFF_WHY, OFF_BY).catch(() => undefined);
        if (done?.status === "paused") stopped.push(task.id);
      }
      this.repo.releaseAll();
      if (this.repo.state().mode !== "stopping") return;
      // Remembered like a stop at once, so turning on again can resume exactly these.
      for (const id of stopped) this.repo.hold(id, "owner", STOPPED_NOW);
      const why = "turned off after the current turns";
      this.setMode(
        "off",
        "majhi",
        "Turned off after the current turns",
        "Autonomous is off. The tasks it started finished their step and are paused.",
        why,
      );
    } finally {
      this.finishing = false;
    }
  }

  /** A task the stop leaves paused for the owner: one that runs, or would resume by itself. */
  private stoppable(task: Task): boolean {
    if (task.status === "running") return true;
    return task.status === "paused" && ["offline", "limit", "owner"].includes(task.pausedReason ?? "");
  }

  private setMode(mode: AutonomyMode, by: "owner" | "majhi", text: string, line: string, why?: string): void {
    this.repo.setMode(mode, this.now().toISOString(), by, why);
    if (mode === "off") this.holds = [];
    this.event({ kind: "mode", text, ...(why === undefined ? {} : { reason: why }) });
    this.say(line);
    this.driver?.onMode(mode);
  }

  /** The captain's id, when it is set and its agent file is good. */
  private async bossId(): Promise<string | undefined> {
    const { boss } = await this.deps.config.sections();
    if (boss === undefined) return undefined;
    const stored = await this.deps.agents.get(boss);
    return stored?.ok === true ? boss : undefined;
  }

  // ---------------------------------------------------------------------------
  // The run gate (rule 7)

  /**
   * Asked between turns of every run: `owner` while the mode is paused or stopping, `limit` under a
   * cap. Records the hold, so Resume and a lifted cap restart exactly these tasks.
   */
  async held(task: string): Promise<{ reason: "owner" | "limit"; why: string } | undefined> {
    try {
      const hold = this.holdFor(task);
      if (hold === undefined) return undefined;
      this.repo.hold(task, hold.reason, hold.scope);
      return { reason: hold.reason, why: hold.why };
    } catch {
      // The database closed under a shutdown: the run stops anyway.
      return undefined;
    }
  }

  /**
   * The run gate inside a turn (rule 7): a line when the day's spend, with what this turn of an
   * autonomous task spent so far, passed the day cap or its workspace's cap by more than
   * `CAP_MARGIN`. Records the hold, so the cap lifting restarts the task. Never throws.
   */
  async overCap(task: string, turnCostUsd: number): Promise<string | undefined> {
    try {
      if (this.repo.state().mode !== "on" || !this.repo.isAutonomous(task)) return undefined;
      const [all, sections] = await Promise.all([this.deps.config.settings(), this.deps.config.sections()]);
      const settings = all.autonomy;
      const tz = zoneOr(settings.tz);
      const window = dayWindow(this.now(), tz);
      const spend = spendOf(
        this.repo.spendRows(window.start, window.end, this.spendChats()),
        settings,
        window,
        tz,
      );
      const names = Object.fromEntries(Object.entries(sections.orgs).map(([id, o]) => [id, o.name]));
      const passed = capPassed(spend, this.deps.store.tasks.get(task)?.org ?? PRIVATE, turnCostUsd, names);
      if (passed === undefined) return undefined;
      this.repo.hold(task, "limit", passed.scope);
      return `${passed.text}, so this agent stopped in the middle of its turn. It continues when the cap lifts.`;
    } catch {
      // The database closed under a shutdown: the run stops anyway.
      return undefined;
    }
  }

  /** What holds the task's runs now, without recording it. */
  holdFor(task: string): { reason: HeldReason; why: string; scope?: string } | undefined {
    const { mode, since } = this.repo.state();
    if (mode === "off") return undefined;
    const row = this.repo.task(task);
    if (row === undefined) return undefined;
    // The owner resumed it by hand during this pause or stop: it runs, until the mode changes again.
    const resumed = row.resumedAt !== undefined && since !== undefined && row.resumedAt >= since;
    if (mode === "stopping" && resumed) return undefined;
    if (mode === "stopping") {
      return { reason: "owner", why: "Autonomous mode is stopping, so this agent starts nothing new." };
    }
    const org = this.deps.store.tasks.get(task)?.org ?? PRIVATE;
    const cap = capHoldFor(this.holds, org);
    if (cap === undefined) return undefined;
    return {
      reason: "limit",
      why: `${cap.text}, so this agent waits. It continues when the cap lifts.`,
      scope: capScope(cap),
    };
  }

  /**
   * The owner resumed an autonomous task by hand (like the budget gate's owner resume): it leaves
   * the held set, so the next Resume does not start it again, and while the mode stays paused or
   * stopping the gate lets it run. The next pause holds it again.
   */
  ownerResumed(task: string): void {
    try {
      if (this.repo.isAutonomous(task)) this.repo.ownerResumed(task, this.now().toISOString());
    } catch {
      // The database closed under a shutdown.
    }
  }

  /** The owner stopped or resumed the task by hand: autonomous mode no longer restarts it. */
  forgetHold(task: string): void {
    this.repo.release(task);
  }

  /** Restarts a task the gate held: its held runs go on, and a paused task runs again. */
  private async resumeTask(id: string, why: string): Promise<void> {
    this.repo.release(id);
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || task.status === "done") return;
    const resumed = this.deps.runs.resumeHeld(id, why);
    const paused =
      task.status === "paused" && (task.pausedReason === "owner" || task.pausedReason === "limit");
    if (!paused && resumed === 0) return;
    if (paused) {
      try {
        await this.deps.tasks.start(id, "autonomy");
      } catch (err) {
        this.event({
          kind: "task",
          text: `${id} could not resume: ${errorMessage(err)}`,
          task: id,
          ...orgOf(task),
        });
        return;
      }
    }
    // After a restart the held prompts are gone, so the lead is told to go on.
    const lead = task.team[0];
    if (resumed === 0 && lead !== undefined && this.deps.runs.working(id).length === 0) {
      this.deps.runs.notify(id, lead, "Autonomous mode resumed this task. Continue from where you stopped.");
    }
    this.event({ kind: "task", text: `${id} resumed: ${why}`, task: id, ...orgOf(task) });
  }

  // ---------------------------------------------------------------------------
  // Spend and holds (rule 6)

  private async measure(): Promise<Measure> {
    const [all, sections, views] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
      this.deps.accounts.list().catch(() => [] as AccountView[]),
    ]);
    const settings = all.autonomy;
    const tz = zoneOr(settings.tz);
    const now = this.now();
    const window = dayWindow(now, tz);
    const rows = this.repo.spendRows(window.start, window.end, this.spendChats());
    return {
      settings,
      spend: spendOf(rows, settings, window, tz),
      accounts: accountsOf(views, settings.floors, now),
      names: Object.fromEntries(Object.entries(sections.orgs).map(([id, o]) => [id, o.name])),
    };
  }

  /**
   * Recomputes what holds new work. A hold that starts or lifts writes a `cap` event and wakes the
   * captain; a cap that starts holds runs at their next boundary, one that lifts restarts what it held.
   * One at a time, so two callers never write the same event twice.
   */
  refreshHolds(measured?: Measure): Promise<AutonomyHold[]> {
    const next = this.holdsQueue.then(() => this.recomputeHolds(measured));
    this.holdsQueue = next.catch(() => undefined);
    return next;
  }

  private async recomputeHolds(measured?: Measure): Promise<AutonomyHold[]> {
    const state = this.repo.state();
    if (state.mode === "off") {
      this.holds = [];
      return [];
    }
    const m = measured ?? (await this.measure());
    const holds = holdsOf(m.spend, m.accounts, m.names);
    this.holds = holds;
    const { started, lifted } = diffHolds(state.holds, holds);
    if (started.length === 0 && lifted.length === 0) return holds;
    this.repo.setHolds(holds);
    for (const h of started) {
      this.event({ kind: "cap", text: `${h.text}. No new work starts there until it lifts.`, ...holdOrg(h) });
    }
    for (const h of lifted)
      this.event({ kind: "cap", text: `No longer held: ${lowerFirst(h.text)}.`, ...holdOrg(h) });
    if (started.some((h) => h.kind !== "account")) await this.deps.runs.pauseLimited();
    if (lifted.some((h) => h.kind !== "account")) await this.liftCaps();
    const first = started[0] ?? lifted[0];
    if (first !== undefined) {
      const org = holdOrg(first).org;
      this.wake(started.length > 0 ? `${first.text}` : `No longer held: ${lowerFirst(first.text)}`, org);
    }
    return holds;
  }

  /** Restarts the tasks a cap held once no cap holds their org. Only while the mode is on. */
  private async liftCaps(): Promise<void> {
    if (this.repo.state().mode !== "on") return;
    for (const row of this.repo.tasks()) {
      if (row.held !== "limit") continue;
      const org = this.deps.store.tasks.get(row.task)?.org ?? PRIVATE;
      if (capHoldFor(this.holds, org) !== undefined) continue;
      await this.resumeTask(row.task, "the cap that held it lifted");
    }
  }

  // ---------------------------------------------------------------------------
  // Calls of the captain and of autonomous tasks' agents (rules 2, 4, 5)

  /** Whether this caller acts for autonomous mode. Checked in every mode, for the hard limits. */
  async callerKind(caller: AdminCaller): Promise<AutonomyCaller | undefined> {
    const { chat } = this.repo.state();
    // The captain in a lane, or in the autonomy chat from before lanes. An agent it brought into
    // either acts for autonomous mode too, with none of the captain's tools.
    if (this.laneOrg(caller.task) !== undefined || (chat !== undefined && caller.task === chat)) {
      return caller.agent === (await this.bossId()) ? "boss" : "agent";
    }
    return this.repo.isAutonomous(caller.task) ? "agent" : undefined;
  }

  /** The hard limit the call breaks, if any (rule 5). A refusal writes a `refused` event. */
  async refusal(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<string | undefined> {
    const call = { command, input, reason };
    // A read passes nothing between orgs: only the text limits apply, and no org's files are read.
    // In a lane a read still stays in the lane's workspace: another workspace's task or project is refused.
    const read = commands[command].risk === "read";
    const lane = this.laneOrg(caller.task);
    const ctx = read && lane === undefined ? undefined : await this.context(caller, command, input);
    const world = ctx?.world;
    const why =
      world === undefined
        ? textLimit(call)
        : read
          ? (textLimit(call) ?? (await this.laneRefusal(lane, world.org)))
          : (hardLimit(call, world) ??
            (await this.laneRefusal(lane, world.org)) ??
            (await this.pickRefusal(caller, command, input, world.org, ctx)));
    if (why === undefined) return undefined;
    this.event({
      kind: "refused",
      text: `${summarize(command, input)}: ${why.replace(/^Refused: /, "")}`,
      ...(reason === "" ? {} : { reason }),
      task: caller.task,
      agent: caller.agent,
      command,
      outcome: "refused",
      ...(world === undefined ? this.orgOfTask(caller.task) : { org: world.org }),
    });
    return why;
  }

  /**
   * What a captain lane may read (5.18): reads that ask about another workspace are refused, `org`
   * filters are set to the lane's, and rows of other workspaces are taken out of every output.
   * Undefined when the task is no lane.
   */
  async laneScope(task: string): Promise<LaneReads | undefined> {
    const lane = this.laneOrg(task);
    if (lane === undefined) return undefined;
    const sections = await this.deps.config.sections();
    const agents = new Map<string, string>();
    for (const a of await this.deps.agents.list()) {
      if (a.ok && a.agent.frontmatter.scope !== "root") agents.set(a.id, a.agent.frontmatter.scope);
    }
    const world: ScopeWorld = {
      orgs: new Set(workspaceIds(sections.orgs)),
      task: (id) => {
        const t = this.deps.store.tasks.get(id);
        return t === undefined ? undefined : (t.org ?? PRIVATE);
      },
      project: (id) => sections.projects[id]?.org,
      account: (id) => sections.accounts[id]?.org,
      agent: (id) => agents.get(id),
      names: new Map(Object.entries(sections.orgs).map(([id, o]) => [id, o.name])),
    };
    const name = (org: string) => (org === PRIVATE ? "Private" : (sections.orgs[org]?.name ?? org));
    return {
      refusal: (input) => readRefusal(lane, input, world, name),
      input: (command, input) => forceOrg(command, input, lane),
      output: (value) => narrow(value, lane, world, name),
    };
  }

  /**
   * A lane works in its own workspace only (5.18): a call that acts in, or reads, another workspace's
   * tasks or projects is refused, so one workspace's content never reaches another's lane.
   */
  private async laneRefusal(lane: string | undefined, org: string): Promise<string | undefined> {
    if (lane === undefined || org === lane) return undefined;
    return `Refused: this lane works in ${await this.orgName(lane)} only, and the call is about ${await this.orgName(org)}. Each workspace has its own lane.`;
  }

  /**
   * The owner's pick rules (PRV-74 follow-up, 5.18), for the captain and the agents in its lanes: no
   * call that touches a task marked Not for autonomous mode, no task work in a workspace that is not
   * set to "Runs it" with the mode on, and no start of a task larger than the size rule allows.
   */
  private async pickRefusal(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    org: string,
    ctx: { sections: ConfigSections; world: LimitWorld } | undefined,
  ): Promise<string | undefined> {
    const state = this.repo.state();
    const legacy = state.chat !== undefined && caller.task === state.chat;
    if (this.laneOrg(caller.task) === undefined && !legacy) return undefined;
    if (command.startsWith("autonomy.")) return undefined;
    const sections = ctx?.sections ?? (await this.deps.config.sections());
    const settings = (await this.deps.config.settings()).autonomy;
    const { pick } = settings;
    const names = orgNames(sections);
    const group = command.split(".", 1)[0];
    const starts = startsWork(command, input);
    // The task the call is about, and a new task's parent.
    const touched = [targetOf(command, input), str(input.parent), str(input.followUpOf)].flatMap((id) => {
      const t =
        id === undefined || id === state.chat || this.laneOrg(id) !== undefined
          ? undefined
          : this.deps.store.tasks.get(id);
      return t === undefined ? [] : [t];
    });
    const marked = touched.find((t) => t.noAutonomy === true);
    if (marked !== undefined) {
      return `Refused: the owner marked ${marked.id} Not for autonomous mode, so autonomous mode leaves it alone.`;
    }
    if (group === "tasks" || group === "team" || starts) {
      const outside = levelProblem(levelOf(settings, org), state.mode, org, names);
      if (outside !== undefined) return `Refused: ${outside}.`;
    }
    // "More rules": the AI tools the work it starts here may run on.
    const providers = settings.orgs[org]?.providers;
    if (starts && providers !== undefined && ctx !== undefined) {
      const tools = this.teamAccounts(command, input, ctx.world, sections).flatMap(
        (id) => sections.accounts[id]?.tool ?? [],
      );
      const other = tools.find((t) => !providers.includes(t));
      if (other !== undefined) {
        return `Refused: ${orgName(org, names)} lets the captain start work on ${providers.join(", ")} only, and this would run on ${other}.`;
      }
    }
    if (!starts || pick.size === "any") return undefined;
    const big = await this.sizeRefusal(command, input);
    return big === undefined ? undefined : `Refused: ${big}. Pick work the size rule allows.`;
  }

  /** For a call that starts work: why the size rule keeps it from starting. */
  private async sizeRefusal(
    command: CommandName,
    input: Record<string, unknown>,
  ): Promise<string | undefined> {
    const { pick } = (await this.deps.config.settings()).autonomy;
    const existing = (id: string | undefined) =>
      id === undefined ? undefined : this.deps.store.tasks.get(id);
    const check = (label: string, of: SizeOf) => {
      const problem = sizeProblem(pick.size, of);
      return problem === undefined ? undefined : `${label} was not started: ${problem}`;
    };
    if (command === "tasks.start") {
      const task = existing(str(input.id));
      return task === undefined ? undefined : check(task.id, await this.sizes.of(task));
    }
    if (command === "team.add" || command === "tasks.addAgent") {
      const task = existing(str(input.task) ?? str(input.id));
      // An autonomous task passed the rule when it started.
      if (task === undefined || this.repo.isAutonomous(task.id)) return undefined;
      return check(task.id, await this.sizes.of(task));
    }
    const texts =
      command === "tasks.create"
        ? [input]
        : command === "tasks.split" && Array.isArray(input.children)
          ? (input.children as unknown[]).map((c) => (typeof c === "object" && c !== null ? c : {}))
          : [];
    for (const raw of texts as Record<string, unknown>[]) {
      const text = str(raw.text) ?? "";
      const title =
        text
          .split("\n")
          .find((l) => l.trim() !== "")
          ?.trim() ?? "";
      const repos = (Array.isArray(raw.repos) ? raw.repos : []).flatMap((r) => {
        const project =
          typeof r === "object" && r !== null ? str((r as { project?: unknown }).project) : undefined;
        return project === undefined ? [] : [project];
      });
      const of = await this.sizes.rateText({ title, brief: text, kind: "code", repos });
      const problem = check(`"${clip(title, 60)}"`, of);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }

  /** While Autonomous is turning off, calls that start work are refused. */
  blockedStart(command: string, input: Record<string, unknown>): string | undefined {
    const { mode } = this.repo.state();
    if (mode !== "stopping" || !startsWork(command, input)) return undefined;
    return "Autonomous is turning off: nothing new starts.";
  }

  /**
   * While the mode is on, a call that starts work and runs without a card (a saved rule, an `auto`
   * mode, a lead starting its subtasks) still keeps to the caps and floors: the hold's line when one
   * covers it.
   */
  async heldStart(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    raw: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (this.repo.state().mode !== "on" || !startsWork(command, input)) return undefined;
    const { world, sections } = await this.context(caller, command, raw);
    const hold = holdCovering(
      await this.refreshHolds(),
      world.org,
      this.teamAccounts(command, input, world, sections),
    );
    return hold === undefined ? undefined : `Not started: ${hold.text}. It can start when that lifts.`;
  }

  /** Decides a call that would wait for the owner, while the mode is on (rule 4). */
  async decide(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    raw: Record<string, unknown>,
    ask: { confirm: boolean; reason: string },
  ): Promise<AutonomyVerdict> {
    const { world, sections } = await this.context(caller, command, raw);
    const starts = startsWork(command, input);
    const holds = starts ? await this.refreshHolds() : this.holds;
    const settings = (await this.deps.config.settings()).autonomy;
    const org = sections.orgs[world.org];
    return decideAutonomously(
      { command, input, org: world.org, confirm: ask.confirm },
      {
        settings,
        orgMerge: org?.merge,
        holds,
        accounts: starts ? this.teamAccounts(command, input, world, sections) : [],
        refused: hardLimit({ command, input: raw, reason: ask.reason }, world),
        orgName: org?.name,
        automationAction: this.automationAction(command, input),
      },
    );
  }

  /** The action a schedule or trigger has now, for its update. */
  private automationAction(command: string, input: Record<string, unknown>): string | undefined {
    const id = typeof input.id === "string" ? input.id : undefined;
    if (id === undefined) return undefined;
    if (command === "schedules.update") return this.deps.automationAction?.("schedule", id);
    if (command === "triggers.update") return this.deps.automationAction?.("trigger", id);
    return undefined;
  }

  /** The accounts of the agents a work-starting call puts to work. */
  private teamAccounts(
    command: string,
    input: Record<string, unknown>,
    world: LimitWorld,
    sections: ConfigSections,
  ): string[] {
    const agents = new Set<string>();
    const add = (id: unknown) => {
      if (typeof id === "string") agents.add(id);
    };
    const existing =
      command === "tasks.start" || command === "tasks.addAgent"
        ? input.id
        : command === "team.add"
          ? input.task
          : undefined;
    if (typeof existing === "string") for (const a of this.deps.store.tasks.get(existing)?.team ?? []) add(a);
    add(input.agent);
    for (const a of Array.isArray(input.team) ? input.team : []) add(a);
    for (const c of Array.isArray(input.children) ? input.children : [])
      add((c as { agent?: unknown }).agent);
    if (agents.size === 0) for (const a of sections.orgs[world.org]?.team ?? []) add(a);
    return [...new Set([...agents].flatMap((a) => world.agents[a]?.account ?? []))];
  }

  /** A call of an autonomous caller ran by the owner's policy or a saved rule: a `decision` event. */
  ran(
    caller: AdminCaller,
    command: CommandName,
    input: unknown,
    reason: string,
    done: { ok: boolean; error?: string | undefined },
  ): void {
    if (commands[command].risk === "read" || this.repo.state().mode === "off") return;
    this.event({
      kind: "decision",
      text: done.ok
        ? summarize(command, input)
        : `${summarize(command, input)} failed: ${done.error ?? "error"}`,
      ...(reason === "" ? {} : { reason }),
      task: caller.task,
      agent: caller.agent,
      command,
      outcome: done.ok ? "applied" : "failed",
      ...this.orgOfTask(caller.task),
    });
  }

  /** Autonomous mode approved the card and ran it: an `approval` event. */
  approved(
    caller: AdminCaller,
    command: CommandName,
    input: unknown,
    why: string,
    reason: string,
    item: string,
    done: { ok: boolean; error?: string | undefined },
  ): void {
    this.event({
      kind: "approval",
      text: `Approved: ${summarize(command, input)}. ${why}${done.ok ? "" : `. It failed: ${done.error ?? "error"}`}`,
      ...(reason === "" ? {} : { reason }),
      task: caller.task,
      agent: caller.agent,
      command,
      outcome: done.ok ? "applied" : "failed",
      item,
      ...this.orgOfTask(caller.task),
    });
  }

  /** Autonomous mode left the card for the owner: an `approval` event, and the captain hears of it. */
  left(
    caller: AdminCaller,
    command: CommandName,
    input: unknown,
    why: string,
    reason: string,
    item: string,
  ): void {
    const summary = summarize(command, input);
    this.event({
      kind: "approval",
      text: `Left for the owner: ${summary}. ${why}`,
      ...(reason === "" ? {} : { reason }),
      task: caller.task,
      agent: caller.agent,
      command,
      outcome: "left",
      item,
      ...this.orgOfTask(caller.task),
    });
    this.wake(
      `${caller.task}: left for the owner: ${summary}`,
      this.deps.store.tasks.get(caller.task)?.org ?? PRIVATE,
    );
  }

  /**
   * After a call of an autonomous caller ran (rule 2): tasks the captain creates, splits or starts from
   * its chat join, and so do tasks an agent of an autonomous task creates or splits.
   */
  adopt(caller: AutonomyCaller, command: CommandName, output: unknown, reason = ""): void {
    if (this.repo.state().mode !== "on") return;
    const ids: string[] = [];
    const id = (o: unknown) => (typeof o === "object" && o !== null ? (o as { id?: unknown }).id : undefined);
    if (command === "tasks.create" || (command === "tasks.start" && caller === "boss")) {
      const one = id(output);
      if (typeof one === "string") ids.push(one);
    }
    if (command === "tasks.split") {
      const children = (output as { children?: unknown }).children;
      for (const c of Array.isArray(children) ? children : []) {
        const one = id(c);
        if (typeof one === "string") ids.push(one);
      }
    }
    let joined = false;
    for (const task of ids) {
      if (!this.repo.join(task, this.now().toISOString(), reason === "" ? undefined : clip(reason, 240)))
        continue;
      joined = true;
      const t = this.deps.store.tasks.get(task);
      const verb =
        command === "tasks.start" ? "Started" : command === "tasks.split" ? "Split out" : "Created";
      this.event({ kind: "task", text: `${verb} ${task}: ${t?.title ?? task}`, task, ...orgOf(t) });
    }
    if (joined) this.deps.events.emit(["autonomy", "tasks"]);
  }

  private orgOfTask(task: string): { org?: string } {
    return orgOf(this.deps.store.tasks.get(task));
  }

  /** What the hard limits need, and the org the call acts in. */
  private async context(
    caller: AdminCaller,
    command: string,
    input: Record<string, unknown>,
  ): Promise<{ world: LimitWorld; sections: ConfigSections }> {
    const sections = await this.deps.config.sections();
    const agents: Record<string, LimitAgent> = {};
    for (const s of await this.deps.agents.list()) {
      if (!s.ok) continue;
      const fm = s.agent.frontmatter;
      agents[s.id] = { scope: fm.scope, account: fm.account, where: fm.where, connections: fm.connections };
    }
    const logins =
      command === "orgs.useGitLogin" && this.deps.gitLogins !== undefined
        ? (await this.deps.gitLogins.list().catch(() => ({ hosts: [] }) as GitLoginsResult)).hosts.flatMap(
            (h) => h.logins.map((l) => ({ host: h.host, via: l.via, account: l.account, alias: l.alias })),
          )
        : [];
    const look: OrgLookup = {
      task: (id) => {
        const t = this.deps.store.tasks.get(id);
        return t === undefined ? undefined : (t.org ?? null);
      },
      project: (id) => sections.projects[id]?.org,
      connection: (id) => connectionOwner(id, sections.orgs),
    };
    const callerOrg = this.deps.store.tasks.get(caller.task)?.org ?? PRIVATE;
    return {
      sections,
      world: {
        org: callOrg(command, input, look, callerOrg),
        orgs: sections.orgs,
        accounts: Object.fromEntries(
          Object.entries(sections.accounts).map(([id, a]) => [id, { org: a.org, key: a.key }]),
        ),
        agents,
        logins,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // The owner's settings and guidance (rule 10)

  async configure(
    patch: AutonomyPatch,
    change: { command: string; meta: CommandMeta },
  ): Promise<AutonomyStatus> {
    const sections = await this.deps.config.sections();
    if (!sections.exists) throw new UserError("Pick workspace roots first.", 409);
    for (const [id, change] of Object.entries(patch.orgs ?? {})) {
      if (change !== null && id !== PRIVATE && sections.orgs[id] === undefined) {
        throw new UserError(`Org "${id}" does not exist.`, 404);
      }
      if (change === null) continue;
      if (typeof change.tz === "string" && !validZone(change.tz)) {
        throw new UserError(`${change.tz} is not a time zone. Use one like Europe/Berlin.`, 400);
      }
      for (const tool of change.providers ?? []) {
        if (!(ToolIdSchema.options as readonly string[]).includes(tool)) {
          throw new UserError(
            `${tool} is not an AI provider majhi knows. Use ${ToolIdSchema.options.join(" or ")}.`,
            400,
          );
        }
      }
      if (typeof change.account === "string") {
        const account = sections.accounts[change.account];
        if (account === undefined) throw new UserError(`There is no account ${change.account}.`, 404);
        // A workspace's lane never runs on another workspace's account (5.18, the never list).
        if (account.org !== id && account.org !== PRIVATE) {
          throw new UserError(
            `${change.account} belongs to ${sections.orgs[account.org]?.name ?? account.org}, so it cannot pay for ${id === PRIVATE ? "Private" : (sections.orgs[id]?.name ?? id)}.`,
            409,
          );
        }
      }
    }
    if (patch.tz !== undefined && !validZone(patch.tz)) {
      throw new UserError(`${patch.tz} is not a time zone. Use one like Europe/Berlin.`, 400);
    }
    const current = (await this.deps.config.settings()).autonomy;
    const next = mergePatch(current, patch);
    await this.deps.config.setSettings(
      { autonomy: toFile(next, patch) },
      { command: change.command, meta: change.meta, summary: describePatch(patch, sections) },
    );
    await this.noteCaps();
    await this.refreshHolds();
    await this.liftCaps();
    this.deps.events.emit(["autonomy"]);
    return this.status();
  }

  /**
   * The owner's message to the captain, in any mode: it goes to a workspace's lane as the owner's
   * message, which wakes the captain there (default: the first workspace set to "Runs it"). With
   * `keep` it is also a standing instruction for every lane, as a config commit.
   */
  async guide(
    input: { text: string; keep: boolean; org?: string | undefined },
    change: { command: string; meta: CommandMeta },
  ): Promise<{ chat: TaskId; instruction?: AutonomyInstruction }> {
    if (detectSecrets(input.text).length > 0) {
      throw new UserError(
        "That looks like a secret. Save it in Secrets and refer to it as secret:<name> instead.",
        400,
      );
    }
    const org = input.org ?? (await this.runsOrgs())[0];
    if (org === undefined) {
      throw new UserError(
        "No workspace is set to Runs it. Set one on the Captain page, or name the workspace.",
        409,
      );
    }
    if ((await this.bossId()) === undefined) {
      throw new UserError("There is no captain yet. Make a root agent the captain first.", 409);
    }
    const chat = await this.deps.lanes.ensure(org);
    let instruction: AutonomyInstruction | undefined;
    if (input.keep) {
      const { instructions } = (await this.deps.config.settings()).autonomy;
      if (instructions.length >= 50) throw new UserError("There are 50 instructions. Remove one first.", 409);
      instruction = { id: instructionId(), text: input.text, at: this.now().toISOString() };
      await this.deps.config.setSettings(
        { autonomy: { instructions: [...instructions, instruction] } },
        {
          command: change.command,
          meta: change.meta,
          summary: `added an instruction for autonomous mode: ${clip(input.text, 80)}`,
        },
      );
      this.event({ kind: "guide", text: `New standing instruction: ${input.text}` });
    } else {
      this.event({ kind: "guide", text: `The owner said: ${input.text}` });
    }
    await this.deps.tasks.send({ task: chat.id, text: input.text, attachments: [], mode: "queue" });
    return { chat: chat.id, ...(instruction === undefined ? {} : { instruction }) };
  }

  async forget(id: string, change: { command: string; meta: CommandMeta }): Promise<AutonomyStatus> {
    const { instructions } = (await this.deps.config.settings()).autonomy;
    const gone = instructions.find((i) => i.id === id);
    if (gone === undefined) throw new UserError("That instruction does not exist.", 404);
    await this.deps.config.setSettings(
      { autonomy: { instructions: instructions.filter((i) => i.id !== id) } },
      {
        command: change.command,
        meta: change.meta,
        summary: `removed an instruction of autonomous mode: ${clip(gone.text, 80)}`,
      },
    );
    this.event({ kind: "guide", text: `Removed the instruction: ${gone.text}` });
    return this.status();
  }

  /** The owner marks a task Not for autonomous mode, or clears the mark. */
  async exclude(task: string, exclude: boolean): Promise<AutonomyStatus> {
    const found = this.deps.store.tasks.get(task);
    if (found === undefined) throw new UserError(`There is no task ${task}.`, 404);
    if (found.id === this.repo.state().chat || this.laneOrg(found.id) !== undefined) {
      throw new UserError(`${task} is a chat of the captain.`, 409);
    }
    if ((found.noAutonomy === true) !== exclude) {
      this.deps.store.tasks.setNoAutonomy(task, exclude);
      this.event({
        kind: "guide",
        text: exclude
          ? `Marked ${task} Not for autonomous mode: ${found.title}`
          : `Cleared the mark Not for autonomous mode on ${task}: ${found.title}`,
        task,
        ...orgOf(found),
      });
      this.deps.events.emit(["autonomy", "tasks"]);
      if (!exclude) this.wake(`The owner let autonomous mode take ${task} again`, found.org ?? PRIVATE);
    }
    return this.status();
  }

  // ---------------------------------------------------------------------------
  // The driver's inputs (rule 8)

  /** While the day cap holds, the driver wakes the captain only for the owner's own messages. */
  dayCapped(): boolean {
    return this.holds.some((h) => h.kind === "day-cap");
  }

  /** Pending cards of autonomous tasks the captain may answer with majhi_autonomy_answer. */
  answerable(org?: string): AnswerableCard[] {
    const out: AnswerableCard[] = [];
    for (const task of this.openTasks()) {
      if (org !== undefined && (task.org ?? PRIVATE) !== org) continue;
      this.deps.room.flush(task.id);
      for (const type of ["permission", "ask", "choice", "owner-question"] as const) {
        for (const item of this.deps.store.room.pendingOfType(task.id, type)) {
          const text = answerableText(item);
          if (text !== undefined) out.push({ task: task.id, item: item.id, kind: item.type, text });
        }
      }
    }
    return out;
  }

  /** Inbox and ready tasks of one workspace, or all, chats left out, in the order the captain takes them. */
  backlog(org?: string): (BacklogTask & { task: Task })[] {
    const ages = this.repo.backlogAges();
    return backlogOrder(
      this.deps.store.tasks.list(false).flatMap((t) => {
        if (t.chat === true || (t.status !== "inbox" && t.status !== "ready")) return [];
        if (org !== undefined && (t.org ?? PRIVATE) !== org) return [];
        const task = this.deps.store.tasks.get(t.id);
        if (task === undefined) return [];
        return [
          {
            id: t.id,
            title: t.title,
            ...(t.org === undefined ? {} : { org: t.org }),
            ...(t.priority === undefined ? {} : { priority: t.priority }),
            ...(t.due === undefined ? {} : { due: t.due }),
            createdAt: ages.get(t.id) ?? t.updatedAt,
            task,
          },
        ];
      }),
    );
  }

  /** The backlog with each task's size and why the pick rules leave it out, if they do. */
  private async rated(
    org?: string,
  ): Promise<{ item: BacklogTask & { task: Task }; size: SizeOf; leftOut: string | undefined }[]> {
    const [settings, sections] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
    ]);
    const { pick } = settings.autonomy;
    const names = orgNames(sections);
    return this.backlog(org).map((item) => {
      const size = this.sizes.known(item.task) ?? { note: "Not rated yet" };
      const level = levelOf(settings.autonomy, item.org ?? PRIVATE);
      return { item, size, leftOut: leftOutWhy(pick, item.task, size, names, level) };
    });
  }

  /**
   * What the tick shows the captain: the backlog the pick rules allow, with sizes, how many they leave
   * out, and the rules in words. Sizes not known yet are rated first, for up to `fillMs`.
   */
  async pickable(
    fillMs: number,
    org?: string,
  ): Promise<{ backlog: BacklogTask[]; leftOut: number; rules: string[] }> {
    if (fillMs > 0) {
      const marked = (t: Task) => t.noAutonomy === true;
      await this.sizes.fill(
        this.backlog(org)
          .map((b) => b.task)
          .filter((t) => !marked(t)),
        fillMs,
      );
    }
    const [settings, sections] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
    ]);
    const rows = await this.rated(org);
    return {
      backlog: rows.flatMap(({ item, size, leftOut }) => {
        if (leftOut !== undefined) return [];
        const { task: _task, ...rest } = item;
        return [{ ...rest, ...(size.size === undefined ? {} : { size: size.size }) }];
      }),
      leftOut: rows.filter((r) => r.leftOut !== undefined).length,
      rules: pickLines(settings.autonomy.pick, orgNames(sections), org),
    };
  }

  /** The backlog as the page lists it: at most 100 tasks. */
  private async backlogView(): Promise<AutonomyBacklogItem[]> {
    return (await this.rated()).slice(0, 100).map(({ item, size, leftOut }) => ({
      task: item.id,
      title: item.title,
      ...(item.org === undefined ? {} : { org: item.org }),
      status: item.task.status,
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      ...(item.due === undefined ? {} : { due: item.due }),
      ...(size.size === undefined ? {} : { size: size.size }),
      sizeNote: size.note,
      noAutonomy: item.task.noAutonomy === true,
      ...(leftOut === undefined ? {} : { leftOut }),
    }));
  }

  /** Rates the sizes the page shows in the background, one pass at a time, and tells open pages. */
  fillSizes(): void {
    if (this.filling) return;
    this.filling = true;
    const tasks = this.backlog()
      .slice(0, 100)
      .map((b) => b.task)
      .filter((t) => t.noAutonomy !== true && this.sizes.known(t) === undefined);
    if (tasks.length === 0) {
      this.filling = false;
      return;
    }
    void this.sizes
      .fill(tasks, 120_000)
      .then((rated) => {
        if (rated) this.deps.events.emit(["autonomy"]);
      })
      .catch(() => undefined)
      .finally(() => {
        this.filling = false;
      });
  }

  /** The driver woke the captain: the feed and the chat say why. */
  ticked(reasons: readonly string[], org?: string, chat?: string): void {
    this.repo.setLastTick(this.now().toISOString());
    const last = reasons.at(-1) ?? "a check";
    const text = `Woke the captain: ${last}${reasons.length > 1 ? ` (and ${reasons.length - 1} more)` : ""}`;
    this.event({ kind: "tick", text, ...(org === undefined || org === PRIVATE ? {} : { org }) });
    if (chat !== undefined) this.sayIn(chat, text);
  }

  // ---------------------------------------------------------------------------
  // The captain's own tools (rule 9)

  /**
   * `autonomy.plan`, `autonomy.note` and `autonomy.answer`: no policy and no card. Only for the captain
   * in a lane: while the mode is not off, or in any mode in a lane whose workspace is set to "Keeps
   * things tidy" or "Runs it", where the upkeep asks it about agents' questions (5.18).
   */
  async bossTool(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<ToolResult> {
    if ((await this.callerKind(caller)) !== "boss") {
      return fail(`${command} is a tool of the captain in its lanes.`);
    }
    const { mode } = this.repo.state();
    const lane = this.laneOrg(caller.task);
    const level =
      lane === undefined ? undefined : levelOf((await this.deps.config.settings()).autonomy, lane);
    const upkeep = level === "tidy" || level === "runs";
    // Off: the captain acts only when the owner talks to it, so it plans, notes and answers nothing.
    if (mode === "off") return fail("Autonomous is off, so the captain acts only when you ask.");
    if (command === "autonomy.answer" && mode !== "on" && !upkeep) {
      return fail(`Autonomous is ${mode === "stopping" ? "turning off" : mode}, so nothing is answered now.`);
    }
    const refused = await this.refusal(caller, command, input, reason);
    if (refused !== undefined) return fail(refused);
    if (command === "autonomy.plan") {
      const parsed = AutonomyPlanInputSchema.safeParse(input);
      if (!parsed.success) return invalid(command, parsed.error);
      // A lane plans its own workspace only; the other lanes' plans stay.
      const items =
        lane === undefined ? parsed.data.items : parsed.data.items.map((i) => ({ ...i, org: lane }));
      const others =
        lane === undefined ? [] : this.repo.state().queue.filter((i) => (i.org ?? PRIVATE) !== lane);
      this.repo.setQueue([...others, ...items], this.now().toISOString());
      this.deps.events.emit(["autonomy"]);
      return ok({ queue: items.length });
    }
    if (command === "autonomy.note") {
      const parsed = AutonomyNoteInputSchema.safeParse(input);
      if (!parsed.success) return invalid(command, parsed.error);
      const note = parsed.data;
      const org =
        lane ?? note.org ?? (note.task === undefined ? undefined : this.deps.store.tasks.get(note.task)?.org);
      const seq = this.event({
        kind: "decision",
        text: note.text,
        ...(reason === "" ? {} : { reason }),
        agent: caller.agent,
        ...(note.task === undefined ? {} : { task: note.task }),
        ...(org === undefined ? {} : { org }),
        ...(note.unsure ? { unsure: true } : {}),
      });
      return ok({ seq });
    }
    if (command === "autonomy.answer") {
      const parsed = AutonomyAnswerInputSchema.safeParse(input);
      if (!parsed.success) return invalid(command, parsed.error);
      return this.answer(caller, parsed.data, reason, upkeep ? lane : undefined);
    }
    return fail(`${command} is not a tool of autonomous mode.`);
  }

  /**
   * The captain answers a card through the owner's own paths: in an autonomous task, or, for the
   * upkeep, in any task of the lane's workspace (`upkeep`). Never in a task the owner is in.
   */
  private async answer(
    caller: AdminCaller,
    input: z.infer<typeof AutonomyAnswerInputSchema>,
    reason: string,
    upkeep: string | undefined,
  ): Promise<ToolResult> {
    const inLane = upkeep !== undefined && (this.deps.store.tasks.get(input.task)?.org ?? PRIVATE) === upkeep;
    if (!this.repo.isAutonomous(input.task) && !inLane) {
      return fail(
        `${input.task} is not an autonomous task or a task of this lane's workspace, so only the owner answers its cards.`,
      );
    }
    const present = presenceWhy(this.deps.ownerAt?.(input.task), this.now());
    if (present !== undefined) return fail(`The owner is in ${input.task}: ${present}. Leave it to them.`);
    const item = this.deps.room.get(input.task, input.item);
    if (item === undefined) return fail(`There is no card ${input.item} in ${input.task}.`);
    const option = input.option;
    let answered: RoomItem;
    try {
      switch (item.type) {
        case "permission":
          if (item.connection !== undefined) return fail("A write through a connection needs the owner.");
          if (option === undefined) return fail("Give option: the id of one of the prompt's options.");
          answered = this.deps.tasks.answerPermission(input.task, item.id, option, caller.agent);
          break;
        case "choice":
          if (option === undefined) return fail("Give option: the id of one of the choices.");
          answered = await this.deps.tasks.answerChoice(input.task, item.id, option, caller.agent);
          break;
        case "ask":
          if (input.answers === undefined)
            return fail("Give answers: each question's id to an option id or text.");
          answered = await this.deps.tasks.answerAsk(input.task, item.id, input.answers, caller.agent);
          break;
        case "owner-question":
          if (option === undefined) return fail("Give option: the choice to answer with.");
          answered = await this.deps.tasks.answerQuestion(input.task, item.id, option, caller.agent);
          break;
        case "secret-request":
          return fail("Only the owner gives secrets.");
        case "approval":
          return fail("Approval cards follow the policy. Autonomous mode does not answer them.");
        default:
          return fail("That item takes no answer.");
      }
    } catch (err) {
      return fail(errorMessage(err));
    }
    // Said as the captain's, never the owner's (5.18): the card itself carries `by: "captain"`.
    this.deps.room.post(input.task as TaskId, `autonomy:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: redactText(captainAnsweredLine(answered, reason)),
    });
    this.event({
      kind: "answer",
      text: `Answered the ${item.type} ${item.id} in ${input.task}`,
      ...(reason === "" ? {} : { reason }),
      task: input.task,
      agent: caller.agent,
      item: item.id,
      ...this.orgOfTask(input.task),
    });
    return ok({ item: answered });
  }

  // ---------------------------------------------------------------------------
  // The daily summary (rule 10)

  /**
   * At `summary_at` in the owner's zone, once per local day, when the mode was not off at some
   * point in the 24 h before: stored once, said in the chat, told to the owner, written to the feed.
   */
  async dailySummary(): Promise<AutonomySummary | undefined> {
    const settings = (await this.deps.config.settings()).autonomy;
    const tz = zoneOr(settings.tz);
    const now = this.now();
    const today = localDay(now, tz);
    const due = summaryDue(today, settings.summary_at, tz);
    if (now.getTime() < due.getTime()) return undefined;
    // Made today, about yesterday: the day the caps and the spend belong to.
    const day = addDays(today, -1);
    if (this.repo.hasSummary(day)) return undefined;
    const from = dayStart(day, tz).toISOString();
    const to = dayStart(today, tz).toISOString();
    const state = this.repo.state();
    const wasOn =
      (state.mode !== "off" && (state.since === undefined || state.since <= to)) ||
      this.repo.modeChangedBetween(from, to);
    if (!wasOn) return undefined;
    const events = this.repo.eventsBetween(from, to);
    const tasks = new Map<string, { title: string; org?: string }>();
    for (const e of events) {
      if (e.task === undefined || tasks.has(e.task)) continue;
      const t = this.deps.store.tasks.get(e.task);
      if (t !== undefined) tasks.set(e.task, { title: t.title, ...orgOf(t) });
    }
    // The caps that applied that day, not today's. A day nothing noted (before majhi kept them) has none.
    const noted = this.repo.dayCaps(day);
    const caps = {
      ...(noted?.caps.day === undefined ? {} : { day: noted.caps.day }),
      orgs: Object.fromEntries(Object.entries(noted?.caps.orgs ?? {}).map(([org, cap]) => [org, { cap }])),
    };
    const spend = withChanged(
      spendOf(this.repo.spendRows(from, to, this.spendChats()), caps, { day, end: to }, tz),
      noted?.changed ?? [],
    );
    const summary = buildSummary({
      day,
      from,
      to,
      at: now.toISOString(),
      events,
      tasks,
      spent: { total: spend.total, orgs: spend.orgs },
      waiting: this.waiting(),
    });
    if (!this.repo.addSummary(summary)) return undefined;
    const line = summaryLine(summary);
    this.say(line);
    this.event({ kind: "summary", text: line });
    this.deps.notify?.(summary, line);
    return summary;
  }

  /** Notes today's caps, so the summary of today compares against what applied. Never throws. */
  private async noteCaps(): Promise<void> {
    try {
      const settings = (await this.deps.config.settings()).autonomy;
      const orgs: Record<string, Budget> = {};
      for (const [org, o] of Object.entries(settings.orgs)) if (o.cap !== undefined) orgs[org] = o.cap;
      this.repo.noteCaps(localDay(this.now(), zoneOr(settings.tz)), {
        ...(settings.day === undefined ? {} : { day: settings.day }),
        orgs,
      });
    } catch {
      // The database closed under a shutdown, or the settings do not read: the next sweep notes them.
    }
  }

  // ---------------------------------------------------------------------------
  // What the page reads

  /** The captain's chats whose turns count as autonomous spend: every lane, and the chat from before lanes. */
  private spendChats(): string[] {
    const legacy = this.repo.state().chat;
    return [...this.laneChats(), ...(legacy === undefined ? [] : [legacy])];
  }

  /** Each workspace set to "Runs it": its lane, today's spend there, its tasks and why it rests. */
  private async lanesView(
    m: Measure,
    holds: readonly AutonomyHold[],
    boss: string | undefined,
  ): Promise<AutonomyLane[]> {
    const settings = m.settings;
    const rows = await this.rated();
    const now = this.nowList();
    const out: AutonomyLane[] = [];
    for (const org of await this.runsOrgs()) {
      const chat = this.deps.lanes.chat(org);
      const nowDoing =
        chat === undefined || boss === undefined ? undefined : this.deps.room.getLive(chat, boss)?.nowDoing;
      const used = m.spend.orgs.find((o) => o.org === org);
      const cap = settings.orgs[org]?.cap;
      const spend: CapUse = used ?? {
        used: { tokens: 0, cost: 0 },
        ...(cap === undefined ? {} : { cap }),
        percent: 0,
        reached: false,
      };
      const rules = settings.orgs[org];
      const hold = capHoldFor(holds, org);
      const rest = hold?.text ?? restWhy(rules, this.now(), zoneOr(rules?.tz ?? settings.tz));
      out.push({
        org,
        name: org === PRIVATE ? "Private" : (m.names[org] ?? org),
        ...(chat === undefined ? {} : { chat: chat as TaskId }),
        working: chat !== undefined && this.deps.runs.working(chat).length > 0,
        ...(nowDoing === undefined ? {} : { nowDoing }),
        spend,
        tasks: now.filter((t) => (t.org ?? PRIVATE) === org).length,
        backlog: rows.filter((r) => (r.item.org ?? PRIVATE) === org && r.leftOut === undefined).length,
        ...(rest === undefined ? {} : { resting: rest }),
      });
    }
    return out;
  }

  async status(): Promise<AutonomyStatus> {
    const state = this.repo.state();
    const m = await this.measure();
    const holds = state.mode === "off" ? [] : await this.refreshHolds(m);
    const boss = await this.bossId();
    const lanes = await this.lanesView(m, holds, boss);
    const chat = lanes.find((l) => l.chat !== undefined)?.chat ?? this.chat();
    const nowDoing =
      chat === undefined || boss === undefined ? undefined : this.deps.room.getLive(chat, boss)?.nowDoing;
    const summary = this.repo.latestSummary();
    const after = this.repo.state();
    return {
      mode: after.mode,
      ...(after.since === undefined ? {} : { since: after.since }),
      ...(after.by === undefined ? {} : { by: after.by }),
      ...(after.why === undefined ? {} : { why: after.why }),
      ...(boss === undefined
        ? {}
        : {
            boss: {
              id: boss,
              ...(chat === undefined ? {} : { chat }),
              working: chat !== undefined && this.deps.runs.working(chat).length > 0,
              ...(nowDoing === undefined ? {} : { nowDoing }),
            },
          }),
      lanes,
      now: this.nowList(),
      queue: after.queue,
      backlog: await this.backlogView(),
      ...(after.queuedAt === undefined ? {} : { queuedAt: after.queuedAt }),
      holds,
      spend: m.spend,
      accounts: m.accounts,
      waiting: this.waiting(),
      settings: m.settings,
      ...(summary === undefined ? {} : { summary }),
      ...(after.lastTick === undefined ? {} : { lastTick: after.lastTick }),
      stopped: this.stoppedNow(),
    };
  }

  /** Tasks Stop now paused that are still paused, for the turn-on dialog. */
  private stoppedNow(): string[] {
    return this.repo
      .tasks()
      .filter((r) => r.held === "owner" && r.heldScope === STOPPED_NOW)
      .filter((r) => this.deps.store.tasks.get(r.task)?.status === "paused")
      .map((r) => r.task);
  }

  events(q: { before?: number | undefined; limit: number; decisions: boolean; task?: string | undefined }): {
    events: AutonomyEvent[];
  } {
    return { events: this.repo.events(q) };
  }

  /** Autonomous tasks that are not done, newest first. */
  openTasks(): Task[] {
    return this.repo
      .tasks()
      .flatMap((r) => this.deps.store.tasks.get(r.task) ?? [])
      .filter((t) => t.status !== "done")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** The autonomous tasks that are not done and what their agents do, running ones first. */
  nowList(): AutonomyNow[] {
    const why = new Map(this.repo.tasks().map((r) => [r.task, r.why]));
    const ids = new Set(why.keys());
    return this.deps.tasks
      .list(false)
      .filter((t) => ids.has(t.id))
      .sort((a, b) => rank(b) - rank(a) || (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((t) => ({
        task: t.id,
        title: t.title,
        ...(t.org === undefined ? {} : { org: t.org }),
        status: t.status,
        agents: t.team.map((a) => {
          const doing = this.deps.room.getLive(t.id, a)?.nowDoing;
          return { id: a, ...(doing === undefined ? {} : { nowDoing: doing }) };
        }),
        ...(why.get(t.id) === undefined ? {} : { why: why.get(t.id) }),
      }));
  }

  /** Cards in autonomous tasks and the captain's lanes that only the owner can decide. */
  waiting(): AutonomyWaiting[] {
    const ids = [...this.openTasks().map((t) => t.id), ...this.laneChats()];
    const out: AutonomyWaiting[] = [];
    for (const task of ids) {
      this.deps.room.flush(task);
      const rooms = this.deps.store.room;
      for (const item of rooms.pendingOfType(task, "approval")) {
        if (item.type !== "approval") continue;
        out.push({
          task,
          item: item.id,
          kind: "approval",
          text: item.summary,
          why: item.autonomy?.why ?? "It waits for the owner's approval",
        });
      }
      for (const item of rooms.pendingOfType(task, "secret-request")) {
        if (item.type !== "secret-request") continue;
        out.push({
          task,
          item: item.id,
          kind: "secret-request",
          text: item.label,
          why: "Only the owner gives secrets",
        });
      }
      for (const item of rooms.pendingOfType(task, "permission")) {
        if (item.type !== "permission" || item.connection === undefined) continue;
        out.push({
          task,
          item: item.id,
          kind: "permission",
          text: item.title,
          why: `A write through ${item.connection.name} needs the owner`,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  /** Writes a feed event, redacted, and tells open pages. */
  event(e: Omit<AutonomyEvent, "seq" | "at">): number {
    const seq = this.repo.addEvent({
      ...e,
      at: this.now().toISOString(),
      text: redactText(e.text),
      ...(e.reason === undefined ? {} : { reason: redactText(e.reason) }),
    });
    this.deps.events.emit(["autonomy"]);
    return seq;
  }

  /** A quiet line in every lane of a workspace set to "Runs it" that has a chat. */
  say(text: string, level: "info" | "warn" = "info"): void {
    void this.runsOrgs()
      .then((orgs) => {
        for (const org of orgs) {
          const chat = this.deps.lanes.chat(org);
          if (chat !== undefined) this.sayIn(chat, text, level);
        }
      })
      .catch(() => undefined);
  }

  /** A quiet line in one of the captain's chats. */
  sayIn(chat: string, text: string, level: "info" | "warn" = "info"): void {
    this.deps.room.post(chat as TaskId, `autonomy:${randomUUID()}`, {
      type: "system",
      level,
      text: redactText(text),
    });
  }

  // ---------------------------------------------------------------------------
  // What the captain per workspace (5.18) reads

  /** Today's spend in a workspace: the captain's lane there and its autonomous tasks. */
  async orgSpend(org: string): Promise<{ used: Spend; tz: string }> {
    const m = await this.measure();
    const row = m.spend.orgs.find((o) => o.org === org);
    return { used: row?.used ?? { tokens: 0, cost: 0 }, tz: m.spend.tz };
  }

  /**
   * Why a workspace's lane rests now: the day budget is used, the workspace's own budget is used, or
   * the lane's account is under its floor. Undefined: it may run. Rules and Laya go on either way.
   */
  async laneRest(org: string, account: string): Promise<string | undefined> {
    const m = await this.measure();
    if (m.spend.total.reached) return "the day budget is used up";
    const own = m.spend.orgs.find((o) => o.org === org);
    if (own?.reached === true)
      return `${org === PRIVATE ? "Private" : (m.names[org] ?? org)} used its daily budget`;
    const held = m.accounts.find((a) => a.id === account)?.blocked;
    return held === undefined ? undefined : `${account} is ${lowerFirst(held.why)}`;
  }

  /** The old "Stop the captain": the same as turning Autonomous off and pausing its tasks. */
  async stopNowForCaptain(): Promise<void> {
    if (this.repo.state().mode === "off") return;
    await this.stopNow();
  }

  /** The old "Resume the captain": the same as turning Autonomous on, resuming the tasks it paused. */
  async startForCaptain(): Promise<void> {
    await this.start(true);
  }
}

function orgNames(sections: Pick<ConfigSections, "orgs">): OrgNames {
  return Object.fromEntries(Object.entries(sections.orgs).map(([id, o]) => [id, o.name]));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The existing task a call is about: `id` for `tasks.*`, else `task`. */
function targetOf(command: string, input: Record<string, unknown>): string | undefined {
  return command.startsWith("tasks.") ? (str(input.id) ?? str(input.task)) : str(input.task);
}

function orgOf(task: { org?: string | undefined } | undefined): { org?: string } {
  return task?.org === undefined ? {} : { org: task.org };
}

function holdOrg(h: AutonomyHold): { org?: string } {
  return h.kind === "org-cap" && h.id !== undefined ? { org: h.id } : {};
}

/** Running work first, then the rest. */
function rank(t: { working: readonly string[]; status: string }): number {
  return (t.working.length > 0 ? 2 : 0) + (t.status === "running" ? 1 : 0);
}

function lowerFirst(text: string): string {
  return text === "" ? text : text[0]?.toLowerCase() + text.slice(1);
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Eight lowercase letters and digits, as instruction ids are. */
function instructionId(): string {
  return [...randomBytes(8)].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The settings' zone, or the server's when it has none or names no real zone. */
export function zoneOr(tz: string | undefined): string {
  return tz !== undefined && validZone(tz) ? tz : defaultTimeZone();
}

/** When the day's summary is due: `HH:MM` on that local day. */
export function summaryDue(day: string, clock: string, tz: string): Date {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return new Date(dayStart(day, tz).getTime() + (h * 60 + m) * 60_000);
}

function ok(output: unknown): ToolResult {
  return { text: JSON.stringify(redact(output), null, 2) ?? "ok", isError: false };
}

function fail(text: string): ToolResult {
  return { text, isError: true };
}

function invalid(command: string, error: z.ZodError): ToolResult {
  const details = error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
  return fail(`Invalid input for ${command}.\n${details.join("\n")}`);
}

/** Marks the caps that moved during the day: `day` for the day cap, else the org. */
function withChanged(spend: AutonomySpend, changed: readonly string[]): AutonomySpend {
  if (changed.length === 0) return spend;
  return {
    ...spend,
    total: changed.includes("day") ? { ...spend.total, changed: true } : spend.total,
    orgs: spend.orgs.map((o) => (changed.includes(o.org) ? { ...o, changed: true } : o)),
  };
}
