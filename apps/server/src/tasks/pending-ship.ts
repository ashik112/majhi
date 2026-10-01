import { randomUUID } from "node:crypto";
import { type MergeMethod, type PendingShip, shipWords, type Task, type TaskId } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { uncommitted } from "../git/git.ts";
import { mergeConflicts } from "../git/merge.ts";
import type { MrService } from "../mrs/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "./service.ts";

type ShipResult = { project: string; ok: boolean; detail: string; conflicts?: string[] | undefined };

export interface PendingShipDeps {
  store: Store;
  tasks: TaskService;
  mrs: MrService;
  room: RoomService;
  events: EventHub;
  now: () => Date;
}

/**
 * "Resolve and merge" (the Ship panel, after a merge stopped on conflicts). One click asks the
 * lead to bring the target into the task branch, resolve, check and commit, and keeps the ship on
 * the task. When the agents finish and the task reaches review, the ship is taken off the task
 * first, so it runs at most once, and runs through the same path as the Ship panel when the
 * branch now merges cleanly. Otherwise the task stays in review with the reason. Never a retry.
 */
export class PendingShips {
  constructor(private readonly deps: PendingShipDeps) {}

  async request(input: {
    id: string;
    action: PendingShip["action"];
    into: string;
    method: MergeMethod;
    deleteAfter: boolean;
    by: string;
  }): Promise<Task> {
    const { store, tasks } = this.deps;
    let task = tasks.get(input.id);
    const lead = task.team[0];
    if (lead === undefined) throw new UserError(`${task.id} has no agent to resolve the conflicts.`, 409);
    if (task.repos.length === 0) throw new UserError(`${task.id} has no repo to merge.`);
    const conflicts = await this.conflicts(task, input.into);
    if (input.method !== "rebase" && conflicts.every((c) => c.files.length === 0)) {
      throw new UserError(`Nothing conflicts with ${input.into} now. Ship again.`, 409);
    }
    if (task.status === "done") task = await tasks.reopen(task.id);
    const pending: PendingShip = {
      action: input.action,
      into: input.into,
      method: input.method,
      deleteAfter: input.deleteAfter,
      lead,
      requestedAt: this.deps.now().toISOString(),
      by: input.by,
    };
    store.tasks.setPendingShip(task.id, pending);
    tasks.cards.settle(
      task.id,
      "review",
      `Asked @${lead} to resolve the conflicts, then ${shipWords(pending)}`,
      input.by,
    );
    try {
      await tasks.send({
        task: task.id,
        text: askText(task, pending, conflicts),
        attachments: [],
        mode: "queue",
        agent: lead,
      });
    } catch (err) {
      store.tasks.setPendingShip(task.id, undefined);
      this.publish(task.id);
      throw err;
    }
    this.publish(task.id);
    return tasks.get(task.id);
  }

  /** The owner changed their mind: the lead keeps working, and nothing ships when it is done. */
  cancel(id: string): Task {
    this.deps.tasks.dropPendingShip(id, "you cancelled it");
    return this.deps.tasks.get(id);
  }

  /** The task reached review. A waiting ship is taken off the task, then run once or explained. */
  async reviewReached(id: string): Promise<void> {
    const { store, tasks, mrs } = this.deps;
    const pending = store.tasks.takePendingShip(id);
    if (pending === undefined) return;
    this.publish(id);
    const input = {
      id,
      into: pending.into,
      done: true,
      by: pending.by,
      method: pending.method,
      deleteAfter: pending.deleteAfter,
    };
    try {
      const blocked = await this.blocker(tasks.get(id), pending);
      if (blocked !== undefined) return this.backToReview(id, pending, blocked);
      this.say(
        id,
        `@${pending.lead} is done and ${pending.into} merges cleanly. majhi will ${shipWords(pending)}, as you asked.`,
      );
      const out = pending.action === "mergePush" ? await mrs.mergeAndPush(input) : await tasks.merge(input);
      const failed: ShipResult[] = out.results.filter((r) => !r.ok);
      if (failed.length > 0) this.backToReview(id, pending, failure(failed));
    } catch (err) {
      this.backToReview(id, pending, errorMessage(err));
    }
  }

  /** Why the ship must not run now, or undefined when it may. */
  private async blocker(task: Task, pending: PendingShip): Promise<string | undefined> {
    const { room, store } = this.deps;
    room.flush(task.id);
    const asked =
      store.room.pendingOfType(task.id, "ask").length > 0 ||
      store.room.pendingOfType(task.id, "owner-question").length > 0;
    if (asked) return `@${pending.lead} asked you a question`;
    for (const repo of task.repos) {
      if (repo.worktree === undefined) continue;
      const dirty = await uncommitted(repo.worktree).catch(() => []);
      if (dirty.length > 0) {
        return `@${pending.lead} left uncommitted changes in ${repo.project}, so its checks may not pass`;
      }
    }
    const files = (await this.conflicts(task, pending.into)).flatMap((c) => c.files);
    if (files.length > 0) return `Still conflicts in ${listed(files)}`;
    return undefined;
  }

  /** Per repo, the files that conflict with `into` now. */
  private async conflicts(
    task: Task,
    into: string,
  ): Promise<{ project: string; branch: string; files: string[] }[]> {
    const out: { project: string; branch: string; files: string[] }[] = [];
    for (const repo of task.repos) {
      const files = await mergeConflicts(repo.source, repo.branch, into);
      out.push({ project: repo.project, branch: repo.branch, files });
    }
    return out;
  }

  /** The ship did not run or did not finish: a fresh review card says why. */
  private backToReview(id: string, pending: PendingShip, why: string): void {
    const task = this.deps.tasks.get(id);
    const text = `Did not ${shipWords(pending)}: ${why.replace(/\.$/, "")}.`;
    if (task.status === "review") this.deps.tasks.cards.review(task, text);
    else this.say(id, text, "warn");
    this.publish(id);
  }

  private say(id: string, text: string, level: "info" | "warn" = "info"): void {
    this.deps.room.post(id as TaskId, `${level}:${randomUUID()}`, { type: "system", level, text });
  }

  private publish(id: string): void {
    this.deps.room.publishTask(this.deps.tasks.get(id));
    this.deps.events.emit(["tasks"]);
  }
}

function listed(files: readonly string[]): string {
  const unique = [...new Set(files)];
  return `${unique.slice(0, 8).join(", ")}${unique.length > 8 ? " and more" : ""}`;
}

/** The reason a ship that ran did not finish. */
function failure(failed: readonly ShipResult[]): string {
  const files = failed.flatMap((r) => r.conflicts ?? []);
  if (files.length > 0) return `Still conflicts in ${listed(files)}`;
  return failed.map((r) => (failed.length > 1 ? `${r.project}: ${r.detail}` : r.detail)).join(" ");
}

/** What the lead is asked to do, in plain words. */
function askText(
  task: Task,
  pending: PendingShip,
  conflicts: readonly { project: string; branch: string; files: string[] }[],
): string {
  const { into, lead } = pending;
  const where = (c: { project: string }) => (task.repos.length > 1 ? ` in ${c.project}` : "");
  const lines = conflicts
    .filter((c) => c.files.length > 0)
    .map((c) => `${c.branch}${where(c)} conflicts with ${into} in ${listed(c.files)}.`);
  const integrate =
    pending.method === "rebase"
      ? `Rebase your branch onto ${into}, resolve each conflict keeping what both sides meant, and finish the rebase.`
      : `Merge ${into} into your branch, resolve each conflict keeping what both sides meant, and commit the merge.`;
  return [
    `@${lead} Shipping hit conflicts with ${into}. Nothing was merged.${lines.length > 0 ? ` ${lines.join(" ")}` : ""}`,
    integrate,
    "Then run typecheck and the tests of the files you touched. If a check fails and you cannot fix it, do not commit: say what failed.",
    `When you are done, majhi will ${shipWords(pending)} by itself.`,
  ].join("\n");
}
