import { z } from "zod";

/**
 * Background e2e (PRV-72). After a merge into a project's base branch, the host helper runs the
 * project's Playwright suite in its own worktree, one run at a time. Agents never run it: they read
 * the latest result.
 */

/** The project whose suite runs by default. Others opt in with `e2e.projects.<id>: true`. */
export const E2E_DEFAULT_PROJECT_NAME = "majhi";

/** `e2e.projects.<id>` in majhi.yaml: true or false per project. A project left out uses the default. */
export const E2eSettingsSchema = z.strictObject({ projects: z.record(z.string(), z.boolean()).default({}) });
export type E2eSettings = z.infer<typeof E2eSettingsSchema>;
const e2eFields = { projects: z.record(z.string(), z.boolean()) };
export const E2ePatchSchema = z.strictObject(e2eFields).partial();
export type E2ePatch = z.infer<typeof E2ePatchSchema>;

export const E2eRunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  /** The suite could not run (install, browsers, a timeout, the helper went away). */
  "errored",
  /** A newer merge took its place in the queue before it started. */
  "replaced",
]);
export type E2eRunStatus = z.infer<typeof E2eRunStatusSchema>;

export const E2eRunSchema = z.object({
  id: z.string(),
  project: z.string(),
  commit: z.string(),
  /** The commit's subject line. */
  subject: z.string().optional(),
  /** The task whose merge triggered this run. */
  task: z.string().optional(),
  status: E2eRunStatusSchema,
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  passed: z.number().int().min(0).optional(),
  failed: z.number().int().min(0).optional(),
  failedSpecs: z.array(z.string()).default([]),
  /** Why the run errored. A fixed sentence. */
  error: z.string().optional(),
  /** The task a failure opened, or the open one this run found still broken. */
  breakTask: z.string().optional(),
});
export type E2eRun = z.infer<typeof E2eRunSchema>;

export const E2eStatusSchema = z.object({
  /** Projects the suite runs for now, with why. */
  projects: z.array(z.object({ id: z.string(), on: z.boolean(), byDefault: z.boolean() })),
  /** The run in progress, if any. */
  running: E2eRunSchema.optional(),
  /** Runs waiting to start, oldest first. */
  queued: z.array(E2eRunSchema),
  /** The newest finished run per project. */
  latest: z.array(E2eRunSchema),
  /** The newest finished runs, newest first. */
  recent: z.array(E2eRunSchema),
});
export type E2eStatus = z.infer<typeof E2eStatusSchema>;

export const E2E_MAX_SPECS = 50;
export const E2E_MAX_TRACES = 5;

/** What the host helper sends back when the suite ended. */
export const E2eRunResultSchema = z.object({
  outcome: z.enum(["passed", "failed", "errored"]),
  durationMs: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** `file > title` of each failing test, at most E2E_MAX_SPECS. */
  failedSpecs: z.array(z.string().max(300)).max(E2E_MAX_SPECS),
  /** Trace files, relative to the majhi folder (`e2e/traces/<run>/...`). The helper keeps them there. */
  traces: z.array(z.object({ spec: z.string().max(300), file: z.string().max(300) })).max(E2E_MAX_TRACES),
  /** For `errored`: a fixed sentence. */
  error: z.string().max(500).optional(),
});
export type E2eRunResult = z.infer<typeof E2eRunResultSchema>;
