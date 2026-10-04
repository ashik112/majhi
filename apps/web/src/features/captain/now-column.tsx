import type { AutonomyStatus, CaptainStatus } from "@majhi/shared";
import { PRIVATE } from "@majhi/shared";
import { type ReactNode, useState } from "react";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useExclude } from "@/features/autonomy/desk";
import { TaskRef } from "@/features/autonomy/task-ref";
import { DecisionRow } from "@/features/decisions/decision-row";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { FindingsBox } from "./findings";
import { RecentLog } from "./log";
import { WeekLine } from "./scorecard";

// Each section shows a few whole rows; the rest open in place. The column scrolls as one.
const SHOWN_DECISIONS = 2;
const SHOWN_ROWS = 3;

/** One section of the Now column: a heading with a count and an action, then its rows. */
function Box({
  title,
  count,
  aside,
  label,
  lamp,
  children,
}: {
  title: string;
  lamp?: LampState;
  count?: number | undefined;
  aside?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label ?? title}
      className="flex min-w-0 flex-col gap-1 border-b border-line px-3.5 py-2.5 last:border-b-0"
    >
      <div className="flex min-h-6 items-center gap-2">
        {lamp && <Lamp state={lamp} size={8} />}
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {count !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{count}</span>}
        {aside && <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** "Show 11 more" under a list that shows only its first rows. */
function More({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mt-1 cursor-pointer self-start text-sm text-blue hover:underline"
    >
      {open ? "Show fewer" : `Show ${hidden} more`}
    </button>
  );
}

/** What waits for the owner: the same rows as the Decisions page, answered here. */
function NeedsYou() {
  const query = useDecisions();
  const decisions = query.data?.decisions;
  const total = useNeedsYou() ?? 0;
  const [open, setOpen] = useState(false);
  const shown = (decisions ?? []).slice(0, open ? 12 : SHOWN_DECISIONS);
  return (
    <Box
      title="Needs you"
      lamp={total > 0 ? "needs" : "idle"}
      count={decisions === undefined ? undefined : total}
      aside={
        total > 0 ? (
          <PageLink page="decisions" className="text-blue hover:underline">
            All {total}
          </PageLink>
        ) : undefined
      }
    >
      {query.isError ? (
        <p className="text-sm text-red">Could not load the decisions: {describeError(query.error)}</p>
      ) : decisions === undefined ? (
        <RowsSkeleton rows={2} height={64} />
      ) : total === 0 ? (
        <p className="text-sm text-fg-muted">Nothing needs you.</p>
      ) : (
        <div className="-mx-3.5">
          {shown.map((d) => (
            <DecisionRow key={d.id} decision={d} compact dense />
          ))}
        </div>
      )}
      <More hidden={Math.min(total, 12) - SHOWN_DECISIONS} open={open} onToggle={() => setOpen(!open)} />
    </Box>
  );
}

/** A task line: a lamp, the task id and title, and one short word on the right. */
function WorkLine({
  title,
  task,
  lamp,
  note,
  noteClass,
  aside,
}: {
  title: string;
  task?: string | undefined;
  lamp?: LampState;
  note?: string | undefined;
  noteClass?: string | undefined;
  aside?: ReactNode;
}) {
  return (
    <li className="flex min-h-6 min-w-0 items-center gap-2 text-base text-fg-soft">
      {lamp && <Lamp state={lamp} size={6} />}
      {task && <TaskRef task={task} />}
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      {note && (
        <span className={cn("max-w-[45%] shrink-0 truncate text-xs text-fg-faint", noteClass)} title={note}>
          {note}
        </span>
      )}
      {aside}
    </li>
  );
}

function Running({
  autonomy,
  names,
}: {
  autonomy: AutonomyStatus;
  names: (org: string | undefined) => string | undefined;
}) {
  // Running first; paused tasks follow with their badge, so one click opens them to resume.
  const running = autonomy.now.filter((t) => t.status === "running");
  const paused = autonomy.now.filter((t) => t.status === "paused");
  const all = [...running, ...paused];
  const [open, setOpen] = useState(false);
  const list = open ? all : all.slice(0, SHOWN_ROWS);
  const title = paused.length > 0 ? `Running ${running.length} · Paused ${paused.length}` : "Running";
  return (
    <Box title={title} label="Running" lamp="working" count={paused.length > 0 ? undefined : running.length}>
      {all.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing running.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((t) => (
            <WorkLine
              key={t.task}
              title={t.title}
              task={t.task}
              lamp={t.status === "paused" ? "paused" : "working"}
              note={
                t.status === "paused"
                  ? (t.pause?.label ?? "Paused")
                  : t.agents[0]
                    ? `@${t.agents[0].id}`
                    : names(t.org)
              }
              noteClass={t.status === "paused" ? "text-lamp-paused" : undefined}
            />
          ))}
        </ul>
      )}
      <More hidden={all.length - SHOWN_ROWS} open={open} onToggle={() => setOpen(!open)} />
    </Box>
  );
}

function Next({ autonomy }: { autonomy: AutonomyStatus }) {
  const exclude = useExclude();
  const all = autonomy.queue;
  const [open, setOpen] = useState(false);
  const list = open ? all : all.slice(0, SHOWN_ROWS);
  const marked = new Map(autonomy.backlog.map((b) => [b.task, b.noAutonomy]));
  return (
    <Box title="Next" lamp="idle" count={all.length}>
      {all.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {autonomy.mode === "off" ? "Nothing is planned while Auto-pilot is off." : "Nothing planned yet."}
        </p>
      ) : (
        <ol className="flex flex-col">
          {list.map((q) => {
            const task = q.task;
            const left = task !== undefined && marked.get(task) === true;
            return (
              <WorkLine
                key={`${task ?? ""}|${q.title}`}
                title={q.title}
                task={task}
                aside={
                  task && (
                    <button
                      type="button"
                      aria-label={`Leave ${q.title} alone`}
                      title="The captain will not touch this task"
                      disabled={exclude.busy || left}
                      onClick={() => exclude.set(task, true)}
                      className="shrink-0 cursor-pointer text-xs text-fg-faint hover:text-fg disabled:cursor-default disabled:opacity-60"
                    >
                      {left ? "Left alone" : "Leave alone"}
                    </button>
                  )
                }
              />
            );
          })}
        </ol>
      )}
      <More hidden={all.length - SHOWN_ROWS} open={open} onToggle={() => setOpen(!open)} />
    </Box>
  );
}

/**
 * The Now column: what needs the owner, what runs, what is next and what the captain did lately.
 * The column scrolls as one panel; each section shows its first rows and opens the rest in place.
 */
export function NowColumn({
  captain,
  autonomy,
  now,
  onLog,
  onSummary,
  onFindings,
}: {
  captain: CaptainStatus | undefined;
  autonomy: AutonomyStatus | undefined;
  now: number;
  onLog: () => void;
  onSummary: (() => void) | undefined;
  onFindings: () => void;
}) {
  const orgs = captain?.orgs ?? [];
  const names = (org: string | undefined) => {
    if (orgs.length < 2) return undefined;
    return orgs.find((o) => o.org === (org ?? PRIVATE))?.name;
  };
  return (
    // One panel that scrolls as a whole: no box scrolls on its own, so every section is reachable.
    <section
      aria-label="Now"
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain rounded-2xl scroll-fade",
        GLASS,
      )}
    >
      <NeedsYou />
      {autonomy ? (
        <>
          <Running autonomy={autonomy} names={names} />
          <Next autonomy={autonomy} />
        </>
      ) : (
        <RowsSkeleton rows={2} height={88} />
      )}
      {captain !== undefined && <FindingsBox orgs={orgs} onOpen={onFindings} />}
      <Box
        title="Did recently"
        label="Did recently"
        aside={
          <>
            {onSummary && (
              <button type="button" onClick={onSummary} className="cursor-pointer text-blue hover:underline">
                Summary
              </button>
            )}
            <button type="button" onClick={onLog} className="cursor-pointer text-blue hover:underline">
              History
            </button>
          </>
        }
      >
        {captain === undefined ? <RowsSkeleton rows={2} height={44} /> : <RecentLog orgs={orgs} now={now} />}
        <WeekLine />
      </Box>
    </section>
  );
}
