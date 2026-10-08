import type { OwnerDecision, TaskSummary } from "@majhi/shared";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { actionOf, openLabel, workspaceOf } from "@/features/decisions/model";
import { useSendDecision } from "@/features/decisions/use-send-decision";
import { useDecisions } from "@/lib/decision-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";

/** One line of the Now list: a live task, or something that waits for the owner with no task. */
export interface NowRow {
  key: string;
  lamp: LampState;
  /** The task id, or the workspace's name for a decision with no task. */
  id: string;
  title: string;
  /** What it is doing, in a word or two, when nothing is asked of the owner. */
  state: string;
  /** The decision that needs the owner here, with its first answer as the row's button. */
  decision?: OwnerDecision;
}

/** The statuses a task is live in. Waiting in the queue (inbox, ready) and done are not "now". */
const LIVE: Partial<Record<TaskSummary["status"], { lamp: LampState; state: string }>> = {
  running: { lamp: "working", state: "Working" },
  review: { lamp: "done", state: "Review" },
  mr: { lamp: "done", state: "Merge request" },
  paused: { lamp: "paused", state: "Paused" },
};

/**
 * What is happening now, from the task list and the decisions list and nothing else. A task is one row, and
 * when a decision waits in it the row carries that decision's button; a decision with no live task (the
 * captain blocked with no account, a sign-in, the budget) is a row of its own. No task or decision appears twice.
 */
export function nowRows(
  tasks: readonly TaskSummary[],
  decisions: readonly OwnerDecision[],
  orgName: (org: string | undefined) => string,
): NowRow[] {
  const live = new Map(tasks.filter((t) => t.chat !== true).map((t) => [t.id, t]));
  const firstFor = new Map<string, OwnerDecision>();
  const own: OwnerDecision[] = [];
  for (const d of decisions) {
    if (d.task !== undefined && live.has(d.task)) {
      if (!firstFor.has(d.task)) firstFor.set(d.task, d);
    } else own.push(d);
  }
  const rows: NowRow[] = [];
  for (const [id, decision] of firstFor) {
    const task = live.get(id);
    if (task === undefined) continue;
    rows.push({ key: `t:${id}`, lamp: "needs", id, title: task.title, state: "Needs you", decision });
  }
  for (const task of live.values()) {
    const now = LIVE[task.status];
    if (now === undefined || firstFor.has(task.id)) continue;
    rows.push({ key: `t:${task.id}`, lamp: now.lamp, id: task.id, title: task.title, state: now.state });
  }
  for (const d of own) {
    rows.push({
      key: `d:${d.id}`,
      lamp: "needs",
      id: orgName(workspaceOf(d)),
      title: d.title,
      state: "Needs you",
      decision: d,
    });
  }
  // The rows that need the owner first, then by lamp; the task list's own order holds within each.
  const rank = (r: NowRow) =>
    r.decision !== undefined ? 0 : r.lamp === "working" ? 1 : r.lamp === "paused" ? 2 : 3;
  return rows.toSorted((a, b) => rank(a) - rank(b));
}

/** The one list of what is going on, above the Captain chat. */
export function NowList() {
  const tasks = useTasks().data;
  const decisions = useDecisions().data?.decisions;
  const orgs = useOrgs().data;
  const rows = nowRows(
    tasks ?? [],
    decisions ?? [],
    (org) => orgs?.find((o) => o.id === org)?.name ?? org ?? "",
  );
  return (
    <section aria-label="Now" className="flex max-h-[44%] shrink-0 flex-col border-b border-line">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h3 className="m-0 font-mono text-xs font-medium tracking-wide text-fg-faint uppercase">Now</h3>
        <span className="tnum font-mono text-xs text-fg-faint">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 px-3 pb-2.5 text-sm text-fg-muted">Nothing is running and nothing needs you.</p>
      ) : (
        <ul className="m-0 flex min-h-0 list-none flex-col overflow-y-auto p-0 pb-1">
          {rows.map((row) => (
            <NowItem key={row.key} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NowItem({ row }: { row: NowRow }) {
  const run = useRunAttention();
  const { send, busy } = useSendDecision();
  const { decision } = row;
  const answer =
    decision?.options.find((o) => o.text !== true && o.primary === true) ??
    decision?.options.find((o) => o.text !== true);
  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <Lamp state={row.lamp} size={7} />
      <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-fg-muted">{row.id}</span>
      <button
        type="button"
        title={row.title}
        onClick={() => run(decision === undefined ? { kind: "task", id: row.id } : actionOf(decision.link))}
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm text-fg hover:underline"
      >
        {row.title}
      </button>
      {decision === undefined ? (
        <span className="shrink-0 text-xs text-fg-faint">{row.state}</span>
      ) : answer !== undefined ? (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => send(decision, answer.id)}>
          {answer.label}
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => run(actionOf(decision.link))}>
          {openLabel(decision.link)}
        </Button>
      )}
    </li>
  );
}
