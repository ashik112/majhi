import type { Thread } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useCloseThread, useReopenThread } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";

/** Who closed a thread, in words, with the task as a link. */
export function ClosedBy({ thread }: { thread: Thread }) {
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
