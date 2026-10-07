import { z } from "zod";

/**
 * The checked hand-off (SPEC 5.18, captain v2 step 7): when an agent says a task is done, majhi
 * verifies it before the owner or the ship chore sees "Ready to ship". Code first (tests, build and
 * lint from the project card, committed, merges cleanly, no secret, no card waiting, the brief's
 * acceptance lines), then a small review pass that only adds notes.
 */

export const HANDOFF_STEP_IDS = [
  "ready",
  "install",
  "tests",
  "build",
  "lint",
  "typecheck",
  "acceptance",
  "review",
] as const;
export const HandoffStepIdSchema = z.enum(HANDOFF_STEP_IDS);
export type HandoffStepId = z.infer<typeof HandoffStepIdSchema>;

/**
 * `pass` and `fail` are as they say. `timeout`: the command did not finish. `flaky`: it failed, then
 * passed on a retry, which is not green. `none`: there is nothing to run (no command on the project
 * card). `skipped`: not run, with the reason in `detail`. `note`: a flag for the owner that blocks nothing.
 * `existing`: it failed, and fails the same way on the commit the task branched from, so it is not this
 * task's and blocks nothing.
 */
export const HandoffStatusSchema = z.enum([
  "pass",
  "fail",
  "timeout",
  "flaky",
  "none",
  "skipped",
  "note",
  "existing",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

/** What a failed step says besides its name: how it ended and how long it ran, like "exit 1" and "24 s". */
export function handoffFailedFacts(failed: Pick<HandoffFailed, "status" | "code" | "ms">): string[] {
  return [
    failed.status === "timeout" ? "timed out" : failed.code === null ? undefined : `exit ${failed.code}`,
    failed.ms >= 1000 ? handoffSeconds(failed.ms) : undefined,
  ].flatMap((f) => (f === undefined ? [] : [f]));
}

/** The steps that run a shell line of the project: a person can rerun one of these on its own. */
export const HANDOFF_COMMAND_STEPS = ["install", "lint", "typecheck", "build", "tests"] as const;
export const HandoffCommandStepSchema = z.enum(HANDOFF_COMMAND_STEPS);
export type HandoffCommandStep = z.infer<typeof HandoffCommandStepSchema>;

/**
 * The whole output of one step, kept as a file in the task folder (`.checks/<run>/<step>.log`) so
 * the file viewer opens it. `path` is relative to the task folder.
 */
export const HandoffLogSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  /** Set when the output was longer than the cap: how many characters were left out of the middle. */
  cut: z.number().int().positive().optional(),
  /** The line the viewer opens at: where the output the card shows begins (1-based). */
  focus: z.number().int().positive(),
});
export type HandoffLog = z.infer<typeof HandoffLogSchema>;

/** One command a step ran, and where majhi got it. */
export const HandoffRanSchema = z.object({
  project: z.string(),
  /** The line that ran, in its read-only form. */
  command: z.string(),
  /** "from .gitlab-ci.yml job build", "set for this project", or "from the project card". */
  from: z.string(),
  /** The environment variables it ran with. */
  env: z.record(z.string(), z.string()),
  /** The folder it ran in, relative to the repo, when not the root. */
  workdir: z.string().optional(),
  /** What majhi changed about it or did not run, like "eslint ran read-only". */
  notes: z.array(z.string()),
});
export type HandoffRan = z.infer<typeof HandoffRanSchema>;

/** A failure that the commit the task branched from has too. */
export const HandoffExistingSchema = z.object({
  /** The base commit, short. */
  base: z.string(),
  /** The problems both have, as the tool names them; empty when only pass or fail was compared. */
  problems: z.array(z.string()),
  /** The finding that holds it, for the owner to open a task from. */
  finding: z.number().int().positive().optional(),
});
export type HandoffExisting = z.infer<typeof HandoffExistingSchema>;

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
  /** The command's exit code; null when it was stopped. Only for a step that ran a command and did not pass. */
  code: z.number().int().nullable().optional(),
  /** The whole output, saved as a file. Absent for a result saved before logs were kept. */
  log: HandoffLogSchema.optional(),
  /** For the acceptance lines: each line of the brief and what matched it. */
  items: z.array(z.object({ text: z.string(), ok: z.boolean(), note: z.string().optional() })).optional(),
  /** The commands the step ran. */
  ran: z.array(HandoffRanSchema).optional(),
  /** Set when the step failed the same way on the base commit. */
  existing: HandoffExistingSchema.optional(),
  /** Set when the check was killed for memory: what it was given, like "6g". */
  memory: z.object({ limit: z.string() }).optional(),
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

/** The first step that failed for the lead to fix, as typed fields: nothing to read out of a message. */
export const HandoffFailedSchema = z.object({
  step: HandoffStepIdSchema,
  label: z.string(),
  status: HandoffStatusSchema,
  code: z.number().int().nullable(),
  /** How long the step ran, in milliseconds. */
  ms: z.number().int().nonnegative(),
  log: HandoffLogSchema.optional(),
});
export type HandoffFailed = z.infer<typeof HandoffFailedSchema>;

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
  /** The first step in `failures`, named: its exit code, duration and log. Absent when nothing failed, and in results saved before this was kept. */
  failed: HandoffFailedSchema.optional(),
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

/**
 * What a check that has not ended is doing, for the Home rows: waiting for a free slot (`position`,
 * 1 is next) or running one step (`step`), since `since` (UTC ISO, the start of the step).
 */
export const HandoffActivitySchema = z.object({
  phase: z.enum(["queued", "running"]),
  step: HandoffStepIdSchema.optional(),
  since: z.string(),
  position: z.number().int().positive().optional(),
});
export type HandoffActivity = z.infer<typeof HandoffActivitySchema>;

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
  /** Set while `running` or `queued`: which step runs, since when, and the place in the queue. */
  activity: HandoffActivitySchema.optional(),
});
export type HandoffState = z.infer<typeof HandoffStateSchema>;

export const HandoffGetInputSchema = z.object({ task: z.string().min(1) });
export const HandoffCheckInputSchema = z.object({
  task: z.string().min(1),
  /** Run the tests, build, lint and review again even when this head was checked. */
  force: z.boolean().optional(),
});

/** Run one step of the check again, or all of them: `handoff.rerun`. */
export const HandoffRerunInputSchema = z.object({
  task: z.string().min(1),
  /** One step to run again. Left out: every step. */
  step: HandoffCommandStepSchema.optional(),
});

/**
 * What an agent's own tools take (`handoff`, `handoff_rerun` of majhi-processes). Neither names a
 * task: the task is the one the agent runs in, from its token.
 */
export const HandoffToolRerunSchema = z.object({
  step: HandoffCommandStepSchema.optional().describe(
    "The step to run again: install, lint, typecheck, build or tests. Leave it out to run every step.",
  ),
});

/** "31 s" style duration. */
export function handoffSeconds(ms: number): string {
  return ms < 950 ? `${Math.max(1, Math.round(ms / 100) / 10)} s` : `${Math.round(ms / 1000)} s`;
}

const STEP_WORD: Record<HandoffStepId, string> = {
  ready: "ready",
  install: "install",
  tests: "tests",
  build: "build",
  lint: "lint",
  typecheck: "type check",
  acceptance: "brief",
  review: "review",
};

/** One step as the summary line says it. */
function stepWords(step: HandoffStep): string | undefined {
  const word = STEP_WORD[step.id];
  const time = step.ms === undefined || step.ms < 1000 ? "" : ` (${handoffSeconds(step.ms)})`;
  switch (step.status) {
    case "pass":
      return step.id === "ready" || step.id === "acceptance" || step.id === "install"
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
    case "existing":
      return `${word} already failing on the base`;
  }
}

/** The line the review card and the Decisions item show, collapsed: what ran and how it ended. */
export function handoffSummary(steps: readonly HandoffStep[], review: HandoffReview): string {
  if (steps.some((s) => s.id === "ready" && s.status === "none"))
    return "No code changes. Nothing to check or ship.";
  const parts = steps.filter((s) => s.id !== "review").flatMap((s) => stepWords(s) ?? []);
  const ready = steps.find((s) => s.id === "ready");
  if (ready !== undefined && ready.status !== "pass") parts.unshift(ready.detail);
  const notes = review.notes.length;
  if (review.by === "skipped") parts.push("review not run");
  else parts.push(`review: ${notes === 0 ? "no notes" : `${notes} ${notes === 1 ? "note" : "notes"}`}`);
  return `Checked: ${parts.join(", ")}`;
}
