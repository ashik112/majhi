import type { AccountView, AgentEntry, LegacyOnboardingStepId, OnboardingStepId } from "@majhi/shared";
import { isUsableStatus } from "../features/accounts/model";

/**
 * A step onboarding can open at. The steps and their order are `ONBOARDING_STEP_IDS` in
 * `@majhi/shared` (welcome, account, workspaces, git, projects, boss, finish). `roots` is the old id
 * of `welcome`; map it with `onboardingStepId` before looking a step up.
 */
export type SetupStepId = OnboardingStepId | LegacyOnboardingStepId;

export interface SetupState {
  /** The config is in first-run state: no workspace roots yet. */
  noRoots: boolean;
  accounts: readonly AccountView[];
  agents: readonly AgentEntry[];
}

/** An account that passed its health check and can run agents. */
export function firstHealthyAccount(accounts: readonly AccountView[]): AccountView | undefined {
  return accounts.find((a) => isUsableStatus(a.status));
}

export function hasBoss(agents: readonly AgentEntry[]): boolean {
  return agents.some((a) => a.status === "ok" && a.isBoss);
}

/**
 * The first setup step the server state says is not done, or null when setup is complete. To be
 * replaced by `onboarding.status`'s `next`, which also covers workspaces, git and projects.
 */
export function firstIncompleteStep(state: SetupState): SetupStepId | null {
  if (state.noRoots) return "roots";
  if (!firstHealthyAccount(state.accounts)) return "account";
  if (!hasBoss(state.agents)) return "boss";
  return null;
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
