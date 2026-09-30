import type { Thread } from "@majhi/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { TaskRef } from "@/features/task-drawer/task-ref";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useCloseThread, useReopenThread } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";
import { GLOBAL } from "./model";
import { ClosedBy } from "./threads-view";

/**
 * What finished tasks left open in this project, as a checklist: ticking one closes it, and it stays
 * in place with Undo until the page is left. Closed ones sit below, folded.
 */
export function ThreadsTab({
  target,
  threads,
}: {
  target: string;
  threads: UseQueryResult<Thread[], ApiRequestError>;
}) {
  // Threads closed on this visit stay in the open list, ticked, with Undo.
  const [closedHere, setClosedHere] = useState<ReadonlySet<number>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  const mine = useMemo(
    () => (threads.data ?? []).filter((t) => (t.project ?? GLOBAL) === target),
    [threads.data, target],
  );
  const open = mine.filter((t) => t.status === "open" || closedHere.has(t.id));
  const closed = mine.filter((t) => t.status === "closed" && !closedHere.has(t.id));
  const openCount = mine.filter((t) => t.status === "open").length;

  if (threads.isError) return <p className="pt-5 text-base text-red">{describeError(threads.error)}</p>;
  if (threads.isPending) return <Skeleton className="mt-5 h-32 rounded-lg" />;
  return (
    <>
      <DetailSection
        title="Open"
        note={openCount === 0 ? "Nothing is left open" : `${openCount} left by finished tasks`}
        className="border-t-0"
      >
        {open.length === 0 ? (
          <p className="text-base text-fg-muted text-pretty">
            A thread opens when a finished task leaves something to do, and closes when a later task does it
            or its follow-up is done.
          </p>
        ) : (
          <ul aria-label="Open threads" className="m-0 flex list-none flex-col p-0">
            {open.map((t) => (
              <ThreadItem
                key={t.id}
                thread={t}
                justClosed={t.status === "closed"}
                onClosed={() => setClosedHere((prev) => new Set([...prev, t.id]))}
              />
            ))}
          </ul>
        )}
      </DetailSection>
      {closed.length > 0 && (
        <DetailSection
          title="Closed"
          note={`${closed.length}`}
          actions={
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showClosed}
              onClick={() => setShowClosed(!showClosed)}
            >
              {showClosed ? "Hide" : "Show"}
            </Button>
          }
        >
          {showClosed && (
            <ul aria-label="Closed threads" className="m-0 flex list-none flex-col p-0">
              {closed.map((t) => (
                <ThreadItem key={t.id} thread={t} />
              ))}
            </ul>
          )}
        </DetailSection>
      )}
    </>
  );
}

/** One thread with its tick box. Ticking closes it; unticking a closed one reopens it. */
function ThreadItem({
  thread,
  justClosed = false,
  onClosed,
}: {
  thread: Thread;
  justClosed?: boolean;
  onClosed?: () => void;
}) {
  const close = useCloseThread();
  const reopen = useReopenThread();
  const toast = useToast();
  const now = useNow(60_000);
  const done = thread.status === "closed";
  const busy = close.isPending || reopen.isPending;
  const toggle = () => {
    if (!done)
      close.mutate(
        { id: thread.id },
        {
          onSuccess: () => onClosed?.(),
          onError: (e) => toast("Could not close it", { detail: describeError(e), tone: "error" }),
        },
      );
    else
      reopen.mutate(
        { id: thread.id },
        { onError: (e) => toast("Could not reopen it", { detail: describeError(e), tone: "error" }) },
      );
  };
  return (
    <li className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0">
      <span className="relative mt-px flex size-[18px] shrink-0">
        <input
          type="checkbox"
          checked={done}
          disabled={busy}
          onChange={toggle}
          aria-label={`${done ? "Reopen" : "Close"}: ${thread.text}`}
          className="peer size-[18px] cursor-pointer appearance-none rounded-[5px] border border-line-bright bg-field transition-colors duration-150 checked:border-green-line checked:bg-green-wash hover:border-line-hover disabled:cursor-default disabled:opacity-50"
        />
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className="pointer-events-none absolute inset-0 m-auto size-3 text-green opacity-0 peer-checked:opacity-100"
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className={cn(
            "text-base text-pretty [overflow-wrap:anywhere]",
            done ? "text-fg-muted line-through decoration-fg-faint" : "text-fg",
          )}
        >
          {thread.text}
        </p>
        <p className="flex flex-wrap gap-x-1.5 text-xs text-fg-faint">
          <span>
            From <TaskRef id={thread.task} />
          </span>
          {thread.follow_up !== undefined && (
            <span>
              · Follow-up <TaskRef id={thread.follow_up} />
            </span>
          )}
          <span>· {formatAgo(thread.created_at, now)}</span>
          {done && (
            <span>
              · <ClosedBy thread={thread} />
            </span>
          )}
        </p>
        {done && thread.closed_reason !== undefined && (
          <p className="text-sm text-fg-muted text-pretty">{thread.closed_reason}</p>
        )}
      </div>
      {justClosed && done && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={toggle}>
          Undo
        </Button>
      )}
    </li>
  );
}
