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
  return (
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
          {item.error && <span className="sr-only">{item.error}</span>}
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
  );
}
