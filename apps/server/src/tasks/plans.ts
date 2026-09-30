import type { PlanAgentTokens, PlanMember, PlanOutcome, Task, TeamPlan } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { UsageRepo } from "../usage/repo.ts";
import { agentsText } from "./team-facts.ts";

export interface PlansDeps {
  store: Store;
  room: RoomService;
  /** Absent: outcomes are not read. */
  usage?: UsageRepo | undefined;
  /** Resolves when every queued usage row is written, so the last turn counts. */
  flushUsage?: (() => Promise<void>) | undefined;
  /** The team as it is now, for the snapshot kept with a plan. */
  team: (task: Task) => Promise<PlanMember[]>;
  now: () => Date;
}

/** The most agents one plan version lists. */
const AGENT_LIMIT = 50;

/** The lead's plans for a task, and what each version cost (PRV-52). */
export class TaskPlans {
  constructor(private readonly deps: PlansDeps) {}

  /** Stores the next version of the task's plan and shows it in the room. Only the lead may. */
  async record(task: Task, agent: string, plan: TeamPlan): Promise<string> {
    const lead = task.team[0];
    if (agent !== lead) throw new UserError(`Only the lead, @${lead ?? "nobody"}, records the plan.`);
    const { store, room } = this.deps;
    const version = (store.plans.forTask(task.id).at(-1)?.version ?? 0) + 1;
    store.plans.add({
      task: task.id,
      org: task.org ?? null,
      version,
      at: this.deps.now().toISOString(),
      agent,
      plan,
      team: await this.deps.team(task),
    });
    room.post(task.id, `team-plan:${version}`, {
      type: "team-plan",
      agent,
      version,
      steps: plan.steps,
      why: plan.why,
      how: plan.how,
    });
    return `Recorded plan v${version}. The room shows it.`;
  }

  /**
   * For a task in review or done: stores on every plan version the tokens each agent used from its
   * time to the next version's (the first has no start, so it includes the planning turn; the last
   * has no end), subtasks included. Posts one line for the latest version at review, or at done
   * when no outcome was read before. A task without a plan gets nothing.
   */
  async settle(task: Task): Promise<void> {
    const { store, room, usage } = this.deps;
    if (usage === undefined || (task.status !== "review" && task.status !== "done")) return;
    const rows = store.plans.forTask(task.id);
    const latest = rows.at(-1);
    if (latest === undefined) return;
    await this.deps.flushUsage?.();
    const ids = this.withSubtasks(task.id);
    const at = this.deps.now().toISOString();
    let after: PlanOutcome | undefined;
    for (const [i, row] of rows.entries()) {
      const outcome: PlanOutcome = {
        at,
        status: task.status,
        withSubtasks: ids.length > 1,
        agents: this.tokens(ids, i === 0 ? undefined : row.at, rows[i + 1]?.at),
      };
      store.plans.setOutcome(row.id, outcome);
      if (row === latest) after = outcome;
    }
    if (after === undefined) return;
    // At done a line was already posted at review; at review the same numbers are not said twice.
    const before = latest.outcome;
    const say = task.status === "review" ? before === null || !sameAgents(before, after) : before === null;
    if (say) room.post(task.id, `plan-outcome:${latest.version}:${at}`, outcomeLine(latest.version, after));
  }

  /** The task and its subtasks, children of children too. */
  private withSubtasks(id: string): string[] {
    const { store } = this.deps;
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      for (const l of store.tasks.linksTo(next)) {
        if (l.type !== "parent" || seen.has(l.task)) continue;
        seen.add(l.task);
        queue.push(l.task);
      }
    }
    return [...seen];
  }

  /** Per agent over the given tasks in a time span, most tokens first. */
  private tokens(
    ids: readonly string[],
    start: string | undefined,
    end: string | undefined,
  ): PlanAgentTokens[] {
    const usage = this.deps.usage;
    const by = new Map<string, PlanAgentTokens & { priced: number }>();
    if (usage === undefined) return [];
    for (const task of ids) {
      for (const g of usage.groups("agent", { filters: { task }, start, end }, AGENT_LIMIT)) {
        if (g.key === null || g.totals.turns === 0) continue;
        const held = by.get(g.key) ?? {
          agent: g.key,
          turns: 0,
          tokens: 0,
          outputTokens: 0,
          costUsd: null,
          priced: 0,
        };
        const priced = g.totals.turns - g.totals.unpricedTurns;
        held.turns += g.totals.turns;
        held.tokens += g.totals.totalTokens;
        held.outputTokens += g.totals.outputTokens;
        held.priced += priced;
        if (priced > 0) held.costUsd = (held.costUsd ?? 0) + g.totals.costUsd;
        by.set(g.key, held);
      }
    }
    return [...by.values()]
      .map(({ priced: _priced, ...agent }) => agent)
      .sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent));
  }
}

function sameAgents(a: PlanOutcome, b: PlanOutcome): boolean {
  return JSON.stringify(a.agents) === JSON.stringify(b.agents);
}

function outcomeLine(version: number, o: PlanOutcome) {
  const used = `Plan v${version} used${o.withSubtasks ? " (with subtasks)" : ""}`;
  return {
    type: "system" as const,
    level: "info" as const,
    text: o.agents.length === 0 ? `${used} no tokens.` : `${used}: ${agentsText(o.agents)}.`,
  };
}
