import {
  type DeployAsk,
  type DeployEnvironment,
  type DeployRecord,
  type DeployStepView,
  deployStepOf,
  deployStepOfRecord,
  type Task,
} from "@majhi/shared";
import type { ShipPlan } from "../ship/plan.ts";
import type { DeployRepo } from "../store/deploys.ts";
import { BLOCKS, blockedWhy } from "./blocked.ts";
import type { SyncHead } from "./git.ts";
import type { DeployService } from "./service.ts";

/**
 * What happens to each step of a task's deploy plan, read now. Nothing is stored twice: a record says what
 * already happened, and for a planned one the ship rules say who deploys it (by the environment's tier) and
 * the guards say whether it may go. The trail, the "Deploy to production?" bar and the captain's chore all
 * read this one answer, so they cannot disagree.
 */

export interface DeployPlanDeps {
  service: Pick<DeployService, "evaluate">;
  repo: Pick<DeployRepo, "find" | "ofTask">;
  /** Who does each deploy step, by the one ship decision. */
  ship(task: string): Promise<Pick<ShipPlan, "steps" | "rest" | "facts">>;
  /** The environments of a project, or nothing when it has none. */
  environments(project: string): Promise<readonly DeployEnvironment[]>;
}

/** A step the captain does next, with what it needs to start. */
export interface DeployStep extends DeployStepView {
  /** The project's id again, for a caller that only holds the step. */
  task: string;
  /** For a `preparing` step: what the deploy remote has that the source lacks. Never sent to a screen. */
  sync?: SyncHead;
}

export class DeployPlanner {
  constructor(private readonly deps: DeployPlanDeps) {}

  /** The steps of a task, and the question to put to the owner when one waits for them. */
  async describe(task: Pick<Task, "id" | "repos">): Promise<{ steps: DeployStep[]; ask?: DeployAsk }> {
    const steps = await this.stepsOf(task);
    const waiting = steps.find((s) => s.state === "waits-for-owner" && s.commit !== undefined);
    if (waiting?.commit === undefined) return { steps };
    const before = steps
      .filter((s) => s.project === waiting.project && s.state === "live" && s.commit === waiting.commit)
      .at(-1);
    const lines = (await this.deps.ship(task.id).catch(() => undefined))?.facts.changedLines;
    return {
      steps,
      ask: {
        project: waiting.project,
        env: waiting.env,
        commit: waiting.commit,
        ...(before === undefined ? {} : { after: before.env }),
        ...(lines === undefined ? {} : { lines }),
      },
    };
  }

  /** The steps of a task's plan, in order. */
  async stepsOf(task: Pick<Task, "id" | "repos">): Promise<DeployStep[]> {
    const all = this.deps.repo.ofTask(task.id);
    // One step per environment: a newer step of the same project and environment replaces an older one.
    const mine = all.filter(
      (r) =>
        !all.some(
          (o) =>
            o.id !== r.id &&
            o.project === r.project &&
            o.env === r.env &&
            (o.seq > r.seq || (o.seq === r.seq && o.id > r.id)),
        ),
    );
    if (mine.length === 0) return [];
    const out: DeployStep[] = [];
    let plan: Awaited<ReturnType<DeployPlanDeps["ship"]>> | undefined;
    const shipOf = async () => {
      if (plan === undefined) plan = await this.deps.ship(task.id);
      return plan;
    };
    const environments = new Map<string, readonly DeployEnvironment[]>();
    for (const rec of mine) {
      if (!environments.has(rec.project)) {
        environments.set(rec.project, await this.deps.environments(rec.project).catch(() => []));
      }
      const tier = environments.get(rec.project)?.find((e) => e.env === rec.env)?.tier;
      const landed = task.repos.some((r) => r.project === rec.project && r.landed !== undefined);
      // What already happened, or a step that waits for the merge: the record says it.
      const step =
        rec.state !== "planned" || !landed
          ? this.record(rec, tier, rec.state === "planned" ? (await shipOf()).steps : undefined)
          : await this.decide(task.id, rec, tier, await shipOf());
      out.push({ ...step, task: task.id });
    }
    return out;
  }

  private record(
    rec: DeployRecord,
    tier: DeployEnvironment["tier"] | undefined,
    steps: Awaited<ReturnType<DeployPlanDeps["ship"]>>["steps"] | undefined,
  ): DeployStepView {
    const view = deployStepOfRecord(rec, tier);
    return steps === undefined ? view : { ...view, who: steps[deployStepOf(tier ?? "production")] };
  }

  private async decide(
    task: string,
    rec: DeployRecord,
    tier: DeployEnvironment["tier"] | undefined,
    plan: Awaited<ReturnType<DeployPlanDeps["ship"]>>,
  ): Promise<DeployStepView> {
    const who = plan.steps[deployStepOf(tier ?? "production")];
    const base = deployStepOfRecord(rec, tier);
    const ev = await this.deps.service.evaluate(
      { project: rec.project, env: rec.env, runs: rec.runs, task, record: rec },
      who === "captain" ? "captain" : "owner",
      plan.rest,
    );
    // A commit a GitLab host lacks is not a block: the deploy pushes it there first, as a case's deploy does.
    const pushes =
      !ev.ok &&
      ev.kind === "unpushed" &&
      ev.commit !== undefined &&
      rec.runs.some(
        (r) => r.kind === "gitlab-job" || r.kind === "gitlab-pipeline" || r.kind === "gitlab-merge",
      );
    if (!ev.ok && !pushes) {
      if (ev.kind === "previous") return { ...base, who, state: "waits-for-previous", why: ev.why };
      // The deploy remote has commits the source lacks: not a block. majhi brings them into the task's own branch.
      if (ev.kind === "sync") {
        return {
          ...base,
          who,
          state: "preparing",
          why: `${ev.why} The deploy goes when the task has them and lands again.`,
          ...(ev.sync === undefined ? {} : { sync: ev.sync }),
        };
      }
      return {
        ...base,
        who,
        state: "blocked",
        why: blockedWhy(ev.kind, ev.why),
        clears: BLOCKS[ev.kind].clears,
      };
    }
    const commit = ev.ok ? ev.ctx.commit : ev.commit;
    if (commit === undefined) {
      return { ...base, who, state: "blocked", why: ev.ok ? "" : ev.why, clears: "owner" };
    }
    // Another task's deploy of the same head is this task's step too.
    const existing = this.deps.repo.find(rec.project, rec.env, commit);
    if (existing !== undefined && existing.id !== rec.id) return deployStepOfRecord(existing, tier);
    return {
      ...base,
      who,
      commit,
      state: who === "captain" ? "captain-next" : "waits-for-owner",
    };
  }
}
