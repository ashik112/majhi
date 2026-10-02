import {
  type AccountView,
  type AgentEntry,
  DEFAULT_GIT_HOST,
  type LegacyOnboardingStepId,
  type MrHost,
  MrHostSchema,
  ONBOARDING_STEP_IDS,
  type OnboardingStatus,
  type OnboardingStepId,
  type OnboardingWorkspace,
  type OrgView,
  PRIVATE,
  type ProjectView,
} from "@majhi/shared";
import { isUsableStatus } from "../features/accounts/model";

/**
 * A step onboarding can open at. The steps and their order are `ONBOARDING_STEP_IDS` in
 * `@majhi/shared` (welcome, account, workspaces, git, projects, boss, finish). `roots` is the old id
 * of `welcome`; map it with `onboardingStepId` before looking a step up.
 */
export type SetupStepId = OnboardingStepId | LegacyOnboardingStepId;

/** An account that passed its health check and can run agents. */
export function firstHealthyAccount(accounts: readonly AccountView[]): AccountView | undefined {
  return accounts.find((a) => isUsableStatus(a.status));
}

export function hasBoss(agents: readonly AgentEntry[]): boolean {
  return agents.some((a) => a.status === "ok" && a.isBoss);
}

/** The git host kind of a host name, for workspaces whose status came from the org list. */
export function hostKind(host: string): MrHost | undefined {
  const h = host.toLowerCase();
  if (h === "github.com") return "github";
  if (h === "bitbucket.org") return "bitbucket";
  if (h.includes("gitlab")) return "gitlab";
  return undefined;
}

/** A workspace's git hosts as its org config has them: an account per host, signed in when it has a token. */
export function workspaceGit(org: OrgView): OnboardingWorkspace["git"] {
  const rows: OnboardingWorkspace["git"] = [];
  for (const account of org.gitAccounts ?? []) {
    const kind = hostKind(account.host);
    if (!kind) continue;
    rows.push({
      kind,
      host: account.host,
      account: account.account,
      signedIn: account.token !== undefined || org.mrTokens?.[kind] !== undefined,
    });
  }
  for (const kind of MrHostSchema.options) {
    if (org.mrTokens?.[kind] === undefined || rows.some((r) => r.kind === kind)) continue;
    rows.push({ kind, host: DEFAULT_GIT_HOST[kind], signedIn: true });
  }
  return rows;
}

export interface DerivedInput {
  roots: readonly string[];
  accounts: readonly AccountView[];
  agents: readonly AgentEntry[];
  orgs: readonly OrgView[];
  projects: readonly ProjectView[];
  hostHelper: boolean;
}

/**
 * `onboarding.status` worked out in the browser from the reads it already has, for when the server
 * cannot answer it. Same rules as the server's (see the brief); git counts only what the org
 * config shows, so it never says a token works.
 */
export function deriveStatus(input: DerivedInput): OnboardingStatus {
  const workspaces: OnboardingWorkspace[] = [...input.orgs]
    .sort((a, b) => (a.id === PRIVATE ? -1 : b.id === PRIVATE ? 1 : a.name.localeCompare(b.name)))
    .map((org) => ({
      id: org.id,
      name: org.name,
      ...(org.color ? { color: org.color } : {}),
      git: workspaceGit(org),
      projects: input.projects.filter((p) => p.org === org.id).length,
    }));
  const needGit = workspaces.filter((w) => w.id !== PRIVATE || w.projects > 0);
  const welcome = input.roots.length > 0;
  const account = firstHealthyAccount(input.accounts) !== undefined;
  const boss = hasBoss(input.agents);
  const done: Record<OnboardingStepId, boolean> = {
    welcome,
    account,
    workspaces: workspaces.some((w) => w.id !== PRIVATE),
    git: needGit.length > 0 && needGit.every((w) => w.git.some((g) => g.signedIn)),
    projects: input.projects.length > 0,
    boss,
    finish: welcome && account && boss,
  };
  const steps = ONBOARDING_STEP_IDS.map((id) => ({ id, done: done[id] }));
  return {
    steps,
    next: steps.find((s) => !s.done)?.id ?? null,
    roots: [...input.roots],
    hostHelper: input.hostHelper,
    workspaces,
  };
}

/** Steps without which majhi cannot run a task. Only these open the journey by themselves. */
export const ESSENTIAL_STEPS: readonly OnboardingStepId[] = ["welcome", "account", "boss"];

/**
 * Where the gate should open the journey, or null to show the app: the first essential step that
 * is neither done nor skipped. Workspaces, git and projects never open it alone; the journey walks
 * through them once it is open, and Hub setup reopens them.
 */
export function gateStep(
  status: Pick<OnboardingStatus, "steps">,
  skipped: ReadonlySet<OnboardingStepId>,
): OnboardingStepId | null {
  const done = new Set(status.steps.filter((s) => s.done).map((s) => s.id));
  return ESSENTIAL_STEPS.find((id) => !done.has(id) && !skipped.has(id)) ?? null;
}

/**
 * The suggested id for the captain. A root agent already called `majhi-boss` (from an attempt that
 * stopped before it was made captain) is reused; any other agent with that id makes the id bump.
 */
export function bossId(agents: readonly AgentEntry[]): string {
  const blocked = new Set(
    agents
      .filter((a) => !(a.status === "ok" && a.agent.frontmatter.scope === "root"))
      .map((a) => (a.status === "ok" ? a.agent.frontmatter.id : a.id)),
  );
  if (!blocked.has("majhi-boss")) return "majhi-boss";
  for (let n = 2; ; n += 1) if (!blocked.has(`majhi-boss-${n}`)) return `majhi-boss-${n}`;
}

/** True when a valid root agent with this id exists, so creating it again would fail. */
export function isExistingRootAgent(agents: readonly AgentEntry[], id: string): boolean {
  return agents.some(
    (a) => a.status === "ok" && a.agent.frontmatter.id === id && a.agent.frontmatter.scope === "root",
  );
}

export const BOSS_INSTRUCTIONS =
  "You set up and run majhi for the owner. You help create accounts, agents and tasks, and you explain what you did in plain words. Ask before you change anything that is hard to undo.";
