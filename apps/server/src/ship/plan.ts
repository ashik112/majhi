import {
  type AutonomyMode,
  type AutonomySettings,
  type DeployEnvironment,
  deployStepOf,
  PRIVATE,
  type ShipFacts,
  type ShipSteps,
  shipRuleSubject,
  shipSteps,
  type Task,
} from "@majhi/shared";
import { authorityOf, askedSentence as rowSentence, shipRulesOf } from "../captain/levels.ts";
import { restWhy } from "../captain/rules.ts";
import type { AreasReader } from "../tasks/areas.ts";
import { changedLinesOfTask } from "./lines.ts";

/**
 * Who does each step of shipping one task, read the same way by everything that ships (SPEC 5.18,
 * "One way to ship"): the captain's ship chore, its lane, the lead's merge card, and the merge request
 * poller. The answer is the workspace's authority rows refined by its ship rules (`shipSteps`), for
 * facts read now. Nothing here is stored, so there is no second copy to disagree.
 */

/** How a task lands: a local merge of the branch, or the merge request its project works through. */
export type ShipWay = "local" | "merge-request";

export interface ShipPlan {
  org: string;
  steps: ShipSteps;
  way: ShipWay;
  facts: ShipFacts;
  /** In words, what the rule that decided covers: "A bug up to 200 lines". Absent when the rows decided. */
  ruleSubject?: string | undefined;
  /** Why the captain rests in the workspace now (working hours, a freeze), or undefined. */
  rest?: string | undefined;
  /**
   * Set when the work goes into a branch that deploys an environment by itself (the host's CI): the environment
   * whose Deploy cell made Merge or Push the owner's, which the rows alone would have left to the captain.
   */
  gated?: { project: string; env: string; tier: DeployEnvironment["tier"] } | undefined;
}

export interface ShipPlannerDeps {
  tasks: { get(id: string): Task | undefined };
  /** Autonomous mode's settings, as saved. */
  settings(): Promise<AutonomySettings>;
  mode(): AutonomyMode;
  areas: Pick<AreasReader, "of" | "forget">;
  /** The environments of a project. A merge or push into the branch of one is a deploy of it. */
  environments(project: string): Promise<readonly DeployEnvironment[]>;
  /** Whether every repo the task changes has a token for its host, so its project works through merge requests. */
  viaMergeRequests(task: Task): Promise<boolean>;
  zone(tz: string | undefined): string;
  now(): Date;
}

export class ShipPlanner {
  constructor(private readonly deps: ShipPlannerDeps) {}

  /** The facts a rule reads, from the task and its diff now. */
  async facts(task: Task): Promise<ShipFacts> {
    // The areas are cached for the board; a ship decision reads them again, for this head.
    this.deps.areas.forget(task.id);
    const [areas, changedLines] = await Promise.all([
      this.deps.areas.of(task).catch(() => undefined),
      changedLinesOfTask(task.repos).catch(() => undefined),
    ]);
    return {
      ...(task.typing === undefined ? {} : { type: task.typing.type }),
      ...(areas === undefined
        ? {}
        : { areas: [...new Set(areas.areas.map((a) => a.component))], unmapped: areas.unmapped }),
      ...(changedLines === undefined ? {} : { changedLines }),
      projects: task.repos.filter((r) => r.writes !== false).map((r) => r.project),
    };
  }

  async plan(id: string): Promise<ShipPlan> {
    const task = this.deps.tasks.get(id);
    if (task === undefined) throw new Error(`There is no task ${id}`);
    const org = task.org ?? PRIVATE;
    const settings = await this.deps.settings();
    const facts = await this.facts(task);
    const base = shipSteps(
      authorityOf(settings, org),
      shipRulesOf(settings, org),
      facts,
      this.deps.mode() === "on",
    );
    const { steps, gated } = await this.gate(task, base);
    const rule = shipRulesOf(settings, org).find((r) => r.id === steps.rule);
    const rules = settings.orgs[org];
    const now = this.deps.now();
    const rest = restWhy(rules, now, this.deps.zone(rules?.tz ?? settings.tz));
    const way: ShipWay = (await this.deps.viaMergeRequests(task).catch(() => false))
      ? "merge-request"
      : "local";
    return {
      org,
      steps,
      way,
      facts,
      ...(rule === undefined ? {} : { ruleSubject: shipRuleSubject(rule.when) }),
      ...(rest === undefined ? {} : { rest }),
      ...(gated === undefined ? {} : { gated }),
    };
  }

  /** A merge or push into the branch of an environment is a deploy of it: the stricter of that and the Deploy cell. */
  private async gate(task: Task, steps: ShipSteps): Promise<{ steps: ShipSteps; gated?: ShipPlan["gated"] }> {
    const hits: { project: string; env: DeployEnvironment }[] = [];
    for (const repo of task.repos) {
      if (repo.writes === false) continue;
      const into = repo.landed?.into ?? repo.shipped?.into ?? repo.base;
      const envs = await this.deps.environments(repo.project).catch(() => []);
      for (const env of envs) if (env.branch === into) hits.push({ project: repo.project, env });
    }
    return tightenForBranchDeploys(steps, hits);
  }
}

/**
 * Pure. For each environment the work deploys by landing in its branch, Merge and Push become the stricter of
 * their own answer and that tier's Deploy cell (the owner's wins). Never loosens: a step the owner keeps stays.
 */
export function tightenForBranchDeploys(
  steps: ShipSteps,
  hits: readonly { project: string; env: Pick<DeployEnvironment, "env" | "tier"> }[],
): { steps: ShipSteps; gated?: ShipPlan["gated"] } {
  let out = steps;
  let gated: ShipPlan["gated"];
  for (const hit of hits) {
    const cell = out[deployStepOf(hit.env.tier)];
    if (cell !== "owner") continue;
    if (out.merge === "captain" || out.push === "captain") {
      out = { ...out, merge: "owner", push: "owner" };
      gated ??= { project: hit.project, env: hit.env.env, tier: hit.env.tier };
    }
  }
  return gated === undefined ? { steps: out } : { steps: out, gated };
}

/**
 * Whether the captain's way to land this task is to open a merge request: Push is the captain's and
 * either Merge is the owner's (it opens the request and the owner merges on the host) or the project
 * works through merge requests (the request is merged on the host once it is green).
 */
export function opensMergeRequest(plan: Pick<ShipPlan, "steps" | "way">): boolean {
  return plan.steps.push === "captain" && (plan.steps.merge === "owner" || plan.way === "merge-request");
}

/**
 * "In Acme you decide when work is merged, so the captain does not merge it": the line for a step the
 * owner keeps, naming the rule when one decided and the row when none did.
 */
export function shipAsked(
  row: "merge" | "push",
  name: string,
  plan?: Pick<ShipPlan, "ruleSubject" | "gated">,
): string {
  if (plan?.gated !== undefined) {
    const { env, tier } = plan.gated;
    return `In ${name} ${env} is deployed when its branch is ${row === "merge" ? "merged" : "pushed"}, and deploying ${tier} is the owner's`;
  }
  if (plan?.ruleSubject === undefined) return rowSentence(row, name);
  const what = row === "merge" ? "the merge" : "the push";
  return `In ${name} the rule for ${plan.ruleSubject.charAt(0).toLowerCase()}${plan.ruleSubject.slice(1)} leaves ${what} to you`;
}
