import {
  type AutonomyMode,
  type AutonomySettings,
  type CaptainCapAsk,
  type CaptainChore,
  type CaptainOrg,
  type CaptainRunChoreResult,
  type CaptainRunnableChore,
  type CaptainStatus,
  CHORE_LABEL,
  type CommandMeta,
  type CommandName,
  commands,
  type Fact,
  PRIVATE,
  type RoomItem,
  type Spend,
} from "@majhi/shared";
import { zoneOr } from "../autonomy/service.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import type { Store } from "../store/index.ts";
import { addDays, localDay } from "../usage/ranges.ts";
import { createChores, memoryKey } from "./chores.ts";
import { LaneGate } from "./lane-gate.ts";
import type { Lanes } from "./lanes.ts";
import { authorityOf, choresNow, effectiveAuthority, migratePickOrgs, workspaceIds } from "./levels.ts";
import { laneOfScope } from "./memory-scopes.ts";
import type { CaptainPorts } from "./ports.ts";
import { CaptainRepo, type StoredAction } from "./repo.ts";
import { DAILY_CHORES, dailyCaps, MEMORY_WAITING, restWhy } from "./rules.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";
import { summaryOf } from "./summary.ts";
import { type Identity, revertMerge } from "./undo.ts";

/** How often the daily chores, the hourly checks and the daily summary are looked at. */
export const CAPTAIN_SWEEP_MS = 60_000;
/** Chores that run when something happens also look once an hour, for what a restart missed. */
const HOURLY_MS = 60 * 60_000;
/** Events about a task the captain just acted in count as the captain's for this long. */
const CAUSED_MS = 2 * 60_000;
/** A burst of triggers is looked at once. */
const TRIGGER_MS = 1_500;

/** Autonomous mode as the captain needs it: the master switch, its stop, and why a lane rests. */
export interface AutonomyLink {
  mode(): AutonomyMode;
  stopNowForCaptain(): Promise<void>;
  startForCaptain(): Promise<void>;
  /** Today's spend of the captain and autonomous work in a workspace, and its daily budget. */
  orgSpend(org: string): Promise<{ used: Spend; tz: string }>;
}

export interface CaptainDeps {
  store: Store;
  config: ConfigService;
  events: EventHub;
  autonomy: AutonomyLink;
  lanes: Lanes;
  ports: CaptainPorts;
  /** Tells the owner through the bell, once per key. */
  tell: (key: string, text: string) => void;
  /** What a thread is doing now: the captain in a turn, an item waiting on the owner, or neither. */
  threadState?: (chat: string, org: string) => "working" | "waiting" | "idle";
  /** Replaces the thread's session with a fresh one that carries a summary (the room's "fresh session"). */
  fresh?: (chat: string, agent: string) => Promise<RoomItem>;
  /** Cancels the captain's turn in a lane. */
  cancelTurn: (chat: string) => Promise<void>;
  /** The org's identity for revert commits. */
  identity: (org: string) => Promise<Identity>;
  /** Runs a command as the owner, for Undo through majhi's own paths. */
  ownerCommand: (command: string, input: unknown, meta: CommandMeta) => Promise<void>;
  /** The workspace of a task, `undefined` when it is unknown or a chat. Default: majhi's tasks. */
  taskOrg?: (task: string) => string | undefined;
  /** How long a burst of triggers is batched. Default `TRIGGER_MS`. */
  triggerMs?: number;
  now?: () => Date;
}

/**
 * The captain per workspace (SPEC 5.18): the choice per workspace, the upkeep chores under the
 * runner's guards, the stop switch, presence, the cause of events, the daily summary line and the
 * captain's log with Undo. The rules are in docs/PROGRESS.md under Phase 13.
 */
export class CaptainService {
  readonly repo: CaptainRepo;
  readonly runner: ChoreRunner;
  /** What the lane's ships and repo registrations are held to: the chores' own rules (SPEC 5.18, One rule set). */
  readonly laneGate: LaneGate;
  private sweep: NodeJS.Timeout | undefined;
  private readonly caused = new Map<string, number>();
  /** The captain as last read, so a room write can tell the captain's own cards at once. */
  private boss: string | undefined;
  private closed = false;
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; why: string; subject?: string }>();

  constructor(private readonly deps: CaptainDeps) {
    this.repo = new CaptainRepo(deps.store.raw);
    this.laneGate = new LaneGate({
      repo: this.repo,
      ports: deps.ports,
      workspace: (org) => this.workspace(org),
      now: () => this.now(),
      capAsked: (ask) => {
        this.deps.tell(`captain-cap:${ask.org}:${ask.chore}:${ask.day}`, ask.text);
        this.deps.events.emit(["captain"]);
      },
    });
    this.runner = new ChoreRunner({
      repo: this.repo,
      now: () => this.now(),
      workspace: (org) => this.workspace(org),
      stopped: () => this.stopped(),
      tellOwner: (org, text) => this.deps.tell(`captain:${org}:${this.now().toISOString()}`, text),
      caused: (subject) => this.markCaused(subject),
      laneTokens: (org, since) => {
        const chat = this.repo.lane(org);
        return chat === undefined ? 0 : this.repo.laneSpend(chat, since).tokens;
      },
      chores: createChores(deps.ports, () => this.now()),
      changed: () => this.deps.events.emit(["captain"]),
      capAsked: (ask) => {
        this.deps.tell(`captain-cap:${ask.org}:${ask.chore}:${ask.day}`, ask.text);
        this.deps.events.emit(["captain"]);
      },
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * This service closed: nothing of the captain acts. Autonomous being Off is not this: it keeps
   * memory review and cleanup going (`choresNow`) and stops everything else through the workspace's
   * authority. The captain's lanes and chats always answer.
   */
  stopped(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** After a restart: runs it cut short end as stopped, and an old pick rule moves to the choice. */
  async boot(): Promise<void> {
    this.repo.closeOpenRuns(this.now().toISOString(), "majhi restarted during the run");
    await this.migratePick().catch((err: unknown) =>
      console.error(`Could not move the autonomy workspaces to the captain's choice: ${errorMessage(err)}`),
    );
  }

  /** The pick rule "workspaces it may work in" becomes "Runs it" for each listed workspace, once. */
  async migratePick(): Promise<boolean> {
    const autonomy = (await this.deps.config.settings()).autonomy;
    const moved = migratePickOrgs(autonomy);
    if (moved === undefined) return false;
    const sections = await this.deps.config.sections();
    const names = (autonomy.pick.orgs ?? []).map((id) =>
      id === PRIVATE ? "Private" : (sections.orgs[id]?.name ?? id),
    );
    await this.deps.config.setSettings(
      { autonomy: { orgs: moved.orgs, pick: moved.pick } },
      {
        command: "config.migrate",
        meta: { actor: { kind: "agent", id: "majhi" } },
        summary:
          names.length === 0
            ? "moved autonomous mode's workspace list to the captain's choice per workspace"
            : `let the captain start work in ${names.join(", ")}, from autonomous mode's workspace list`,
      },
    );
    return true;
  }

  startSweep(): void {
    if (this.sweep !== undefined) return;
    this.sweep = setInterval(() => void this.sweepNow().catch(() => undefined), CAPTAIN_SWEEP_MS);
    this.sweep.unref();
  }

  close(): void {
    // A run still going ends at its next step, as after a restart.
    this.closed = true;
    if (this.sweep !== undefined) clearInterval(this.sweep);
    this.sweep = undefined;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** The minute sweep: daily chores once a day, the others once an hour, and the summary line. */
  async sweepNow(): Promise<void> {
    if (this.closed) return;
    const sections = await this.deps.config.sections();
    for (const org of this.closed ? [] : workspaceIds(sections.orgs)) {
      const ws = await this.workspace(org);
      if (ws === undefined || ws.rest !== undefined) continue;
      for (const chore of choresNow(ws.authority, ws.mode)) {
        if (this.runner.running(org, chore) || this.repo.chore(org, chore).offAt !== undefined) continue;
        if (DAILY_CHORES.includes(chore)) {
          if (this.repo.runsToday(org, chore, ws.day) > 0) continue;
          await this.runner.start(org, chore, "Daily run");
          continue;
        }
        const last = this.repo.lastRun(org, chore);
        if (last !== undefined && this.now().getTime() - Date.parse(last) < HOURLY_MS) continue;
        await this.runner.start(org, chore, "Hourly check");
      }
    }
    await this.dailySummary();
  }

  // ---------------------------------------------------------------------------
  // What happens in majhi

  /** The captain acted in this task: events about it count as its own for a while. */
  markCaused(subject: string): void {
    this.caused.set(subject, this.now().getTime() + CAUSED_MS);
    if (this.caused.size > 2_000) {
      const now = this.now().getTime();
      for (const [k, until] of this.caused) if (until < now) this.caused.delete(k);
    }
  }

  /** Whether the captain caused events about this subject now. */
  causedByCaptain(subject: string): boolean {
    const until = this.caused.get(subject);
    return until !== undefined && until >= this.now().getTime();
  }

  /**
   * A trigger from an event: tagged with its cause, batched for a moment, then handed to the runner,
   * which drops the captain's own and joins a run that is going.
   */
  private trigger(
    org: string,
    chore: CaptainChore,
    why: string,
    cause: "owner" | "agent" | "captain" | "majhi",
    subject?: string,
    /** Read once the burst is over: why the chore should run now, or undefined to start nothing. */
    gate?: () => Promise<string | undefined>,
  ): void {
    if (cause === "captain") {
      this.runner.selfDropped += 1;
      return;
    }
    if (this.closed) return;
    const key = `${org}:${chore}`;
    if (this.pending.has(key)) return;
    const timer = setTimeout(() => {
      const fire = async () => {
        let reason: string | undefined = why;
        try {
          if (gate !== undefined) reason = await gate();
        } catch {
          reason = undefined;
        }
        // Held in `pending` until the gate is read, so `settled` waits for it. The runner marks the
        // run as starting before its first await, so a trigger after this joins it.
        this.pending.delete(key);
        if (reason !== undefined) await this.runner.trigger({ org, chore, cause, why: reason, subject });
      };
      void fire().catch(() => undefined);
    }, this.deps.triggerMs ?? TRIGGER_MS);
    timer.unref();
    this.pending.set(key, { timer, why, ...(subject === undefined ? {} : { subject }) });
  }

  /** The workspace of a task, or undefined for a chat or a task that is gone. */
  private orgOfTask(task: string): string | undefined {
    if (this.deps.taskOrg !== undefined) return this.deps.taskOrg(task);
    const found = this.deps.store.tasks.get(task);
    if (found === undefined || found.kind === "chat") return undefined;
    return found.org ?? PRIVATE;
  }

  /** Waits until no trigger is batched and no run is going: for tests and a clean shutdown. */
  async settled(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      if (this.pending.size === 0 && !this.runner.busy()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** A task reached review: the ship chore of its workspace looks. */
  reviewReached(task: string): void {
    const org = this.orgOfTask(task);
    if (org === undefined) return;
    const cause = this.causedByCaptain(task) ? "captain" : "agent";
    this.trigger(org, "ship", `${task} reached review`, cause, task);
  }

  /** A room item was written: a new card or question wakes the chore that answers it. */
  roomWrote(task: string, item: RoomItem, captain: string | undefined = this.boss): void {
    let org: string | undefined;
    try {
      // The captain's own lanes start nothing.
      if (this.deps.lanes.orgOf(task) !== undefined) return;
      org = this.orgOfTask(task);
    } catch {
      return;
    }
    if (org === undefined) return;
    const agent = "agent" in item && typeof item.agent === "string" ? item.agent : undefined;
    const cause = agent !== undefined && agent === captain ? "captain" : "agent";
    if (item.type === "approval" && item.state === "pending" && item.autonomy === undefined) {
      this.trigger(org, "cards", `A card arrived in ${task}`, cause, `${task}:${item.id}`);
      return;
    }
    const question =
      (item.type === "ask" || item.type === "choice" || item.type === "owner-question") &&
      item.state === "pending";
    const prompt = item.type === "permission" && item.state === "pending" && item.connection === undefined;
    if (question || prompt)
      this.trigger(org, "questions", `An agent asks in ${task}`, cause, `${task}:${item.id}`);
  }

  /** The repo scan found repos: a new one wakes the projects chore of the workspace whose folder holds it. */
  reposSeen(orgs: readonly string[]): void {
    for (const org of new Set(orgs)) this.trigger(org, "projects", "A new repo appeared", "majhi");
  }

  /**
   * Curation left a memory waiting for review. Once the workspace that reviews it has
   * `MEMORY_WAITING` memories its chore has not looked at, the memory chore runs, not only daily.
   * A memory from the captain's own lane, or from a task it just acted in, starts nothing.
   */
  async memoryWaiting(fact: Pick<Fact, "scope" | "task">): Promise<void> {
    // Not by agent: the Housekeeper is the captain's agent unless the owner picked another.
    const task = fact.task;
    const own =
      task !== undefined && (this.causedByCaptain(task) || this.deps.lanes.orgOf(task) !== undefined);
    const org = laneOfScope(fact.scope, (await this.deps.config.sections()).projects);
    if (org === undefined) return;
    this.trigger(org, "memory", "Memories wait", own ? "captain" : "agent", undefined, async () => {
      const waiting = (await this.deps.ports.pendingFacts(org)).filter(
        (f) => !this.repo.hasAction(memoryKey(f.id)),
      ).length;
      return waiting >= MEMORY_WAITING ? `${waiting} memories wait for review` : undefined;
    });
  }

  /**
   * The owner stopped typing in a task (sent, left or went quiet) that the captain waited on: the
   * chores that wait on typing look again, now (SPEC 5.18, Presence).
   */
  ownerIdle(task: string): void {
    const org = this.orgOfTask(task);
    if (org === undefined) return;
    for (const chore of ["ship", "cards", "questions"] as const) {
      this.trigger(org, chore, `You stopped typing in ${task}`, "majhi", task);
    }
  }

  // ---------------------------------------------------------------------------
  // The workspace as the captain sees it

  async workspace(org: string): Promise<Workspace | undefined> {
    const [sections, settings] = await Promise.all([
      this.deps.config.sections(),
      this.deps.config.settings(),
    ]);
    if (org !== PRIVATE && sections.orgs[org] === undefined) return undefined;
    this.boss = sections.boss;
    if (sections.boss === undefined) return undefined;
    return this.workspaceOf(org, settings.autonomy, sections.orgs[org]?.name);
  }

  private workspaceOf(org: string, autonomy: AutonomySettings, name: string | undefined): Workspace {
    const rules = autonomy.orgs[org];
    const tz = zoneOr(rules?.tz ?? autonomy.tz);
    const now = this.now();
    const rest = restWhy(rules, now, tz);
    return {
      org,
      name: name ?? (org === PRIVATE ? "Private" : org),
      mode: this.deps.autonomy.mode(),
      authority: effectiveAuthority(authorityOf(autonomy, org), this.deps.autonomy.mode()),
      rules,
      tz,
      day: localDay(now, tz),
      ...(rest === undefined ? {} : { rest }),
    };
  }

  // ---------------------------------------------------------------------------
  // What the owner reads and does

  async status(): Promise<CaptainStatus> {
    const [sections, settings] = await Promise.all([
      this.deps.config.sections(),
      this.deps.config.settings(),
    ]);
    const state = this.repo.state();
    const mode = this.deps.autonomy.mode();
    const orgs: CaptainOrg[] = [];
    let day = localDay(this.now(), zoneOr(settings.autonomy.tz));
    for (const org of workspaceIds(sections.orgs)) {
      const ws = this.workspaceOf(org, settings.autonomy, sections.orgs[org]?.name);
      if (org === PRIVATE) day = ws.day;
      const authority = authorityOf(settings.autonomy, org);
      const { line, forYou } = summaryOf(this.repo.dayActions(org, ws.day));
      const spend = await this.deps.autonomy
        .orgSpend(org)
        .catch(() => ({ used: { tokens: 0, cost: 0 }, tz: ws.tz }));
      const lane = this.deps.lanes.chat(org);
      const cap = settings.autonomy.orgs[org]?.cap;
      orgs.push({
        org,
        name: ws.name,
        authority,
        effective: ws.authority,
        rules: settings.autonomy.orgs[org] ?? {},
        ...(cap === undefined ? {} : { budget: cap }),
        used: spend.used,
        summary: line,
        forYou,
        ...(ws.rest === undefined ? {} : { resting: ws.rest }),
        ...(lane === undefined ? {} : { lane }),
        thread: lane === undefined ? "idle" : (this.deps.threadState?.(lane, org) ?? "idle"),
        chores: choresNow(authority, mode).map((chore) => {
          const c = this.repo.chore(org, chore);
          const caps = dailyCaps(chore, this.repo.capRaised(org, chore, ws.day));
          const last = this.repo.lastRun(org, chore);
          return {
            chore,
            ...(this.runner.running(org, chore) ? { running: true as const } : {}),
            ...(c.offWhy === undefined ? {} : { off: c.offWhy }),
            today:
              caps.actions !== undefined
                ? this.repo.actionsToday(org, chore, ws.day)
                : this.repo.runsToday(org, chore, ws.day),
            cap: caps.actions ?? caps.runs ?? 1,
            ...(last === undefined ? {} : { lastRun: last }),
          };
        }),
      });
    }
    return {
      // The captain is never stopped; the field stays for older clients. The switch is `autonomy`.
      stopped: false,
      autonomy: mode,
      ...(sections.boss === undefined ? {} : { captain: sections.boss }),
      day,
      orgs,
    };
  }

  log(q: { org?: string | undefined; before?: number | undefined; limit: number }) {
    return {
      actions: this.repo.actions(q).map(publicAction),
      runs: this.repo.runs({ org: q.org, limit: Math.min(q.limit, 50) }),
    };
  }

  /**
   * The old "Stop the captain" is now turning Autonomous off and pausing its tasks: every upkeep run
   * ends at its next step and the lanes' turns end. The captain still answers when spoken to.
   */
  async stop(): Promise<CaptainStatus> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.deps.autonomy.mode() !== "off") await this.deps.autonomy.stopNowForCaptain();
    this.deps.events.emit(["captain", "autonomy"]);
    return this.status();
  }

  /** The old "Resume the captain" is turning Autonomous on, resuming the tasks it paused. */
  async resume(): Promise<CaptainStatus> {
    await this.deps.autonomy.startForCaptain();
    this.deps.events.emit(["captain", "autonomy"]);
    return this.status();
  }

  /**
   * "Start fresh" in a workspace's thread: the session ends and a new one starts, seeded with the
   * summary majhi's fresh-session handoff writes (the agent's own note, else one built from the
   * saved state). The thread's messages stay, and the room shows the summary as an item.
   */
  async startFresh(org: string): Promise<{ item: RoomItem }> {
    const chat = this.deps.lanes.chat(org);
    const agent = chat === undefined ? undefined : this.deps.store.tasks.get(chat)?.team[0];
    if (chat === undefined || agent === undefined || this.deps.fresh === undefined) {
      throw new UserError("That workspace has no captain thread yet.", 404);
    }
    const item = await this.deps.fresh(chat, agent);
    this.deps.events.emit(["captain"]);
    return { item };
  }

  /**
   * "Review now": one run of the memory or cleanup chore of a workspace, started by the owner. The
   * answer comes at once; the run goes on in the background and the status shows it running.
   */
  async runChore(org: string, chore: CaptainRunnableChore): Promise<CaptainRunChoreResult> {
    const started = await this.runner.startNow(org, chore);
    if (!started.ran) return { started: false, text: started.why, overCap: false };
    this.deps.events.emit(["captain"]);
    void started.done.catch(() => undefined).finally(() => this.deps.events.emit(["captain"]));
    const label = CHORE_LABEL[chore].toLowerCase();
    return {
      started: true,
      overCap: started.overCap,
      text: started.overCap
        ? `Started ${label}. Today's limit was reached, and this run goes past it because you asked.`
        : `Started ${label}.`,
    };
  }

  async choreOn(org: string, chore: CaptainChore): Promise<CaptainStatus> {
    this.repo.turnOn(org, chore);
    this.deps.events.emit(["captain"]);
    return this.status();
  }

  /** The questions about daily caps that wait for the owner, of each workspace's today only. */
  async asks(): Promise<{ asks: CaptainCapAsk[] }> {
    const settings = (await this.deps.config.settings()).autonomy;
    const today = (org: string) => localDay(this.now(), zoneOr(settings.orgs[org]?.tz ?? settings.tz));
    return { asks: this.repo.pendingCapAsks().filter((a) => a.day === today(a.org)) };
  }

  /**
   * The owner's answer about a chore that reached its daily cap today. Raise doubles the chore's caps
   * for that day only, and the chore looks again at once; Leave it keeps them.
   */
  async answerCap(
    org: string,
    chore: CaptainChore,
    answer: "raise" | "leave",
  ): Promise<{ asks: CaptainCapAsk[] }> {
    const ask = (await this.asks()).asks.find((a) => a.org === org && a.chore === chore);
    if (ask === undefined) {
      throw new UserError(
        `The captain is not asking about ${CHORE_LABEL[chore].toLowerCase()} in ${org} today.`,
        409,
      );
    }
    this.repo.answerCapAsk(
      org,
      chore,
      ask.day,
      answer === "raise" ? "raised" : "left",
      this.now().toISOString(),
    );
    this.deps.events.emit(["captain"]);
    if (answer === "raise") {
      void this.runner.start(org, chore, "The owner raised today's limit").catch(() => undefined);
    }
    return this.asks();
  }

  /** Undo one action of the log through majhi's own paths. */
  async undo(
    id: number,
    meta: CommandMeta,
  ): Promise<{ action: ReturnType<typeof publicAction>; detail: string }> {
    const action = this.repo.action(id);
    if (action === undefined) throw new UserError(`There is no action ${id} in the captain's log.`, 404);
    if (action.undoneAt !== undefined) throw new UserError("That action is already undone.", 409);
    const undo = action.undoData;
    if (undo === undefined) {
      throw new UserError(action.undoNote ?? "That action cannot be undone.", 409);
    }
    let detail: string;
    switch (undo.kind) {
      case "revert": {
        const identity = await this.deps.identity(action.org);
        const heads: string[] = [];
        for (const repo of undo.repos) {
          const head = await revertMerge(
            repo,
            identity,
            `Revert the captain's merge of ${action.task ?? "a task"} into ${repo.into}`,
          );
          if (head !== undefined) heads.push(`${repo.project} ${repo.into} at ${head.slice(0, 8)}`);
        }
        detail =
          heads.length === 0
            ? "The merge changed nothing to revert."
            : `Reverted with a new commit: ${heads.join(", ")}.`;
        break;
      }
      case "config":
        await this.deps.ownerCommand("history.undo", { commit: undo.commit }, meta);
        detail = "Reverted the config change through the config history.";
        break;
      case "task":
        await this.deps.ownerCommand(
          "tasks.update",
          { id: undo.task, priority: undo.priority, due: undo.due },
          meta,
        );
        detail = `Put ${undo.task}'s priority and due date back.`;
        break;
      case "memory":
        await this.deps.ownerCommand("memory.undo", { event: undo.event }, meta);
        detail = "Undid the memory step.";
        break;
    }
    this.repo.markUndone(id, this.now().toISOString());
    this.deps.events.emit(["captain"]);
    const after = this.repo.action(id) ?? action;
    return { action: publicAction(after), detail };
  }

  /**
   * Once a day at autonomous mode's summary time, the bell gets one line per workspace for the day
   * before. Nothing when no workspace did anything.
   */
  async dailySummary(): Promise<string | undefined> {
    const [sections, settings] = await Promise.all([
      this.deps.config.sections(),
      this.deps.config.settings(),
    ]);
    const tz = zoneOr(settings.autonomy.tz);
    const now = this.now();
    const today = localDay(now, tz);
    const [h = 8, m = 0] = settings.autonomy.summary_at.split(":").map(Number);
    const clock = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    if (clock < `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`) return undefined;
    if (!this.repo.markSummary(today)) return undefined;
    const yesterday = addDays(today, -1);
    const lines: string[] = [];
    for (const org of workspaceIds(sections.orgs)) {
      const { line } = summaryOf(this.repo.dayActions(org, yesterday));
      if (line !== "")
        lines.push(`${org === PRIVATE ? "Private" : (sections.orgs[org]?.name ?? org)}: ${line}`);
    }
    if (lines.length === 0) return undefined;
    const text = `The captain yesterday. ${lines.join(". ")}.`;
    this.deps.tell(`captain-summary:${today}`, text);
    return text;
  }

  /** The chore's label, for lines elsewhere. */
  static label(chore: CaptainChore): string {
    return CHORE_LABEL[chore];
  }
}

function publicAction(a: StoredAction) {
  const { key: _key, run: _run, undoData: _undo, ...rest } = a;
  return rest;
}
