import { canWorkIn, type ModelTier, type Role, type TaskSize } from "@majhi/shared";

/**
 * Staffing (SPEC 5.18): which agents work on a task, and which one leads. A pure function of facts,
 * with no built-in preference for any agent, role or account: every candidate gets a score from what
 * the facts say, the best one leads, and further members join only while the task is big enough and
 * they would not just wait for a slot. `staffing-source.ts` gathers the facts.
 */

export interface StaffAgent {
  id: string;
  /** An org id, or `root`. */
  scope: string;
  where: readonly string[];
  role: Role;
  account: string;
  skills: readonly string[];
  /** The model tier this agent runs at (its own model's rank, or its role's fallback). */
  tier: ModelTier;
  /** Blended USD per million tokens of its model, when the price table knows it. */
  pricePerMTok?: number | undefined;
}

export interface StaffAccount {
  id: string;
  /** False for an account that needs a sign-in, is at its limit or cannot be reached. */
  usable: boolean;
  /** Slots free for a new start on this account right now (per-account and global limits). */
  freeSlots: number;
  /** Percent left of the 5-hour and weekly windows. Undefined: unknown, or an API key (no window). */
  windowLeftPct?: number | undefined;
  weeklyLeftPct?: number | undefined;
  /** An API key pays per token: no windows, so the budget and the price carry the weight. */
  apiKey?: boolean | undefined;
}

/** How agents did on finished tasks in the task's repo: the tasks they were on that got through, or failed. */
export interface StaffHistory {
  done: number;
  failed: number;
}

export interface StaffInput {
  task: { title: string; brief: string; kind: string; org: string | undefined };
  /** Laya's rating. Undefined: not known, which is staffed like a medium task. */
  size: TaskSize | undefined;
  /** Every agent of majhi. Those not allowed in the task's org, and the captain, are ignored. */
  agents: readonly StaffAgent[];
  boss?: string | undefined;
  accounts: ReadonlyMap<string, StaffAccount>;
  floors: { window: number; weekly: number };
  /** USD left today under the tightest budget that covers the task's workspace. Undefined: no budget. */
  budgetLeftUsd?: number | undefined;
  /** Per agent, past results in this repo. Undefined: no task records to read, and that factor is skipped. */
  history?: ReadonlyMap<string, StaffHistory> | undefined;
  /** The repo rule's line when another task holds the repo, said at the end of the reason. */
  repoNote?: string | undefined;
  /** The repo the task changes, for the history line. */
  repo?: string | undefined;
}

export interface StaffProposal {
  /** Lead first. Empty when no agent can take the task now. */
  team: string[];
  lead: string | undefined;
  /** One line naming the main factors. */
  reason: string;
  /** Every candidate with its score, best first, for the tool and the tests. */
  ranked: { agent: string; score: number }[];
}

/** Tokens a task of this size is expected to use, for the cost estimate. */
const TOKENS_M: Record<TaskSize, number> = { small: 0.3, medium: 1.5, large: 6 };
/** How many agents a task of this size can use at most. */
const MAX_TEAM: Record<TaskSize, number> = { small: 1, medium: 2, large: 4 };
/** Roles that can lead. */
const CAN_LEAD: ReadonlySet<Role> = new Set(["Lead", "Builder"]);
const TIER_RANK: Record<ModelTier, number> = { "most-capable": 1, balanced: 0.5, cheapest: 0 };

interface Factor {
  key: "slot" | "headroom" | "cost" | "fit" | "skills" | "history";
  /** 0 to 1. */
  value: number;
  weight: number;
  /** The phrase when this factor is a main one. */
  phrase: string;
}

interface Scored {
  agent: StaffAgent;
  score: number;
  factors: Factor[];
  /** Why it cannot take the task at all, or undefined. */
  out?: string;
}

const WEIGHTS = { slot: 3, headroom: 3, cost: 2, fit: 2, skills: 1, history: 2 } as const;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []);
}

/** How much room an account has above the floors: 1 is untouched, 0 is at the floor. Undefined: unknown. */
function headroom(
  a: StaffAccount,
  floors: StaffInput["floors"],
): { value: number; text: string } | undefined {
  const parts: { value: number; text: string }[] = [];
  const one = (left: number | undefined, floor: number, label: string) => {
    if (left === undefined) return;
    parts.push({
      value: Math.max(0, Math.min(1, (left - floor) / Math.max(1, 100 - floor))),
      text: `${Math.round(left)}% of its ${label} left`,
    });
  };
  one(a.windowLeftPct, floors.window, "window");
  one(a.weeklyLeftPct, floors.weekly, "week");
  if (parts.length === 0) return undefined;
  return parts.reduce((low, p) => (p.value < low.value ? p : low));
}

function score(
  agent: StaffAgent,
  input: StaffInput,
  slotsLeft: Map<string, number>,
  maxCost: number,
): Scored {
  const account = input.accounts.get(agent.account);
  const out = (why: string): Scored => ({ agent, score: 0, factors: [], out: why });
  if (account === undefined) return out(`${agent.account} is unknown`);
  if (!account.usable) return out(`${agent.account} cannot run now`);
  const room = headroom(account, input.floors);
  if (account.windowLeftPct !== undefined && account.windowLeftPct < input.floors.window) {
    return out(`${agent.account} is under its window floor`);
  }
  if (account.weeklyLeftPct !== undefined && account.weeklyLeftPct < input.floors.weekly) {
    return out(`${agent.account} is under its weekly floor`);
  }
  const size = input.size ?? "medium";
  const cost = agent.pricePerMTok === undefined ? undefined : agent.pricePerMTok * TOKENS_M[size];
  if (input.budgetLeftUsd !== undefined && cost !== undefined && cost > input.budgetLeftUsd) {
    return out("its expected cost is over the budget left");
  }
  const free = slotsLeft.get(agent.account) ?? 0;
  const factors: Factor[] = [];
  factors.push({
    key: "slot",
    value: free > 0 ? 1 : 0,
    weight: WEIGHTS.slot,
    phrase: free > 0 ? "free slot" : "no free slot yet",
  });
  factors.push({
    key: "headroom",
    value: room?.value ?? (account.apiKey === true ? 1 : 0.6),
    weight: WEIGHTS.headroom,
    phrase: room?.text ?? (account.apiKey === true ? "pays per token, no window" : "usage not known"),
  });
  const costValue = cost === undefined ? 0.5 : maxCost <= 0 ? 1 : 1 - cost / maxCost;
  factors.push({
    key: "cost",
    value: costValue,
    weight: input.budgetLeftUsd !== undefined || account.apiKey === true ? WEIGHTS.cost + 1 : WEIGHTS.cost,
    phrase: cost === undefined ? "price not known" : `about $${cost.toFixed(2)} expected`,
  });
  const rank = TIER_RANK[agent.tier];
  const want = size === "large" ? 1 : size === "small" ? 0 : 0.5;
  factors.push({
    key: "fit",
    value: 1 - Math.abs(rank - want),
    weight: WEIGHTS.fit,
    phrase: `${agent.tier.replace("-", " ")} model suits a ${size} task`,
  });
  const text = words(`${input.task.title} ${input.task.brief} ${input.task.kind}`);
  const matched = agent.skills.filter((s) => [...words(s)].some((w) => text.has(w)));
  if (agent.skills.length > 0) {
    factors.push({
      key: "skills",
      value: matched.length > 0 ? 1 : 0,
      weight: WEIGHTS.skills,
      phrase: matched.length > 0 ? `skill ${matched[0]}` : "no skill match",
    });
  }
  const past = input.history?.get(agent.id);
  if (past !== undefined && past.done + past.failed > 0) {
    factors.push({
      key: "history",
      value: (past.done + 1) / (past.done + past.failed + 2),
      weight: WEIGHTS.history,
      phrase: `${past.done} finished${input.repo === undefined ? "" : ` in ${input.repo}`}${past.failed > 0 ? `, ${past.failed} failed` : ""}`,
    });
  }
  const total = factors.reduce((s, f) => s + f.weight, 0);
  const sum = factors.reduce((s, f) => s + f.value * f.weight, 0);
  return { agent, score: total === 0 ? 0 : sum / total, factors };
}

/** The phrases of the factors that helped most (value times weight above its share), best first. */
function mainFactors(s: Scored, count: number): string[] {
  return [...s.factors]
    .filter((f) => f.value >= 0.5 || f.key === "slot")
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .slice(0, count)
    .map((f) => f.phrase);
}

function joinWhy(role: Role): string {
  if (role === "Reviewer") return "to review";
  if (role === "Tester") return "for the tests";
  if (role === "Lead") return "to plan alongside";
  return "to build";
}

/**
 * Picks the team and the lead for a task. Never looks at an agent the task's workspace may not use.
 * Extra members join one at a time, best score first, while the size allows more agents, each has a
 * free slot on its account (a member that would only wait adds nothing) and scores at least half of
 * what the lead scored.
 */
export function staffTask(input: StaffInput): StaffProposal {
  const size = input.size ?? "medium";
  const allowed = input.agents.filter(
    (a) => a.id !== input.boss && a.role !== "Root" && canWorkIn(a, input.task.org),
  );
  const slotsLeft = new Map([...input.accounts].map(([id, a]) => [id, a.freeSlots]));
  const maxCost = Math.max(
    0,
    ...allowed.flatMap((a) => (a.pricePerMTok === undefined ? [] : [a.pricePerMTok * TOKENS_M[size]])),
  );
  const scored = allowed.map((a) => score(a, input, slotsLeft, maxCost));
  const usable = scored
    .filter((s) => s.out === undefined)
    .sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id));
  const ranked = usable.map((s) => ({ agent: s.agent.id, score: Math.round(s.score * 1000) / 1000 }));

  const lead = usable.find((s) => CAN_LEAD.has(s.agent.role));
  if (lead === undefined) {
    const why = scored
      .filter((s) => s.out !== undefined)
      .slice(0, 3)
      .map((s) => `@${s.agent.id}: ${s.out}`)
      .join("; ");
    return {
      team: [],
      lead: undefined,
      reason: `No agent of this workspace can take it now${why === "" ? "" : ` (${why})`}.`,
      ranked,
    };
  }

  const team = [lead];
  slotsLeft.set(lead.agent.account, Math.max(0, (slotsLeft.get(lead.agent.account) ?? 0) - 1));
  for (const cand of usable) {
    if (team.length >= MAX_TEAM[size]) break;
    if (team.includes(cand)) continue;
    if ((slotsLeft.get(cand.agent.account) ?? 0) <= 0) continue;
    if (cand.score < lead.score * 0.5) continue;
    // A reviewer or tester helps a bigger task only; a small one has no use for them.
    if ((cand.agent.role === "Reviewer" || cand.agent.role === "Tester") && size === "small") continue;
    team.push(cand);
    slotsLeft.set(cand.agent.account, (slotsLeft.get(cand.agent.account) ?? 0) - 1);
  }

  const leadPhrases = mainFactors(lead, 3).join(", ");
  const joins = team
    .slice(1)
    .map((m) => `@${m.agent.id} joins ${joinWhy(m.agent.role)}`)
    .join("; ");
  const notes: string[] = [];
  if (input.history === undefined || input.history.size === 0)
    notes.push("no past results in this repo to weigh");
  if (input.size === undefined) notes.push("size not known, staffed as medium");
  const parts = [
    `@${lead.agent.id} leads on ${lead.agent.account}: ${leadPhrases}${joins === "" ? "" : `; ${joins}`}`,
    ...(notes.length === 0 ? [] : [notes.join(", ")]),
    ...(input.repoNote === undefined ? [] : [input.repoNote]),
  ];
  return {
    team: team.map((m) => m.agent.id),
    lead: lead.agent.id,
    reason: `${parts.join(". ")}.`.replace(/\.\.$/, "."),
    ranked,
  };
}
