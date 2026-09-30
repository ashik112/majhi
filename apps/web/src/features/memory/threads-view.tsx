import type { Thread } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useCloseThread, useReopenThread, useThreads } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";

const NO_PROJECT = "";

/** Who closed a thread, in words, with the task as a link. */
function ClosedBy({ thread }: { thread: Thread }) {
  const by = thread.closed_by;
  if (by === undefined || by === "owner") return <>Closed by you</>;
  const [kind, id] = by.split(":", 2);
  if (kind === "task" && id !== undefined)
    return (
      <>
        Done in <TaskRef id={id} />
      </>
    );
  if (kind === "follow-up" && id !== undefined)
    return (
      <>
        Its follow-up <TaskRef id={id} /> is done
      </>
    );
  return <>Closed</>;
}

/**
 * One thread: what is left, which task left it, the follow-up made for it, and Close or Reopen.
 * `justClosed` keeps a thread the owner closed a moment ago in place, with Reopen, as the undo.
 */
export function ThreadRow({
  thread,
  justClosed = false,
  showProject = false,
  onClosed,
}: {
  thread: Thread;
  justClosed?: boolean;
  showProject?: boolean;
  onClosed?: () => void;
}) {
  const close = useCloseThread();
  const reopen = useReopenThread();
  const toast = useToast();
  const now = useNow(60_000);
  const open = thread.status === "open";
  const busy = close.isPending || reopen.isPending;
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-xl border border-line-strong bg-card px-4 py-3",
        !open && "opacity-75",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={cn(
            "m-0 text-body text-fg text-pretty [overflow-wrap:anywhere]",
            !open && "text-fg-muted line-through decoration-fg-faint",
          )}
        >
          {thread.text}
        </p>
        <p className="m-0 flex flex-wrap gap-x-1.5 text-xs text-fg-faint">
          {showProject && thread.project !== undefined && (
            <span className="font-mono [overflow-wrap:anywhere]">{thread.project} ·</span>
          )}
          <span>
            From <TaskRef id={thread.task} />
          </span>
          {thread.follow_up !== undefined && (
            <span>
              · Follow-up <TaskRef id={thread.follow_up} />
            </span>
          )}
          <span>· {formatAgo(thread.created_at, now)}</span>
          {!open && (
            <span>
              · <ClosedBy thread={thread} />
            </span>
          )}
        </p>
        {!open && thread.closed_reason !== undefined && (
          <p className="m-0 text-sm text-fg-muted text-pretty">{thread.closed_reason}</p>
        )}
      </div>
      {open ? (
        <Button
          size="sm"
          aria-label={`Close: ${thread.text}`}
          disabled={busy}
          onClick={() =>
            close.mutate(
              { id: thread.id },
              {
                onSuccess: () => onClosed?.(),
                onError: (e) => toast("Could not close it", { detail: describeError(e), tone: "error" }),
              },
            )
          }
        >
          Close
        </Button>
      ) : (
        <Button
          size="sm"
          variant={justClosed ? "primary" : "secondary"}
          aria-label={`Reopen: ${thread.text}`}
          disabled={busy}
          onClick={() =>
            reopen.mutate(
              { id: thread.id },
              { onError: (e) => toast("Could not reopen it", { detail: describeError(e), tone: "error" }) },
            )
          }
        >
          {justClosed ? "Undo" : "Reopen"}
        </Button>
      )}
    </li>
  );
}

/** Open threads per project, what finished tasks left to do. Closed ones on request. */
export function ThreadsView() {
  const threads = useThreads();
  const [showClosed, setShowClosed] = useState(false);
  // Threads closed on this visit stay in place with Undo until the page is left.
  const [closedHere, setClosedHere] = useState<ReadonlySet<number>>(new Set());
  const all = useMemo(() => threads.data ?? [], [threads.data]);
  const onClosed = (id: number) => setClosedHere((prev) => new Set([...prev, id]));

  const groups = useMemo(() => {
    const byProject = new Map<string, Thread[]>();
    for (const t of all) {
      const stays = t.status === "open" || closedHere.has(t.id);
      if (!stays) continue;
      const key = t.project ?? NO_PROJECT;
      byProject.set(key, [...(byProject.get(key) ?? []), t]);
    }
    return [...byProject.entries()].sort(([a], [b]) =>
      a === NO_PROJECT ? 1 : b === NO_PROJECT ? -1 : a.localeCompare(b),
    );
  }, [all, closedHere]);
  const closed = all.filter((t) => t.status === "closed" && !closedHere.has(t.id));

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-base text-fg-muted text-pretty">
        What finished tasks left to do: loose ends, follow-ups and known issues. A thread closes when a later
        task does it or its follow-up task is done.
      </p>
      {threads.isError && <p className="m-0 text-base text-red">{describeError(threads.error)}</p>}
      {threads.isPending && <Skeleton className="h-32 w-full rounded-xl" />}
      {threads.data !== undefined && groups.length === 0 && (
        <p className="m-0 text-base text-fg-muted text-pretty">Nothing is left open.</p>
      )}
      {groups.map(([project, list]) => {
        const count = list.filter((t) => t.status === "open").length;
        return (
          <section key={project} aria-label={project || "No project"} className="flex flex-col gap-2">
            <h2 className="m-0 flex min-w-0 items-baseline gap-2 text-md font-semibold">
              <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{project || "No project"}</span>
              <span className="font-mono text-xs font-normal text-fg-faint tabular-nums">{count}</span>
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {list.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  justClosed={t.status === "closed"}
                  onClosed={() => onClosed(t.id)}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {closed.length > 0 && (
        <section aria-label="Closed threads" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <SectionLabel>Closed</SectionLabel>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showClosed}
              onClick={() => setShowClosed(!showClosed)}
            >
              {showClosed ? "Hide" : `Show ${closed.length}`}
            </Button>
          </div>
          {showClosed && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {closed.map((t) => (
                <ThreadRow key={t.id} thread={t} showProject />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
