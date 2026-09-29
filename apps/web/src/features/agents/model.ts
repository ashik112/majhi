import {
  type AccountView,
  type AgentEntry,
  type AgentFrontmatter,
  type AgentFrontmatterInput,
  AUTO,
  type HealthCheck,
  type OptionValue,
  type OrgView,
  PERSONAL,
  type Perm,
  type Role,
} from "@majhi/shared";
import { statusInfo, type Tone } from "../accounts/model";

export type OkAgent = Extract<AgentEntry, { status: "ok" }>;
export type InvalidAgent = Extract<AgentEntry, { status: "invalid" }>;

export const ROOT_SCOPE = "root";
/** Group for files that failed to load. Not a real scope. */
export const INVALID_GROUP = "invalid";

export function entryId(entry: AgentEntry): string {
  return entry.status === "ok" ? entry.agent.frontmatter.id : entry.id;
}

export interface AgentGroup {
  /** `root`, an org id, an unknown scope found in a file, or `invalid`. */
  scope: string;
  label: string;
  color?: string;
  entries: AgentEntry[];
  /** Whether the owner can add an agent here. False for the invalid group. */
  canAdd: boolean;
}

function byBossThenId(a: AgentEntry, b: AgentEntry): number {
  const boss = Number(b.status === "ok" && b.isBoss) - Number(a.status === "ok" && a.isBoss);
  return boss !== 0 ? boss : entryId(a).localeCompare(entryId(b));
}

/**
 * Root first, then every org in list order (empty ones too, so each has a "New" button), then
 * scopes that appear in files but not in the org list, then files that failed to load.
 */
export function groupAgents(entries: readonly AgentEntry[], orgs: readonly OrgView[]): AgentGroup[] {
  const ok = entries.filter((e): e is OkAgent => e.status === "ok");
  const invalid = entries.filter((e) => e.status === "invalid");
  const inScope = (scope: string) => ok.filter((e) => e.agent.frontmatter.scope === scope).sort(byBossThenId);

  const groups: AgentGroup[] = [
    { scope: ROOT_SCOPE, label: "Root", entries: inScope(ROOT_SCOPE), canAdd: true },
  ];
  const known = new Set<string>([ROOT_SCOPE]);
  for (const org of orgs) {
    known.add(org.id);
    const group: AgentGroup = { scope: org.id, label: org.name, entries: inScope(org.id), canAdd: true };
    if (org.color) group.color = org.color;
    groups.push(group);
  }
  const strays = [...new Set(ok.map((e) => e.agent.frontmatter.scope))].filter((s) => !known.has(s)).sort();
  for (const scope of strays) groups.push({ scope, label: scope, entries: inScope(scope), canAdd: false });
  if (invalid.length > 0) {
    groups.push({
      scope: INVALID_GROUP,
      label: "Files with errors",
      entries: invalid.sort(byBossThenId),
      canAdd: false,
    });
  }
  return groups;
}

/**
 * Accounts an agent in `scope` may use. Root agents work anywhere, so any account fits. An org's
 * agent uses that org's accounts or the owner's personal ones, never another org's credentials
 * (SPEC 6).
 */
export function accountsForScope(accounts: readonly AccountView[], scope: string): AccountView[] {
  if (scope === ROOT_SCOPE) return [...accounts];
  return accounts.filter((a) => a.org === scope || a.org === PERSONAL);
}

/** The scope a new agent on an account belongs to: personal accounts get root agents. */
export function scopeForAccount(account: Pick<AccountView, "org">): string {
  return account.org === PERSONAL ? ROOT_SCOPE : account.org;
}

export interface Dot {
  tone: Tone;
  label: string;
}

/** Status dot for an agent: its last health check when there is one, else its account's status. */
export function agentDot(entry: AgentEntry, accounts: readonly AccountView[], health?: HealthCheck): Dot {
  if (entry.status === "invalid") return { tone: "red", label: "File has errors" };
  if (health)
    return health.ok
      ? { tone: "green", label: "Health check passed" }
      : { tone: "red", label: "Health check failed" };
  const account = accounts.find((a) => a.id === entry.agent.frontmatter.account);
  if (!account) return { tone: "red", label: "Account not found" };
  const info = statusInfo(account.status);
  return { tone: info.tone, label: `Account ${info.label.toLowerCase()}` };
}

export interface SelectOption {
  /** Empty string means "not set": the account's own default. */
  value: string;
  label: string;
}

export interface OptionChoices {
  options: SelectOption[];
  /** Set when the saved value is not offered by the account any more. */
  warning?: string;
}

/**
 * Options for a model or effort select: "Account default", `auto`, then what the account offers.
 * A saved value the account does not offer stays selectable and comes with a warning, so the
 * owner sees it instead of the select silently showing something else.
 * `offered` is undefined while the account's list has not loaded.
 */
export function buildOptions(
  kind: "model" | "effort",
  offered: readonly OptionValue[] | undefined,
  current: string | undefined,
  accountDefault?: string,
): OptionChoices {
  const defaultName = offered?.find((o) => o.id === accountDefault)?.name ?? accountDefault;
  const options: SelectOption[] = [
    { value: "", label: defaultName ? `Account default (${defaultName})` : "Account default" },
    { value: AUTO, label: "Auto" },
    ...(offered ?? []).map((o) => ({ value: o.id, label: o.name === o.id ? o.id : `${o.name} (${o.id})` })),
  ];
  const missing = current !== undefined && current !== "" && !options.some((o) => o.value === current);
  if (!missing) return { options };
  options.push({ value: current, label: `${current} (not offered)` });
  if (offered === undefined) return { options };
  return { options, warning: `This account does not offer the ${kind} "${current}". Pick another.` };
}

export interface AgentDraft {
  scope: string;
  role: Role;
  account: string;
  model: string | undefined;
  effort: string | undefined;
  models: string[];
  where: string[];
  perms: Perm[];
  fallback: string | undefined;
  instructions: string;
}

export function draftFromAgent(agent: OkAgent["agent"]): AgentDraft {
  const f = agent.frontmatter;
  return {
    scope: f.scope,
    role: f.role,
    account: f.account,
    model: f.model,
    effort: f.effort,
    models: f.models ?? [],
    where: f.where,
    perms: f.perms,
    fallback: f.fallback,
    instructions: agent.instructions,
  };
}

/** The `agents.update` input: the draft laid over the file's other fields (skills, tools, ...), which the editor does not touch. */
export function updateInput(original: OkAgent["agent"], draft: AgentDraft) {
  const { id: _id, model: _m, effort: _e, models: _ms, fallback: _f, ...rest } = original.frontmatter;
  const frontmatter: Omit<AgentFrontmatterInput, "id"> = {
    ...rest,
    scope: draft.scope,
    role: draft.role,
    account: draft.account,
    where: draft.where,
    perms: draft.perms,
  };
  if (draft.model) frontmatter.model = draft.model;
  if (draft.effort) frontmatter.effort = draft.effort;
  if (draft.model === AUTO && draft.models.length > 0) frontmatter.models = draft.models;
  if (draft.fallback) frontmatter.fallback = draft.fallback;
  return { id: original.frontmatter.id, frontmatter, instructions: draft.instructions };
}

/** Clicking `value` in the "can work in" list: `anywhere` alone, or a set of orgs; never empty. */
export function toggleWhere(where: readonly string[], value: string): string[] {
  if (value === "anywhere") return ["anywhere"];
  const orgs = where.filter((w) => w !== "anywhere");
  const next = orgs.includes(value) ? orgs.filter((w) => w !== value) : [...orgs, value];
  return next.length === 0 ? ["anywhere"] : next;
}

export function togglePerm(perms: readonly Perm[], perm: Perm, on: boolean): Perm[] {
  const rest = perms.filter((p) => p !== perm);
  return on ? [...rest, perm] : rest;
}

/** A free agent id like `acme-claude` or `acme-claude-2`. */
export function suggestAgentId(scope: string, tool: string, taken: readonly string[]): string {
  const base = `${scope}-${tool}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** Frontmatter for a new agent, before the owner tunes it. */
export function newAgentFrontmatter(
  scope: string,
  role: Role,
  account: string,
): Omit<AgentFrontmatter, "id"> {
  return {
    scope,
    role,
    account,
    where: scope === ROOT_SCOPE ? ["anywhere"] : [scope],
    perms: ["edit", "shell"],
    tools: [],
    connections: [],
    skills: [],
    origin: "owner",
  };
}

export const ROLES: readonly Role[] = ["Lead", "Builder", "Reviewer", "Tester", "Root"];
export const PERMS: readonly { id: Perm; label: string }[] = [
  { id: "edit", label: "Edit files" },
  { id: "shell", label: "Run shell commands" },
  { id: "push", label: "Push" },
  { id: "mr", label: "Open merge requests" },
  { id: "merge", label: "Merge" },
];
