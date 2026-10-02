import {
  type AccountStatus,
  DEFAULT_GIT_HOST,
  type MrHost,
  ONBOARDING_STEP_IDS,
  type OnboardingStatus,
  type OnboardingStepId,
  type OnboardingStepStatus,
  type OnboardingWorkspace,
  type OrgConfig,
  PRIVATE,
} from "@majhi/shared";
import { mrKindOf } from "../orgs/gitAccount.ts";
import { classifyHost } from "../scan/remote.ts";

/** Account states that count as passing the health check, as the web reads them. */
const USABLE: ReadonlySet<AccountStatus> = new Set<AccountStatus>([
  "healthy",
  "running-high",
  "relogin-soon",
]);

export interface OnboardingInput {
  /** Resolved workspace roots; empty on first run. */
  roots: string[];
  orgs: Record<string, OrgConfig>;
  /** Cached account health, no new check. */
  accounts: readonly { status: AccountStatus }[];
  /** True when a valid root agent is the captain. */
  hasCaptain: boolean;
  /** Project count per org. */
  projects: Readonly<Record<string, number>>;
  hostHelper: boolean;
}

/** The git hosts of a workspace: its git accounts, then `mr_tokens` for hosts with no account. */
function gitHosts(org: OrgConfig): OnboardingWorkspace["git"] {
  const out: OnboardingWorkspace["git"] = [];
  const seen = new Set<string>();
  for (const a of org.git_accounts ?? []) {
    const kind: MrHost = mrKindOf(classifyHost(a.host));
    const tokenRef = a.token ?? (a.host === DEFAULT_GIT_HOST[kind] ? org.mr_tokens?.[kind] : undefined);
    out.push({ kind, host: a.host, account: a.account, signedIn: tokenRef !== undefined });
    seen.add(a.host);
  }
  for (const [kind, ref] of Object.entries(org.mr_tokens ?? {}) as [MrHost, string | undefined][]) {
    const host = DEFAULT_GIT_HOST[kind];
    if (ref === undefined || seen.has(host)) continue;
    out.push({ kind, host, signedIn: true });
  }
  return out;
}

/** `onboarding.status`, from config, cached account health and the host link only: it calls no git host. */
export function onboardingStatus(input: OnboardingInput): OnboardingStatus {
  const workspaces: OnboardingWorkspace[] = Object.entries(input.orgs)
    .map(([id, org]) => ({
      id,
      name: org.name,
      ...(org.color === undefined ? {} : { color: org.color }),
      git: gitHosts(org),
      projects: input.projects[id] ?? 0,
    }))
    .sort((a, b) => (a.id === PRIVATE ? -1 : b.id === PRIVATE ? 1 : a.name.localeCompare(b.name)));
  const others = workspaces.filter((w) => w.id !== PRIVATE);
  const needGit = workspaces.filter((w) => w.id !== PRIVATE || w.projects > 0);
  const signedIn = needGit.filter((w) => w.git.some((g) => g.signedIn));
  const projectCount = Object.values(input.projects).reduce((a, b) => a + b, 0);
  const healthy = input.accounts.filter((a) => USABLE.has(a.status)).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const done: Record<OnboardingStepId, boolean> = {
    welcome: input.roots.length > 0,
    account: healthy > 0,
    workspaces: others.length > 0,
    git: signedIn.length === needGit.length,
    projects: projectCount > 0,
    boss: input.hasCaptain,
    finish: false,
  };
  done.finish = done.welcome && done.account && done.boss;
  const detail: Partial<Record<OnboardingStepId, string>> = {
    ...(input.roots.length > 0 ? { welcome: plural(input.roots.length, "project folder") } : {}),
    ...(healthy > 0 ? { account: plural(healthy, "account") } : {}),
    ...(others.length > 0 ? { workspaces: plural(others.length + 1, "workspace") } : {}),
    ...(needGit.length > 0 ? { git: `Signed in on ${signedIn.length} of ${needGit.length}` } : {}),
    ...(projectCount > 0 ? { projects: plural(projectCount, "project") } : {}),
  };
  const steps: OnboardingStepStatus[] = ONBOARDING_STEP_IDS.map((id) => ({
    id,
    done: done[id],
    ...(detail[id] === undefined ? {} : { detail: detail[id] }),
  }));
  return {
    steps,
    next: steps.find((s) => !s.done)?.id ?? null,
    roots: input.roots,
    hostHelper: input.hostHelper,
    workspaces,
  };
}
