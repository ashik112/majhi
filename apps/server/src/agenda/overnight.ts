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
 * A task is shipped when a merge or a push went through, or it reached an open merge request or done in the
 * span. Reaching review is not shipping. A ship that failed counts as failed, and the task is not shipped
 * unless a later ship of it went through. Any other call that failed or a hard limit that refused one
 * counts as failed too. The ship chore's own merges count as merged and shipped without a feed event.
 */
export function overnightOf(input: OvernightInput): Overnight {
  const shipped = new Set<string>();
  const merged = new Set<string>();
  const failed = new Set<string>();
  /** Tasks whose latest ship attempt in the span failed. */
  const shipFailed = new Set<string>();
  let failedLoose = 0;
  let decided = 0;
  let upkeep = 0;
  const ships = (task: string) => {
    shipped.add(task);
    merged.add(task);
    shipFailed.delete(task);
  };
  for (const a of input.upkeep) {
    if (a.chore === "ship") {
      if (a.task !== undefined) ships(a.task);
    } else upkeep++;
  }
  for (const e of input.events) {
    if (e.kind === "task" && (e.status === "mr" || e.status === "done")) {
      if (e.task !== undefined) shipped.add(e.task);
    }
    if ((e.kind === "decision" || e.kind === "approval") && e.outcome === "applied") {
      decided++;
      if (e.task !== undefined && e.command !== undefined && SHIPS[e.command] !== undefined) ships(e.task);
    }
    if (e.kind === "refused" || e.outcome === "failed") {
      if (e.task === undefined) failedLoose++;
      else {
        failed.add(e.task);
        if (e.command !== undefined && SHIPS[e.command] !== undefined) shipFailed.add(e.task);
      }
    }
  }
  for (const task of shipFailed) {
    shipped.delete(task);
    merged.delete(task);
  }
  return {
    shipped: [...shipped].map((task) => ({ task, title: input.title(task) ?? task })),
    merged: merged.size,
    failed: failed.size + failedLoose,
    decided,
    upkeep,
  };
}
