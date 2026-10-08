import {
  type AutonomyMode,
  type AutonomySettings,
  type CaptainBlocker,
  type CaptainChore,
  type CaptainOrg,
  type CaptainRunChoreResult,
  type CaptainRunnableChore,
  type CaptainStatus,
  CHORE_LABEL,
  type CommandMeta,
  type Job,
  type Fact,
  PRIVATE,
  type RoomItem,
  restOf,
  type Spend,
} from "@majhi/shared";
import { zoneOr } from "../autonomy/service.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { type ChorePlaybooks, DefaultChorePlays } from "../playbooks/chore-plays.ts";
import type { Store } from "../store/index.ts";
import { addDays, localDay } from "../usage/ranges.ts";
import { createChores, memoryKey } from "./chores.ts";
import { LaneGate } from "./lane-gate.ts";
import type { Lanes } from "./lanes.ts";
import { authorityOf, choresNow, migratePickOrgs, workspaceIds } from "./levels.ts";
import { laneOfScope } from "./memory-scopes.ts";
import { captainPolicyOf } from "./policy.ts";
import type { CaptainPorts } from "./ports.ts";
import { CaptainRepo, type StoredAction } from "./repo.ts";
import { MEMORY_WAITING, pausedToday, restHolds } from "./rules.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";
import { summaryOf } from "./summary.ts";
import { type Identity, revertMerge } from "./undo.ts";

/** How often the daily chores, the hourly checks and the daily summary are looked at. */
export const CAPTAIN_SWEEP_MS = 60_000;
/** Chores that run when something happens also look once an hour, for what a restart missed. */
const HOURLY_MS = 60 * 60_000;
/** A burst of triggers is looked at once. */
const TRIGGER_MS = 1_500;

/** Autonomous mode as the captain needs it: the master switch, its stop, and why a lane rests. */
export interface AutonomyLink {
  mode(): AutonomyMode;
  /** Stop everything was pressed: end the captain's turns and pause the tasks it drives. */
  haltNow(): Promise<void>;
  /** Stop everything was pressed again. */
  resumeHalt(): Promise<void>;
  /** Today's spend of the captain and autonomous work in every workspace, read once. */
  orgSpends(): Promise<{ of: (org: string) => Spend; tz: string }>;
}

export interface CaptainDeps {
  /** The one repo of the captain's tables: the Stop switch is read through it everywhere. */
  repo?: CaptainRepo;
  store: Store;
  config: ConfigService;
  events: EventHub;
  autonomy: AutonomyLink;
  lanes: Lanes;
  ports: CaptainPorts;
  /** Tells the owner through the bell, once per key. */
  tell: (key: string, text: string) => void;
  /** What a thread is doing now: the captain in a turn, an item waiting on the owner, or neither. */
  /** Takes the state of the room once, then answers per lane: a status asks for every workspace. */
  threadState?: () => (chat: string, org: string) => "working" | "waiting" | "idle";
  /** Replaces the thread's session with a fresh one that carries a summary (the room's "fresh session"). */
  fresh?: (chat: string, agent: string) => Promise<RoomItem>;
  /** Cancels the captain's turn in a lane. */
  cancelTurn: (chat: string) => Promise<void>;
  /** An action was undone: the trust ladder looks at once. */
  undone?: () => void;
  /** The org's identity for revert commits. */
  identity: (org: string) => Promise<Identity>;
  /** Runs a command as the owner, for Undo through majhi's own paths. */
  ownerCommand: (command: string, input: unknown, meta: CommandMeta) => Promise<void>;
  /** How many open owner cards the workspace has: the Needs you count, so the lane and the list agree. */
  ownerCards?: (org: string) => Promise<number>;
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
  /** The captain as last read, so a room write can tell the captain's own cards at once. */
  private boss: string | undefined;
  private closed = false;
  /** When each chore is due and whether it is on: the playbooks. Replaced by the scheduler with the owner's changes. */
  private plays: ChorePlaybooks;
  /** The rest of the playbook scheduler, run in the same minute sweep. */
  private playbookSweep: (() => Promise<void>) | undefined;
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; why: string; subject?: string }>();

  constructor(private readonly deps: CaptainDeps) {
    this.plays = new DefaultChorePlays(undefined, () => this.now());
    this.repo = deps.repo ?? new CaptainRepo(deps.store.raw);
    this.laneGate = new LaneGate({
      repo: this.repo,
      ports: deps.ports,
      workspace: (org) => this.workspace(org),
      now: () => this.now(),
    });
    this.runner = new ChoreRunner({
      repo: this.repo,
      now: () => this.now(),
      workspace: (org) => this.workspace(org),
      stopped: () => this.stopped(),
      tellOwner: (org, text) => this.deps.tell(`captain:${org}:${this.now().toISOString()}`, text),
      laneTokens: (org, since) => {
        return this.repo
          .lanes()
          .filter((l) => l.org === org)
          .reduce((sum, l) => sum + this.repo.laneSpend(l.chat, since).tokens, 0);
      },
      chores: createChores(deps.ports, () => this.now()),
      enabled: (org, chore) => this.plays.enabled(org, chore),
      afterRun: (org, chore, did) => this.plays.afterRun(org, chore, did),
      changed: () => this.deps.events.emit(["captain"]),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The playbook scheduler takes over when the chores are due and whether they are on, and sweeps the rest. */
  usePlaybooks(plays: ChorePlaybooks, sweep: () => Promise<void>): void {
    this.plays = plays;
    this.playbookSweep = sweep;
  }

  /**
   * This service closed, or the owner pressed Stop everything: nothing of the captain acts. Auto-pilot
   * being Off is not this: it holds only the backlog work (`may.ts`).
   */
  stopped(): boolean {
    return this.closed || this.repo.isStopped();
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
            ? "moved Auto-pilot's workspace list to the captain's choice per workspace"
            : `let the captain start work in ${names.join(", ")}, from Auto-pilot's workspace list`,
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
      if (ws === undefined) continue;
      for (const chore of choresNow(ws.authority, ws, ws.rules?.ships)) {
        if (ws.rest !== undefined && restHolds(chore)) continue;
        if (
          this.runner.running(org, chore) ||
          pausedToday(this.repo.chore(org, chore).offAt, this.now(), ws.tz)
        )
          continue;
        const why = this.plays.due(org, chore, ws, {
          any: this.repo.lastRun(org, chore),
          worked: this.repo.lastWorkedRun(org, chore),
        });
        if (why !== undefined) await this.runner.start(org, chore, why);
      }
    }
    await this.playbookSweep?.().catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // What happens in majhi

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
    this.trigger(org, "ship", `${task} reached review`, "agent", task);
  }

  /** A deploy went live: the next environment of its project may go now, so the ship chore looks again. */
  deployChanged(org: string): void {
    this.trigger(org, "ship", "A deploy went live", "majhi");
  }

  /** A room item was written: a new card or question wakes the chore that answers it. */
  roomWrote(task: string, item: RoomItem, captain: string | undefined = this.boss): void {
    // Most items (tool calls, text, plans) wake nothing: decide that before any task lookup.
    const card = item.type === "approval" && item.state === "pending" && item.autonomy === undefined;
    const question =
      (item.type === "ask" || item.type === "choice" || item.type === "owner-question") &&
      item.state === "pending";
    const prompt = item.type === "permission" && item.state === "pending" && item.connection === undefined;
    if (!card && !question && !prompt) return;
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
    if (card) {
      this.trigger(org, "cards", `A card arrived in ${task}`, cause, `${task}:${item.id}`);
      return;
    }
    if (question || prompt)
      this.trigger(org, "questions", `An agent asks in ${task}`, cause, `${task}:${item.id}`);
  }

  /** An org's git accounts or MR tokens changed: cards left for a missing sign-in are looked at again. */
  /**
   * A new majhi version may unblock what waited: a fixed check, a new tool, a higher cap. Every
   * workspace's cards, ship and tidy chores run once right away instead of at the next hourly check.
   */
  afterUpdate(orgs: readonly string[]): void {
    for (const org of new Set(orgs)) {
      for (const chore of ["cards", "ship", "tidy"] as const)
        this.trigger(org, chore, "majhi was updated", "majhi");
    }
  }

  gitChanged(org: string): void {
    this.trigger(org, "cards", "A git account changed", "majhi");
    this.trigger(org, "ship", "A git account changed", "majhi");
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
    const own = task !== undefined && this.deps.lanes.orgOf(task) !== undefined;
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
    const now = this.now();
    const policy = captainPolicyOf(autonomy, org, {
      name: name ?? (org === PRIVATE ? "Private" : org),
      autopilot: this.deps.autonomy.mode(),
      stopped: this.repo.isStopped(),
    });
    const { tz } = policy;
    const rest = restOf(policy, now);
    const off = this.plays.rulesOff(org);
    return {
      org,
      name: policy.name,
      mode: policy.autopilot,
      stopped: policy.stopped,
      authority: policy.authority,
      rules,
      ...(off.length === 0 ? {} : { rulesOff: new Set(off) }),
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
    const threadOf = this.deps.threadState?.();
    const spends = await this.deps.autonomy
      .orgSpends()
      .catch(() => ({ of: (): Spend => ({ tokens: 0, cost: 0 }), tz: "" }));
    let day = localDay(this.now(), zoneOr(settings.autonomy.tz));
    const asking = this.deps.store.room.pendingPermissions();
    for (const org of workspaceIds(sections.orgs)) {
      const ws = this.workspaceOf(org, settings.autonomy, sections.orgs[org]?.name);
      if (org === PRIVATE) day = ws.day;
      const authority = authorityOf(settings.autonomy, org);
      const forYou = (await this.deps.ownerCards?.(org)) ?? 0;
      const line = summaryOf(this.repo.dayActions(org, ws.day), forYou);
      const spend = { used: spends.of(org) };
      const lane = this.deps.lanes.chat(org);
      const onCall = this.deps.lanes.chat(org, "reacting");
      const cap = settings.autonomy.orgs[org]?.cap;
      const paid = await this.deps.lanes.account(org).catch(() => undefined);
      orgs.push({
        org,
        name: ws.name,
        authority,
        rules: settings.autonomy.orgs[org] ?? {},
        ...(cap === undefined ? {} : { budget: cap }),
        used: spend.used,
        summary: line,
        forYou,
        ...(ws.rest === undefined ? {} : { resting: ws.rest }),
        ...(paid === undefined || "problem" in paid ? {} : { pays: paid.account }),
        ...(lane === undefined ? {} : { lane }),
        thread: lane === undefined ? "idle" : (threadOf?.(lane, org) ?? "idle"),
        ...(onCall === undefined ? {} : { onCall }),
        urgent: onCall === undefined ? "idle" : (threadOf?.(onCall, org) ?? "idle"),
        ...blockerOf(paid, asking, [onCall, lane]),
        chores: choresNow(
          authority,
          { mode, stopped: state.stopped },
          settings.autonomy.orgs[org]?.ships,
        ).map((chore) => {
          const c = this.repo.chore(org, chore);
          const last = this.repo.lastRun(org, chore);
          return {
            chore,
            ...(this.runner.running(org, chore) ? { running: true as const } : {}),
            ...(c.offWhy === undefined || !pausedToday(c.offAt, this.now(), ws.tz) ? {} : { off: c.offWhy }),
            today: this.repo.actionsToday(org, chore, ws.day),
            ...(last === undefined ? {} : { lastRun: last }),
          };
        }),
      });
    }
    return {
      stopped: state.stopped,
      ...(state.stoppedAt === undefined ? {} : { stoppedAt: state.stoppedAt }),
      autonomy: mode,
      ...(sections.boss === undefined ? {} : { captain: sections.boss }),
      day,
      orgs,
    };
  }

  log(q: {
    org?: string | undefined;
    before?: number | undefined;
    after?: number | undefined;
    limit: number;
  }) {
    return {
      actions: this.repo.actions(q).map(publicAction),
      // A catch-up read (`after`) carries only the newest runs: the tab merges them by id.
      runs: this.repo.runs({ org: q.org, limit: q.after === undefined ? Math.min(q.limit, 50) : 5 }),
    };
  }

  /**
   * Stop everything: every captain run ends at its next step, the lanes' turns end, the tasks the captain
   * drives pause, and nothing new starts until it is pressed again. Auto-pilot's switch is not touched.
   */
  async stop(): Promise<CaptainStatus> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.repo.setStopped(true, this.now().toISOString());
    this.deps.events.emit(["captain", "autonomy"]);
    await this.deps.autonomy.haltNow();
    return this.status();
  }

  /** Stop everything pressed again: the captain works as its Permissions and Auto-pilot say. */
  async resume(): Promise<CaptainStatus> {
    this.repo.setStopped(false, this.now().toISOString());
    await this.deps.autonomy.resumeHalt();
    // What came in while it was stopped is looked at now, not at the next event.
    for (const org of workspaceIds((await this.deps.config.sections()).orgs)) {
      for (const chore of ["ship", "cards", "questions"] as const) {
        this.trigger(org, chore, "Stop everything was lifted", "owner");
      }
    }
    this.deps.events.emit(["captain", "autonomy"]);
    return this.status();
  }

  /**
   * "Start fresh" in a workspace's thread: the session ends and a new one starts, seeded with the
   * summary majhi's fresh-session handoff writes (the agent's own note, else one built from the
   * saved state). The thread's messages stay, and the room shows the summary as an item.
   */
  async startFresh(org: string, job: Job = "backlog"): Promise<{ item: RoomItem }> {
    const chat = this.deps.lanes.chat(org, job);
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
    if (!started.ran) return { started: false, text: started.why };
    this.deps.events.emit(["captain"]);
    void started.done.catch(() => undefined).finally(() => this.deps.events.emit(["captain"]));
    const label = CHORE_LABEL[chore].toLowerCase();
    return { started: true, text: `Started ${label}.` };
  }

  async choreOn(org: string, chore: CaptainChore): Promise<CaptainStatus> {
    this.repo.turnOn(org, chore);
    this.deps.events.emit(["captain"]);
    return this.status();
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
      case "rollback":
        await this.deps.ownerCommand("projects.rollback", { record: undo.record }, meta);
        detail = "Rolled the target back.";
        break;
    }
    this.repo.markUndone(id, this.now().toISOString());
    this.deps.events.emit(["captain"]);
    // The owner took the action back: the ladder drops its line to You and says so now, not at the next sweep.
    this.deps.undone?.();
    const after = this.repo.action(id) ?? action;
    return { action: publicAction(after), detail };
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

/** The permission card waiting in a lane, or the account that cannot pay: the one thing the owner can answer to unblock it. */
function blockerOf(
  paid: { problem: string } | { account: string; own: boolean } | undefined,
  asking: readonly RoomItem[],
  chats: readonly (string | undefined)[],
): { blocker: CaptainBlocker } | Record<string, never> {
  if (paid !== undefined && "problem" in paid) return { blocker: { kind: "account", why: paid.problem } };
  // The on-call lane first: a client's message waits there.
  for (const item of chats.flatMap((chat) => asking.filter((i) => i.task === chat))) {
    if (item.type !== "permission") continue;
    const allow = item.options.find((o) => o.kind === "allow_once");
    const deny = item.options.find((o) => o.kind === "reject_once");
    if (allow === undefined || deny === undefined) continue;
    return {
      blocker: {
        kind: "permission",
        task: item.task,
        item: item.id,
        title: item.title,
        allow: allow.id,
        deny: deny.id,
      },
    };
  }
  return {};
}
