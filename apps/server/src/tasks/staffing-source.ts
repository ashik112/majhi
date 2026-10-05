import {
  type AccountModels,
  type AccountStatus,
  type AgentFrontmatter,
  type ModelTier,
  resolveTier,
  type SlotCapacity,
  type Task,
  type TaskSize,
} from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { readDecisionSettings } from "../decisions/settings.ts";
import type { SkillStore } from "../skills/store.ts";
import type { Store } from "../store/index.ts";
import { readPrices } from "../usage/prices.ts";
import {
  type StaffAccount,
  type StaffAgent,
  type StaffHistory,
  type StaffProposal,
  staffTask,
} from "./staffing.ts";
import { type FactsInput, type MemberFacts, memberFacts } from "./team-facts.ts";

/** What staffing is asked about: an existing task, or the text of one that is about to be made. */
export interface StaffRequest {
  task?: Task | undefined;
  title: string;
  brief: string;
  kind: string;
  org: string | undefined;
  /** The projects it changes, with the base branch when known. */
  repos: readonly { project: string; base?: string | undefined }[];
}

export interface StaffingDeps {
  store: Store;
  agents: AgentStore;
  skills: Pick<SkillStore, "effectiveFor">;
  accounts: Pick<AccountService, "list"> & Partial<Pick<AccountService, "cachedModels">>;
  config: ConfigService;
  /** Free slots now, as `RunManager.capacity` gives them. */
  capacity: (accounts: readonly string[]) => Promise<SlotCapacity>;
  /** Laya's size for the request, cached for an existing task. Undefined: not known. */
  size: (request: StaffRequest) => Promise<TaskSize | undefined>;
  /** USD left today under the tightest budget that covers the org. Undefined: no budget. */
  budgetLeft: (org: string | undefined) => Promise<number | undefined>;
  /** The account floors in percent left. */
  floors: () => Promise<{ window: number; weekly: number }>;
}

const UNUSABLE: ReadonlySet<AccountStatus> = new Set(["needs-login", "at-limit", "unreachable"]);

const TIER_BY_LABEL: Record<string, ModelTier> = {
  "most capable": "most-capable",
  balanced: "balanced",
  "cheapest and fastest": "cheapest",
};

/** Gathers the facts `staffTask` weighs and runs it. Only this request's workspace is read. */
export class StaffingSource {
  constructor(private readonly deps: StaffingDeps) {}

  async propose(request: StaffRequest): Promise<StaffProposal> {
    const { agents, accounts, config, store } = this.deps;
    const stored = await agents.list();
    const all = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    const sections = await config.sections();
    const settings = await readDecisionSettings(config.file).catch(() => undefined);
    const prices = await readPrices(config.file).catch(() => ({}));
    const views = await accounts.list().catch(() => []);
    const viewById = new Map(views.map((v) => [v.id, v]));
    const orgTiers = sections.orgs[request.org ?? ""]?.tiers;

    const offered = new Map<string, AccountModels>();
    for (const id of new Set(all.map((a) => a.account))) {
      const models = await accounts.cachedModels?.(id).catch(() => undefined);
      if (models !== undefined) offered.set(id, models);
    }
    const task = request.task ?? stand(request);
    const tierOf = (fm: AgentFrontmatter) =>
      resolveTier(fm.role, fm.tier, orgTiers?.[fm.role], settings?.tiers[fm.role]);
    const facts: FactsInput = {
      task: { ...task, overrides: {} },
      now: new Date().toISOString(),
      agents: all,
      boss: sections.boss,
      accounts: viewById,
      offered,
      prices,
      runs: new Map(),
      tierOf,
      running: [],
    };

    const usedAccounts = [...new Set(all.map((a) => a.account))];
    const capacity = await this.deps.capacity(usedAccounts);
    const free = new Map(capacity.accounts.map((a) => [a.account, Math.min(a.free, capacity.agents.free)]));

    const staff: StaffAgent[] = [];
    const accountFacts = new Map<string, StaffAccount>();
    for (const fm of all) {
      const m = memberFacts(fm, facts);
      staff.push(agentOf(fm, m, tierOf(fm).model, await this.deps.skills.effectiveFor(fm)));
      if (!accountFacts.has(fm.account)) {
        accountFacts.set(fm.account, accountOf(fm.account, m, viewById.get(fm.account)?.status, free));
      }
    }
    const size = await this.deps.size(request);
    const repo = request.repos[0]?.project;
    const budgetLeftUsd = await this.deps.budgetLeft(request.org);
    return staffTask({
      task: { title: request.title, brief: request.brief, kind: request.kind, org: request.org },
      size,
      agents: staff,
      boss: sections.boss,
      accounts: accountFacts,
      floors: await this.deps.floors(),
      budgetLeftUsd,
      history: this.history(request, store),
      repo,
    });
  }

  /**
   * How each agent did on finished tasks that changed the same project: tasks it was on that got
   * through (review, merge request or done) against tasks that paused on an error. Undefined when
   * the request names no repo, so that factor is skipped and the reason says so.
   */
  private history(request: StaffRequest, store: Store): Map<string, StaffHistory> | undefined {
    const projects = request.repos.map((r) => r.project);
    if (projects.length === 0) return undefined;
    const out = new Map<string, StaffHistory>();
    for (const s of store.tasks.list(true)) {
      if (s.id === request.task?.id || !s.repos.some((r) => projects.includes(r.project))) continue;
      const finished = s.status === "done" || s.status === "review" || s.status === "mr";
      const failed = s.status === "paused" && s.pausedReason === "error";
      if (!finished && !failed) continue;
      for (const agent of s.team) {
        const h = out.get(agent) ?? { done: 0, failed: 0 };
        if (finished) h.done += 1;
        else h.failed += 1;
        out.set(agent, h);
      }
    }
    return out;
  }
}

function agentOf(fm: AgentFrontmatter, m: MemberFacts, fallback: ModelTier, skills: string[]): StaffAgent {
  return {
    id: fm.id,
    scope: fm.scope,
    where: fm.where,
    role: fm.role,
    account: fm.account,
    skills,
    tier: (m.tier === undefined ? undefined : TIER_BY_LABEL[m.tier]) ?? fallback,
    pricePerMTok: m.price === undefined ? undefined : (m.price.input + m.price.output) / 2,
  };
}

function accountOf(
  id: string,
  m: MemberFacts,
  status: AccountStatus | undefined,
  free: ReadonlyMap<string, number>,
): StaffAccount {
  const plan = m.limits.kind === "plan" ? m.limits : undefined;
  return {
    id,
    usable: status !== undefined && !UNUSABLE.has(status),
    freeSlots: free.get(id) ?? 0,
    windowLeftPct: plan?.window?.leftPct,
    weeklyLeftPct: plan?.weekly?.leftPct,
    apiKey: m.limits.kind === "api-key",
  };
}

/** A task that does not exist yet, shaped just enough for `memberFacts`. */
function stand(request: StaffRequest): Task {
  return {
    id: "NEW-0",
    title: request.title,
    brief: request.brief,
    org: request.org,
    team: [],
    overrides: {},
    repos: [],
  } as unknown as Task; // memberFacts reads only `overrides`; the rest keeps the type honest.
}
