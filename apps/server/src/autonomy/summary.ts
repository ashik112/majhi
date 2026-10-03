import {
  type AutonomyEvent,
  type AutonomySummary,
  type AutonomyWaiting,
  type CapUse,
  PRIVATE,
  type QueueItem,
  SUMMARY_TITLES,
} from "@majhi/shared";
import { capText } from "./spend.ts";

/**
 * The daily summary (SPEC 5.18): what shipped in the span (grouped by workspace, three titles each),
 * what was spent per workspace against its budget, what waits on the owner (the count and three
 * decisions) and what the captain plans next (three queue entries). Pure: built from the span's
 * feed, the captain's upkeep log, the task titles, the inbox and the queue.
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
  /** The captain's own actions in the span that went through (upkeep), with what each was about. */
  upkeep: readonly { chore: string; task?: string | undefined }[];
  /** The owner's Decisions inbox now, in its order. */
  decisions: readonly { id: string; title: string; org?: string | undefined }[];
  /** The captain's queue, in order. */
  queue: readonly Pick<QueueItem, "title" | "why" | "task" | "org">[];
  /** Workspace names by id; an id without a name reads as itself. */
  names: ReadonlyMap<string, string>;
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
  let upkeep = 0;
  // The ship chore merges and pushes on its own, in any mode, without a feed event.
  for (const a of input.upkeep) {
    if (a.chore === "ship" && a.task !== undefined) reach(a.task, "merged");
    else if (a.chore !== "ship") upkeep++;
  }
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
  const shipped = [...furthest].map(([task, how]) => {
    const t = input.tasks.get(task);
    return { task, title: t?.title ?? task, ...(t?.org === undefined ? {} : { org: t.org }), how };
  });
  const name = (org: string) => input.names.get(org) ?? org;
  const groups = new Map<string, { titles: string[]; count: number }>();
  for (const s of shipped) {
    const g = groups.get(s.org ?? PRIVATE) ?? { titles: [], count: 0 };
    g.count++;
    if (g.titles.length < SUMMARY_TITLES) g.titles.push(s.title);
    groups.set(s.org ?? PRIVATE, g);
  }
  return {
    day: input.day,
    from: input.from,
    to: input.to,
    at: input.at,
    shipped,
    shipGroups: [...groups]
      .map(([org, g]) => ({ org, name: name(org), count: g.count, titles: g.titles }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    spent: { total: input.spent.total, orgs: input.spent.orgs.map((o) => ({ ...o, name: name(o.org) })) },
    unsure,
    waiting: [...input.waiting],
    needs: {
      count: input.decisions.length,
      top: input.decisions.slice(0, SUMMARY_TITLES).map((d) => ({
        id: d.id,
        title: d.title,
        ...(d.org === undefined ? {} : { org: d.org }),
      })),
    },
    next: input.queue.slice(0, SUMMARY_TITLES).map((q) => ({
      title: q.title,
      why: q.why,
      ...(q.task === undefined ? {} : { task: q.task }),
      ...(q.org === undefined ? {} : { org: q.org }),
    })),
    upkeep,
    decisions,
  };
}

/** One line for the chat, the notification and the feed. */
export function summaryLine(s: AutonomySummary): string {
  const { total } = s.spent;
  const cap =
    total.cap === undefined
      ? ""
      : total.changed === true
        ? ` (the cap changed during the day, to ${capText(total.cap)})`
        : ` of ${capText(total.cap)}`;
  const spent = `$${total.used.cost.toFixed(2)}${cap}`;
  const over = total.cap !== undefined && total.percent > 100 ? " (over)" : "";
  const parts = [`shipped ${s.shipped.length}`, `spent ${spent}${over}`];
  if (s.unsure.length > 0) parts.push(`unsure about ${s.unsure.length}`);
  const waits = s.needs?.count ?? s.waiting.length;
  if (waits > 0) parts.push(`${waits} waiting for you`);
  return `Daily summary for ${s.day}: ${parts.join(", ")}.`;
}
