import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ReviewComment } from "./model";

/** A textarea under a diff line. Cmd/Ctrl+Enter saves, Esc cancels. */
export function CommentEditor({
  label,
  initial = "",
  onSave,
  onCancel,
}: {
  label: string;
  initial?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const canSave = body.trim() !== "";

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) onSave(body.trim());
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-strong bg-card p-2">
      <textarea
        ref={field}
        rows={3}
        value={body}
        aria-label={label}
        placeholder="Leave a comment for the agent"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-[68px] w-full resize-y rounded-md border border-line-control bg-sunken px-2 py-1.5 font-sans text-base text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-fg-faint">Cmd/Ctrl+Enter saves, Esc cancels</span>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!canSave} onClick={() => onSave(body.trim())}>
          Save comment
        </Button>
      </div>
    </div>
  );
}

/** A saved comment, with Edit and Delete. */
export function CommentItem({
  comment,
  onEdit,
  onDelete,
}: {
  comment: ReviewComment;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      aria-label={`Comment on line ${comment.line}`}
      className="flex items-start gap-2 rounded-md border border-line-strong bg-card px-2.5 py-1.5"
    >
      <p className="min-w-0 flex-1 font-sans text-base whitespace-pre-wrap text-fg text-pretty">
        {comment.body}
      </p>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete}>
        Delete
      </Button>
    </article>
  );
}
