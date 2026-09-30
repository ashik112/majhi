import { type AccountModels, type AgentFrontmatter, canWorkIn, resolveTier, type Task } from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { readDecisionSettings } from "../decisions/settings.ts";
import type { Store } from "../store/index.ts";
import { readPrices } from "../usage/prices.ts";
import type { TaskPlanner } from "./planner.ts";
import { likelyPaths, overlapsOf } from "./planning.ts";
import {
  buildTeamFacts,
  type PastPlan,
  type RunningFacts,
  runningFactsOf,
  type TeamFacts,
} from "./team-facts.ts";

/** The facts list this many other tasks, so only this many are read. */
const RUNNING_CAP = 6;
/** Recent plans in the facts. */
const PAST_CAP = 3;

export interface TeamFactsDeps {
  store: Store;
  agents: AgentStore;
  accounts: AccountService;
  config: ConfigService;
  planner: TaskPlanner;
  now: () => Date;
}

/** Gathers the team facts of a task from the agents, accounts, price table, runs and the planner. */
export class TeamFactsSource {
  constructor(private readonly deps: TeamFactsDeps) {}

  /**
   * The facts for a lead-mode task with a team. Undefined when they do not apply (a chat task, the
   * boss chat, another mode, no team) or the agents cannot be read. Any other read that fails
   * leaves its part out: facts never stop a turn.
   */
  async facts(task: Task): Promise<TeamFacts | undefined> {
    if (task.kind === "chat" || isBossChat(task) || task.mode !== "lead" || task.team.length === 0) {
      return undefined;
    }
    const { store, agents, accounts, config } = this.deps;
    const stored = await attempt(() => agents.list());
    if (stored === undefined) return undefined;
    const all = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    const lead = all.find((a) => a.id === task.team[0]);
    if (lead === undefined) return undefined;

    const sections = await attempt(() => config.sections());
    const settings = await attempt(() => readDecisionSettings(config.file));
    const prices = (await attempt(() => readPrices(config.file))) ?? {};
    const views = (await attempt(() => accounts.list())) ?? [];
    const orgTiers = sections?.orgs[task.org ?? ""]?.tiers;

    const offered = new Map<string, AccountModels>();
    for (const id of new Set(all.map((a) => a.account))) {
      const models = await attempt(() => accounts.cachedModels(id));
      if (models !== undefined) offered.set(id, models);
    }
    const runs = new Map<string, { model?: string; effort?: string }>();
    for (const r of (await attempt(async () => store.runs.forTask(task.id))) ?? []) {
      runs.set(r.agent, {
        ...(r.model === undefined ? {} : { model: r.model }),
        ...(r.effort === undefined ? {} : { effort: r.effort }),
      });
    }

    return buildTeamFacts({
      task,
      now: this.deps.now().toISOString(),
      agents: all,
      boss: sections?.boss,
      accounts: new Map(views.map((v) => [v.id, v])),
      offered,
      prices,
      runs,
      tierOf: (fm) => resolveTier(fm.role, fm.tier, orgTiers?.[fm.role], settings?.tiers[fm.role]),
      running: (await attempt(() => this.running(task, lead, all))) ?? [],
      past: (await attempt(async () => this.past(task, lead, Object.keys(sections?.orgs ?? {})))) ?? [],
    });
  }

  /** Recent plans of finished tasks in the orgs the lead may see. A root lead sees every org. */
  private past(task: Task, lead: AgentFrontmatter, orgIds: readonly string[]): PastPlan[] {
    const { store } = this.deps;
    const orgs = lead.scope === "root" ? undefined : orgIds.filter((id) => canWorkIn(lead, id));
    return store.plans.recent(orgs, PAST_CAP, task.id).flatMap((row) =>
      row.outcome === null
        ? []
        : [
            {
              task: row.task,
              title: store.tasks.get(row.task)?.title ?? "",
              how: row.plan.how,
              agents: row.outcome.agents,
            },
          ],
    );
  }

  /** The other running tasks the lead may see, with the files they touch and how much they overlap this one. */
  private async running(
    task: Task,
    lead: AgentFrontmatter,
    agents: readonly AgentFrontmatter[],
  ): Promise<RunningFacts[]> {
    const { planner } = this.deps;
    const visible = planner
      .running(task.id)
      .filter((t) => lead.scope === "root" || canWorkIn(lead, t.org))
      .slice(0, RUNNING_CAP);
    const named = likelyPaths(`${task.title}\n${task.brief}`);
    const likely = new Map(task.repos.map((r) => [r.project, named]));
    const accountOf = (id: string) => agents.find((a) => a.id === id)?.account;
    const out: RunningFacts[] = [];
    for (const other of visible) {
      const footprints = await planner.footprints(other);
      const overlap = overlapsOf(likely, footprints).find((o) => o.task === other.id)?.level ?? "none";
      out.push(runningFactsOf(other, accountOf, footprints, overlap));
    }
    return out;
  }
}

async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}
