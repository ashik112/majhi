import { CircleAlert, Loader2, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PendingAttachment } from "@/lib/use-attachments";

/** Uploaded files as removable chips. A failed upload keeps its chip, with the reason. */
export function AttachmentChips({
  items,
  onRemove,
}: {
  items: readonly PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  const failed = items.filter((item) => item.state === "error" && item.error);
  return (
    <div className="flex flex-col gap-1.5">
      <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item.key}
            title={item.error}
            className={cn(
              "flex h-6 max-w-full items-center gap-1 rounded-sm border pr-0.5 pl-1.5 font-mono text-xs",
              item.state === "error" ? "border-red-line text-red" : "border-blue-line text-blue",
            )}
          >
            {item.state === "uploading" ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : item.state === "error" ? (
              <CircleAlert aria-hidden="true" className="size-3" />
            ) : (
              <Paperclip aria-hidden="true" className="size-3" />
            )}
            <span className="truncate">{item.name}</span>
            {item.state === "uploading" && <span className="sr-only">uploading</span>}
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              onClick={() => onRemove(item.key)}
              className="flex size-5 items-center justify-center rounded-xs hover:bg-raised"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 text-xs text-red text-pretty">
          {failed.map((item) => (
            <li key={item.key}>{item.error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Covers the drop target while a file is dragged over it. Ignores the mouse so the drop reaches the target. */
export function DropHint() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-glass-strong text-sm text-fg"
    >
      <Paperclip className="size-4" />
      Drop to attach
    </div>
  );
}
