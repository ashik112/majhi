import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { TaskRef } from "@/features/autonomy/task-ref";
import { cn } from "@/lib/cn";
import { span, type WorkspaceRow } from "./model";
import { Panel } from "./panel";

/** Seven columns on a wide window; Review and Last action give way first on a narrow one. */
export const COLUMNS =
  "grid-cols-[minmax(100px,1fr)_minmax(0,1.7fr)_minmax(0,1.2fr)_minmax(0,0.85fr)_minmax(0,1fr)] min-[1280px]:grid-cols-[minmax(150px,1.3fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_minmax(0,1.7fr)]";

const HEAD = "px-2 py-1.5 text-xs font-medium tracking-wide text-fg-faint uppercase";

/** A count that opens its list, then the one entry worth a glance, on one line. */
function Cell({ count, to, children }: { count: number; to: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 px-2">
      {count === 0 ? (
        <span className="tnum w-4 shrink-0 text-right font-mono text-sm text-fg-faint">–</span>
      ) : (
        <span className="flex w-4 shrink-0 items-center justify-end gap-1">{to}</span>
      )}
      {count > 0 && (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate text-xs text-fg-muted">
          {children}
        </span>
      )}
    </div>
  );
}

function Count({ n, tone }: { n: number; tone?: "needs" | undefined }) {
  return (
    <span
      className={cn("tnum font-mono text-sm font-medium", tone === "needs" ? "text-lamp-needs" : "text-fg")}
    >
      {n}
    </span>
  );
}

function Row({ row, nowMs }: { row: WorkspaceRow; nowMs: number }) {
  const { running, blocked, review, waiting, last } = row;
  const quiet = running.count + blocked.count + review.count + waiting.count === 0;
  const lamp: LampState = row.lane === "working" ? "working" : row.lane === "resting" ? "paused" : "idle";
  return (
    <li
      className={cn(
        "grid min-h-10 items-center border-t border-line py-1.5 first:border-t-0 hover:bg-raised/60",
        COLUMNS,
        quiet && "opacity-80",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-2">
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-xs" style={{ background: row.color }} />
        <PageLink
          page="board"
          search={{ org: row.org }}
          title={`${row.name}: open its board`}
          className="min-w-0 truncate text-sm font-medium text-fg hover:underline"
        >
          {row.name}
        </PageLink>
        <span
          className="ml-auto flex shrink-0 items-center"
          title={
            row.lane === "working"
              ? "The captain is working here"
              : row.lane === "resting"
                ? (row.resting ?? "Resting")
                : "The captain is idle here"
          }
        >
          <Lamp state={lamp} size={7} />
        </span>
      </div>

      <Cell
        count={running.count}
        to={
          <PageLink page="board" search={{ org: row.org }} title="Running tasks on the board">
            <Count n={running.count} />
          </PageLink>
        }
      >
        {running.first && (
          <>
            <TaskRef task={running.first.task} />
            {running.first.sinceMs !== undefined && (
              <span className="tnum shrink-0 font-mono text-fg-soft">{span(running.first.sinceMs)}</span>
            )}
            <span className="min-w-0 truncate font-mono" title={running.first.title}>
              {running.first.agents.join(" ")}
            </span>
          </>
        )}
      </Cell>

      <Cell
        count={blocked.count}
        to={
          <PageLink page="board" search={{ org: row.org }} title="Paused tasks on the board">
            <Count n={blocked.count} tone="needs" />
          </PageLink>
        }
      >
        {blocked.first && (
          <>
            <TaskRef task={blocked.first.task} />
            <span className="min-w-0 truncate">{blocked.first.reason}</span>
          </>
        )}
      </Cell>

      <Cell
        count={review.count}
        to={
          <PageLink page="decisions" search={{ org: row.org }} title="Tasks in review, in Decisions">
            <Count n={review.count} />
          </PageLink>
        }
      >
        {review.ready > 0 ? (
          <Link
            to="/decisions"
            search={review.shipId === undefined ? {} : { id: review.shipId }}
            className="min-w-0 truncate text-lamp-done hover:underline"
          >
            {review.ready} ready
          </Link>
        ) : (
          review.first && <TaskRef task={review.first.task} />
        )}
      </Cell>

      <Cell
        count={waiting.count}
        to={
          <PageLink page="decisions" search={{ org: row.org }} title="What waits for you in this workspace">
            <Count n={waiting.count} tone="needs" />
          </PageLink>
        }
      >
        {waiting.oldest && (
          <Link
            to="/decisions"
            search={{ id: waiting.oldest.id }}
            title={waiting.oldest.title}
            className="min-w-0 truncate hover:underline"
          >
            oldest{" "}
            <span className="tnum font-mono text-fg-soft">{span(nowMs - Date.parse(waiting.oldest.at))}</span>
          </Link>
        )}
      </Cell>

      <div className="hidden min-w-0 items-baseline gap-2 px-2 text-xs min-[1280px]:flex">
        {last === undefined ? (
          <span className="text-fg-faint">None yet</span>
        ) : (
          <>
            {last.task ? (
              <Link
                to="/t/$taskId"
                params={{ taskId: last.task }}
                title={last.sentence}
                className="min-w-0 truncate text-fg-soft hover:underline"
              >
                {last.sentence}
              </Link>
            ) : (
              <span className="min-w-0 truncate text-fg-soft" title={last.sentence}>
                {last.sentence}
              </span>
            )}
            <time dateTime={last.at} className="tnum shrink-0 font-mono text-fg-faint">
              {span(nowMs - Date.parse(last.at))}
            </time>
          </>
        )}
      </div>
    </li>
  );
}

/** What matters now, one line per workspace. */
export function Workspaces({ rows, nowMs }: { rows: readonly WorkspaceRow[]; nowMs: number }) {
  return (
    <Panel title="Workspaces" aside={`${rows.length}`} className="max-h-full min-h-0 self-start" flush>
      {rows.length === 0 ? (
        <p className="m-0 px-3.5 pb-3 text-sm text-fg-muted">
          No workspace yet. Add one in Orgs and the captain starts a lane there.
        </p>
      ) : (
        <>
          <div className={cn("grid shrink-0 border-y border-line", COLUMNS)}>
            <div className={HEAD}>Workspace</div>
            <div className={HEAD}>Running</div>
            <div className={HEAD}>Paused</div>
            <div className={HEAD} title="Tasks in review. Ready: waiting for you to ship">
              Review
            </div>
            <div className={HEAD}>Needs you</div>
            <div className={cn(HEAD, "hidden min-[1280px]:block")}>Last captain action</div>
          </div>
          <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-0">
            {rows.map((row) => (
              <Row key={row.org} row={row} nowMs={nowMs} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
