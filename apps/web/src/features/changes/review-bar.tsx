import type { RoomItem, Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { formatReview, isAnchored } from "./model";
import { reviewStore, useReviewDraft } from "./review-store";

/**
 * Sticks to the bottom of the Changes view while a review has comments: the overall note, Discard
 * and Send review. Comments whose line has left the diff stay in the review and are listed here.
 */
export function ReviewBar({
  task,
  anchors,
  onSent,
}: {
  task: Task;
  /** Lines now in the diff, `undefined` while it loads or failed: then nothing counts as gone. */
  anchors: ReadonlyMap<string, string> | undefined;
  onSent: (item: RoomItem) => void;
}) {
  const toast = useToast();
  const draft = useReviewDraft(task.id);
  const [listed, setListed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const send = useMutation<{ item: RoomItem }, ApiRequestError, string>({
    mutationFn: (text) => cmd("room.send", { task: task.id, text, mode: "queue" }),
    onSuccess: ({ item }) => {
      onSent(item);
      reviewStore.clear(task.id);
      toast("Review sent");
    },
    onError: (error) => toast("Could not send the review", { detail: error.message, tone: "error" }),
  });

  const count = draft.comments.length;
  if (count === 0) return null;

  const gone = anchors ? draft.comments.filter((c) => !isAnchored(c, anchors)) : [];
  const shown = listed ? draft.comments : gone;

  return (
    <section
      aria-label="Review"
      className="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 rounded-xl border border-line-strong bg-glass-strong px-3 py-2.5 shadow-pop"
    >
      {shown.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {shown.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <span className="font-mono text-xs text-fg-soft">
                  {c.repo} · {c.path}:{c.kind === "del" ? `old ${c.line}` : c.line}
                </span>
                {anchors && !isAnchored(c, anchors) && (
                  <span className="ml-2 text-xs text-amber">No longer in the diff</span>
                )}
                <p className="truncate text-fg-muted" title={c.body}>
                  {c.body}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete comment on ${c.path} line ${c.line}`}
                onClick={() => reviewStore.remove(task.id, c.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={listed}
          onClick={() => setListed((v) => !v)}
          className="shrink-0 cursor-pointer text-sm font-semibold text-fg hover:underline"
        >
          {count} {count === 1 ? "comment" : "comments"}
        </button>
        {gone.length > 0 && (
          <span className="shrink-0 text-xs text-amber">{gone.length} not in the diff</span>
        )}
        <input
          value={draft.note}
          aria-label="Overall note for the review"
          placeholder="Overall note (optional)"
          onChange={(event) => reviewStore.setNote(task.id, event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-line-control bg-sunken px-2 text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent"
        />
        <Button size="sm" disabled={send.isPending} onClick={() => setConfirming(true)}>
          Discard
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={send.isPending}
          onClick={() => send.mutate(formatReview(draft.note, draft.comments))}
        >
          Send review
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Discard this review?"
          body={`The ${count === 1 ? "comment" : `${count} comments`}${draft.note.trim() === "" ? "" : " and the note"} will be deleted. This cannot be undone.`}
          confirmLabel="Discard"
          onConfirm={() => {
            reviewStore.clear(task.id);
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
