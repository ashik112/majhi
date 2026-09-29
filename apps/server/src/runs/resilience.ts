import { randomUUID } from "node:crypto";
import type { Task, TaskId } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { RunManager } from "./manager.ts";
import { NetworkWatch, type Probe } from "./network.ts";

/** What the coordinator needs of the task service: the status changes that follow pauses and resumes. */
export interface TaskHooks {
  statusChanged(id: string): Promise<void>;
  pausedByRuns(id: string, reason: "offline" | "error"): Promise<void>;
}

export interface ResilienceDeps {
  runs: RunManager;
  tasks: TaskHooks;
  store: Store;
  room: RoomService;
  config: ConfigService;
  probe: Probe;
  probeMs?: number;
}

/**
 * Resume without the owner clicking anything (SPEC 5.7): turns cut by a restart or crash,
 * turns paused while offline, and turns that failed or stalled while the Mac slept. Orgs can
 * turn automatic resume off; then the task waits, paused, for the owner.
 */
export class Resilience {
  readonly network: NetworkWatch;

  constructor(private readonly deps: ResilienceDeps) {
    this.network = new NetworkWatch({
      probe: deps.probe,
      ...(deps.probeMs === undefined ? {} : { intervalMs: deps.probeMs }),
      onChange: (online) => void this.networkChanged(online).catch(() => undefined),
    });
  }

  start(): void {
    this.network.start();
  }

  stop(): void {
    this.network.stop();
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

  /**
   * At server start: tasks waiting on work that finished while majhi was down start, and turns
   * that were cut by the restart or a crash continue.
   */
  async startup(): Promise<void> {
    const { store, runs, tasks } = this.deps;
    for (const t of store.tasks.list(true)) {
      if (t.status === "done") await tasks.statusChanged(t.id).catch(() => undefined);
    }
    for (const { task: id, agent } of store.runs.interrupted()) {
      const task = store.tasks.get(id);
      // Gone, finished, or stopped by the owner: nothing to continue.
      if (
        task === undefined ||
        task.status === "done" ||
        (task.status === "paused" && task.pausedReason === "owner")
      ) {
        store.runs.setInFlight(id, agent, 0, false);
        continue;
      }
      try {
        if (await this.autoResume(task)) {
          runs.resumeAfterRestart(task.id, agent);
        } else {
          runs.markInterrupted(task.id, agent);
          await tasks.pausedByRuns(task.id, "error");
          this.note(
            task.id,
            `majhi restarted while @${agent} was working. Automatic resume is off for this org, so resume the task when you are ready.`,
          );
        }
      } catch (err) {
        this.note(task.id, `Could not resume @${agent} after the restart: ${errorMessage(err)}`);
      }
    }
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
      if (await this.autoResume(task)) runs.resume(id, agent, "the connection is back");
      else
        this.note(
          task.id,
          "majhi is back online. Automatic resume is off for this org, so resume the task when you are ready.",
        );
    }
  }

  /** An agent failed like a lost connection. Probe now: offline pauses the rest, a working network resumes it. */
  async networkError(): Promise<void> {
    const online = await this.network.check();
    if (online) await this.networkChanged(true);
  }

  /** The host helper saw the Mac wake from sleep. */
  wake(): Promise<void> {
    return this.deps.runs.wake();
  }

  private note(task: TaskId, text: string): void {
    this.deps.room.post(task, `resume:${randomUUID()}`, { type: "system", level: "warn", text });
  }
}
