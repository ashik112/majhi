import { type AccountModels, type AgentFrontmatter, canWorkIn, resolveTier, type Task } from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { readDecisionSettings } from "../decisions/settings.ts";
import { modelForTier } from "../runs/model-options.ts";
import type { Store } from "../store/index.ts";
import { readPrices } from "../usage/prices.ts";
import { downOf, type Hand, headroomOf, type ReviewerCandidate } from "./crew.ts";
import type { TaskPlanner } from "./planner.ts";
import { likelyPaths, overlapsOf } from "./planning.ts";
import {
  buildTeamFacts,
  fallbackModels,
  limitsOf,
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
  /** What each agent cost this task so far, in USD. Absent: not shown. */
  costs?: ((task: string) => Map<string, number>) | undefined;
  /** Why this computer is busy now, or undefined when it is calm. */
  busy?: (() => string | undefined) | undefined;
}

/** Gathers the team facts of a task from the agents, accounts, price table, runs and the planner. */
export class TeamFactsSource {
  constructor(private readonly deps: TeamFactsDeps) {}

  /**
   * The facts for a lead-mode task with a team. Undefined when they do not apply (a chat task, the
   * captain chat, another mode, no team) or the agents cannot be read. Any other read that fails
   * leaves its part out: facts never stop a turn.
   */
  async facts(task: Task, options: { light?: boolean } = {}): Promise<TeamFacts | undefined> {
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
      running: options.light === true ? [] : ((await attempt(() => this.running(task, lead, all))) ?? []),
      past:
        options.light === true
          ? []
          : ((await attempt(async () => this.past(task, lead, Object.keys(sections?.orgs ?? {})))) ?? []),
      removed: store.tasks.roomState(task.id).removed ?? [],
      costs: this.deps.costs?.(task.id) ?? new Map(),
      busy: this.deps.busy?.(),
    });
  }

  /**
   * The team as staffing sees it: for each agent whether its account can run now, what it has left and
   * what it cost this task. Reads the agents and the accounts, no git: it runs at every step.
   */
  async hands(task: Task): Promise<Hand[]> {
    const { agents, accounts } = this.deps;
    const stored = await attempt(() => agents.list());
    const all = (stored ?? []).flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    const views = new Map(((await attempt(() => accounts.list())) ?? []).map((v) => [v.id, v]));
    const costs = this.deps.costs?.(task.id) ?? new Map<string, number>();
    return task.team.flatMap((id) => {
      const fm = all.find((a) => a.id === id);
      if (fm === undefined) return [];
      const view = views.get(fm.account);
      const limits =
        view === undefined ? ({ kind: "unknown" } as const) : limitsOf(view.auth, view.status, view.usage);
      const down = downOf(fm.account, limits, view?.limit?.until);
      return [
        { id, up: down === undefined, headroom: headroomOf(limits), costUsd: costs.get(id) ?? 0, down },
      ];
    });
  }

  /** The agents that could review this task, each with the price of its model: the team first, then the ones that could join. */
  async reviewers(task: Task): Promise<ReviewerCandidate[]> {
    const facts = await this.facts(task, { light: true });
    if (facts === undefined) return [];
    const hands = await this.hands(task);
    const row = (m: TeamFacts["members"][number], inTeam: boolean): ReviewerCandidate => ({
      id: m.id,
      role: m.role,
      inTeam,
      up: inTeam ? (hands.find((h) => h.id === m.id)?.up ?? true) : downOf(m.account, m.limits) === undefined,
      price: m.price?.output,
    });
    return [...facts.members.map((m) => row(m, true)), ...facts.joinable.map((m) => row(m, false))];
  }

  /** The cheapest model the agent's account offers, by the price ranking. Undefined when it offers fewer than two. */
  async cheapestModel(agent: string): Promise<string | undefined> {
    const { agents, accounts, config } = this.deps;
    const stored = await attempt(() => agents.get(agent));
    if (stored === undefined || !stored.ok) return undefined;
    const fm = stored.agent.frontmatter;
    const offered = await attempt(() => accounts.cachedModels(fm.account));
    if (offered === undefined) return undefined;
    const view = ((await attempt(() => accounts.list())) ?? []).find((v) => v.id === fm.account);
    const models = fallbackModels(fm, offered, view);
    if (models.length < 2) return undefined;
    const prices = (await attempt(() => readPrices(config.file))) ?? {};
    return modelForTier(models, "cheapest", prices);
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
    // An ancestor holds this task's own work, so it is never an overlap (the planner says the same).
    const ancestors = planner.ancestors(task);
    const out: RunningFacts[] = [];
    for (const other of visible) {
      const footprints = await planner.footprints(other);
      const overlap = ancestors.has(other.id)
        ? "none"
        : (overlapsOf(likely, footprints).find((o) => o.task === other.id)?.level ?? "none");
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
