import type { AutonomyEvent, AutonomySummary, AutonomyWaiting, CapUse } from "@majhi/shared";
import { capText } from "./spend.ts";

/**
 * The daily summary (PRV-74, rule 10): what autonomous mode shipped in the span, what it spent
 * against the caps, what it is unsure about (unsure notes and refusals), and the cards still waiting
 * for the owner. Pure: built from the span's feed and the task titles.
 */

type How = AutonomySummary["shipped"][number]["how"];

/** How far a task went; a later step counts over an earlier one. */
const RANK: Record<How, number> = { review: 1, done: 2, "mr-open": 3, pushed: 4, merged: 5, "mr-merged": 6 };

/** The ship calls that count, by what they did. */
const SHIPS: Readonly<Record<string, How>> = {
  "tasks.merge": "merged",
  "tasks.push": "pushed",
  "tasks.openMrs": "mr-open",
  "tasks.mergeMrs": "mr-merged",
  "tasks.markMerged": "mr-merged",
};

export interface SummaryInput {
  day: string;
  from: string;
  to: string;
  at: string;
  /** The feed in the span, any order. */
  events: readonly AutonomyEvent[];
  /** Titles and orgs of the tasks the events name. */
  tasks: ReadonlyMap<string, { title: string; org?: string | undefined }>;
  spent: { total: CapUse; orgs: (CapUse & { org: string })[] };
  waiting: readonly AutonomyWaiting[];
}

export function buildSummary(input: SummaryInput): AutonomySummary {
  const furthest = new Map<string, How>();
  const reach = (task: string | undefined, how: How | undefined) => {
    if (task === undefined || how === undefined) return;
    const had = furthest.get(task);
    if (had === undefined || RANK[how] > RANK[had]) furthest.set(task, how);
  };
  const unsure: AutonomySummary["unsure"] = [];
  let decisions = 0;
  for (const e of [...input.events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === "task") {
      reach(
        e.task,
        e.status === "review"
          ? "review"
          : e.status === "mr"
            ? "mr-open"
            : e.status === "done"
              ? "done"
              : undefined,
      );
    }
    if (
      (e.kind === "decision" || e.kind === "approval") &&
      e.outcome === "applied" &&
      e.command !== undefined
    ) {
      reach(e.task, SHIPS[e.command]);
    }
    if (e.kind === "decision" || e.kind === "approval") decisions++;
    if (e.kind === "refused" || e.unsure === true) {
      unsure.push({
        text: e.kind === "refused" ? `Refused: ${e.text}` : e.text,
        ...(e.task === undefined ? {} : { task: e.task }),
        ...(e.item === undefined ? {} : { item: e.item }),
      });
    }
  }
  return {
    day: input.day,
    from: input.from,
    to: input.to,
    at: input.at,
    shipped: [...furthest].map(([task, how]) => {
      const t = input.tasks.get(task);
      return { task, title: t?.title ?? task, ...(t?.org === undefined ? {} : { org: t.org }), how };
    }),
    spent: input.spent,
    unsure,
    waiting: [...input.waiting],
    decisions,
  };
}

/** One line for the chat, the notification and the feed. */
export function summaryLine(s: AutonomySummary): string {
  const spent = `$${s.spent.total.used.cost.toFixed(2)}${s.spent.total.cap === undefined ? "" : ` of ${capText(s.spent.total.cap)}`}`;
  const parts = [`shipped ${s.shipped.length}`, `spent ${spent}`];
  if (s.unsure.length > 0) parts.push(`unsure about ${s.unsure.length}`);
  if (s.waiting.length > 0) parts.push(`${s.waiting.length} waiting for you`);
  return `Daily summary for ${s.day}: ${parts.join(", ")}.`;
}
