import { z } from "zod";
import { IdSchema, MrHostSchema } from "./accounts.ts";

/**
 * The first-run flow's steps, in order. Every step can be skipped and comes back later: the server
 * says which are done (`onboarding.status`), the web remembers which the owner skipped.
 *
 * - `welcome`: what majhi is, and the project folder (workspace roots). Everything else writes
 *   majhi.yaml, which needs a root, so this step sets one. It is the old `roots` step.
 * - `account`: the first AI account (Claude Code or Codex).
 * - `workspaces`: the workspaces to keep apart (orgs in code). Private always exists.
 * - `git`: sign each workspace in to its git hosts.
 * - `projects`: projects on this computer, from GitHub/GitLab/Bitbucket, or a new project.
 * - `boss`: choose the captain.
 * - `finish`: arrive, with the captain's chat open.
 */
export const OnboardingStepIdSchema = z.enum([
  "welcome",
  "account",
  "workspaces",
  "git",
  "projects",
  "boss",
  "finish",
]);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;
export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = OnboardingStepIdSchema.options;

/** Step ids from before the git connect phase, still accepted by `reopenOnboarding`. */
export const LEGACY_ONBOARDING_STEPS = { roots: "welcome" } as const satisfies Record<
  string,
  OnboardingStepId
>;
export type LegacyOnboardingStepId = keyof typeof LEGACY_ONBOARDING_STEPS;

/** A current step id for a current or legacy one. */
export function onboardingStepId(id: OnboardingStepId | LegacyOnboardingStepId): OnboardingStepId {
  return id === "roots" ? LEGACY_ONBOARDING_STEPS.roots : id;
}

export const OnboardingStepStatusSchema = z.object({
  id: OnboardingStepIdSchema,
  /** What the server can see is set up. `finish` is done when `welcome`, `account` and `boss` are. */
  done: z.boolean(),
  /** A short plain line for the step list, like "2 workspaces" or "Signed in on 1 of 3". */
  detail: z.string().optional(),
});
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatusSchema>;

/** One git host a workspace uses or signed in to. */
export const OnboardingGitHostSchema = z.object({
  kind: MrHostSchema,
  host: z.string(),
  /** The account it signed in as, or the git account bound to it. */
  account: z.string().optional(),
  /** A token is saved for the workspace on this host. Not checked against the host here. */
  signedIn: z.boolean(),
});

export const OnboardingWorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string(),
  color: z.string().optional(),
  git: z.array(OnboardingGitHostSchema),
  projects: z.number().int().nonnegative(),
});
export type OnboardingWorkspace = z.infer<typeof OnboardingWorkspaceSchema>;

/**
 * `onboarding.status`: what each step needs from the server, in one read. Cheap: it reads the
 * config, cached account health and the host link, and calls no git host.
 */
export const OnboardingStatusSchema = z.object({
  /** Every step, in order. */
  steps: z.array(OnboardingStepStatusSchema),
  /** The first step not done, or null when every step is done. Skips are the web's, not counted here. */
  next: OnboardingStepIdSchema.nullable(),
  /** The workspace roots, resolved. Empty on first run. */
  roots: z.array(z.string()),
  /** The host helper is connected, so clone, open a page and folder browsing work. */
  hostHelper: z.boolean(),
  /** Private first, then the others by name. */
  workspaces: z.array(OnboardingWorkspaceSchema),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;
