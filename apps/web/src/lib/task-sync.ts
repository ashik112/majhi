import { compareDecisions, type DecisionList, type OwnerDecision, type TaskSummary } from "@majhi/shared";
import type { QueryClient } from "@tanstack/react-query";
import { cmd } from "./api";
import { queryKeys } from "./queries";

/** Tasks the feed named are read at most once per this long: the first change at once, a burst after it in one read. */
const WINDOW_MS = 2000;
/** More named tasks than this are not worth reading one by one: the list is read again. */
const MAX_NAMED = 100;

const listKey = [...queryKeys.tasks, "list"] as const;

/** The list's order: newest change first, the id breaks a tie. */
const newestFirst = (a: TaskSummary, b: TaskSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);

/**
 * Puts the rows the server gave for `ids` into the list: a row that came back replaces its old one (or
 * joins the list), an id that did not come back is gone. Rows that did not change keep their object, so
 * only the cards of changed tasks render again.
 */
export function patchTaskList(
  list: readonly TaskSummary[],
  ids: readonly string[],
  rows: readonly TaskSummary[],
): TaskSummary[] {
  const named = new Set(ids);
  const fresh = new Map(rows.map((r) => [r.id, r]));
  const next = list.flatMap((t) => (named.has(t.id) ? (fresh.get(t.id) ?? []) : [t]));
  const have = new Set(next.map((t) => t.id));
  for (const row of rows) if (!have.has(row.id)) next.push(row);
  return next.toSorted(newestFirst);
}

/** The decision id of a room card is `room:<task>:<item>`: its task is the second part. */
const taskOfDecision = (id: unknown): string | undefined => (typeof id === "string" ? id.split(":")[1] : undefined);

/**
 * Puts what waits in the named tasks into the decisions list: their old decisions go, the ones the server
 * gave join, and the list keeps the server's order. Decisions of other tasks keep their objects.
 */
export function patchDecisions(
  list: readonly OwnerDecision[],
  ids: ReadonlySet<string>,
  fresh: readonly OwnerDecision[],
): OwnerDecision[] {
  const kept = list.filter((d) => d.task === undefined || !ids.has(d.task));
  return [...kept, ...fresh].toSorted(compareDecisions);
}

/** The details of these tasks' cards are read again; the details of every other card stay (each one runs the diff). */
function readDetails(client: QueryClient, tasks: ReadonlySet<string>): void {
  void client.invalidateQueries({
    queryKey: [...queryKeys.decisions, "detail"],
    predicate: (query) => {
      const task = taskOfDecision(query.queryKey[2]);
      return task !== undefined && tasks.has(task);
    },
  });
}

/**
 * Reads the tasks an event named, together with the counts, in one request, and patches the task list
 * and the counts of the decisions list from the answer. Reads are batched per window.
 */
export function taskSync(client: QueryClient): { touch: (ids: readonly string[], waits: readonly string[]) => void; stop: () => void } {
  const pending = new Set<string>();
  const pendingWaits = new Set<string>();
  let last = Number.NEGATIVE_INFINITY;
  let timer: number | undefined;
  let stopped = false;

  const refetchLists = () => {
    void client.invalidateQueries({ queryKey: listKey });
    void client.invalidateQueries({ queryKey: queryKeys.decisions });
  };

  const flush = async () => {
    timer = undefined;
    last = performance.now();
    const ids = [...pending];
    const waits = new Set(pendingWaits);
    pending.clear();
    pendingWaits.clear();
    if (ids.length === 0 || stopped) return;
    if (ids.length > MAX_NAMED) return refetchLists();
    try {
      const answer = await cmd("tasks.changed", { ids, ...(waits.size > 0 ? { decisions: true } : {}) });
      if (stopped) return;
      client.setQueryData<TaskSummary[]>(listKey, (old) => old && patchTaskList(old, ids, answer.tasks));
      client.setQueryData<DecisionList>(queryKeys.decisions, (old) => {
        if (old === undefined) return old;
        const decisions =
          answer.decisions === undefined ? old.decisions : patchDecisions(old.decisions, new Set(ids), answer.decisions);
        return { decisions, counts: answer.counts };
      });
      // An open task page reads its own task again; one nobody looks at is only marked stale.
      for (const id of ids) void client.invalidateQueries({ queryKey: [...queryKeys.tasks, "one", id] });
      if (waits.size > 0) readDetails(client, waits);
    } catch {
      refetchLists();
    }
  };

  return {
    touch(ids, waits) {
      for (const id of ids) pending.add(id);
      for (const id of waits) pendingWaits.add(id);
      if (timer !== undefined || stopped) return;
      const wait = last + WINDOW_MS - performance.now();
      if (wait <= 0) void flush();
      else timer = window.setTimeout(() => void flush(), wait);
    },
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      pending.clear();
      pendingWaits.clear();
    },
  };
}
