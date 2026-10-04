import type { CaptainOrg } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { clockTime, type Tone } from "@/features/autonomy/model";
import { WrongButton } from "@/features/decisions/wrong-button";
import { useAutonomyEvents } from "@/lib/autonomy-queries";
import { useCaptainLog, useCaptainUndo } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useChats, useTasks } from "@/lib/task-queries";
import {
  describeLine,
  inLogView,
  isQuiet,
  LOG_FILTERS,
  type LogEntry,
  type LogFilter,
  mergeLog,
  type TaskNames,
} from "./log-model";

const DOT: Record<Tone, string> = {
  neutral: "text-lamp-idle",
  blue: "text-blue",
  green: "text-lamp-done",
  amber: "text-lamp-needs",
  red: "text-red",
};

/** The titles the log puts where it had ids, and the chats it leaves out. */
function useTaskNames(): TaskNames {
  const tasks = useTasks().data;
  const chats = useChats().data;
  return useMemo(() => {
    const titles = new Map((tasks ?? []).map((t) => [t.id, t.title]));
    const chatIds = new Set((chats ?? []).map((t) => t.id));
    return { title: (id) => titles.get(id), isChat: (id) => chatIds.has(id) };
  }, [tasks, chats]);
}

/**
 * Both records of what the captain did as plain entries, newest first. `quiet` leaves out wake-ups
 * and other noise, for the short list on the page.
 */
export function useLogEntries(org: string, filter: LogFilter, quiet: boolean) {
  const log = useCaptainLog(undefined);
  const feed = useAutonomyEvents(false);
  const names = useTaskNames();
  const entries = useMemo(() => {
    const merged = mergeLog(log.data?.actions ?? [], feed.data?.pages.flatMap((p) => p.events) ?? []);
    const out: LogEntry[] = [];
    for (const line of merged) {
      if (!inLogView(line, org, filter) || (quiet && (isQuiet(line) || line.kind === "other"))) continue;
      const entry = describeLine(line, names);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }, [log.data, feed.data, names, org, filter, quiet]);
  return {
    entries,
    loading: log.isPending || feed.isPending,
    error: log.error ?? feed.error,
    more: feed.hasNextPage,
    loadingMore: feed.isFetchingNextPage,
    loadMore: () => void feed.fetchNextPage(),
  };
}

/** One entry: the time, a dot for how it went, the sentence, and Undo where it works. */
function EntryRow({
  entry,
  now,
  workspace,
  full,
  onUndo,
}: {
  entry: LogEntry;
  now: number;
  workspace: string | undefined;
  full: boolean;
  onUndo: (entry: LogEntry) => void;
}) {
  const action = entry.action;
  return (
    <li className="flex min-w-0 gap-2.5 border-t border-line py-2 first:border-t-0">
      <time
        dateTime={entry.at}
        title={new Date(entry.at).toLocaleString()}
        className="tnum w-11 shrink-0 pt-[3px] font-mono text-xs text-fg-faint"
      >
        {clockTime(entry.at, now)}
      </time>
      <span
        aria-hidden="true"
        className={cn("mt-[7px] size-1.5 shrink-0 rounded-full bg-current", DOT[entry.tone])}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 text-sm text-fg-soft text-pretty break-words">
          {workspace && (
            <span className="mr-1.5 inline-block max-w-[40%] truncate rounded-full border border-line-control px-2 py-px align-[-2px] text-xs text-fg-muted">
              {workspace}
            </span>
          )}
          {entry.task ? (
            <Link
              to="/t/$taskId"
              params={{ taskId: entry.task.id }}
              search={entry.task.item === undefined ? {} : { item: entry.task.item }}
              title={`Open ${entry.task.id}`}
              className="hover:underline"
            >
              {entry.sentence}
            </Link>
          ) : (
            entry.sentence
          )}
        </span>
        {entry.why && (
          <span
            className={cn("text-xs text-fg-faint text-pretty break-words", !full && "line-clamp-1")}
            title={entry.why}
          >
            {full ? "Why: " : ""}
            {entry.why}
          </span>
        )}
        {full && entry.checked && (
          <span className="text-xs text-fg-faint text-pretty">Checked: {entry.checked}</span>
        )}
        {action?.decision !== undefined && <WrongButton decision={action.decision} />}
        {full && action?.outcome === "done" && action.undo === "no" && action.undoNote && (
          <span className="text-xs text-fg-faint text-pretty">No Undo: {action.undoNote}</span>
        )}
      </span>
      {action?.undo === "yes" && (
        <Button size="sm" variant="ghost" className="shrink-0 self-start" onClick={() => onUndo(entry)}>
          Undo
        </Button>
      )}
      {action?.undo === "done" && (
        <Badge className="shrink-0 self-start" title="Undone">
          Undone
        </Badge>
      )}
    </li>
  );
}

function UndoDialog({ entry, onClose }: { entry: LogEntry; onClose: () => void }) {
  const undo = useCaptainUndo();
  const toast = useToast();
  const action = entry.action;
  if (action === undefined) return null;
  return (
    <ConfirmDialog
      title="Undo this?"
      body={
        <span className="text-pretty">
          {entry.sentence}.{" "}
          {action.chore === "ship"
            ? "A new commit reverts the merge. Later work on the branch stays."
            : "It goes back the way it was."}
        </span>
      }
      confirmLabel="Undo"
      busy={undo.isPending}
      error={undo.error ? describeError(undo.error) : undefined}
      onConfirm={() =>
        undo.mutate(
          { id: action.id },
          {
            onSuccess: (done) => {
              onClose();
              toast("Undone", { detail: done.detail });
            },
          },
        )
      }
      onCancel={() => {
        undo.reset();
        onClose();
      }}
    />
  );
}

/** "Did recently": the last few entries, short, with Undo. */
export function RecentLog({
  orgs,
  now,
  limit = 4,
}: {
  orgs: readonly CaptainOrg[];
  now: number;
  limit?: number;
}) {
  const { entries, loading, error } = useLogEntries("", "all", true);
  const [undoing, setUndoing] = useState<LogEntry>();
  const [all, setAll] = useState(false);
  const name = (id: string | undefined) => orgs.find((o) => o.org === id)?.name;
  if (error) return <p className="text-sm text-red">Could not load the history: {describeError(error)}</p>;
  if (loading) return <RowsSkeleton rows={3} height={32} />;
  if (entries.length === 0)
    return <p className="text-sm text-fg-faint">Nothing yet. What the captain does shows up here.</p>;
  return (
    <>
      <ul className="flex flex-col">
        {entries.slice(0, all ? 12 : limit).map((entry) => (
          <EntryRow
            key={entry.key}
            entry={entry}
            now={now}
            workspace={orgs.length > 1 ? name(entry.org) : undefined}
            full={false}
            onUndo={setUndoing}
          />
        ))}
      </ul>
      {entries.length > limit && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className="mt-1 cursor-pointer self-start text-sm text-blue hover:underline"
        >
          {all ? "Show fewer" : `Show ${Math.min(entries.length, 12) - limit} more`}
        </button>
      )}
      {undoing && <UndoDialog entry={undoing} onClose={() => setUndoing(undefined)} />}
    </>
  );
}

/** The whole log: filters by kind and workspace, every entry with why and what was checked, Undo, Load more. */
export function FullLog({ orgs, now }: { orgs: readonly CaptainOrg[]; now: number }) {
  const [org, setOrg] = useState("");
  const [filter, setFilter] = useState<LogFilter>("all");
  const { entries, loading, error, more, loadingMore, loadMore } = useLogEntries(org, filter, false);
  const [undoing, setUndoing] = useState<LogEntry>();
  const name = (id: string | undefined) => orgs.find((o) => o.org === id)?.name;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pb-2">
        <Segmented label="Show in History" value={filter} segments={LOG_FILTERS} onChange={setFilter} />
        <Select
          aria-label="Workspace"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          className="ml-auto h-8 w-[180px] text-sm"
        >
          <option value="">All workspaces</option>
          {orgs.map((o) => (
            <option key={o.org} value={o.org}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>
      {error ? (
        <p role="alert" className="pt-2 text-sm text-red">
          Could not load the history: {describeError(error)}
        </p>
      ) : loading ? (
        <RowsSkeleton rows={5} height={40} />
      ) : entries.length === 0 && !more ? (
        <p className="pt-2 text-sm text-fg-faint text-pretty">
          {filter === "all" && org === ""
            ? "Nothing yet. Each thing the captain does lands here with why, and Undo where it can."
            : "Nothing here under this filter."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <EntryRow
              key={entry.key}
              entry={entry}
              now={now}
              workspace={org === "" ? name(entry.org) : undefined}
              full
              onUndo={setUndoing}
            />
          ))}
        </ul>
      )}
      {more && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 self-start"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading" : "Load more"}
        </Button>
      )}
      {undoing && <UndoDialog entry={undoing} onClose={() => setUndoing(undefined)} />}
    </div>
  );
}
