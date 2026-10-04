import { Plus, X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { Skeleton } from "@/components/ui/skeleton";
import {
  busiestAccount,
  busiestText,
  USAGE_FULL_PCT,
  USAGE_HIGH_PCT,
  usageTitle,
} from "@/features/accounts/model";
import { MODE_LAMP } from "@/features/autonomy/model";
import { markSeen, useUnseenSummary } from "@/features/autonomy/summary-seen";
import { SpendToday, useAutonomousSwitch } from "@/features/autonomy/switch";
import { summaryLine } from "@/features/captain/summary";
import { workspaceOf } from "@/features/decisions/model";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { useCaptainLog } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useNewTask } from "../new-task/new-task-context";
import { inOrg } from "../shell/model";
import { shortAgo } from "../tasks/schedule";
import { DecisionCard, DoneCard, QueuedCard, WorkingCard } from "./home-cards";
import { columnOf } from "./model";

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
    const own = (tasks.data ?? []).filter((t) => inOrg(t, org));
    const midnight = localMidnight(now);
    const working = own
      .filter((t) => ["working", "mr"].includes(columnOf(t)) || t.status === "paused")
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const pausedIds = new Set(working.filter((t) => t.status === "paused").map((t) => t.id));
    const needs = (decisions.data?.decisions ?? []).filter((d) => {
      if (org !== undefined && workspaceOf(d) !== org) return false;
      return !(d.kind === "paused" && d.task !== undefined && pausedIds.has(d.task));
    });
    const next = own
      .filter((t) => columnOf(t) === "inbox")
      .toSorted((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1));
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
      <TopBar working={view.working.filter((t) => t.status !== "paused").length} done={view.done.length} />
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

function TopBar({ working, done }: { working: number; done: number }) {
  const { org } = useOrgFilter();
  const needs = useNeedsYou(org);
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
        <AccountReadout org={org} />
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

/**
 * The account of this workspace (every account without a filter) whose 5-hour or weekly window is
 * fullest: "claude-acme-1 82%", amber from 80%, "claude-acme-1 at limit" in the limit lamp's colour.
 * Every account's windows and resets are in its tooltip, and it opens Health and usage.
 */
function AccountReadout({ org }: { org: string | undefined }) {
  const accounts = useAccounts().data;
  const now = useNow(60_000);
  const busiest = accounts && busiestAccount(accounts, org);
  if (!accounts || !busiest) return null;
  const text = busiestText(busiest);
  const full = busiest.limit !== undefined || busiest.pct >= USAGE_FULL_PCT;
  return (
    <PageLink
      page="usage"
      title={usageTitle(accounts, org, now)}
      className="tnum min-w-0 truncate rounded-xs hover:text-fg max-[1199px]:hidden"
    >
      <span className="font-mono text-sm text-fg">{text.head}</span>{" "}
      <b
        className={cn(
          "ml-0.5 font-mono text-md font-medium",
          full ? LAMP_TEXT.paused : busiest.pct >= USAGE_HIGH_PCT ? "text-amber" : "text-fg",
        )}
      >
        {text.value}
      </b>
      {text.rest}
    </PageLink>
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
