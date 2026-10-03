import {
  type AccountModels,
  type AccountStatus,
  type AccountUsage,
  type AccountView,
  type AgentFrontmatter,
  AUTO,
  type AuthMode,
  canWorkIn,
  findPrice,
  normalizeModel,
  type PlanAgentTokens,
  type PlanHow,
  type PricesConfig,
  type Role,
  type Task,
  type Tier,
} from "@majhi/shared";
import { effortForTier, modelForTier, normalizeOffered, rankModels } from "../runs/model-options.ts";
import type { Footprint, OverlapLevel } from "./planning.ts";

/**
 * What the lead of a task gets to decide how to staff it (PRV-52): each member's model, price tier,
 * effort, account and what is left of the account's limits; the agents that could join; the other
 * running tasks and the files they touch. Pure functions: `team-facts-source.ts` gathers the inputs.
 */

export type Limits =
  | { kind: "api-key" } // pays per token, no plan windows
  | { kind: "unknown" } // login account, usage not read yet
  | {
      kind: "plan";
      status: AccountStatus;
      /** majhi counted the tokens itself (AccountUsage.estimated). */
      estimated: boolean;
      window?: { leftPct: number; resetsAt?: string };
      weekly?: { leftPct: number; resetsAt?: string };
      /** Weekly windows of one model (Opus, Sonnet), when the tool reports them. */
      models: { label: string; leftPct: number }[];
    };

export interface MemberFacts {
  id: string;
  role: Role;
  /** What it runs or will run. Undefined: the CLI's default. */
  model: string | undefined;
  /** The agent file says auto and it has not run in this task yet: `model` is its fallback tier's model. */
  auto: boolean;
  /** rankModels label among the models its account offers: "most capable", "balanced", "cheapest and fastest". */
  tier?: string;
  /** The rank is a guess: an offered model has no price. */
  estimated?: boolean;
  /** USD per million tokens (findPrice: owner rows over defaults). */
  price?: { input: number; output: number };
  effort: string | undefined;
  account: string;
  limits: Limits;
}

export interface RunningFacts {
  id: string;
  title: string;
  /** Its team, lead first, with accounts. */
  agents: { id: string; account: string }[];
  /** Per project: files it changed, or (changed: false) paths its brief names. At most 6 each, `more` counts the rest. */
  projects: { project: string; files: string[]; more: number; changed: boolean }[];
  /** Overlap with this task, as overlapsOf gives it. */
  overlap: OverlapLevel;
}

/** A plan of another task that has finished, with the tokens each agent used under it. */
export interface PastPlan {
  task: string;
  /** Empty when the task is gone. */
  title: string;
  how: PlanHow[];
  agents: PlanAgentTokens[];
}

export interface TeamFacts {
  /** ISO time of the read. */
  at: string;
  lead: string;
  members: MemberFacts[];
  /** Agents that may work in the task's org, not on the team, not the captain. Mentioning one adds it. */
  joinable: MemberFacts[];
  running: RunningFacts[];
  /** At most 3 plans of other tasks with an outcome, newest first. */
  past: PastPlan[];
}

export interface FactsInput {
  task: Task;
  now: string;
  agents: readonly AgentFrontmatter[];
  boss: string | undefined;
  accounts: ReadonlyMap<string, AccountView>;
  /** Cached models and efforts per account id (AccountModels). */
  offered: ReadonlyMap<string, AccountModels>;
  prices: PricesConfig;
  /** Latest run of each agent in this task: what it really runs. */
  runs: ReadonlyMap<string, { model?: string; effort?: string }>;
  /** Fallback tier of an agent, resolved like runs/pick.ts: resolveTier(role, fm.tier, orgTiers[role], settings.tiers[role]). */
  tierOf: (fm: AgentFrontmatter) => Tier;
  running: readonly RunningFacts[];
  past?: readonly PastPlan[];
  /** Agents the owner took off the team: a mention does not bring them back, so they are not offered. */
  removed?: readonly string[];
}

/** At most this many agents that could join, and running tasks, and files per project. */
const LIST_CAP = 6;
/** At most this many recent plans. */
const PAST_CAP = 3;

// ---------------------------------------------------------------------------
// Building the facts

export function buildTeamFacts(input: FactsInput): TeamFacts {
  const { task, agents } = input;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const members = task.team.flatMap((id) => {
    const fm = byId.get(id);
    return fm === undefined ? [] : [memberFacts(fm, input)];
  });
  const usable = (a: AgentFrontmatter) => {
    const status = input.accounts.get(a.account)?.status;
    return status !== undefined && !UNUSABLE.has(status);
  };
  const joinable = agents
    .filter(
      (a) =>
        !task.team.includes(a.id) &&
        a.id !== input.boss &&
        !(input.removed ?? []).includes(a.id) &&
        canWorkIn(a, task.org),
    )
    .sort(
      (a, b) =>
        Number(!usable(a)) - Number(!usable(b)) ||
        Number(a.scope !== task.org) - Number(b.scope !== task.org) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, LIST_CAP)
    .map((a) => memberFacts(a, input));
  return {
    at: input.now,
    lead: task.team[0] ?? "",
    members,
    joinable,
    running: input.running.slice(0, LIST_CAP),
    past: (input.past ?? []).slice(0, PAST_CAP),
  };
}

const UNUSABLE: ReadonlySet<AccountStatus> = new Set(["needs-login", "at-limit", "unreachable"]);

export function memberFacts(fm: AgentFrontmatter, input: FactsInput): MemberFacts {
  const { task } = input;
  const run = input.runs.get(fm.id);
  const override = task.overrides[fm.id];
  const offered = input.offered.get(fm.account);
  const view = input.accounts.get(fm.account);
  const named = (value: string | undefined) => (value === undefined || value === AUTO ? undefined : value);

  // The owner's override for this task wins: it switches a live session without touching its run row.
  const overrideModel = named(override?.model);
  const overrideEffort = named(override?.effort);
  let model = overrideModel ?? run?.model ?? (override?.model === AUTO ? undefined : named(fm.model));
  let auto = false;
  if (
    model === undefined &&
    (override?.model === AUTO || (override?.model === undefined && fm.model === AUTO))
  ) {
    auto = true;
    model =
      offered === undefined
        ? undefined
        : modelForTier(fallbackModels(fm, offered, view), input.tierOf(fm).model, input.prices);
  }
  const effortAuto = override?.effort === AUTO || (override?.effort === undefined && fm.effort === AUTO);
  const effort =
    overrideEffort ??
    run?.effort ??
    (override?.effort === AUTO ? undefined : named(fm.effort)) ??
    (effortAuto && offered !== undefined
      ? effortForTier(offered.efforts, input.tierOf(fm).effort)
      : undefined);

  return {
    id: fm.id,
    role: fm.role,
    model,
    auto,
    ...priceTier(model, offered, input.prices),
    effort,
    account: fm.account,
    limits: view === undefined ? { kind: "unknown" } : limitsOf(view.auth, view.status, view.usage),
  };
}

/** The models an `auto` pick may take: the agent's own list when it has one, else all but the hidden ones. */
function fallbackModels(fm: AgentFrontmatter, offered: AccountModels, view: AccountView | undefined) {
  const allowed = fm.models ?? [];
  const hidden = view?.hiddenModels ?? [];
  return normalizeOffered(
    offered.models.filter((m) => (allowed.length > 0 ? allowed.includes(m.id) : !hidden.includes(m.id))),
  );
}

const leftOf = (usedPct: number) => Math.max(0, Math.round(100 - usedPct));

/** The plan windows of a login account, or why there are none. */
export function limitsOf(auth: AuthMode, status: AccountStatus, usage: AccountUsage | undefined): Limits {
  if (auth === "api-key") return { kind: "api-key" };
  if (usage === undefined && (status === "unknown" || status === "healthy")) return { kind: "unknown" };
  return {
    kind: "plan",
    status,
    estimated: usage?.estimated ?? false,
    ...(usage?.window === undefined ? {} : { window: windowLeft(usage.window) }),
    ...(usage?.weekly === undefined ? {} : { weekly: windowLeft(usage.weekly) }),
    models: (usage?.models ?? []).map((m) => ({ label: m.label, leftPct: leftOf(m.usedPct) })),
  };
}

function windowLeft(w: { usedPct: number; resetsAt?: string | undefined }): {
  leftPct: number;
  resetsAt?: string;
} {
  return { leftPct: leftOf(w.usedPct), ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }) };
}

/** Where the model stands among the account's offered models, and what it costs. */
export function priceTier(
  model: string | undefined,
  offered: AccountModels | undefined,
  prices: PricesConfig,
): Pick<MemberFacts, "tier" | "estimated" | "price"> {
  const out: Pick<MemberFacts, "tier" | "estimated" | "price"> = {};
  if (model === undefined) return out;
  if (offered !== undefined) {
    const rank = rankModels(normalizeOffered(offered.models), prices);
    const wanted = normalizeModel(model);
    const label =
      rank.labels.get(model) ?? [...rank.labels].find(([id]) => normalizeModel(id) === wanted)?.[1];
    if (label !== undefined) {
      out.tier = label;
      if (rank.estimated) out.estimated = true;
    }
  }
  const found = findPrice(model, prices);
  if (found !== undefined) out.price = { input: found.price.input, output: found.price.output };
  return out;
}

/** What one other running task looks like to the lead. `footprints` are that task's, `overlap` its overlap with this one. */
export function runningFactsOf(
  other: Pick<Task, "id" | "title" | "team">,
  accountOf: (agent: string) => string | undefined,
  footprints: readonly Footprint[],
  overlap: OverlapLevel,
): RunningFacts {
  return {
    id: other.id,
    title: other.title,
    agents: other.team.map((id) => ({ id, account: accountOf(id) ?? "unknown" })),
    projects: footprints
      .filter((f) => f.task === other.id)
      .map((f) => {
        const paths = f.changed ? (f.changedPaths ?? f.paths) : f.paths;
        return {
          project: f.project,
          files: paths.slice(0, LIST_CAP),
          more: Math.max(0, paths.length - LIST_CAP),
          changed: f.changed,
        };
      }),
    overlap,
  };
}

// ---------------------------------------------------------------------------
// TASK.md

/**
 * The TASK.md "Team facts" section. It changes every time the lead wakes (the clock, the limits
 * left, what runs), so TASK.md puts it after the sections that do not.
 */
export function teamFactsLines(f: TeamFacts): string[] {
  const lines = [
    "## Team facts",
    "",
    `As of ${clock(f.at)}. majhi rewrites this each time it wakes @${f.lead}.`,
    "",
    ...f.members.map(memberLine),
  ];
  if (f.joinable.length > 0) {
    lines.push(
      "",
      'Could join (start a line with "@name:" or use the mention tool to add one to the team):',
      ...f.joinable.map(memberLine),
    );
  }
  lines.push("");
  if (f.running.length === 0) lines.push("Running now: nothing else.");
  else lines.push("Running now:", ...f.running.map(runningLine));
  if (f.past.length > 0) {
    lines.push("", "Recent plans, with the tokens each agent used:", ...f.past.map(pastLine));
  }
  return lines;
}

/** The TASK.md "How the lead plans" section: fixed text, so it sits with the stable sections. */
export function leadPlanLines(lead: string): string[] {
  return [
    "## How the lead plans",
    "",
    `@${lead}: choose the cheapest way that gets this done well, and say why.`,
    "",
    '- Your first reply states the plan in a few lines: who does what, in which order, and why that is cheaper or faster. For example "the builder on a cheaper model writes the code, I review", or "small change, I do it myself". Record it with the majhi-room record_plan tool before you start the work: the room shows it as a plan line, and majhi keeps it with the tokens each agent used.',
    "- Rules of thumb, not limits: give bulk implementation to cheaper agents; keep expensive models for planning and review; split large work into child tasks so turns stay short; run independent parts in parallel on different accounts when their limits allow. Doing it alone is right when handing over would cost more than the work.",
    "- Do not give a long job to an agent whose account is nearly out.",
    "- The owner may reply to change the plan. Follow the new plan, and record it again with record_plan.",
    "- Hand over the lead (majhi-tasks set_lead, naming a teammate or an agent that may join) when your account is at its limit, the task needs another skill or model, or you are stuck. The new lead gets a note with the plan, what is done and what is next; you stay as a builder unless you set keepOldLead to false.",
  ];
}

function memberLine(m: MemberFacts): string {
  const parts: string[] = [];
  if (m.model === undefined) parts.push(m.auto ? "auto, picked when it starts" : "CLI default model");
  else parts.push(m.auto ? `${m.model} (auto, its fallback tier)` : m.model);
  if (m.tier !== undefined) parts.push(m.estimated === true ? `${m.tier} (estimated)` : m.tier);
  if (m.price !== undefined)
    parts.push(`$${money(m.price.input)} in and $${money(m.price.output)} out per M tokens`);
  parts.push(m.effort === undefined ? "default effort" : `effort ${m.effort}`);
  return `- @${m.id} (${m.role}): ${parts.join(", ")}. ${limitsSentence(m.account, m.limits)}`;
}

function limitsSentence(account: string, l: Limits): string {
  if (l.kind === "api-key") return `Account ${account}: API key, pays per token, no plan limits.`;
  if (l.kind === "unknown") return `Account ${account}: limits not read yet.`;
  if (l.status === "needs-login") return `Account ${account}: needs login.`;
  if (l.status === "unreachable") return `Account ${account}: unreachable.`;
  if (l.status === "at-limit") {
    const blocked = [l.window, l.weekly].find((w) => w?.leftPct === 0) ?? l.window ?? l.weekly;
    const until = blocked?.resetsAt === undefined ? undefined : stamp(blocked.resetsAt, blocked === l.weekly);
    return `Account ${account}: at its limit${until === undefined ? "" : ` until ${until}`}.`;
  }
  const parts: string[] = [];
  if (l.window !== undefined) parts.push(`5-hour ${leftText(l.window, false)}`);
  if (l.weekly !== undefined) parts.push(`weekly ${leftText(l.weekly, true)}`);
  for (const m of l.models) parts.push(`weekly ${m.label} ${m.leftPct}% left`);
  if (parts.length === 0) return `Account ${account}: limits not read yet.`;
  return `Account ${account}: ${parts.join(", ")}${l.estimated ? " (majhi's count)" : ""}.`;
}

function leftText(w: { leftPct: number; resetsAt?: string }, weekly: boolean): string {
  const reset = w.resetsAt === undefined ? undefined : stamp(w.resetsAt, weekly);
  return `${w.leftPct}% left${reset === undefined ? "" : ` (resets ${reset})`}`;
}

function runningLine(r: RunningFacts): string {
  const who = r.agents.map((a) => `@${a.id} on ${a.account}`).join(", ");
  const where = r.projects
    .filter((p) => p.files.length > 0)
    .map((p) => {
      const files = p.files.join(", ") + (p.more > 0 ? ` and ${p.more} more` : "");
      return p.changed
        ? `Changed in ${p.project}: ${files}.`
        : `Its brief names in ${p.project}: ${files} (nothing changed yet).`;
    });
  return `- ${r.id} ${r.title}: ${[`${who}.`, ...where, `Overlap with this task: ${r.overlap}.`].join(" ")}`;
}

function pastLine(p: PastPlan): string {
  const title = p.title === "" ? "" : ` ${p.title}`;
  return `- ${p.task}${title} (${p.how.join(", ")}): ${agentsText(p.agents)}.`;
}

/** "@acme-lead 310k tokens ($2.10), @acme-builder 1.2M tokens ($1.40)". */
export function agentsText(agents: readonly PlanAgentTokens[]): string {
  return agents
    .map(
      (a) =>
        `@${a.agent} ${tokensText(a.tokens)} tokens${a.costUsd === null ? "" : ` (${usdText(a.costUsd)})`}`,
    )
    .join(", ");
}

/** 950, 310k, 1.2M: one decimal at most. */
export function tokensText(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${String(Number((n / 1000).toFixed(1)))}k`;
  return `${String(Number((n / 1_000_000).toFixed(1)))}M`;
}

/** "$2.10". */
export function usdText(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Dollars without trailing zeros: 0.8, 1.25, 5. */
function money(n: number): string {
  return String(Number(n.toFixed(4)));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "11:05 UTC". An unreadable time is left as it came. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${hhmm(d)} UTC`;
}

/** "13:00 UTC", or with the weekday for a weekly reset: "Mon 09:00 UTC". Undefined when unreadable. */
function stamp(iso: string, withDay: boolean): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${withDay ? `${DAYS[d.getUTCDay()]} ` : ""}${hhmm(d)} UTC`;
}

// ---------------------------------------------------------------------------
// The wake prompt

/** Left percentages are rounded to the nearest 5, so small moves do not count as a change. */
const nearest5 = (pct: number) => Math.round(pct / 5) * 5;

/** The short block added to a wake prompt. */
export function wakeFacts(f: TeamFacts): string {
  const line = (m: MemberFacts) => {
    const what = [
      m.model ?? (m.auto ? "auto, picked when it starts" : "CLI default model"),
      ...(m.tier === undefined ? [] : [m.tier]),
    ];
    what.push(m.effort === undefined ? "default effort" : `effort ${m.effort}`);
    return `- @${m.id} (${m.role}): ${what.join(", ")}; ${shortLimits(m.account, m.limits)}.`;
  };
  const lines = ["Team facts now (TASK.md has the detail):", ...f.members.map(line)];
  if (f.joinable.length > 0) {
    lines.push(
      `Could join: ${f.joinable.map((m) => `@${m.id} (${m.role}${m.model === undefined ? "" : `, ${m.model}`})`).join(", ")}.`,
    );
  }
  lines.push(
    f.running.length === 0
      ? "Running: nothing else."
      : `Running: ${f.running.map((r) => (r.overlap === "unknown" ? r.id : `${r.id} (${r.overlap === "none" ? "no" : r.overlap} overlap)`)).join(", ")}.`,
  );
  return lines.join("\n");
}

function shortLimits(account: string, l: Limits): string {
  if (l.kind === "api-key") return `${account} API key, no plan limits`;
  if (l.kind === "unknown") return `${account} limits not read yet`;
  if (l.status === "needs-login") return `${account} needs login`;
  if (l.status === "unreachable") return `${account} unreachable`;
  if (l.status === "at-limit") return `${account} at its limit`;
  const parts: string[] = [];
  if (l.window !== undefined) parts.push(`5-hour ${nearest5(l.window.leftPct)}% left`);
  if (l.weekly !== undefined) parts.push(`weekly ${nearest5(l.weekly.leftPct)}% left`);
  return parts.length === 0 ? `${account} limits not read yet` : `${account} ${parts.join(", ")}`;
}
