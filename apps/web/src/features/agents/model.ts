import {
  type AccountView,
  type AgentEntry,
  type AgentFrontmatter,
  type AgentFrontmatterInput,
  AUTO,
  type OptionValue,
  type OrgView,
  type Perm,
  PRIVATE,
  type Role,
  type TaskSummary,
  type TierPatch,
} from "@majhi/shared";

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
 * agent uses that org's accounts or the owner's private ones, never another org's credentials
 * (SPEC 6).
 */
export function accountsForScope(accounts: readonly AccountView[], scope: string): AccountView[] {
  if (scope === ROOT_SCOPE) return [...accounts];
  return accounts.filter((a) => a.org === scope || a.org === PRIVATE);
}

/** The scope a new agent on an account belongs to: private accounts get root agents. */
export function scopeForAccount(account: Pick<AccountView, "org">): string {
  return account.org === PRIVATE ? ROOT_SCOPE : account.org;
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

export interface OptionChip {
  value: string;
  /** The words on the chip: the id for a model, `Account default` and `Auto` for the two special ones. */
  label: string;
  /** The longer name, when the account gave one. */
  title?: string;
}

/** `buildOptions` as chips: ids on the model chips, the two special ones named plainly. */
export function optionChips(
  choices: OptionChoices,
  offered: readonly OptionValue[] | undefined,
): OptionChip[] {
  return choices.options.map((o) => {
    if (o.value === "") return { value: "", label: "Account default", title: o.label };
    if (o.value === AUTO) return { value: AUTO, label: "Auto", title: "Let majhi pick for each run" };
    const name = offered?.find((x) => x.id === o.value)?.name;
    const chip: OptionChip = { value: o.value, label: o.label.endsWith("(not offered)") ? o.label : o.value };
    if (name && name !== o.value) chip.title = name;
    return chip;
  });
}

export interface AgentDraft {
  scope: string;
  role: Role;
  account: string;
  model: string | undefined;
  effort: string | undefined;
  models: string[];
  /** Fallback tiers when `model` or `effort` is `auto` and there is no confident pick. */
  tier: TierPatch;
  where: string[];
  perms: Perm[];
  /** Server names to add and `-name` to turn a default off (see `TOOL_CATALOG`). */
  tools: string[];
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
    tier: f.tier ?? {},
    where: f.where,
    perms: f.perms,
    tools: f.tools,
    fallback: f.fallback,
    instructions: agent.instructions,
  };
}

/** The `agents.update` input: the draft laid over the file's other fields (skills, connections, ...), which the editor does not touch. */
export function updateInput(original: OkAgent["agent"], draft: AgentDraft) {
  const {
    id: _id,
    model: _m,
    effort: _e,
    models: _ms,
    tier: _t,
    fallback: _f,
    ...rest
  } = original.frontmatter;
  const frontmatter: Omit<AgentFrontmatterInput, "id"> = {
    ...rest,
    scope: draft.scope,
    role: draft.role,
    account: draft.account,
    where: draft.where,
    perms: draft.perms,
    tools: draft.tools,
  };
  if (draft.model) frontmatter.model = draft.model;
  if (draft.effort) frontmatter.effort = draft.effort;
  if (draft.model === AUTO && draft.models.length > 0) frontmatter.models = draft.models;
  const tier: TierPatch = {
    ...(draft.model === AUTO && draft.tier.model !== undefined ? { model: draft.tier.model } : {}),
    ...(draft.effort === AUTO && draft.tier.effort !== undefined ? { effort: draft.tier.effort } : {}),
  };
  if (Object.keys(tier).length > 0) frontmatter.tier = tier;
  if (draft.fallback) frontmatter.fallback = draft.fallback;
  return { id: original.frontmatter.id, frontmatter, instructions: draft.instructions };
}

/** The tier with one part set, or cleared when `value` is undefined. */
export function withTier<K extends keyof TierPatch>(
  tier: TierPatch,
  key: K,
  value: TierPatch[K] | undefined,
): TierPatch {
  const { [key]: _old, ...rest } = tier;
  return value === undefined ? rest : { ...rest, [key]: value };
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
  { id: "shell", label: "Run shell" },
  { id: "push", label: "Push branches" },
  { id: "mr", label: "Open MRs" },
  { id: "merge", label: "Merge" },
];

/** Roles the segmented control offers: root agents pick from Root first, org agents get Tester. The current role always shows. */
export function rolesForScope(scope: string, current: Role): Role[] {
  const base: Role[] =
    scope === ROOT_SCOPE
      ? ["Root", "Lead", "Builder", "Reviewer"]
      : ["Lead", "Builder", "Reviewer", "Tester"];
  return base.includes(current) ? base : [...base, current];
}

/** Two capitals for a scope tab: `RT` for root, else the first two letters of the org name. */
export function scopeBadge(scope: string, label: string): string {
  if (scope === ROOT_SCOPE) return "RT";
  const letters = label
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();
  return letters === "" ? "?" : letters;
}

/** Agents that can take over when this one's account is out: same scope or root, never itself. */
export function fallbackCandidates(entries: readonly AgentEntry[], self: OkAgent): OkAgent[] {
  const id = self.agent.frontmatter.id;
  const scope = self.agent.frontmatter.scope;
  return entries.filter(
    (e): e is OkAgent =>
      e.status === "ok" &&
      e.agent.frontmatter.id !== id &&
      (scope === ROOT_SCOPE ||
        e.agent.frontmatter.scope === scope ||
        e.agent.frontmatter.scope === ROOT_SCOPE),
  );
}

/** True when an org agent may work outside its own org, so the editor says its account will be used there. */
export function worksOutsideScope(scope: string, where: readonly string[]): boolean {
  return scope !== ROOT_SCOPE && (where.includes("anywhere") || where.some((w) => w !== scope));
}

/** Model or effort options for a select: Auto first, then the account default, then what the account offers. */
export function autoFirst(choices: OptionChoices): SelectOption[] {
  const auto = choices.options.filter((o) => o.value === AUTO);
  return [...auto, ...choices.options.filter((o) => o.value !== AUTO)];
}

/** The open tasks an agent is on: the ones it works in right now first, then the newest. */
export function tasksOf<T extends Pick<TaskSummary, "status" | "team" | "working" | "updatedAt">>(
  id: string,
  tasks: readonly T[],
): T[] {
  return tasks
    .filter((t) => t.status !== "done" && t.team.includes(id))
    .toSorted(
      (a, b) =>
        Number(b.working.includes(id)) - Number(a.working.includes(id)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}
