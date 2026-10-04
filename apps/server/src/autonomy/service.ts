import { randomBytes, randomUUID } from "node:crypto";
import {
  type AccountModels,
  type AccountView,
  type Authority,
  type AuthorityRow,
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
  type BudgetAsk,
  type CapUse,
  type CommandMeta,
  type CommandName,
  commands,
  type DecisionRecommendInput,
  DecisionRecommendInputSchema,
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
import type { LaneGate } from "../captain/lane-gate.ts";
import { forceOrg, narrow, readRefusal, type ScopeWorld } from "../captain/lane-scope.ts";
import type { Lanes } from "../captain/lanes.ts";
import { askedWhy, authorityOf, workspaceIds } from "../captain/levels.ts";
import { classifyOwnWork, scopeOfTask } from "../captain/own-work.ts";
import { permissionVerdict } from "../captain/permission-rules.ts";
import {
  loopLine,
  NEAR_SAME_MS,
  nudgeText,
  type PastAnswer,
  questionLoop,
} from "../captain/question-loop.ts";
import { restWhy, typingWhy } from "../captain/rules.ts";
import type { ConfigSections } from "../config/sections.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import type { RoomService } from "../room/service.ts";
import { noRoomLine } from "../runs/limits.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import { captainAnsweredLine } from "../tasks/cards.ts";
import { ancestorsOf } from "../tasks/planner.ts";
import { likelyPaths } from "../tasks/planning.ts";
import type { TaskService } from "../tasks/service.ts";
import { StaffingSource, type StaffRequest } from "../tasks/staffing-source.ts";
import { addDays, dayStart, defaultTimeZone, localDay } from "../usage/ranges.ts";
import { askableHolds, askName, buildAsk, DAY_SCOPE, waitText, withRaises } from "./budget-asks.ts";
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
import { authorityProblem, leftOutWhy, type OrgNames, orgName, pickLines } from "./pick.ts";
import { type AutonomyVerdict, decideAutonomously, startsWork } from "./policy.ts";
import { AutonomyRepo, type HeldReason, STOPPED_NOW } from "./repo.ts";
import { areasOf, type RepoRuleTask, repoRuleLine } from "./repo-rule.ts";
import { mayResume, pausedLabel, type ResumeEnv, resumeRefusal } from "./resume.ts";
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
import { evaluateWaits, waitProblem } from "./waits.ts";

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
  accounts: { list(): Promise<AccountView[]>; cachedModels?(id: string): Promise<AccountModels | undefined> };
  agents: AgentStore;
  events: EventHub;
  /** This computer's git logins, to tell whose a gh or glab login is. */
  gitLogins?: { list(refresh?: boolean): Promise<GitLoginsResult> };
  /** Tells the owner a budget ran out and asks about it (a decision for the bell). */
  tell?: (key: string, text: string) => void;
  /** Tells the owner the daily summary is ready. majhi sends no alert for it (SPEC 5.18: alerts are for decisions). */
  notify?: (summary: AutonomySummary, line: string) => void;
  /** Records the captain's recommendation on a decision of the owner's inbox, from the lane's workspace. */
  recommend?: (input: DecisionRecommendInput, lane: string | undefined) => Promise<void>;
  /** The kind of action a schedule or trigger has now, for an update that leaves it as it is. */
  automationAction?: (kind: "schedule" | "trigger", id: string) => string | undefined;
  /** Rates how much work a task is (the decision provider), for the size rule. */
  rateSize?: SizeRater;
  /** The captain's lanes (5.18): autonomous mode wakes the captain in each workspace's own. */
  lanes: Lanes;
  /** The captain's upkeep lines in a span (UTC ISO, `to` excluded), for the daily summary. */
  upkeepBetween?: (
    from: string,
    to: string,
  ) => { chore: string; task?: string | undefined; outcome: string }[];
  /** What waits in the owner's Decisions inbox, in its order, for the daily summary. */
  decisions?: () => Promise<{ id: string; title: string; org?: string | undefined }[]>;
  /** Whether the owner is typing in a task now: the captain waits (SPEC 5.18, Presence). */
  typing?: (task: string) => boolean;
  /** Projects the owner protects: Own work never approves a change in one of them. */
  protectedProjects?: () => Promise<ReadonlySet<string>>;
  now?: () => Date;
}

/** What the service tells the driver (part B, `driver.ts`). */
export interface DriverHooks {
  /** For one workspace, or every workspace where the captain starts work when `org` is absent. */
  wake(line: string, org?: string, kind?: "news" | "soft"): void;
  onMode(mode: AutonomyMode): void;
  fire(org: string): Promise<void>;
  loopEnded(task: string): void;
  sweep(): void;
  start(): void;
  close(): void;
}

/** Who acts for autonomous mode: the captain in its autonomy chat, or an agent of an autonomous task. */
export type AutonomyCaller = "boss" | "agent";

/** Today's numbers, read once for the status and the holds. */
interface Measure {
  /** The saved settings. */
  settings: AutonomySettings;
  /** The settings as they hold today: the saved budgets with today's raises. */
  effective: AutonomySettings;
  /** The budgets the owner raised for today, by scope. */
  raised: Record<string, Budget>;
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
  /** Tasks a resume left held because no agent slot was free; the minute sweep tries them again. */
  private readonly roomWait = new Set<string>();
  /** The numbers of the last measure, for the words on a held task's card. */
  private lastMeasure: Measure | undefined;

  constructor(private readonly deps: AutonomyDeps) {
    this.repo = new AutonomyRepo(deps.store.raw);
    this.sizes = new TaskSizes(deps.store.raw, deps.rateSize, () => this.now());
    this.holds = this.repo.state().holds;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Minutes the queue has held ready work while no step was taken, for majhi's self-watch. Undefined when
   * the switch is off, nothing is ready, or it is moving.
   */
  queueStall(): number | undefined {
    const state = this.repo.state();
    if (state.mode !== "on" || !state.queue.some((q) => q.waitFor === undefined)) return undefined;
    const since = state.lastTick ?? state.queuedAt;
    if (since === undefined) return undefined;
    return Math.max(0, (this.now().getTime() - Date.parse(since)) / 60_000);
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

  /** The workspaces where the captain decides when work starts, Private first. */
  async runsOrgs(): Promise<string[]> {
    const [sections, settings] = await Promise.all([
      this.deps.config.sections(),
      this.deps.config.settings(),
    ]);
    return workspaceIds(sections.orgs).filter(
      (org) => authorityOf(settings.autonomy, org).start === "decide",
    );
  }

  /**
   * The workspaces where the captain has a lane to think in: where it decides when work starts, and
   * where it does upkeep while the owner starts work (it hears of findings, follow-ups and review there
   * and files proposals; its rows still limit what it does).
   */
  async thinksIn(): Promise<string[]> {
    const [sections, settings] = await Promise.all([
      this.deps.config.sections(),
      this.deps.config.settings(),
    ]);
    return workspaceIds(sections.orgs).filter((org) => {
      const a = authorityOf(settings.autonomy, org);
      return a.start === "decide" || a.upkeep === "decide";
    });
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
   * The lane a tick goes to, while the mode is on and the workspace is where the captain starts work. When the
   * lane's chat was removed or closed, majhi makes or reopens it first and says so in the feed.
   * Undefined: the mode is not on, the workspace does not run, or there is no captain.
   */
  async laneChat(org: string): Promise<string | undefined> {
    if (this.repo.state().mode !== "on") return undefined;
    if (!(await this.thinksIn()).includes(org)) return undefined;
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
    let lane: string | undefined;
    try {
      lane = this.deps.lanes.orgOf(task.id);
    } catch {
      // The database closed under a shutdown.
      return;
    }
    if (lane === undefined || !isCaptainLane(task)) return;
    throw new UserError(
      `${task.id} is a captain thread, not a task, so it cannot be ${action === "close" ? "closed" : "removed"}. Use Start fresh in the Captain panel to clear it.`,
      409,
    );
  }

  useDriver(driver: DriverHooks): void {
    this.driver = driver;
  }

  /** A line on why the captain should look again: it goes into the next tick of that workspace's lane, or every lane. */
  private wake(line: string, org?: string, kind: "news" | "soft" = "news"): void {
    this.driver?.wake(line, org, kind);
  }

  /** Sends a lane's waiting wakes now, without the wait that batches them. */
  async fireWakes(org: string): Promise<void> {
    await this.driver?.fire(org);
  }

  /** Ticks the driver sent and batches it held back because nothing had changed, since majhi started. */
  readonly wakes = { sent: 0, skipped: 0 };

  /** A batch of wakes was held back: the facts and the news were the captain's already. */
  skipped(_reasons: readonly string[], _org: string): void {
    this.wakes.skipped += 1;
  }

  /**
   * A news line for a workspace's lane from outside the autonomy service: a finding, a project card.
   * Every workspace's lane hears of it, whoever decides when work starts there.
   */
  news(line: string, org: string): void {
    this.wake(line, org, "news");
  }

  /**
   * Why a running task with no agent working needs no wake: a cap or the owner holds it, a card
   * waits for the owner, or it waits for an account. Undefined when nothing explains it.
   */
  stallExplained(task: string): string | undefined {
    const found = this.deps.store.tasks.get(task);
    const row = this.repo.tasks().find((r) => r.task === task);
    if (row?.held !== undefined) return "held by a cap or the owner";
    if (holdCovering(this.holds, found?.org ?? PRIVATE, []) !== undefined) return "held by a cap";
    if (this.deps.store.room.tasksWaitingOnOwner().has(task)) return "waits on the owner";
    const waits = this.repo.state().queue.some((q) => q.task === task && q.waitFor !== undefined);
    return waits ? "waits for an account" : undefined;
  }

  /** Whether a workspace has backlog, an open finding or a decision waiting: a reason for the hourly check. */
  async pendingWork(org: string, findings: number): Promise<boolean> {
    if (this.backlog(org).length > 0 || findings > 0) return true;
    const decisions = (await this.deps.decisions?.().catch(() => [])) ?? [];
    return decisions.some((d) => (d.org ?? PRIVATE) === org);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** After a restart: in `on`, the captain is woken once; in `stopping`, the stop finishes. */
  async boot(): Promise<void> {
    const { mode } = this.repo.state();
    if (mode === "stopping") await this.maybeFinishStop();
    else if (mode !== "off") await this.refreshHolds();
    // A restart is no news: the captain hears of a task that did not come back through the stall check.
    if (mode === "on") this.wake("majhi restarted", undefined, "soft");
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
    await this.resumeWaiting();
    await this.checkWaits();
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

  /**
   * A task the stop pauses for Autonomous being off: one that runs, or would resume by itself, or that
   * the run gate paused when the stop began (it holds it for the owner). A task the owner paused by hand
   * is theirs and stays so: marking it paused by the switch would let the captain resume it.
   */
  private stoppable(task: Task): boolean {
    if (task.status === "running") return true;
    if (task.status !== "paused") return false;
    if (task.pausedReason === "offline" || task.pausedReason === "limit") return true;
    return (
      task.pausedReason === "owner" &&
      task.pausedBy === undefined &&
      this.repo.task(task.id)?.held === "owner"
    );
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
        withRaises(settings, this.repo.raisedBudgets(window.day)),
        window,
        tz,
      );
      const names = Object.fromEntries(Object.entries(sections.orgs).map(([id, o]) => [id, o.name]));
      const passed = capPassed(spend, this.deps.store.tasks.get(task)?.org ?? PRIVATE, turnCostUsd, names);
      if (passed === undefined) return undefined;
      this.repo.hold(task, "limit", passed.scope);
      const used =
        passed.scope === DAY_SCOPE
          ? spend.total.used.cost
          : (spend.orgs.find((o) => o.org === passed.scope)?.used.cost ?? 0);
      const line = waitText(passed.scope, askName(passed.scope, names), used + turnCostUsd);
      return `${line}. This agent stopped in the middle of its turn and continues when the budget is raised or tomorrow.`;
    } catch {
      // The database closed under a shutdown: the run stops anyway.
      return undefined;
    }
  }

  private staffingSource: StaffingSource | undefined;
  /** Staffing lines waiting to be said in the room of the task they made, by the team they picked. */
  private readonly staffLines: { key: string; reason: string }[] = [];

  private staffing(): StaffingSource {
    this.staffingSource ??= new StaffingSource({
      store: this.deps.store,
      agents: this.deps.agents,
      accounts: this.deps.accounts,
      config: this.deps.config,
      capacity: (accounts) => this.deps.runs.capacity(accounts),
      // Only a size already rated counts: staffing never asks the decision provider by itself, so a
      // task not rated yet is staffed as a medium one and the reason says so.
      size: async (request) =>
        request.task === undefined ? undefined : this.sizes.known(request.task)?.size,
      budgetLeft: (org) => this.budgetLeft(org),
      floors: async () => (await this.deps.config.settings()).autonomy.floors,
    });
    return this.staffingSource;
  }

  /** USD left today under the tightest budget that covers the org: the autonomous budget or the workspace's. */
  private async budgetLeft(org: string | undefined): Promise<number | undefined> {
    const m = this.lastMeasure ?? (await this.measure());
    const left: number[] = [];
    const total = m.spend.total;
    if (total.cap?.cost !== undefined) left.push(total.cap.cost - total.used.cost);
    const mine = m.spend.orgs.find((o) => o.org === (org ?? PRIVATE));
    if (mine?.cap?.cost !== undefined) left.push(mine.cap.cost - mine.used.cost);
    return left.length === 0 ? undefined : Math.max(0, Math.min(...left));
  }

  /** `tasks.staff`: the proposal for an existing task, or for the text of one not made yet. */
  async staff(input: {
    task?: string | undefined;
    text?: string | undefined;
    title?: string | undefined;
    kind?: string | undefined;
    repos?: readonly { project: string; base?: string | undefined }[] | undefined;
  }): Promise<{
    team: string[];
    lead: string | null;
    reason: string;
    ranked: { agent: string; score: number }[];
  }> {
    let request: StaffRequest;
    if (input.task !== undefined) {
      const task = this.deps.store.tasks.get(input.task);
      if (task === undefined) throw new UserError(`There is no task ${input.task}.`, 404);
      request = requestOf(task);
    } else {
      if (input.text === undefined) throw new UserError("Give a task id, or the text of the task.", 400);
      const sections = await this.deps.config.sections();
      const project = input.repos?.[0]?.project;
      request = {
        title: input.title ?? firstLine(input.text),
        brief: input.text,
        kind: input.kind ?? "code",
        org: project === undefined ? undefined : sections.projects[project]?.org,
        repos: input.repos ?? [],
      };
    }
    const p = await this.staffing().propose(request);
    return { team: p.team, lead: p.lead ?? null, reason: p.reason, ranked: p.ranked };
  }

  /**
   * For the captain's `tasks.create` and `tasks.start` that name no team: the team staffing picks.
   * A create gets it in its input; a start of a task still on its default team gets it set now.
   * Undefined when the call names a team, is not the captain's, or no agent can take the task.
   */
  async staffCall(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      (command !== "tasks.create" && command !== "tasks.start") ||
      (await this.callerKind(caller)) !== "boss"
    ) {
      return undefined;
    }
    const named = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string");
    let request: StaffRequest;
    if (command === "tasks.start") {
      const task = this.deps.store.tasks.get(str(input.id) ?? "");
      if (task === undefined || (task.status !== "inbox" && task.status !== "ready")) return undefined;
      // A team of more than one was chosen by the owner or the captain and is kept: only a task
      // still on a single default agent is staffed.
      if (task.team.length > 1 || task.kind === "chat") return undefined;
      request = requestOf(task);
    } else {
      if (named(input.team) || named(input.agent) || typeof input.text !== "string") return undefined;
      const repos = Array.isArray(input.repos) ? (input.repos as { project: string; base?: string }[]) : [];
      if (repos.length === 0 || input.readOnly === true) return undefined;
      const { world } = await this.context(caller, command, input);
      request = {
        title: str(input.title) ?? firstLine(input.text),
        brief: input.text,
        kind: str(input.kind) ?? "code",
        org: world.org === PRIVATE ? undefined : world.org,
        repos,
      };
    }
    const p = await this.staffing().propose(request);
    if (p.lead === undefined) return undefined;
    this.staffLines.push({
      key: command === "tasks.start" ? `start:${str(input.id)}` : p.team.join(","),
      reason: p.reason,
    });
    if (this.staffLines.length > 20) this.staffLines.shift();
    if (command === "tasks.create") return { ...input, team: p.team };
    await this.deps.tasks.staffTeam(str(input.id) ?? "", p.team);
    return input;
  }

  /** Says the staffing line in the room of the task the captain just made or started. */
  private saidStaffing(command: CommandName, task: Task): void {
    const key = command === "tasks.start" ? `start:${task.id}` : task.team.join(",");
    const at = this.staffLines.findIndex((l) => l.key === key);
    if (at === -1) return;
    const [line] = this.staffLines.splice(at, 1);
    if (line === undefined) return;
    this.deps.room.post(task.id as never, `staffing:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: `Team: ${line.reason}`,
    });
  }

  /** True while the mode is On: agent slots are shared evenly across workspaces (5.18). */
  slotsFair(): boolean {
    try {
      return this.repo.state().mode === "on";
    } catch {
      return false;
    }
  }

  /**
   * True for a task the owner runs: one the captain did not take on, or one the owner resumed by
   * hand. Its runs go first for a slot and are never stopped to rebalance.
   */
  ownerRuns(task: string): boolean {
    try {
      const row = this.repo.task(task);
      return row === undefined || row.resumedAt !== undefined;
    } catch {
      return true;
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
      why: `${this.waitLine(cap)}. It continues when the budget is raised or tomorrow.`,
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

  /**
   * Restarts a task the gate held: its held runs go on, and a paused task runs again. With no free
   * agent slot for its accounts it stays held and goes on from the minute sweep once one is free.
   */
  private async resumeTask(id: string, why: string): Promise<void> {
    const found = this.deps.store.tasks.get(id);
    this.roomWait.delete(id);
    if (found !== undefined && found.status !== "done") {
      const noRoom = await this.noRoomFor(found);
      const full =
        noRoom === undefined ? await this.repoRuleFor(found, `${id} waits.`) : `${noRoom} ${id} waits.`;
      if (full !== undefined) {
        this.roomWait.add(id);
        this.event({ kind: "task", text: full, task: id, ...orgOf(found) });
        return;
      }
    }
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

  /** Why the task's agents would only wait for a slot now, or undefined when there is room. */
  private async noRoomFor(task: Pick<Task, "team">): Promise<string | undefined> {
    const accounts = await this.teamAccountIds(task);
    return noRoomLine(await this.deps.runs.capacity(accounts), accounts);
  }

  /**
   * Reads the accounts the queue waits for. An item whose account is signed in again becomes ready
   * (`readyAt`), and the captain of its workspace is woken with one line. An item whose account fell
   * back is waiting again. Only while the mode is on.
   */
  private async checkWaits(): Promise<void> {
    const state = this.repo.state();
    if (state.mode !== "on" || !state.queue.some((q) => q.waitFor !== undefined)) return;
    const views = await this.deps.accounts.list().catch(() => undefined);
    if (views === undefined) return;
    const status = new Map(views.map((v) => [v.id, v.status]));
    const found = evaluateWaits(
      state.queue,
      (id) => status.get(id),
      this.now(),
      (task) => this.deps.store.tasks.get(task)?.status === "paused",
    );
    if (!found.changed) return;
    this.repo.setQueue(found.queue, state.queuedAt ?? this.now().toISOString());
    this.deps.events.emit(["autonomy"]);
    for (const l of found.lifted) {
      this.event({
        kind: "task",
        text: l.line,
        ...(l.item.task === undefined ? {} : { task: l.item.task }),
        ...(l.item.org === undefined ? {} : { org: l.item.org }),
      });
      this.wake(l.line, l.item.org ?? PRIVATE);
    }
  }

  /** Tasks a resume left for want of a slot go on once one is free, while the mode is on. */
  private async resumeWaiting(): Promise<void> {
    if (this.repo.state().mode !== "on") {
      this.roomWait.clear();
      return;
    }
    for (const id of [...this.roomWait]) {
      const org = this.deps.store.tasks.get(id)?.org ?? PRIVATE;
      if (capHoldFor(this.holds, org) !== undefined) continue;
      await this.resumeTask(id, "an agent slot is free");
    }
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
    const raised = this.repo.raisedBudgets(window.day);
    const effective = withRaises(settings, raised);
    const measured: Measure = {
      settings,
      effective,
      raised,
      spend: spendOf(rows, effective, window, tz),
      accounts: accountsOf(views, settings.floors, now),
      names: Object.fromEntries(Object.entries(sections.orgs).map(([id, o]) => [id, o.name])),
    };
    this.lastMeasure = measured;
    return measured;
  }

  /** "Waiting for Hooli's daily budget, $20 used": the budget that holds, by name, on a held task's card. */
  private waitLine(hold: AutonomyHold): string {
    const m = this.lastMeasure;
    const scope = capScope(hold);
    const used =
      scope === DAY_SCOPE ? m?.spend.total.used.cost : m?.spend.orgs.find((o) => o.org === scope)?.used.cost;
    return waitText(scope, askName(scope, m?.names ?? {}), used ?? 0);
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
    this.lastMeasure = m;
    const holds = await this.applyHolds(state.holds, m);
    await this.askAboutBudgets(holds, m);
    return holds;
  }

  private async applyHolds(before: readonly AutonomyHold[], m: Measure): Promise<AutonomyHold[]> {
    const holds = holdsOf(m.spend, m.accounts, m.names);
    this.holds = holds;
    const { started, lifted } = diffHolds(before, holds);
    if (started.length === 0 && lifted.length === 0) return holds;
    this.repo.setHolds(holds);
    for (const h of started) {
      this.event({ kind: "cap", text: `${h.text}. No new work starts there until it lifts.`, ...holdOrg(h) });
    }
    for (const h of lifted)
      this.event({ kind: "cap", text: `No longer held: ${lowerFirst(h.text)}.`, ...holdOrg(h) });
    if (started.some((h) => h.kind !== "account")) await this.deps.runs.pauseLimited();
    if (lifted.some((h) => h.kind !== "account")) await this.liftCaps();
    // A cap that starts has its question to the owner already, and the captain can do nothing about it:
    // only a lifted cap and an account that changed are news.
    const news = lifted[0] ?? started.find((h) => h.kind === "account");
    if (news !== undefined) {
      const org = holdOrg(news).org;
      this.wake(lifted.length > 0 ? `No longer held: ${lowerFirst(news.text)}` : news.text, org);
    }
    return holds;
  }

  /** Autonomous tasks a budget holds and backlog tasks it keeps from starting, for `scope` (`day` or a workspace). */
  private waitingOn(scope: string, settings: AutonomySettings): number {
    const held = this.repo.tasks().filter((r) => r.held === "limit" && r.heldScope === scope).length;
    // Backlog the captain would start where it decides when work starts.
    const backlog = this.backlog().filter(
      (b) =>
        b.task.noAutonomy !== true &&
        (scope === DAY_SCOPE || (b.org ?? PRIVATE) === scope) &&
        authorityOf(settings, b.org ?? PRIVATE).start === "decide",
    ).length;
    return held + backlog;
  }

  /**
   * A budget ran out while work waits: ask the owner once per budget and day whether to raise it for
   * today (the decision shows in the bell, on the Captain page and on the Limits screen). Never throws.
   */
  private async askAboutBudgets(holds: readonly AutonomyHold[], m: Measure): Promise<void> {
    try {
      for (const hold of askableHolds(holds)) {
        const scope = capScope(hold);
        if (this.repo.hasBudgetAsk(scope, m.spend.day)) continue;
        const ask = buildAsk({
          scope,
          name: askName(scope, m.names),
          spend: m.spend,
          waiting: this.waitingOn(scope, m.settings),
          day: m.spend.day,
          at: this.now().toISOString(),
        });
        if (ask === undefined || !this.repo.addBudgetAsk(ask)) continue;
        this.deps.tell?.(`budget:${ask.scope}:${ask.day}`, ask.text);
        this.deps.events.emit(["autonomy", "captain"]);
      }
    } catch {
      // The database closed under a shutdown: the next sweep asks.
    }
  }

  /** The budget questions waiting for the owner today. */
  async budgetAsks(): Promise<BudgetAsk[]> {
    const settings = (await this.deps.config.settings()).autonomy;
    return this.repo.pendingBudgetAsks(localDay(this.now(), zoneOr(settings.tz)));
  }

  /**
   * The owner's answer about a budget that ran out today. Raise doubles it for today only: the saved
   * budget stays, tomorrow it is the saved one again, and the hold lifts at once. Leave keeps it.
   */
  async answerBudget(scope: string, answer: "raise" | "leave"): Promise<BudgetAsk[]> {
    const ask = (await this.budgetAsks()).find((a) => a.scope === scope);
    if (ask === undefined) {
      throw new UserError(`The captain is not asking about a budget for ${scope} today.`, 409);
    }
    this.repo.answerBudgetAsk(
      scope,
      ask.day,
      answer === "raise" ? "raised" : "left",
      this.now().toISOString(),
    );
    this.deps.events.emit(["autonomy", "captain"]);
    if (answer === "raise") {
      await this.noteCaps();
      // Looks at the spend again with the raise: the hold lifts and what it held starts.
      await this.refreshHolds();
    }
    return this.budgetAsks();
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
            (await this.pickRefusal(caller, command, input, world.org, ctx)) ??
            (await this.gateRefusal(caller, command, input, lane)));
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
  /** What the lane's ships and repo registrations are held to: the chores' own rules (`LaneGate`). */
  private async gateRefusal(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
    lane: string | undefined,
  ): Promise<string | undefined> {
    if (lane === undefined || this.laneGate?.covers(command) !== true) return undefined;
    if ((await this.callerKind(caller)) !== "boss") return undefined;
    return this.laneGate.check(lane, command, input);
  }

  /** A lane's ship ran: it counts in the chore's log. */
  private shipRan(
    caller: AdminCaller,
    command: CommandName,
    input: unknown,
    reason: string,
    done: { ok: boolean; error?: string | undefined },
  ): void {
    const lane = this.laneOrg(caller.task);
    const gate = this.laneGate;
    if (lane === undefined || gate?.covers(command) !== true) return;
    void this.callerKind(caller)
      .then((kind) =>
        kind === "boss"
          ? gate.ran(lane, command, (input ?? {}) as Record<string, unknown>, reason, done)
          : undefined,
      )
      .catch(() => undefined);
  }

  private laneGate: LaneGate | undefined;

  /** The captain service made the gate the lane's ships and registrations pass through. */
  useLaneGate(gate: LaneGate): void {
    this.laneGate = gate;
  }

  private async laneRefusal(lane: string | undefined, org: string): Promise<string | undefined> {
    if (lane === undefined || org === lane) return undefined;
    return `Refused: this lane works in ${await this.orgName(lane)} only, and the call is about ${await this.orgName(org)}. Each workspace has its own lane.`;
  }

  /**
   * The owner's pick rules (PRV-74 follow-up, 5.18), for the captain and the agents in its lanes: no
   * call that touches a task marked Not for autonomous mode, no task work in a workspace that is not
   * where the captain starts work with the mode on, and no start of a task larger than the size rule allows.
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
    // The captain resumes what it or the Autonomous switch paused, never what the owner paused.
    if (command === "tasks.start") {
      const paused = touched.find((t) => t.id === str(input.id) && t.status === "paused");
      const stays = paused === undefined ? undefined : await this.resumeRefusalFor(paused);
      if (stays !== undefined) return stays;
    }
    if (group === "tasks" || group === "team" || starts) {
      // Starting work needs the start row. Any other change to a task needs the captain to start work or do upkeep there.
      const rows: readonly AuthorityRow[] = starts ? ["start"] : ["upkeep", "start"];
      const outside = authorityProblem(authorityOf(settings, org), state.mode, rows, org, names);
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

  /** Why the captain may not resume this paused task now, or undefined: see `resumeRefusal`. */
  async resumeRefusalFor(task: Task): Promise<string | undefined> {
    return resumeRefusal(task, await this.resumeEnv(task));
  }

  /** The current state of the causes a pause can wait on: the team's accounts and the workspace's budget. */
  private async resumeEnv(task: Task): Promise<ResumeEnv> {
    const ids = await this.teamAccountIds(task);
    const views = await this.deps.accounts.list().catch(() => [] as AccountView[]);
    const accounts = views.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, status: v.status }));
    const hold = capHoldFor(this.holds, task.org ?? PRIVATE);
    return { accounts, ...(hold === undefined ? {} : { budgetHold: this.waitLine(hold) }) };
  }

  /** The accounts of a task's team. */
  private async teamAccountIds(task: Pick<Task, "team">): Promise<string[]> {
    const accountOf = new Map(
      (await this.deps.agents.list()).flatMap((s) =>
        s.ok ? [[s.id, s.agent.frontmatter.account] as const] : [],
      ),
    );
    return [...new Set(task.team.flatMap((a) => accountOf.get(a) ?? []))];
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

  /**
   * The captain starts or resumes a task only when its accounts and majhi have a free agent slot,
   * counting the starts already waiting in line (5.17): with none, the start would only wait. The
   * line says so and what happens to the task. Only the captain's own calls: the owner's starts,
   * and agents of its tasks starting their subtasks, are never held by this.
   */
  async noRoom(
    caller: AdminCaller,
    command: CommandName,
    input: Record<string, unknown>,
  ): Promise<string | undefined> {
    const starts =
      command === "tasks.start" ||
      ((command === "tasks.create" || command === "tasks.split") && input.start === true);
    if (!starts || (await this.callerKind(caller)) !== "boss") return undefined;
    const { world, sections } = await this.context(caller, command, input);
    const named = this.teamAccounts(command, input, world, sections);
    // A new task with no team named gets one picked when it is made: it has room when any account
    // of the workspace's agents has a free slot.
    const candidates =
      named.length > 0
        ? []
        : [
            ...new Set(
              Object.values(world.agents).flatMap((a) => (a.scope === world.org ? [a.account] : [])),
            ),
          ];
    const capacity = await this.deps.runs.capacity([...named, ...candidates]);
    const lines = candidates.map((a) => noRoomLine(capacity, [a]));
    const full =
      candidates.length === 0
        ? noRoomLine(capacity, named)
        : lines.every((l) => l !== undefined)
          ? lines[0]
          : undefined;
    const then =
      command === "tasks.start"
        ? `${str(input.id) ?? "The task"} waits.`
        : command === "tasks.create"
          ? "Filed without starting: it waits in the backlog."
          : "Split without starting: the subtasks wait in the backlog.";
    const line =
      full !== undefined
        ? `${full} ${then}`
        : await this.repoRuleCall(command, input, sections, world.org, then);
    if (line === undefined) return undefined;
    this.event({
      kind: "decision",
      text: `${summarize(command, input)}: ${line}`,
      task: caller.task,
      agent: caller.agent,
      command,
      outcome: "left",
      org: world.org,
    });
    return line;
  }

  /**
   * The repo rule for a start the captain asked for: the one line when another task running or in
   * review already changes one of its repos on the same base branch, with no plan showing disjoint
   * areas. A new task (no id yet) is judged on its repos and the paths its text names.
   */
  private async repoRuleCall(
    command: CommandName,
    input: Record<string, unknown>,
    sections: ConfigSections,
    org: string,
    then: string,
  ): Promise<string | undefined> {
    if (command === "tasks.start") {
      const id = str(input.id);
      const task = id === undefined ? undefined : this.deps.store.tasks.get(id);
      return task === undefined ? undefined : this.repoRuleFor(task, then);
    }
    if (command !== "tasks.create" || !Array.isArray(input.repos) || input.readOnly === true)
      return undefined;
    const text = `${str(input.title) ?? ""}\n${str(input.text) ?? ""}`;
    const areas = areasOf(likelyPaths(text));
    const repos = (input.repos as { project?: unknown; base?: unknown; writes?: unknown }[]).flatMap((r) =>
      typeof r.project === "string"
        ? [
            {
              project: r.project,
              base:
                (typeof r.base === "string" ? r.base : undefined) ??
                sections.projects[r.project]?.base ??
                sections.orgs[org]?.base ??
                "",
              areas,
            },
          ]
        : [],
    );
    const candidate: RepoRuleTask = { id: "", repos };
    const label = str(input.title) ?? "this task";
    return repoRuleLine(label, candidate, await this.writers([]), then);
  }

  /** Tasks running or in review, except `skip` (a task's own ancestors hold its work). */
  private async writers(skip: readonly string[]): Promise<RepoRuleTask[]> {
    const out: RepoRuleTask[] = [];
    for (const s of this.deps.store.tasks.list(false)) {
      // Only work that is changing code now: a task in review waits for the owner and holds nothing.
      if (s.status !== "running" || skip.includes(s.id)) continue;
      const task = this.deps.store.tasks.get(s.id);
      if (task === undefined) continue;
      out.push(await this.repoUses(task));
    }
    return out;
  }

  private async repoUses(task: Task): Promise<RepoRuleTask> {
    const fps = await this.deps.tasks.footprints(task).catch(() => []);
    return {
      id: task.id,
      repos: task.repos
        .filter((r) => r.writes !== false)
        .map((r) => ({
          project: r.project,
          base: r.base,
          areas: areasOf(fps.find((f) => f.project === r.project)?.paths ?? []),
        })),
    };
  }

  /** The repo rule for an existing task the captain starts or resumes: a line, or undefined when it may go. */
  async repoRuleFor(task: Task, then: string): Promise<string | undefined> {
    const skip = [task.id, ...ancestorsOf(task, (id) => this.deps.store.tasks.get(id))];
    return repoRuleLine(task.id, await this.repoUses(task), await this.writers(skip), then);
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
      {
        command,
        input,
        org: world.org,
        confirm: ask.confirm,
        boss: (await this.callerKind(caller)) === "boss",
      },
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
    this.shipRan(caller, command, input, reason, done);
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
    this.shipRan(caller, command, input, reason, done);
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
    if (caller === "boss" && (command === "tasks.create" || command === "tasks.start")) {
      const made =
        typeof output === "object" && output !== null ? (output as { id?: unknown }).id : undefined;
      const task = typeof made === "string" ? this.deps.store.tasks.get(made) : undefined;
      if (task !== undefined) this.saidStaffing(command, task);
    }
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
      if (t !== undefined && caller === "boss") this.saidStaffing(command, t);
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
   * message, which wakes the captain there (default: the first workspace where the captain starts work). With
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
        "In no workspace does the captain decide when work starts. Change that on the Captain page, or name the workspace.",
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
      const authority = authorityOf(settings.autonomy, item.org ?? PRIVATE);
      return { item, size, leftOut: leftOutWhy(pick, item.task, size, names, authority) };
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
    this.wakes.sent += 1;
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
   * in a lane, while the mode is on. The authority table gates an answer by its row (5.18).
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
    // Its opinion on a decision is not an action, so it works whatever the switch says.
    if (command === "decisions.recommend") {
      const parsed = DecisionRecommendInputSchema.safeParse(input);
      if (!parsed.success) return invalid(command, parsed.error);
      if (this.deps.recommend === undefined) return fail("Decisions are not available.");
      try {
        await this.deps.recommend(parsed.data, lane);
      } catch (err) {
        return fail(errorMessage(err));
      }
      return ok({ id: parsed.data.id, option: parsed.data.option });
    }
    const authority =
      lane === undefined ? undefined : authorityOf((await this.deps.config.settings()).autonomy, lane);
    // Off: the captain acts only when the owner talks to it, so it plans, notes and answers nothing.
    if (mode === "off") return fail("Autonomous is off, so the captain acts only when you ask.");
    if (command === "autonomy.answer" && mode !== "on") {
      return fail(`Autonomous is ${mode === "stopping" ? "turning off" : mode}, so nothing is answered now.`);
    }
    const refused = await this.refusal(caller, command, input, reason);
    if (refused !== undefined) return fail(refused);
    if (command === "autonomy.plan") {
      const parsed = AutonomyPlanInputSchema.safeParse(input);
      if (!parsed.success) return invalid(command, parsed.error);
      // A lane plans its own workspace only; the other lanes' plans stay.
      // A wait for an account is checked now: one that already holds is a stale belief, not a plan.
      const views = await this.deps.accounts.list().catch(() => [] as AccountView[]);
      const status = new Map(views.map((v) => [v.id, v.status]));
      for (const item of parsed.data.items) {
        const problem = waitProblem(
          item,
          (id) => status.get(id),
          (id) => status.has(id),
        );
        if (problem !== undefined) return fail(`The queue was not saved. ${problem}`);
      }
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
      return this.answer(caller, parsed.data, reason, lane, authority);
    }
    return fail(`${command} is not a tool of autonomous mode.`);
  }

  /**
   * The captain answers a card through the owner's own paths, in an autonomous task or in any task of
   * the lane's workspace. Which row governs it: "Answer agents' questions" for questions and choices,
   * "Answer routine approval cards" for permission prompts. On "Ask me" it waits for the owner. Never in
   * a task the owner is in.
   */
  private async answer(
    caller: AdminCaller,
    input: z.infer<typeof AutonomyAnswerInputSchema>,
    reason: string,
    lane: string | undefined,
    authority: Authority | undefined,
  ): Promise<ToolResult> {
    const inLane = lane !== undefined && (this.deps.store.tasks.get(input.task)?.org ?? PRIVATE) === lane;
    if (!this.repo.isAutonomous(input.task) && !inLane) {
      return fail(
        `${input.task} is not an autonomous task or a task of this lane's workspace, so only the owner answers its cards.`,
      );
    }
    const item = this.deps.room.get(input.task, input.item);
    if (item === undefined) return fail(`There is no card ${input.item} in ${input.task}.`);
    const row: AuthorityRow = item.type === "permission" ? "approvals" : "questions";
    const answerable = ["permission", "choice", "ask", "owner-question"].includes(item.type);
    // Own work lets the captain allow a routine request of a task it started, whatever the Approvals row says.
    const viaOwn =
      authority !== undefined &&
      item.type === "permission" &&
      authority[row] !== "decide" &&
      authority.own === "decide" &&
      inLane &&
      this.repo.isAutonomous(input.task);
    if (authority !== undefined && answerable && authority[row] !== "decide" && !viaOwn) {
      const names = orgNames(await this.deps.config.sections());
      return fail(`Refused: ${askedWhy(row, orgName(lane ?? PRIVATE, names))}. Leave it to the owner.`);
    }
    const waiting = typingWhy(input.task, this.deps.typing?.(input.task) === true);
    if (waiting !== undefined) {
      return fail(`${waiting}. The captain tries again when you send or leave.`);
    }
    // An agent that asks the same thing again and again is stuck: no answer feeds it.
    const stuck = await this.questionLoopLine(input.task, item);
    if (stuck !== undefined) return fail(`${stuck}. It is left for the owner. Do not answer it.`);
    const option = input.option;
    // The rule table binds the captain too: an empty prompt is the owner's, and a dangerous one is rejected.
    if (item.type === "permission") {
      const rule = permissionVerdict(item.title);
      const kind = item.options.find((o) => o.id === option)?.kind;
      if (rule.decision === "unreadable") return fail(`Refused: ${rule.why}. Leave it to the owner.`);
      if (viaOwn) {
        const task = this.deps.store.tasks.get(input.task);
        const scope =
          task === undefined || task.noAutonomy === true
            ? undefined
            : scopeOfTask(task, (await this.deps.protectedProjects?.()) ?? new Set<string>());
        const verdict = scope === undefined ? undefined : classifyOwnWork(item.title, scope);
        if (kind !== "allow_once" || verdict?.decision !== "approve") {
          const why =
            verdict?.decision === "owner"
              ? verdict.why
              : "only an Allow once of a routine request is its to give";
          return fail(`Refused: Own work does not cover it: ${why}. Leave it to the owner.`);
        }
      }
      if (rule.decision === "deny" && kind !== "reject_once" && kind !== "reject_always") {
        return fail(`Refused: ${rule.why}. Reject it or leave it to the owner.`);
      }
    }
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

  /** Loops already flagged, so the agent hears of one only once and the room gets one line. */
  private readonly flaggedLoops = new Set<string>();

  /**
   * The line "@agent keeps asking in TASK (...)" when this card is the same question again, or the
   * third in five minutes, from the same agent in the same task as the captain answered before. The
   * first time, the line goes into the room and the agent gets one message. Undefined: not a loop.
   */
  private async questionLoopLine(task: string, item: RoomItem): Promise<string | undefined> {
    const found = this.deps.store.tasks.get(task);
    const agent = "agent" in item && typeof item.agent === "string" ? item.agent : found?.team[0];
    const text = plainQuestion(item);
    if (agent === undefined || text === undefined) return undefined;
    const since = new Date(this.now().getTime() - NEAR_SAME_MS).toISOString();
    const past: PastAnswer[] = [];
    for (const e of this.repo.events({ limit: 50, decisions: false, task }).slice().reverse()) {
      if (e.kind !== "answer" || e.item === undefined || e.at < since) continue;
      const before = this.deps.room.get(task, e.item);
      const asked = before === undefined ? undefined : plainQuestion(before);
      const by = before !== undefined && "agent" in before ? before.agent : found?.team[0];
      if (asked !== undefined && by === agent) past.push({ at: e.at, question: asked });
    }
    const loop = questionLoop(past, text, this.now());
    if (loop === undefined) return undefined;
    const line = loopLine(agent, task, loop);
    const key = `${task}:${agent}:${loop.since}`;
    if (!this.flaggedLoops.has(key)) {
      this.flaggedLoops.add(key);
      this.deps.room.post(task as TaskId, `autonomy:${randomUUID()}`, {
        type: "system",
        level: "warn",
        text: `${line}. The captain left its question for the owner.`,
      });
      this.deps.runs.notify(task, agent, nudgeText(task, loop));
    }
    return line;
  }

  // ---------------------------------------------------------------------------
  // The daily summary (rule 10)

  /**
   * At `summary_at` in the owner's zone, once per local day: stored once, said in the chat, written
   * to the feed. Made whatever the mode: Off it reports the captain's upkeep and the spend. A day with
   * the mode off all through and nothing done or spent makes none. It alerts nobody: it is not a decision.
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
    const events = this.repo.eventsBetween(from, to);
    const upkeep = (this.deps.upkeepBetween?.(from, to) ?? []).filter((a) => a.outcome === "done");
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
    const spentSomething = spend.total.used.cost > 0 || spend.total.used.tokens > 0;
    if (!wasOn && events.length === 0 && upkeep.length === 0 && !spentSomething) return undefined;
    for (const a of upkeep) {
      if (a.task === undefined || tasks.has(a.task)) continue;
      const t = this.deps.store.tasks.get(a.task);
      if (t !== undefined) tasks.set(a.task, { title: t.title, ...orgOf(t) });
    }
    const names = new Map<string, string>();
    for (const org of new Set([
      PRIVATE,
      ...spend.orgs.map((o) => o.org),
      ...[...tasks.values()].map((t) => t.org ?? PRIVATE),
    ])) {
      names.set(org, await this.orgName(org));
    }
    const summary = buildSummary({
      day,
      from,
      to,
      at: now.toISOString(),
      events,
      tasks,
      spent: { total: spend.total, orgs: spend.orgs },
      waiting: this.waiting(),
      upkeep,
      decisions: await (this.deps.decisions?.() ?? Promise.resolve([])).catch(() => []),
      queue: state.queue,
      names,
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
      const saved = (await this.deps.config.settings()).autonomy;
      const settings = withRaises(saved, this.repo.raisedBudgets(localDay(this.now(), zoneOr(saved.tz))));
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

  /** Each workspace where the captain starts work: its lane, today's spend there, its tasks and why it rests. */
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
      const cap = m.effective.orgs[org]?.cap;
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
      now: await this.withPauses(this.nowList()),
      queue: after.queue,
      backlog: await this.backlogView(),
      ...(after.queuedAt === undefined ? {} : { queuedAt: after.queuedAt }),
      holds,
      spend: m.spend,
      accounts: m.accounts,
      waiting: this.waiting(),
      settings: m.settings,
      raised: m.raised,
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

  /** Paused tasks say who paused them and whether the captain may resume them now. */
  private async withPauses(list: AutonomyNow[]): Promise<AutonomyNow[]> {
    const out: AutonomyNow[] = [];
    for (const n of list) {
      const task = n.status === "paused" ? this.deps.store.tasks.get(n.task) : undefined;
      if (task === undefined) {
        out.push(n);
        continue;
      }
      const env = await this.resumeEnv(task);
      const stays = resumeRefusal(task, env);
      out.push({
        ...n,
        pause: {
          label: pausedLabel(task),
          mayResume: mayResume(task, env),
          ...(stays === undefined ? {} : { stays: stays.replace(/^Refused: /, "") }),
        },
      });
    }
    return out;
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

  /** A quiet line in every lane of a workspace where the captain starts work that has a chat. */
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

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim()
      .slice(0, 120) ?? ""
  );
}

function requestOf(task: Task): StaffRequest {
  return {
    task,
    title: task.title,
    brief: task.brief,
    kind: task.kind,
    org: task.org,
    repos: task.repos.map((r) => ({ project: r.project, base: r.base })),
  };
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

/** The words an agent asked, without ids, so the same question compares equal. */
function plainQuestion(item: RoomItem): string | undefined {
  switch (item.type) {
    case "choice":
      return item.question;
    case "ask":
      return item.questions.map((q) => q.question).join(" / ");
    case "owner-question":
      return item.text ?? item.choices.join(" / ");
    case "permission":
      return item.title;
    default:
      return undefined;
  }
}
