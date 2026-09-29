import type { RoomItem, ToolContent } from "@majhi/shared";
import {
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Globe,
  Loader2,
  MoveRight,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { type ComponentType, memo, useState } from "react";
import { cn } from "@/lib/cn";
import { DiffView } from "./diff-view";
import { hasToolDetail, toolTarget, trimOutput } from "./model";

type ToolItem = Extract<RoomItem, { type: "tool" }>;

const KIND_ICON: Record<string, ComponentType<{ className?: string; "aria-hidden"?: "true" }>> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
};

const STATUS_LABEL: Record<ToolItem["status"], string> = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

/** One tool call as a compact row: icon by kind, title, status and target. Expands to its output. */
export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[item.kind] ?? Wrench;
  const target = toolTarget(item);
  const expandable = hasToolDetail(item);
  const head = (
    <>
      {expandable ? (
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0 text-fg-faint transition-transform", open && "rotate-90")}
        />
      ) : (
        <span aria-hidden="true" className="size-3 shrink-0" />
      )}
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 shrink truncate text-fg-soft">{item.title}</span>
      {target && target !== item.title && (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint" title={target}>
          {target}
        </span>
      )}
      <StatusMark status={item.status} />
    </>
  );

  return (
    <div className="rounded-md border border-line bg-card/60">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-sm hover:bg-card"
        >
          {head}
        </button>
      ) : (
        <div className="flex h-8 items-center gap-2 px-2.5 text-sm">{head}</div>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          {item.content.map((content, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are positional and never reorder
            <ToolContentView key={i} content={content} />
          ))}
        </div>
      )}
    </div>
  );
});

function StatusMark({ status }: { status: ToolItem["status"] }) {
  const label = STATUS_LABEL[status];
  const cls = "size-3.5 shrink-0";
  return (
    <span className="ml-auto flex shrink-0 items-center" title={label}>
      <span className="sr-only">{label}</span>
      {status === "in_progress" ? (
        <Loader2 aria-hidden="true" className={cn(cls, "animate-spin text-amber")} />
      ) : status === "completed" ? (
        <Check aria-hidden="true" className={cn(cls, "text-green")} />
      ) : status === "failed" ? (
        <CircleAlert aria-hidden="true" className={cn(cls, "text-red")} />
      ) : (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-faint" />
      )}
    </span>
  );
}

function ToolContentView({ content }: { content: ToolContent }) {
  if (content.type === "diff") return <DiffView diff={content} />;
  if (content.type === "text") return <Output text={content.text} label="Output" />;
  return (
    <div className="flex flex-col gap-1">
      <Output text={content.output} label="Terminal output" />
      {content.exitCode !== undefined && (
        <span className={cn("font-mono text-xs", content.exitCode === 0 ? "text-fg-faint" : "text-red")}>
          exit {content.exitCode}
        </span>
      )}
    </div>
  );
}

function Output({ text, label }: { text: string; label: string }) {
  const [all, setAll] = useState(false);
  const trimmed = trimOutput(text, all ? Number.MAX_SAFE_INTEGER : 40);
  return (
    <div>
      <span className="sr-only">{label}</span>
      <pre className="m-0 max-h-[360px] overflow-auto rounded-md border border-line-strong bg-sunken p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-fg-muted">
        {trimmed.text}
      </pre>
      {trimmed.hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-xs text-fg-muted hover:text-fg"
        >
          Show {trimmed.hidden} more lines
        </button>
      )}
    </div>
  );
}
