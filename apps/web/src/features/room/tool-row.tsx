import { PAGE_PATH, type RoomItem, type ToolContent } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
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
import { hasToolDetail, isQuietTool, oneLine, shortPath, toolLabel, toolTarget, trimOutput } from "./model";

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
export const ToolRow = memo(function ToolRow({ item, folder }: { item: ToolItem; folder: string }) {
  const [open, setOpen] = useState(false);
  if (isQuietTool(item.title)) {
    return (
      <p className="flex h-6 items-center gap-1.5 pl-[34px] text-sm text-fg-faint">
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        {toolLabel(item.title)}
      </p>
    );
  }
  const Icon = item.skill === undefined ? (KIND_ICON[item.kind] ?? Wrench) : BookOpen;
  const full = toolTarget(item);
  const target = full === undefined ? undefined : shortPath(full, folder);
  // A skill line holds a link, so it is not also a button.
  const expandable = item.skill === undefined && hasToolDetail(item);
  const head = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
      {item.skill === undefined ? (
        <span className="min-w-0 shrink truncate text-fg-muted" title={item.title}>
          {oneLine(toolLabel(item.title))}
        </span>
      ) : (
        <span className="min-w-0 shrink truncate text-fg-muted">
          Used skill:{" "}
          <Link
            to={PAGE_PATH.skills}
            search={{ skill: item.skill }}
            title={`Open ${item.skill} on the Skills page`}
            className="font-mono text-xs text-blue hover:underline"
          >
            {item.skill}
          </Link>
        </span>
      )}
      {item.skill === undefined && target && target !== item.title && (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint" title={full}>
          {target}
        </span>
      )}
      {expandable && (
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-fg-faint opacity-0 transition group-hover/tool:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      )}
      <StatusMark status={item.status} />
    </>
  );
  const row =
    "-ml-1.5 flex h-6 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-sm";

  // A compact row at the gutter, like a line in a log; its output opens underneath.
  return (
    <div className="group/tool pl-[34px]">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(row, "cursor-pointer text-left hover:bg-raised")}
        >
          {head}
        </button>
      ) : (
        <div className={row}>{head}</div>
      )}
      {open && (
        <div className="mt-1 mb-1.5 ml-5 flex flex-col gap-2">
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
        <Check aria-hidden="true" className={cn(cls, "text-fg-dim")} />
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
