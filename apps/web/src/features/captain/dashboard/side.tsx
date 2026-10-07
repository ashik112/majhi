import type { StuckKind, StuckTask } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { clockTime } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useLogEntries } from "../log";
import { type OrgInfo, orgColor, orgName, span } from "./model";
import { Panel } from "./panel";

const KIND_WORD: Record<StuckKind, string> = {
  idle: "No progress",
  waiting: "Waiting",
};

const KIND_TONE: Record<StuckKind, string> = {
  idle: "text-lamp-needs",
  waiting: "text-lamp-needs",
};

/** Tasks that are not moving, longest first: what the owner should look at before anything else. */
export function Stuck({
  stuck,
  error,
  nowMs,
}: {
  stuck: readonly StuckTask[] | undefined;
  error: unknown;
  nowMs: number;
}) {
  return (
    <Panel title="Stuck" aside={stuck?.length} className="shrink-0">
      {error !== null && error !== undefined ? (
        <p className="m-0 text-sm text-red">Could not read it: {describeError(error)}</p>
      ) : stuck === undefined ? (
        <RowsSkeleton rows={2} height={32} />
      ) : stuck.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Nothing stuck. Every Auto-pilot task moved recently.</p>
      ) : (
        <ul className="m-0 max-h-52 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-0">
          {stuck.map((s) => (
            <li
              key={`${s.task}|${s.kind}`}
              className="flex min-w-0 flex-col border-t border-line py-1.5 first:border-t-0"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={cn("shrink-0 text-xs font-medium", KIND_TONE[s.kind])}>
                  {KIND_WORD[s.kind]}
                </span>
                <TaskRef task={s.task} />
                <Link
                  to="/t/$taskId"
                  params={{ taskId: s.task }}
                  title={s.title}
                  className="min-w-0 truncate text-sm text-fg-soft hover:underline"
                >
                  {s.title}
                </Link>
                <time dateTime={s.since} className="tnum ml-auto shrink-0 font-mono text-xs text-fg-faint">
                  {span(nowMs - Date.parse(s.since))}
                </time>
              </span>
              <span className="truncate text-xs text-fg-faint" title={s.text}>
                {s.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const DOT = {
  neutral: "text-lamp-idle",
  blue: "text-blue",
  green: "text-lamp-done",
  amber: "text-lamp-needs",
  red: "text-red",
} as const;

const FEED_HOURS = 24;
const FEED_MAX = 60;

/** The captain's last actions, newest first, one line each. */
export function Feed({ nowMs, orgs, many }: { nowMs: number; orgs: readonly OrgInfo[]; many: boolean }) {
  const log = useLogEntries("", "all", true);
  const since = nowMs - FEED_HOURS * 3_600_000;
  const entries = log.entries.filter((e) => Date.parse(e.at) >= since).slice(0, FEED_MAX);
  return (
    <Panel
      title="Captain's last actions"
      aside={
        <PageLink page="captain" search={{ tab: "log" }} className="hover:underline">
          All
        </PageLink>
      }
      className="min-h-0"
      flush
    >
      {log.loading ? (
        <div className="px-3.5 pb-3">
          <RowsSkeleton rows={4} height={24} />
        </div>
      ) : log.error ? (
        <p className="m-0 px-3.5 pb-3 text-sm text-red">Could not load the log: {describeError(log.error)}</p>
      ) : entries.length === 0 ? (
        <p className="m-0 px-3.5 pb-3 text-sm text-fg-muted">Nothing in the last {FEED_HOURS} hours.</p>
      ) : (
        <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-0 pb-1">
          {entries.map((e) => {
            const body = (
              <>
                {many && e.org !== undefined && (
                  <span
                    aria-hidden="true"
                    title={orgName(orgs, e.org)}
                    className="mr-1.5 inline-block size-2 rounded-xs align-middle"
                    style={{ background: orgColor(orgs, e.org) }}
                  />
                )}
                {e.sentence}
              </>
            );
            return (
              <li
                key={e.key}
                className="flex min-w-0 items-baseline gap-2 border-t border-line px-3.5 py-1 first:border-t-0"
              >
                <time dateTime={e.at} className="tnum w-10 shrink-0 font-mono text-xs text-fg-faint">
                  {clockTime(e.at, nowMs)}
                </time>
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 self-center rounded-full bg-current", DOT[e.tone])}
                />
                {e.task ? (
                  <Link
                    to="/t/$taskId"
                    params={{ taskId: e.task.id }}
                    search={e.task.item === undefined ? {} : { item: e.task.item }}
                    title={e.sentence}
                    className="min-w-0 truncate text-sm text-fg-soft hover:underline"
                  >
                    {body}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-sm text-fg-soft" title={e.sentence}>
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
