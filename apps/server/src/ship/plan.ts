import {
  type AutonomyMode,
  type AutonomySettings,
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
}

export interface ShipPlannerDeps {
  tasks: { get(id: string): Task | undefined };
  /** Autonomous mode's settings, as saved. */
  settings(): Promise<AutonomySettings>;
  mode(): AutonomyMode;
  areas: Pick<AreasReader, "of" | "forget">;
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
    const steps = shipSteps(
      authorityOf(settings, org),
      shipRulesOf(settings, org),
      facts,
      this.deps.mode() === "on",
    );
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
    };
  }
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
export function shipAsked(row: "merge" | "push", name: string, plan?: Pick<ShipPlan, "ruleSubject">): string {
  if (plan?.ruleSubject === undefined) return rowSentence(row, name);
  const what = row === "merge" ? "the merge" : "the push";
  return `In ${name} the rule for ${plan.ruleSubject.charAt(0).toLowerCase()}${plan.ruleSubject.slice(1)} leaves ${what} to you`;
}
