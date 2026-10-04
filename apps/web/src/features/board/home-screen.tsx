import { PRIVATE } from "@majhi/shared";
import { Plus, X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { Skeleton } from "@/components/ui/skeleton";
import { MODE_LAMP } from "@/features/autonomy/model";
import { markSeen, useUnseenSummary } from "@/features/autonomy/summary-seen";
import { SpendToday, useAutonomousSwitch } from "@/features/autonomy/switch";
import { summaryLine } from "@/features/captain/summary";
import { workspaceOf } from "@/features/decisions/model";
import { useNeedsYou, useWorking } from "@/features/decisions/needs-you";
import { useCaptainLog } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useNewTask } from "../new-task/new-task-context";
import { isOpen } from "../shell/model";
import { shortAgo } from "../tasks/schedule";
import { DecisionCard, DoneCard, QueuedCard, WorkingCard } from "./home-cards";
import { rankNext } from "./model";

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Home: the board as four columns. What needs the owner leads and is answered on its card. */
export function BoardScreen() {
  const tasks = useTasks();
  const decisions = useDecisions();
  const { org } = useOrgFilter();
  const now = useNow(60_000);
  const log = useCaptainLog(org);

  const view = useMemo(() => {
    const own = (tasks.data ?? []).filter((t) => org === undefined || (t.org ?? PRIVATE) === org);
    const midnight = localMidnight(now);
    // The columns list exactly what the server counts: needs you is its decisions, working is the
    // tasks an agent works on now. Everything else that is open and quiet waits in Up next.
    const needs = (decisions.data?.decisions ?? []).filter((d) => org === undefined || workspaceOf(d) === org);
    const asking = new Set(needs.flatMap((d) => (d.task === undefined ? [] : [d.task])));
    const live = new Set(decisions.data?.counts.workingTasks ?? []);
    const working = own
      .filter((t) => live.has(t.id))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const next = own
      .filter((t) => isOpen(t) && t.chat !== true && !live.has(t.id) && !asking.has(t.id))
      .toSorted(
        (a, b) =>
          rankNext(a) - rankNext(b) || b.updatedAt.localeCompare(a.updatedAt),
      );
    const done = own
      .filter((t) => t.status === "done" && Date.parse(t.updatedAt) >= midnight)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { needs, working, next, done };
  }, [tasks.data, decisions.data, org, now]);

  const undoOf = useMemo(() => {
    const byTask = new Map<string, number>();
    for (const action of log.data?.actions ?? []) {
      if (action.chore === "ship" && action.outcome === "done" && action.undo === "yes" && action.task) {
        if (!byTask.has(action.task)) byTask.set(action.task, action.id);
      }
    }
    return byTask;
  }, [log.data]);

  const loading = tasks.isPending || decisions.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <TopBar done={view.done.length} />
      <Away now={now} />
      {tasks.isError ? (
        <p role="alert" className={cn("rounded-2xl p-6 text-base text-red", GLASS)}>
          Could not load tasks. {tasks.error.message}
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(4,minmax(200px,1fr))] gap-3 overflow-x-auto">
          <Column label="Needs you" lamp="needs" count={view.needs.length} loading={loading}>
            {view.needs.map((d) => (
              <DecisionCard key={d.id} decision={d} />
            ))}
          </Column>
          <Column label="Working" lamp="working" count={view.working.length} loading={loading}>
            {view.working.map((t) => (
              <WorkingCard key={t.id} task={t} ago={shortAgo(t.updatedAt, now)} />
            ))}
          </Column>
          <Column label="Up next" lamp="idle" count={view.next.length} loading={loading}>
            {view.next.map((t) => (
              <QueuedCard key={t.id} task={t} />
            ))}
          </Column>
          <Column label="Done today" lamp="done" count={view.done.length} loading={loading}>
            {view.done.map((t) => (
              <DoneCard key={t.id} task={t} time={clock(t.updatedAt)} undoId={undoOf.get(t.id)} />
            ))}
          </Column>
        </div>
      )}
    </div>
  );
}

function TopBar({ done }: { done: number }) {
  const { org } = useOrgFilter();
  const needs = useNeedsYou(org);
  const working = useWorking(org) ?? 0;
  const newTask = useNewTask();
  const { status, unavailable, mode, toggle, dialogs } = useAutonomousSwitch();
  const lamp = MODE_LAMP[mode];
  return (
    <header className={cn("flex h-11 shrink-0 items-center gap-4 rounded-xl px-4", GLASS)}>
      <h1 className="text-[15px] leading-5 font-semibold tracking-[-0.01em]">Home</h1>
      <p className="flex min-w-0 items-baseline gap-4 overflow-hidden text-sm whitespace-nowrap text-fg-muted">
        <Count n={needs ?? "–"} label={needs === 1 ? "needs you" : "need you"} tone="needs" lit={!!needs} />
        <Count n={working} label="working" tone="working" lit={working > 0} />
        <span className="max-[999px]:hidden">
          <Count n={done} label="done today" />
        </span>
        {status && <SpendToday status={status} className="text-sm text-fg-muted max-[1199px]:hidden" />}
      </p>
      <div
        title={unavailable}
        className="ml-auto flex shrink-0 items-center gap-2 text-sm font-medium text-fg-soft"
      >
        <Lamp state={lamp} size={7} />
        Auto-pilot
        {toggle}
      </div>
      <Button variant="primary" size="sm" onClick={newTask.open} title="New task (n)" className="h-7">
        <Plus aria-hidden="true" strokeWidth={2.5} />
        New task
      </Button>
      {dialogs}
    </header>
  );
}

function Count({
  n,
  label,
  tone,
  lit,
}: {
  n: number | string;
  label: string;
  tone?: LampState;
  lit?: boolean;
}) {
  return (
    <span className="tnum flex items-baseline gap-1.5">
      <b className={cn("font-mono text-md font-medium", lit && tone ? LAMP_TEXT[tone] : "text-fg")}>{n}</b>
      {label}
    </span>
  );
}

/** One slim line about the time away, until the owner closes it. */
function Away({ now }: { now: number }) {
  const summary = useUnseenSummary(now);
  if (summary === undefined) return null;
  const line = summaryLine(summary, now);
  return (
    <div className={cn("flex h-8 shrink-0 items-center gap-3 rounded-xl px-4 text-sm", GLASS)}>
      <span className="min-w-0 truncate text-fg-soft">
        <b className="font-semibold text-fg">While you were away:</b> {line.text}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => markSeen(summary.day)}
        className="ml-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint hover:bg-raised hover:text-fg"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

function Column({
  label,
  lamp,
  count,
  loading,
  children,
}: {
  label: string;
  lamp: LampState;
  count: number;
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-h-0 min-w-0 flex-col rounded-2xl px-2.5 pt-3", GLASS)}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-1 pb-2.5">
        <Lamp state={lamp} dim={count === 0} size={8} />
        <h2 className="text-base leading-[18px] font-semibold">{label}</h2>
        <span className="tnum font-mono text-sm text-fg-muted">{count}</span>
      </div>
      <div className="scroll-fade -mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-1 pt-2.5 pb-6">
        {loading ? <Skeleton className="h-[96px] w-full rounded-xl" /> : children}
      </div>
    </section>
  );
}
