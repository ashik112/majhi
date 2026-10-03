import type { AutonomyStatus, CaptainStatus } from "@majhi/shared";
import { PRIVATE } from "@majhi/shared";
import { Ban } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useExclude } from "@/features/autonomy/desk";
import { clockTime } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { DecisionRow } from "@/features/decisions/decision-row";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { RecentLog } from "./log";

// Each section shows a few whole rows; the rest open in place. The column scrolls as one.
const SHOWN_DECISIONS = 2;
const SHOWN_ROWS = 3;

/** One section of the Now column: a heading with a count and an action, then its rows. */
function Box({
  title,
  count,
  aside,
  label,
  children,
}: {
  title: string;
  count?: number | undefined;
  aside?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label ?? title}
      className="flex min-w-0 flex-col border-b border-line px-4 py-3 last:border-b-0"
    >
      <div className="flex min-h-7 items-center gap-2">
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
  const shown = (decisions ?? []).slice(0, SHOWN_DECISIONS);
  const total = decisions?.length ?? 0;
  return (
    <Box
      title="Needs you"
      count={decisions === undefined ? undefined : total}
      aside={
        total > SHOWN_DECISIONS ? (
          <PageLink page="decisions" className="text-blue hover:underline">
            All {total} in Decisions
          </PageLink>
        ) : undefined
      }
    >
      {query.isError ? (
        <p className="text-sm text-red">Could not load the decisions: {describeError(query.error)}</p>
      ) : decisions === undefined ? (
        <RowsSkeleton rows={2} height={64} />
      ) : total === 0 ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Lamp state="idle" size={7} />
          Nothing needs you right now.
        </p>
      ) : (
        <div className="-mx-3.5">
          {shown.map((d) => (
            <DecisionRow key={d.id} decision={d} compact dense />
          ))}
        </div>
      )}
    </Box>
  );
}

/** A task line: the title first, the workspace, one line of why, and the id small. */
function WorkLine({
  title,
  task,
  workspace,
  why,
  status,
  aside,
}: {
  title: string;
  task?: string | undefined;
  workspace: string | undefined;
  why: string | undefined;
  status?: AutonomyStatus["now"][number]["status"];
  aside?: ReactNode;
}) {
  return (
    <li className="group flex min-w-0 gap-2 border-t border-line py-1.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-base text-fg" title={title}>
            {title}
          </span>
          {workspace && (
            <span
              className="max-w-[40%] shrink-0 truncate rounded-full border border-line-control px-2 py-px text-xs text-fg-muted"
              title={workspace}
            >
              {workspace}
            </span>
          )}
          {status && <StatusBadge status={status} />}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-sm text-fg-muted">
          {task && <TaskRef task={task} />}
          {why && (
            <span className="min-w-0 truncate" title={why}>
              {why}
            </span>
          )}
        </span>
      </span>
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
    <Box title={title} label="Running" count={paused.length > 0 ? undefined : running.length}>
      {all.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing running.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((t) => (
            <WorkLine
              key={t.task}
              title={t.title}
              task={t.task}
              workspace={names(t.org)}
              why={t.why}
              status={t.status}
            />
          ))}
        </ul>
      )}
      <More hidden={all.length - SHOWN_ROWS} open={open} onToggle={() => setOpen(!open)} />
    </Box>
  );
}

function Next({
  autonomy,
  now,
  names,
}: {
  autonomy: AutonomyStatus;
  now: number;
  names: (org: string | undefined) => string | undefined;
}) {
  const exclude = useExclude();
  const all = autonomy.queue;
  const [open, setOpen] = useState(false);
  const list = open ? all : all.slice(0, SHOWN_ROWS);
  const marked = new Map(autonomy.backlog.map((b) => [b.task, b.noAutonomy]));
  return (
    <Box title="Next" count={all.length}>
      {all.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {autonomy.mode === "off" ? "Nothing is planned while Autonomous is off." : "Nothing planned yet."}
        </p>
      ) : (
        <ol className="flex flex-col">
          {list.map((q) => {
            const task = q.task;
            const after = q.after !== undefined && Date.parse(q.after) > now ? q.after : undefined;
            return (
              <WorkLine
                key={`${task ?? ""}|${q.title}`}
                title={q.title}
                task={task}
                workspace={names(q.org)}
                why={after === undefined ? q.why : `Not before ${clockTime(after, now)}. ${q.why}`}
                aside={
                  task && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Leave ${q.title} alone`}
                      title="Leave alone: the captain will not touch this task"
                      disabled={exclude.busy || marked.get(task) === true}
                      onClick={() => exclude.set(task, true)}
                      className="shrink-0 self-start opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Ban aria-hidden="true" />
                    </Button>
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
}: {
  captain: CaptainStatus;
  autonomy: AutonomyStatus | undefined;
  now: number;
  onLog: () => void;
  onSummary: (() => void) | undefined;
}) {
  const names = (org: string | undefined) => {
    if (captain.orgs.length < 2) return undefined;
    return captain.orgs.find((o) => o.org === (org ?? PRIVATE))?.name;
  };
  return (
    // One panel that scrolls as a whole: no box scrolls on its own, so every section is reachable.
    <div
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
          <Next autonomy={autonomy} now={now} names={names} />
        </>
      ) : (
        <RowsSkeleton rows={2} height={88} />
      )}
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
              See all
            </button>
          </>
        }
      >
        <RecentLog orgs={captain.orgs} now={now} />
      </Box>
    </div>
  );
}
