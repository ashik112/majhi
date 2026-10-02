import type { ComponentType } from "react";
import { AccountStep } from "./account-step";
import { BossStep } from "./boss-step";
import { FinishStep } from "./finish-step";
import { RootsStep } from "./roots-step";

export interface OnboardingStepProps {
  /** True for the final step, so its button can say where the owner lands next. */
  isLast: boolean;
  /** Moves to the next step, or ends onboarding after the last one. */
  onComplete: () => void;
  /** Leaves setup for now. Present on the steps that can wait: the account, the captain and the last chat. */
  onSkip?: () => void;
}

export interface OnboardingStep {
  id: string;
  /** Short name, read out with the progress header. */
  title: string;
  Component: ComponentType<OnboardingStepProps>;
}

/**
 * The first-run flow, in order. Adding a step is one entry here; the shell derives
 * "Step N of M" and the progress bar from this list.
 */
export const onboardingSteps: readonly OnboardingStep[] = [
  { id: "roots", title: "Project folders", Component: RootsStep },
  { id: "account", title: "First account", Component: AccountStep },
  { id: "boss", title: "Choose the captain", Component: BossStep },
  { id: "finish", title: "Finish with the captain", Component: FinishStep },
];

/** Steps the owner may skip; the roots step cannot be skipped. */
export const skippableSteps: readonly string[] = ["account", "boss", "finish"];
