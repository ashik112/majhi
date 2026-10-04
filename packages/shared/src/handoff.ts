import { z } from "zod";

/**
 * The checked hand-off (SPEC 5.18, captain v2 step 7): when an agent says a task is done, majhi
 * verifies it before the owner or the ship chore sees "Ready to ship". Code first (tests, build and
 * lint from the project card, committed, merges cleanly, no secret, no card waiting, the brief's
 * acceptance lines), then a small review pass that only adds notes.
 */

export const HANDOFF_STEP_IDS = ["ready", "tests", "build", "lint", "acceptance", "review"] as const;
export const HandoffStepIdSchema = z.enum(HANDOFF_STEP_IDS);
export type HandoffStepId = z.infer<typeof HandoffStepIdSchema>;

/**
 * `pass` and `fail` are as they say. `timeout`: the command did not finish. `flaky`: it failed, then
 * passed on a retry, which is not green. `none`: there is nothing to run (no command on the project
 * card). `skipped`: not run, with the reason in `detail`. `note`: a flag for the owner that blocks nothing.
 */
export const HandoffStatusSchema = z.enum(["pass", "fail", "timeout", "flaky", "none", "skipped", "note"]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const HandoffStepSchema = z.object({
  id: HandoffStepIdSchema,
  label: z.string(),
  status: HandoffStatusSchema,
  /** One line: what ran and how it ended, or why it did not. */
  detail: z.string(),
  /** How long it ran, in milliseconds. */
  ms: z.number().int().nonnegative().optional(),
  /** The end of the command's output, secrets masked. Only for a step that failed. */
  output: z.string().optional(),
  /** For the acceptance lines: each line of the brief and what matched it. */
  items: z.array(z.object({ text: z.string(), ok: z.boolean(), note: z.string().optional() })).optional(),
  /** Only the owner can clear it (a card waits, a protected repo): the lead is not told. */
  owner: z.literal(true).optional(),
});
export type HandoffStep = z.infer<typeof HandoffStepSchema>;

export const HandoffReviewSchema = z.object({
  /** `model`: a model read the diff. `code`: the free checks only. `skipped`: nothing ran, see `why`. */
  by: z.enum(["model", "code", "skipped"]),
  why: z.string().optional(),
  notes: z.array(z.string()),
  /** What the model pass used, estimated from its prompt and reply (about 4 characters a token). */
  tokens: z.number().int().nonnegative(),
});
export type HandoffReview = z.infer<typeof HandoffReviewSchema>;

export const HandoffVerdictSchema = z.enum(["green", "red"]);
export type HandoffVerdict = z.infer<typeof HandoffVerdictSchema>;

export const HandoffResultSchema = z.object({
  task: z.string(),
  /** The task's head commits, one per repo: `project@sha`. The check holds for this state only. */
  head: z.string(),
  at: z.string(),
  verdict: HandoffVerdictSchema,
  steps: z.array(HandoffStepSchema),
  review: HandoffReviewSchema,
  /** What the lead is told to fix. */
  failures: z.array(z.string()),
  /** What only the owner can clear. */
  held: z.array(z.string()),
  /** The whole check, in milliseconds. */
  ms: z.number().int().nonnegative(),
  /** The tests, build and lint were not run again: the same head was checked before. */
  cached: z.boolean(),
  /** One line: "Checked: tests 42 passed (31 s), build ok, lint ok, review: 2 notes". */
  summary: z.string(),
});
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

export const HandoffHistoryItemSchema = z.object({
  head: z.string(),
  at: z.string(),
  verdict: HandoffVerdictSchema,
  failures: z.array(z.string()),
  /** The lead was told, or the owner was asked. */
  action: z.enum(["told", "escalated", "none"]),
});
export type HandoffHistoryItem = z.infer<typeof HandoffHistoryItemSchema>;

/** After this many failed hand-offs in a row the task goes to the owner, not back to its lead. */
export const HANDOFF_STRIKES = 3;

export const HandoffStateSchema = z.object({
  task: z.string(),
  /** The check of the task's head now, when there is one. */
  current: HandoffResultSchema.optional(),
  /** The newest check was of an older head: the task moved on since. */
  stale: z.boolean(),
  /** The last checks, newest first, at most ten. */
  history: z.array(HandoffHistoryItemSchema),
  /** Failed hand-offs in a row. A green one clears it. */
  strikes: z.number().int().nonnegative(),
  /** Three failed: the owner decides, with this history. */
  escalated: z.boolean(),
  running: z.boolean(),
  queued: z.boolean(),
});
export type HandoffState = z.infer<typeof HandoffStateSchema>;

export const HandoffGetInputSchema = z.object({ task: z.string().min(1) });
export const HandoffCheckInputSchema = z.object({
  task: z.string().min(1),
  /** Run the tests, build, lint and review again even when this head was checked. */
  force: z.boolean().optional(),
});

/** "31 s" style duration. */
export function handoffSeconds(ms: number): string {
  return ms < 950 ? `${Math.max(1, Math.round(ms / 100) / 10)} s` : `${Math.round(ms / 1000)} s`;
}

const STEP_WORD: Record<HandoffStepId, string> = {
  ready: "ready",
  tests: "tests",
  build: "build",
  lint: "lint",
  acceptance: "brief",
  review: "review",
};

/** One step as the summary line says it. */
function stepWords(step: HandoffStep): string | undefined {
  const word = STEP_WORD[step.id];
  const time = step.ms === undefined || step.ms < 1000 ? "" : ` (${handoffSeconds(step.ms)})`;
  switch (step.status) {
    case "pass":
      return step.id === "ready" || step.id === "acceptance"
        ? undefined
        : `${word} ${step.detail === "" ? "ok" : step.detail}${time}`;
    case "fail":
      return `${word} failed${time}`;
    case "timeout":
      return `${word} timed out${time}`;
    case "flaky":
      return `${word} flaky${time}`;
    case "none":
      return step.id === "tests" ? "no test command, not tested" : undefined;
    case "skipped":
      return step.id === "ready" ? undefined : `${word} not run`;
    case "note":
      return step.id === "acceptance" ? `brief: ${step.detail}` : undefined;
  }
}

/** The line the review card and the Decisions item show, collapsed: what ran and how it ended. */
export function handoffSummary(steps: readonly HandoffStep[], review: HandoffReview): string {
  const parts = steps.filter((s) => s.id !== "review").flatMap((s) => stepWords(s) ?? []);
  const ready = steps.find((s) => s.id === "ready");
  if (ready !== undefined && ready.status !== "pass") parts.unshift(ready.detail);
  const notes = review.notes.length;
  if (review.by === "skipped") parts.push("review not run");
  else parts.push(`review: ${notes === 0 ? "no notes" : `${notes} ${notes === 1 ? "note" : "notes"}`}`);
  return `Checked: ${parts.join(", ")}`;
}
