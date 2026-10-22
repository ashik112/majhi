/**
 * Setup in three steps: sign in, pick projects, give the first task. The workspace, the account's id, one lead
 * agent and the captain are made by majhi on the way, with defaults and without a question.
 */
export const SETUP_STEPS = ["signin", "projects", "task"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export interface SetupStep {
  id: SetupStepId;
  /** The stop's name on the river. */
  title: string;
  /** The panel's heading. */
  heading: string;
}

export const setupSteps: readonly SetupStep[] = [
  { id: "signin", title: "AI account", heading: "Sign in to the AI that does the work" },
  { id: "projects", title: "Projects", heading: "Pick your projects" },
  { id: "task", title: "Arrive", heading: "Give the agents their first task" },
];

export function stepIndex(id: SetupStepId): number {
  return Math.max(
    0,
    setupSteps.findIndex((s) => s.id === id),
  );
}
