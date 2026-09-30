import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { ProcessContainerSchema } from "./containers.ts";

/**
 * Background processes (SPEC 5.15). majhi runs them for an agent through the `majhi-processes`
 * MCP tool, keeps them in memory per task, and shows them in the Processes card. Not stored.
 */

/** `p1`, `p2`: unique within a task. */
export const ProcessIdSchema = z.string().regex(/^p[1-9][0-9]*$/, "Process ids look like p1");

export const ProcessStatusSchema = z.enum(["running", "exited", "stopped"]);
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

/** Who stopped a process: the agent (stop, restart), the owner (Stop in the card), or the task (stop, close). */
export const StoppedBySchema = z.enum(["agent", "owner", "task"]);
export type StoppedBy = z.infer<typeof StoppedBySchema>;

export const ProcessInfoSchema = z.object({
  id: ProcessIdSchema,
  task: z.string(),
  /** The agent that started it. */
  agent: IdSchema,
  /** Defaults to the command. */
  name: z.string(),
  command: z.string(),
  /** Absolute, inside the task folder. */
  cwd: z.string(),
  /** Wake the agent when it ends by itself, and keep the task running meanwhile. */
  wait: z.boolean(),
  status: ProcessStatusSchema,
  /** Set once it exited. Null when a signal ended it. */
  exitCode: z.number().int().nullable().optional(),
  stoppedBy: StoppedBySchema.optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /** The first `localhost:NNNN` (or 127.0.0.1, 0.0.0.0) in its output. */
  port: z.number().int().positive().optional(),
  /** The last lines of stdout and stderr together. */
  tail: z.array(z.string()),
  /** Set when majhi runs a container for the agent (a preview build, a preview or a service). */
  container: ProcessContainerSchema.optional(),
});
export type ProcessInfo = z.infer<typeof ProcessInfoSchema>;

// ---------------------------------------------------------------------------
// majhi-processes tool inputs

export const ProcessStartInputSchema = z.object({
  command: z.string().trim().min(1).max(4_000).describe("Shell command, run with /bin/sh -c"),
  name: z.string().trim().min(1).max(80).optional().describe("Short name. Default: the command"),
  cwd: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Working directory, inside the task folder. Relative paths start there. Default: the task folder",
    ),
  wait: z
    .boolean()
    .default(true)
    .describe(
      "true (default): majhi wakes you with the exit code and output when it ends. false: for servers and watchers that keep running",
    ),
});

export const ProcessListInputSchema = z.object({});

export const ProcessOutputInputSchema = z.object({
  id: ProcessIdSchema,
  lines: z.number().int().min(1).max(200).default(50).describe("How many of the last lines"),
});

export const ProcessStopInputSchema = z.object({ id: ProcessIdSchema });

export const ProcessRestartInputSchema = z.object({ id: ProcessIdSchema });
