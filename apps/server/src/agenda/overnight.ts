import type { AutonomyEvent } from "@majhi/shared";
import { SHIPS } from "../autonomy/summary.ts";

/** What autonomous mode did in a span, as counts and a few titles, for the morning brief. Pure. */
export interface Overnight {
  shipped: { task: string; title: string }[];
  merged: number;
  failed: number;
  /** Cards and questions the captain answered by itself. */
  decided: number;
  upkeep: number;
}

export interface OvernightInput {
  events: readonly AutonomyEvent[];
  title: (task: string) => string | undefined;
  /** The captain's own upkeep actions in the span that went through. */
  upkeep: readonly { chore: string; task?: string | undefined }[];
}

/**
 * A task is shipped when it reached review, an open or merged request, or done in the span; merged when a
 * merge or a push went through. A call that failed or a hard limit that refused one counts as failed.
 * The ship chore's own merges count as merged and shipped without a feed event.
 */
export function overnightOf(input: OvernightInput): Overnight {
  const shipped = new Set<string>();
  const merged = new Set<string>();
  const failed = new Set<string>();
  let failedLoose = 0;
  let decided = 0;
  let upkeep = 0;
  for (const a of input.upkeep) {
    if (a.chore === "ship") {
      if (a.task !== undefined) {
        shipped.add(a.task);
        merged.add(a.task);
      }
    } else upkeep++;
  }
  for (const e of input.events) {
    if (e.kind === "task" && (e.status === "review" || e.status === "mr" || e.status === "done")) {
      if (e.task !== undefined) shipped.add(e.task);
    }
    if ((e.kind === "decision" || e.kind === "approval") && e.outcome === "applied") {
      decided++;
      if (e.task !== undefined && e.command !== undefined && SHIPS[e.command] !== undefined) {
        shipped.add(e.task);
        merged.add(e.task);
      }
    }
    if (e.kind === "refused" || e.outcome === "failed") {
      if (e.task === undefined) failedLoose++;
      else failed.add(e.task);
    }
  }
  return {
    shipped: [...shipped].map((task) => ({ task, title: input.title(task) ?? task })),
    merged: merged.size,
    failed: failed.size + failedLoose,
    decided,
    upkeep,
  };
}
