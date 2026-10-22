import {
  type AccountView,
  type AgentEntry,
  DEFAULT_GIT_HOST,
  type MrHost,
  MrHostSchema,
  ONBOARDING_STEP_IDS,
  type OnboardingStatus,
  type OnboardingStepId,
  type OnboardingWorkspace,
  type OrgView,
  PRIVATE,
  type ProjectView,
  WRITING_IN_THE_ROOM,
} from "@majhi/shared";
import { isUsableStatus } from "../features/accounts/model";

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
      missing: [],
    }));
  const needGit = workspaces.filter((w) => w.id !== PRIVATE || w.projects > 0);
  const welcome = input.roots.length > 0;
  const account = firstHealthyAccount(input.accounts) !== undefined;
  const boss = hasBoss(input.agents);
  const done: Record<OnboardingStepId, boolean> = {
    welcome,
    account,
    workspaces: workspaces.length > 0,
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

/**
 * Whether setup has to open: no account that can run agents yet, or no captain. Everything else (the
 * workspace, the lead, projects, git) is made by setup or asked for when it is first needed.
 */
export function setupOpen(status: Pick<OnboardingStatus, "steps">): boolean {
  const done = new Set(status.steps.filter((s) => s.done).map((s) => s.id));
  return !done.has("account") || !done.has("boss");
}

export const BOSS_INSTRUCTIONS = [
  "You set up and run majhi for the owner. You help create accounts, agents and tasks, and you explain what you did in plain words. Ask before you change anything that is hard to undo.",
  WRITING_IN_THE_ROOM,
].join("\n\n");
