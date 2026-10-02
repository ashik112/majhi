import type { OnboardingStepId } from "@majhi/shared";
import type { ComponentType } from "react";
import { AccountStep } from "./account-step";
import { BossStep } from "./boss-step";
import { FinishStep } from "./finish-step";
import { GitStep } from "./git/git-step";
import { ProjectsStep } from "./projects/projects-step";
import { WelcomeStep } from "./welcome-step";
import { WorkspacesStep } from "./workspaces-step";

export interface OnboardingStep {
  id: OnboardingStepId;
  /** The stop's name on the river. */
  title: string;
  /** The panel's heading. */
  heading: string;
  /** One line: why this step is worth a minute. */
  why: string;
  /** A quiet word beside the heading, in Bengali (only Welcome has one). */
  aside?: string;
  Component: ComponentType;
}

/**
 * The journey, in the order of `ONBOARDING_STEP_IDS`. Adding a step is one entry here and one id in
 * the shared schema; the river draws a stop for each.
 */
export const onboardingSteps: readonly OnboardingStep[] = [
  {
    id: "welcome",
    title: "Welcome",
    heading: "Welcome to majhi",
    aside: "মাঝি",
    why: "majhi runs your AI coding agents and keeps each client's work in its own workspace. You steer, the agents row.",
    Component: WelcomeStep,
  },
  {
    id: "account",
    title: "AI account",
    heading: "Sign in to Claude Code or Codex",
    why: "Agents run on your own login, so they use your plan and your limits.",
    Component: AccountStep,
  },
  {
    id: "workspaces",
    title: "Workspaces",
    heading: "Keep each client's work apart",
    why: "A workspace has its own accounts, repos and git logins. Nothing crosses between them.",
    Component: WorkspacesStep,
  },
  {
    id: "git",
    title: "Git accounts",
    heading: "Sign each workspace in to git",
    why: "Pushes and merge requests then go out as the right account for each workspace.",
    Component: GitStep,
  },
  {
    id: "projects",
    title: "Projects",
    heading: "Add the projects agents can work on",
    why: "Agents only touch the repos you add here.",
    Component: ProjectsStep,
  },
  {
    id: "boss",
    title: "Captain",
    heading: "Choose the captain",
    why: "The captain is an agent that sets up and runs majhi for you, and asks before big changes.",
    Component: BossStep,
  },
  {
    id: "finish",
    title: "Arrive",
    heading: "You have arrived",
    why: "Write a task in one sentence. A team of agents takes it from there.",
    Component: FinishStep,
  },
];

export function stepIndex(id: OnboardingStepId): number {
  return Math.max(
    0,
    onboardingSteps.findIndex((s) => s.id === id),
  );
}
