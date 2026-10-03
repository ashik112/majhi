import type { AutonomyStatus, CaptainStatus } from "@majhi/shared";
import { PRIVATE } from "@majhi/shared";
import { Ban } from "lucide-react";
import type { ReactNode } from "react";
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

const SHOWN_DECISIONS = 4;

/** A box of the Now column: a heading with a count and an action, and a body that scrolls inside it. */
function Box({
  title,
  count,
  aside,
  label,
  className,
  children,
}: {
  title: string;
  count?: number | undefined;
  aside?: ReactNode;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label ?? title}
      className={cn("flex min-h-[88px] shrink flex-col overflow-hidden rounded-xl", GLASS, className)}
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 px-3.5 pt-2">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {count !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{count}</span>}
        {aside && <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">{aside}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-2.5 scroll-fade">
        {children}
      </div>
    </section>
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
      className="shrink-[0.6]"
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
            <DecisionRow key={d.id} decision={d} compact />
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
    <li className="group flex min-w-0 gap-2 border-t border-line py-2 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-base text-fg" title={title}>
            {title}
          </span>
          {status && <StatusBadge status={status} />}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-fg-faint">
          {workspace && (
            <span
              className="max-w-[45%] shrink-0 truncate rounded-full border border-line-control px-2 py-px text-fg-muted"
              title={workspace}
            >
              {workspace}
            </span>
          )}
          {task && <TaskRef task={task} />}
        </span>
        {why && (
          <span className="line-clamp-2 text-sm text-fg-muted text-pretty" title={why}>
            {why}
          </span>
        )}
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
  const list = autonomy.now;
  return (
    <Box title="Running" count={list.length}>
      {list.length === 0 ? (
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
  const list = autonomy.queue;
  const marked = new Map(autonomy.backlog.map((b) => [b.task, b.noAutonomy]));
  return (
    <Box title="Next" count={list.length}>
      {list.length === 0 ? (
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
    </Box>
  );
}

/**
 * The Now column: what needs the owner, what runs, what is next and what the captain did lately.
 * Each box scrolls inside itself, so the column never grows past the screen.
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
    <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto lg:overflow-visible">
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
        className="shrink-[1.4]"
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
