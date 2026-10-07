import {
  type DeployAsk,
  type DeployStepView,
  deployStepOf,
  deployStepOfRecord,
  type Task,
} from "@majhi/shared";
import type { ShipPlan } from "../ship/plan.ts";
import type { DeployRepo } from "../store/deploys.ts";
import type { DeployService } from "./service.ts";

/**
 * What happens to each deploy target of the projects a task changed, read now. Nothing is stored: a
 * record says what already happened, and for a target with none the ship rules say who deploys it and the
 * guards say whether it may go. The trail, the "Deploy to production?" bar and the captain's chore all
 * read this one answer, so they cannot disagree.
 */

export interface DeployPlanDeps {
  service: Pick<DeployService, "evaluate">;
  repo: Pick<DeployRepo, "find" | "ofTask">;
  /** Who does each deploy step, by the one ship decision. */
  ship(task: string): Promise<Pick<ShipPlan, "steps" | "rest" | "facts">>;
  /** The targets of a project, in order, or nothing when it has none. */
  targets(project: string): Promise<readonly { env: string }[]>;
}

/** A step the captain does next, with what it needs to start. */
export interface DeployStep extends DeployStepView {
  /** The project's id again, for a caller that only holds the step. */
  task: string;
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

  /** The deploy steps of a task, project by project, in the order each project's environments go live. */
  async stepsOf(task: Pick<Task, "id" | "repos">): Promise<DeployStep[]> {
    const landed = task.repos.filter((r) => r.landed !== undefined);
    if (landed.length === 0) return [];
    const mine = this.deps.repo.ofTask(task.id);
    const out: DeployStep[] = [];
    let plan: Awaited<ReturnType<DeployPlanDeps["ship"]>> | undefined;
    const shipOf = async () => {
      if (plan === undefined) plan = await this.deps.ship(task.id);
      return plan;
    };
    for (const repo of landed) {
      for (const { env } of await this.deps.targets(repo.project)) {
        // What already happened: this task's own deploy of the target, newest first.
        const own = [...mine].reverse().find((r) => r.project === repo.project && r.env === env);
        const step =
          own !== undefined
            ? deployStepOfRecord(own)
            : await this.decide(task.id, repo.project, env, await shipOf());
        out.push({ ...step, task: task.id });
      }
    }
    return out;
  }

  private async decide(
    task: string,
    project: string,
    env: string,
    plan: Awaited<ReturnType<DeployPlanDeps["ship"]>>,
  ): Promise<DeployStepView> {
    const who = plan.steps[deployStepOf(env)];
    const asked = { project, env, task } as const;
    const ev = await this.deps.service.evaluate(asked, who === "captain" ? "captain" : "owner", plan.rest);
    if (!ev.ok) {
      return {
        project,
        env,
        who,
        state: ev.kind === "previous" ? "waits-for-previous" : "blocked",
        why: ev.why,
      };
    }
    // Another task's deploy of the same head is this task's step too.
    const existing = this.deps.repo.find(project, env, ev.ctx.commit);
    if (existing !== undefined) return deployStepOfRecord(existing);
    return {
      project,
      env,
      who,
      commit: ev.ctx.commit,
      state: who === "captain" ? "captain-next" : "waits-for-owner",
    };
  }
}
