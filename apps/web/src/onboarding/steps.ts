import type { ComponentType } from "react";
import { RootsStep } from "./roots-step";

export interface OnboardingStepProps {
  /** True for the final step, so its button can say where the owner lands next. */
  isLast: boolean;
  /** Moves to the next step, or ends onboarding after the last one. */
  onComplete: () => void;
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
  { id: "roots", title: "Workspace roots", Component: RootsStep },
];
