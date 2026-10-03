import { randomUUID } from "node:crypto";
import type { Task, TaskId } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TaskPlanner } from "./planner.ts";
import { humanWait } from "./planning.ts";
import { findCycle } from "./relations.ts";

/** What the orchestrator needs from the task service. */
export interface OrchestratorHost {
  /** Starts a task now, without asking the plan. */
  start(id: string): Promise<Task>;
  /** Puts `replacement` in the place of `agent` in the task's team. */
  swap(id: string, agent: string, replacement: string): Promise<Task>;
  /** Links of these tasks changed: refresh their rooms and TASK.md. */
  linksChanged(ids: readonly string[]): Promise<void>;
}

export interface OrchestratorDeps {
  store: Store;
  room: RoomService;
  runs: RunManager;
  planner: TaskPlanner;
  host: OrchestratorHost;
}

/** The longest a queued task waits for a window to reset before it is looked at again. */
const MAX_TIMER_MS = 6 * 3_600_000;

/**
 * Lead orchestration (SPEC Phase 3): drives the children of a parent to the end. Before a waiting
 * task starts it checks overlap with the running tasks, removes "waits for" links that hold
 * independent tasks back, and checks the account's windows. It acts when the answer is clear and
 * puts one card to the owner when it is a real trade-off. Every step is a short line in the
 * parent's room (or the task's own when it has no parent).
 */
export class Orchestrator {
  private chain: Promise<void> = Promise.resolve();
  /** The last line said per task, so a sweep that finds the same answer stays quiet. */
  private readonly said = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly told = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Looks at every task waiting to start. Sweeps run one at a time, so a task never starts twice. */
  advance(): Promise<void> {
    const run = this.chain
      .then(() => this.sweep())
      .catch((err) => console.error(`plan failed: ${errorMessage(err)}`));
    this.chain = run;
    return run;
  }

  private waiting(): Task[] {
    const { store } = this.deps;
    return store.tasks
      .list(false)
      .filter((t) => (t.status === "inbox" || t.status === "ready") && store.tasks.startWhenReady(t.id))
      .reverse()
      .flatMap((t) => store.tasks.get(t.id) ?? []);
  }

  private async sweep(): Promise<void> {
    for (const task of this.waiting()) await this.consider(task);
  }

  private async consider(task: Task): Promise<void> {
    const { store, host, planner } = this.deps;
    const plan = await planner.plan(task);

    for (const target of plan.redundant) {
      if (!store.tasks.removeLink(task.id, "depends-on", target)) continue;
      this.line(
        [task.id, target],
        `${task.id} no longer waits for ${target}: they change different files, so nothing needs to be done first.`,
      );
      await host.linksChanged([task.id, target]);
    }
    if (store.tasks.unmetDependencies(task.id).length > 0) return;

    const verdict = plan.verdict;
    switch (verdict.action) {
      case "start":
        this.said.delete(task.id);
        this.line([task.id], `${task.id} starts${verdict.note === undefined ? "" : `: ${verdict.note}`}.`);
        return this.startNow(task.id);
      case "switch": {
        const lead = task.team[0];
        if (lead === undefined) return;
        this.said.delete(task.id);
        try {
          await host.swap(task.id, lead, verdict.agent.agent);
        } catch (err) {
          this.said.set(task.id, `swap:${errorMessage(err)}`);
          return this.startNow(task.id);
        }
        this.line([task.id], `${task.id} goes to @${verdict.agent.agent}: ${verdict.because}.`);
        return this.startNow(task.id);
      }
      case "wait":
        return this.waitFor(task, verdict.on, verdict.because);
      case "queue":
        this.quiet(task, `${task.id} is queued: ${verdict.because}.`);
        this.recheckAt(task.id, verdict.until);
        return;
      case "ask":
        return this.ask(task, verdict.on, verdict.module, verdict.waitMs);
    }
  }

  private async startNow(id: string): Promise<void> {
    try {
      await this.deps.host.start(id);
    } catch (err) {
      // Not again on the next sweep: the owner starts it after fixing the cause.
      this.deps.store.tasks.setStartWhenReady(id, false);
      this.deps.room.post(id as TaskId, `error:${randomUUID()}`, {
        type: "system",
        level: "error",
        text: `Could not start: ${errorMessage(err)}`,
      });
    }
  }

  /** The task waits for the ones it overlaps: a `ready` link, so it goes when they reach review. */
  private async waitFor(task: Task, on: readonly string[], because: string): Promise<void> {
    const { store, host } = this.deps;
    const added: string[] = [];
    for (const target of on) {
      if (findCycle(store.tasks.allLinks(), "depends-on", task.id, target) !== undefined) continue;
      store.tasks.putLink({ task: task.id, type: "depends-on", other: target, when: "ready" });
      added.push(target);
    }
    if (added.length > 0) await host.linksChanged([task.id, ...added]);
    this.quiet(task, `${task.id} waits for ${on.join(", ")}: ${because}.`, [task.id, ...on]);
  }

  /** One card to the owner, once per task, in the parent's room. */
  private ask(task: Task, on: readonly string[], module: string, waitMs: number): void {
    const key = `ask:${task.id}:${on.join(",")}`;
    if (this.said.get(task.id) === key) return;
    this.said.set(task.id, key);
    const room = this.roomOf(task);
    this.deps.room.post(room, `choice:${task.id}:${randomUUID()}`, {
      type: "choice",
      question: `${task.id} overlaps ${on.join(", ")} in ${module}. Start now and merge later, or wait ${humanWait(waitMs)}?`,
      options: [
        { id: `start:${task.id}`, label: "Start now, merge later" },
        { id: `wait:${task.id}:${on.join(",")}`, label: `Wait ${humanWait(waitMs)}` },
      ],
      state: "pending",
    });
  }

  /** The owner's answer to a choice card. */
  /** The owner's pick on a choice card, or the captain's (`captain`). */
  async answer(roomTask: string, itemId: string, option: string, captain = false): Promise<void> {
    const { room, store } = this.deps;
    const item = room.get(roomTask, itemId);
    if (item?.type !== "choice" || item.state !== "pending" || !item.options.some((o) => o.id === option)) {
      throw new Error("That choice was already answered.");
    }
    const { id: _id, task: _task, seq: _seq, at: _at, ...payload } = item;
    room.post(item.task, item.id, {
      ...payload,
      state: "answered",
      chosen: option,
      ...(captain ? { by: "captain" as const } : {}),
    });
    const [kind, id, on] = option.split(":");
    const task = id === undefined ? undefined : store.tasks.get(id);
    if (task === undefined) return;
    if (kind === "start") {
      this.said.delete(id as string);
      this.line(
        [task.id],
        `${captain ? "Captain" : "Owner"}: start ${task.id} now. Merge it after the tasks it overlaps.`,
      );
      await this.startNow(task.id);
    } else if (kind === "wait") {
      const who = captain ? "the captain" : "the owner";
      await this.waitFor(task, (on ?? "").split(",").filter(Boolean), `${who} chose to wait`);
    }
  }

  /** Looks again when a window resets. */
  private recheckAt(id: string, until: string | undefined): void {
    if (until === undefined) return;
    const ms = Date.parse(until) - Date.now();
    if (!Number.isFinite(ms)) return;
    const old = this.timers.get(id);
    if (old !== undefined) clearTimeout(old);
    const timer = setTimeout(
      () => {
        this.timers.delete(id);
        this.said.delete(id);
        void this.advance();
      },
      Math.min(Math.max(ms + 60_000, 60_000), MAX_TIMER_MS),
    );
    timer.unref();
    this.timers.set(id, timer);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Where the plan for a task shows: its parent's room, else its own. */
  private roomOf(task: Task): TaskId {
    return (task.links.find((l) => l.type === "parent")?.task ?? task.id) as TaskId;
  }

  /** A plan line in the task's room, the other rooms named, and the parent's. */
  private line(tasks: readonly string[], text: string): void {
    const rooms = new Set<string>();
    for (const id of tasks) {
      rooms.add(id);
      const t = this.deps.store.tasks.get(id);
      const parent = t?.links.find((l) => l.type === "parent")?.task;
      if (parent !== undefined) rooms.add(parent);
    }
    for (const id of rooms) {
      this.deps.room.post(id as TaskId, `info:${randomUUID()}`, { type: "system", level: "info", text });
    }
  }

  /** Like `line`, but says nothing when the same thing was said last time. */
  private quiet(task: Task, text: string, tasks: readonly string[] = [task.id]): void {
    if (this.said.get(task.id) === text) return;
    this.said.set(task.id, text);
    this.line(tasks, text);
  }

  // -------------------------------------------------------------------------
  // The lead's side

  /** A child reached review: tell the parent's lead once, so it reviews and closes it. */
  childReady(child: Task): void {
    if (child.status !== "review") return;
    const parentId = child.links.find((l) => l.type === "parent")?.task;
    const parent = parentId === undefined ? undefined : this.deps.store.tasks.get(parentId);
    const lead = parent?.team[0];
    if (parent === undefined || lead === undefined) return;
    if (parent.status !== "running" && parent.status !== "review") return;
    const key = `${child.id}:${child.updatedAt}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const open = this.deps.store.tasks
      .children(parent.id)
      .filter((id) => this.deps.store.tasks.get(id)?.status !== "done");
    this.deps.runs.notify(
      parent.id,
      lead,
      [
        `${child.id} "${child.title}" is ready for review (branches: ${child.repos.map((r) => r.branch).join(", ") || "none"}).`,
        `Review what it delivered in its worktree under ${child.folder}. If it is good, ship it (merge it with the merge tool if you have the Merge permission) and close it with the majhi-tasks close tool so the tasks waiting for it can start. Work not merged, pushed or in a pull request cannot be closed by an agent: leave it in review for the owner. If not, say what to fix in ${child.id}'s room.`,
        `Still open in ${parent.id}: ${open.join(", ") || "nothing"}. The next subtasks start by themselves once the overlap and limits check allows it. When all are done, ${parent.id} closes with a report.`,
      ].join("\n"),
    );
  }

  /** The report posted when every child is done. */
  report(parentId: string): string {
    const { store } = this.deps;
    const rows = store.tasks.children(parentId).flatMap((id) => {
      const t = store.tasks.get(id);
      return t === undefined
        ? []
        : [`- ${t.id} ${t.title} (${t.repos.map((r) => r.branch).join(", ") || "no branch"})`];
    });
    return `Every subtask is done. Task closed. Delivered:\n${rows.join("\n")}`;
  }
}
