import { randomUUID } from "node:crypto";
import type { Task, TaskId } from "@majhi/shared";
import { waitsForOwner } from "@majhi/shared";
import { isBossChat } from "../admin/boss.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { RunManager } from "./manager.ts";
import { NetworkWatch, type Probe } from "./network.ts";
import { ResumeDrip, RESUME_GAP_MS } from "./resume-drip.ts";

/** What the coordinator needs of the task service: the status changes that follow pauses and resumes. */
export interface TaskHooks {
  /** Done tasks other work hangs on, handled in one pass. */
  reconcileDone(ids: readonly string[]): Promise<void>;
  pausedByRuns(
    id: string,
    reason: "offline" | "error" | "limit" | "owner" | "signed-out",
    why?: string,
  ): Promise<void>;
  /** A turn ended with nothing queued: the task moves to review when no agent is still working. */
  agentsIdle(id: string): Promise<void>;
}

/** What the room says when a restart left a task running that nothing could bring back. */
const LOST_LINE = "majhi restarted and could not resume this; Resume to continue.";

/** How often paused-for-sign-in tasks look at their accounts. */
const SIGN_IN_CHECK_MS = 30_000;

export interface ResilienceDeps {
  runs: RunManager;
  tasks: TaskHooks;
  store: Store;
  room: RoomService;
  config: ConfigService;
  probe: Probe;
  probeMs?: number;
  /** Runner containers: when the connection is back, any left without a live run are removed. */
  runners?: { prune(): Promise<unknown> } | undefined;
  /** A fresh check of an account: true when it can run agents (signed in). Absent: signed-out pauses wait for the owner. */
  accountSignedIn?: (account: string) => Promise<boolean>;
  /** In ms. Tests pass a fake clock. */
  now?: () => number;
  /** True when one more run may come back after a restart (a free run, a calm machine). Absent: always. */
  resumeReady?: () => Promise<boolean>;
  /** Gap between runs coming back after a restart. */
  resumeGapMs?: number;
  /** Waits. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resume without the owner clicking anything (SPEC 5.7): turns cut by a restart or crash,
 * turns paused while offline, and turns that failed or stalled while the computer slept. Orgs can
 * turn automatic resume off; then the task waits, paused, for the owner.
 */
export class Resilience {
  readonly network: NetworkWatch;
  private signInTimer: NodeJS.Timeout | undefined;
  private readonly drip: ResumeDrip;

  constructor(private readonly deps: ResilienceDeps) {
    this.drip = new ResumeDrip({
      gapMs: deps.resumeGapMs ?? RESUME_GAP_MS,
      ready: deps.resumeReady ?? (() => Promise.resolve(true)),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())),
    });
    this.network = new NetworkWatch({
      probe: deps.probe,
      ...(deps.probeMs === undefined ? {} : { intervalMs: deps.probeMs }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      onChange: (online) => void this.networkChanged(online).catch(() => undefined),
      // Turns still streaming when offline was declared pause once they go quiet.
      onStillOffline: () => void deps.runs.pauseForOffline().catch(() => undefined),
    });
  }

  start(): void {
    this.network.start();
    if (this.deps.accountSignedIn !== undefined && this.signInTimer === undefined) {
      this.signInTimer = setInterval(() => void this.checkSignIns().catch(() => undefined), SIGN_IN_CHECK_MS);
      this.signInTimer.unref();
    }
  }

  stop(): void {
    this.drip.stop();
    this.network.stop();
    if (this.signInTimer !== undefined) clearInterval(this.signInTimer);
    this.signInTimer = undefined;
  }

  /**
   * Tasks paused because no agent could start (its account was signed out) continue by
   * themselves once every account that held them is signed in again.
   */
  async checkSignIns(): Promise<void> {
    const { runs, store, accountSignedIn } = this.deps;
    if (accountSignedIn === undefined) return;
    const byTask = new Map<string, Set<string>>();
    for (const { task, account } of runs.pausedSignedOut()) {
      byTask.set(task, (byTask.get(task) ?? new Set()).add(account));
    }
    if (byTask.size === 0) return;
    const healthy = new Map<string, boolean>();
    for (const accounts of byTask.values()) {
      for (const id of accounts) {
        if (!healthy.has(id)) healthy.set(id, await accountSignedIn(id).catch(() => false));
      }
    }
    for (const [id, accounts] of byTask) {
      if (![...accounts].every((a) => healthy.get(a) === true)) continue;
      const task = store.tasks.get(id);
      if (task === undefined || task.status !== "paused" || waitsForOwner(task.pausedReason)) continue;
      if (await this.autoResume(task)) runs.resumeStarts(id, "the account is signed in again");
    }
  }

  /** `resume.auto` for the task's org: the org's own value, else majhi's. */
  async autoResume(task: Task): Promise<boolean> {
    const [settings, sections] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
    ]);
    const org = sections.orgs[task.org ?? "private"];
    return org?.resume?.auto ?? settings.resume.auto;
  }

  /** `resume.handoff` for the task's org: whether the fallback takes over at an account's limit. */
  async handoffOn(task: Task): Promise<boolean> {
    const [settings, sections] = await Promise.all([
      this.deps.config.settings(),
      this.deps.config.sections(),
    ]);
    const org = sections.orgs[task.org ?? "private"];
    return org?.resume?.handoff ?? settings.resume.handoff;
  }

  /**
   * At server start: tasks waiting on work that finished while majhi was down start, and turns
   * that were cut by the restart or a crash continue.
   */
  async startup(): Promise<void> {
    const { store, runs, tasks } = this.deps;
    // One pass, three queries: only done tasks that something waits on, parents or open merge requests need a look.
    const links = store.tasks.allLinks();
    const hung = new Set<string>([...links.map((l) => l.other), ...links.filter((l) => l.type === "parent").map((l) => l.task)]);
    for (const id of store.tasks.unmergedMrs()) hung.add(id);
    const done = store.tasks.statuses();
    await tasks
      .reconcileDone([...hung].filter((id) => done.get(id) === "done"))
      .catch(() => undefined);
    const handled = new Set<string>();
    const comeBack: { task: TaskId; agent: string }[] = [];
    for (const { task: id, agent } of store.runs.interrupted()) {
      handled.add(id);
      const task = store.tasks.get(id);
      // Gone, finished, or stopped by the owner: nothing to continue.
      if (
        task === undefined ||
        task.status === "done" ||
        (task.status === "paused" && waitsForOwner(task.pausedReason))
      ) {
        store.runs.setInFlight(id, agent, 0, false);
        continue;
      }
      try {
        if (await this.autoResume(task)) {
          comeBack.push({ task: task.id, agent });
        } else {
          runs.markInterrupted(task.id, agent);
          await tasks.pausedByRuns(task.id, "error");
          this.note(
            task.id,
            `majhi restarted while @${agent} was working. Automatic resume is off for this org, so resume the task when you are ready.`,
          );
        }
      } catch (err) {
        await this.lost(task.id, `Could not resume @${agent} after the restart: ${errorMessage(err)}`);
      }
    }
    // One by one, in the background: a restart must not start every run in the same minute.
    void this.drip
      .run(comeBack, (r) => {
        try {
          runs.resumeAfterRestart(r.task, r.agent);
        } catch (err) {
          void this.lost(r.task, `Could not resume @${r.agent} after the restart: ${errorMessage(err)}`);
        }
      })
      .catch(() => undefined);
    await this.wakeStranded(handled);
  }

  /**
   * The one reconcile of a restart: a task left running with no live run and no resume on its way
   * ends in an honest state. Code and ops tasks: the lead is told to go on when auto resume is on
   * (background processes live in memory, so the task may have been waiting on one), else the task
   * pauses with reason `error`. An idle chat is not work in progress: it goes to review, as when its
   * turn ends. Anything that cannot be woken pauses the same way, never stays "running".
   */
  private async wakeStranded(handled: Set<string>): Promise<void> {
    const { store, runs, tasks } = this.deps;
    for (const { id, status } of store.tasks.list(false)) {
      if (status !== "running" || handled.has(id)) continue;
      const task = store.tasks.get(id);
      if (task === undefined || handled.has(id)) continue;
      if (task.status !== "running" || isBossChat(task)) continue;
      if (runs.working(task.id).length > 0) continue;
      try {
        if (task.kind === "chat") {
          await tasks.agentsIdle(task.id);
          continue;
        }
        const agent = this.lastAgent(task);
        if (agent === undefined) {
          await this.lost(task.id, `majhi restarted and no agent is left to wake. ${LOST_LINE}`);
        } else if (await this.autoResume(task)) {
          runs.notify(
            task.id,
            agent,
            "majhi restarted, and background processes from before the restart were stopped without reporting back. Start again any you were waiting on, then carry on.",
          );
          this.note(
            task.id,
            `majhi restarted while @${agent} waited on a background process. Waking @${agent}.`,
          );
        } else {
          await this.lost(
            task.id,
            `majhi restarted while @${agent} waited on a background process. Automatic resume is off for this org, so resume the task when you are ready.`,
          );
        }
      } catch (err) {
        await this.lost(task.id, `${LOST_LINE} (${errorMessage(err)})`);
      }
    }
  }

  /** A task nothing could bring back after a restart: paused with reason `error`, one line in its room. */
  private async lost(task: TaskId, text: string): Promise<void> {
    this.note(task, text);
    await this.deps.tasks.pausedByRuns(task, "error", LOST_LINE).catch(() => undefined);
  }

  /** The team agent that acted last in the task's room. */
  private lastAgent(task: Task): string | undefined {
    for (const item of this.deps.store.room.page(task.id, 50).items) {
      const agent = "agent" in item ? item.agent : undefined;
      if (typeof agent === "string" && task.team.includes(agent)) return agent;
    }
    return task.team[0];
  }

  /** The network went away or came back. */
  async networkChanged(online: boolean): Promise<void> {
    const { runs, store } = this.deps;
    if (!online) {
      await runs.pauseForOffline();
      return;
    }
    for (const { task: id, agent } of runs.pausedOffline()) {
      const task = store.tasks.get(id);
      if (task === undefined) continue;
      // Two calls can overlap (the probe and an agent's network error): only one resumes a run.
      if (await this.autoResume(task)) runs.resumeOffline(id, agent, "the connection is back");
      else
        this.note(
          task.id,
          "majhi is back online. Automatic resume is off for this org, so resume the task when you are ready.",
        );
    }
    await this.deps.runners?.prune().catch(() => undefined);
  }

  /**
   * An agent failed like a lost connection and paused. Probe now: a working network resumes it,
   * and a failing one counts toward the outage that pauses the rest.
   */
  async networkError(): Promise<void> {
    const online = await this.network.check();
    if (online) await this.networkChanged(true);
  }

  /** The host helper saw the computer wake from sleep. */
  wake(): Promise<void> {
    return this.deps.runs.wake();
  }

  private note(task: TaskId, text: string): void {
    this.deps.room.post(task, `resume:${randomUUID()}`, { type: "system", level: "warn", text });
  }
}
