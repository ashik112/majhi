import { z } from "zod";

/** The page runs every check by itself when the last full run is older than this. */
export const HEALTH_STALE_MS = 15 * 60_000;

export const HealthCheckRowSchema = z.object({
  id: z.string(),
  group: z.enum(["majhi", "host", "ssh", "accounts", "connections", "disk"]),
  label: z.string(),
  /** False only for a failure. A warning is ok, with `level` "warn". */
  ok: z.boolean(),
  level: z.enum(["pass", "warn", "fail"]).optional(),
  detail: z.string(),
  /** A fix majhi can do itself, run with health.fix. */
  fix: z.object({ label: z.string() }).optional(),
  /** When this check last ran. */
  checkedAt: z.string(),
});

export const HealthRunOutputSchema = z.object({
  /** When this answer was read. */
  checkedAt: z.string(),
  /** When the last full run (health.checkAll) finished. Absent since majhi started. */
  lastFullRunAt: z.string().optional(),
  /** A full run in progress: checks finished so far out of all of them. */
  run: z.object({ running: z.boolean(), done: z.number().int(), total: z.number().int() }),
  checks: z.array(HealthCheckRowSchema),
});
export type HealthRunOutput = z.infer<typeof HealthRunOutputSchema>;

/**
 * Whether the page should start a full run on its own: not while one is going, and only when the
 * last one finished more than `staleMs` ago or never did. A date that does not parse counts as never.
 */
export function healthRunDue(input: {
  lastFullRunAt: string | undefined;
  running: boolean;
  now: number;
  staleMs?: number;
}): boolean {
  if (input.running) return false;
  if (input.lastFullRunAt === undefined) return true;
  const at = Date.parse(input.lastFullRunAt);
  if (Number.isNaN(at)) return true;
  return input.now - at > (input.staleMs ?? HEALTH_STALE_MS);
}
