import { randomUUID } from "node:crypto";
import type { DeployRecord, Task } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { DeployRepo } from "../store/deploys.ts";
import { type CaseDeployer, type DeployHooks, type OkPath, runLines } from "./deploy.ts";
import { shortVersion } from "./record.ts";

/**
 * A finished task's deploy, whole (docs/DECISIONS.md, "a finished task's deploy is one decision"). The captain writes
 * the plan (`projects.planDeploy`: the targets in order); the owner's one click, or the captain's own call where the
 * workspace lets it decide, runs every target through the case deployer, the same per-target run a case's fix goes
 * through: the commit is pushed to the remote that deploys when it is not there yet, the image is built, the target is
 * deployed and its status read, and a target that fails is put back and stops the ones after it. Nothing here is a
 * second way to deploy.
 */

export interface TaskDeployDeps {
  /** The case deployer, with ports that read a task's own changes and never ask the hand-off checks again. */
  deployer: CaseDeployer;
  tasks: { get(id: string): Task | undefined };
  repo: Pick<DeployRepo, "ofTask" | "dropUnstarted">;
  /** Whether the environment's deploy was read from the project's CI (a recipe): only those go through the case deployer. */
  hasRecipe(project: string, env: string): Promise<boolean>;
  /** One line in the task's room. */
  note(task: string, key: string, level: "info" | "warn", text: string): void;
  /** Runs the rest of the deploy after the first target started; an error is the room's line, never lost. */
  background(run: () => Promise<void>): void;
}

interface First {
  resolve: (record: DeployRecord) => void;
  reject: (err: unknown) => void;
}

export class TaskDeploy {
  /** Tasks whose plan is going out now. */
  private readonly going = new Set<string>();
  /** The caller of `start` that waits for the first target's record. */
  private readonly first = new Map<string, First>();

  constructor(private readonly deps: TaskDeployDeps) {}

  /**
   * The first record a target's deploy made for the task. The deploy ports call it, so the plan's own row for that
   * target is replaced by the record that really ran and the one who started the plan has something to point at.
   */
  recorded(record: DeployRecord): void {
    if (record.task === undefined) return;
    for (const old of this.deps.repo.ofTask(record.task)) {
      if (old.state === "planned" && old.project === record.project && old.env === record.env) {
        this.deps.repo.dropUnstarted(old.id);
      }
    }
    const waiting = this.first.get(record.task);
    if (waiting === undefined) return;
    this.first.delete(record.task);
    waiting.resolve(record);
  }

  /**
   * Starts the task's whole plan as `actor`. Everything that can be refused is refused before anything moves; it
   * answers once the first target's deploy has started, and the rest goes on in the background, one target after the
   * other. A second call while it goes answers with the record it has. Undefined when no planned target has a recipe
   * (the plan names its own runs): the caller then runs the plan's next record, one step at a time, as before.
   */
  async start(
    taskId: string,
    actor: "owner" | "captain",
  ): Promise<{ record: DeployRecord; repeat: boolean } | undefined> {
    const task = this.deps.tasks.get(taskId);
    if (task === undefined) throw new UserError(`There is no task ${taskId}.`, 404);
    if (this.going.has(taskId)) {
      const record = this.deps.repo.ofTask(taskId).at(-1);
      if (record === undefined) throw new UserError(`The deploy of ${taskId} is starting.`, 409);
      return { record, repeat: true };
    }
    const waiting = this.deps.repo.ofTask(taskId).filter((r) => r.state === "planned");
    if (waiting.length === 0) throw new UserError(`${taskId} has no deploy waiting.`, 409);
    const planned: DeployRecord[] = [];
    for (const rec of waiting) if (await this.deps.hasRecipe(rec.project, rec.env)) planned.push(rec);
    if (planned.length === 0) return undefined;
    const groups: { project: string; envs: string[] }[] = [];
    for (const rec of planned) {
      const group = groups.find((g) => g.project === rec.project);
      if (group === undefined) groups.push({ project: rec.project, envs: [rec.env] });
      else group.envs.push(rec.env);
    }
    const about = [task.title];
    // Every project is read before anything moves: the same checks and the same questions as one.
    const plans: { project: string; branch: string; envs: string[]; plan: PlanOk }[] = [];
    for (const group of groups) {
      const repo = task.repos.find((r) => r.project === group.project);
      if (repo === undefined) throw new UserError(`${taskId} has no work in ${group.project}.`, 409);
      const plan = await this.deps.deployer.plan({
        task: taskId,
        project: group.project,
        branch: repo.branch,
        about,
        only: group.envs,
      });
      if (!plan.ok) {
        this.deps.note(taskId, `taskdeploy:${randomUUID()}`, "warn", plan.why);
        throw new UserError(plan.why, 409);
      }
      plans.push({ project: group.project, branch: repo.branch, envs: group.envs, plan });
    }
    for (const { project, plan } of plans) {
      for (const out of plan.left) {
        this.deps.note(
          taskId,
          `taskdeploy:${randomUUID()}`,
          "info",
          `${project} ${out.env} is not deployed: ${out.why}.`,
        );
      }
    }
    this.going.add(taskId);
    const started = new Promise<DeployRecord>((resolve, reject) =>
      this.first.set(taskId, { resolve, reject }),
    );
    this.deps.background(() =>
      this.go(task, actor, about, plans).finally(() => {
        this.going.delete(taskId);
        // Nothing started (the first target needed an answer): the caller is told why instead of waiting.
        const waiting = this.first.get(taskId);
        if (waiting !== undefined) {
          this.first.delete(taskId);
          waiting.reject(
            new UserError(`The deploy of ${taskId} did not start. The task's room says why.`, 409),
          );
        }
      }),
    );
    return { record: await started, repeat: false };
  }

  private async go(
    task: Task,
    actor: "owner" | "captain",
    about: string[],
    plans: { project: string; branch: string; envs: string[]; plan: PlanOk }[],
  ): Promise<void> {
    const say = (level: "info" | "warn", text: string) =>
      this.deps.note(task.id, `taskdeploy:${randomUUID()}`, level, text);
    for (const { project, branch, plan } of plans) {
      const hooks: DeployHooks = {
        started: (path: OkPath) => {
          for (const note of path.notes) say("info", note);
          say(
            "info",
            `Deploying ${project} ${path.env.env}. It replaces ${path.previous === "" ? "a version majhi does not know" : shortVersion(path.previous)}.`,
          );
        },
        threw: (path, err) =>
          say("warn", `The deploy of ${project} ${path.env.env} did not go through: ${errorMessage(err)}`),
        ended: (path, ended) => {
          const live = ended.state === "live";
          for (const text of runLines(ended)) say(live ? "info" : "warn", text);
          say(
            live ? "info" : "warn",
            live
              ? `${project} ${path.env.env} is live at ${ended.commit.slice(0, 7)}.`
              : `The deploy of ${project} ${path.env.env} did not go live (${ended.reason ?? ended.state}). majhi put it back where it can, and the targets after it were not started.`,
          );
        },
      };
      try {
        const done = await this.deps.deployer.deployAll(
          { task: task.id, project, branch, about, landed: true, actor, incidentFix: false },
          plan,
          hooks,
        );
        if (done.blocked !== undefined) {
          say("warn", `${project} ${done.blocked.env} was not started: ${done.blocked.why}`);
          return;
        }
        if (done.targets.at(-1)?.record.state !== "live") return;
        // A planned target the change does not reach was left out and said so: its row goes, so nothing waits on it.
        for (const rec of this.deps.repo.ofTask(task.id)) {
          if (rec.state === "planned" && rec.project === project && !plan.envs.includes(rec.env)) {
            this.deps.repo.dropUnstarted(rec.id);
          }
        }
      } catch (err) {
        say("warn", `The deploy of ${task.id} stopped: ${errorMessage(err)}`);
        return;
      }
    }
  }
}

type PlanOk = Extract<Awaited<ReturnType<CaseDeployer["plan"]>>, { ok: true }>;
