import type { AgentLive, RoomItem } from "@majhi/shared";
import { Brain, ChevronRight, ListChecks, Paperclip, ShieldQuestion } from "lucide-react";
import { memo, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { TaskRefText } from "@/features/task-drawer/task-ref";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { ApprovalCard, SecretRequestCard } from "./approval-card";
import { Markdown } from "./markdown";
import { MediaView, TaskFileLink, type TaskFiles } from "./media";
import { contextLine, permissionOptionLabel, permissionSummary, toolLabel } from "./model";
import { ToolRow } from "./tool-row";

export function permissionDomId(itemId: string): string {
  return `perm-${itemId}`;
}

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

export interface ItemContext {
  agents: readonly AgentLive[];
  /** Ids of plan items shown pinned at the top, which the timeline skips. */
  pinned: ReadonlySet<string>;
  onPermission: (item: string, option: string) => void;
  answering: string | undefined;
  /** The task, so agent text can link to its files. */
  task: TaskFiles;
}

/** One room item. Wrapped so a long room paints only what is on screen. */
export const RoomItemView = memo(function RoomItemView({ item, ctx }: { item: RoomItem; ctx: ItemContext }) {
  if (item.type === "plan" && ctx.pinned.has(item.id)) return null;
  return (
    <li className="animate-fade-in list-none [contain-intrinsic-size:auto_64px] [content-visibility:auto]">
      <ItemBody item={item} ctx={ctx} />
    </li>
  );
});

function ItemBody({ item, ctx }: { item: RoomItem; ctx: ItemContext }) {
  switch (item.type) {
    case "owner":
      return <OwnerMessage item={item} />;
    case "agent":
      return (
        <AgentMessage item={item} live={ctx.agents.find((a) => a.agent === item.agent)} task={ctx.task} />
      );
    case "thought":
      return <Thought item={item} />;
    case "tool":
      return <ToolRow item={item} folder={ctx.task.folder} />;
    case "plan":
      return <PlanSummary item={item} />;
    case "permission":
      return <Permission item={item} onAnswer={ctx.onPermission} busy={ctx.answering === item.id} />;
    case "approval":
      return <ApprovalCard item={item} />;
    case "secret-request":
      return <SecretRequestCard item={item} />;
    case "system":
      return <SystemLine item={item} />;
    case "context":
      return <ContextLine item={item} />;
  }
}

/** A compaction, as one quiet line, with the handoff note when there is one. */
function ContextLine({ item }: { item: Of<"context"> }) {
  return (
    <div className="flex justify-center">
      <span className="flex max-w-[640px] items-baseline gap-2 font-mono text-xs text-fg-faint">
        <span className="break-words">{contextLine(item)}</span>
        {item.note && <TaskFileLink path={item.note} kind="markdown" label="note" />}
      </span>
    </div>
  );
}

function OwnerMessage({ item }: { item: Of<"owner"> }) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[700px] gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-fg text-[11px] font-semibold text-canvas"
        >
          Y
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline gap-2 font-mono">
            <span className="text-base font-semibold">you</span>
            {item.queued && (
              <span className="text-xs text-fg-faint">Queued, waits for the agent's next turn</span>
            )}
          </div>
          <div
            className={cn(
              "rounded-lg bg-blue-wash px-3 py-2.5 text-body leading-normal whitespace-pre-wrap break-words text-fg-soft",
              item.queued && "opacity-70",
            )}
          >
            <TaskRefText text={item.text} />
          </div>
          {item.attachments.length > 0 && (
            <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
              {item.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex h-6 items-center gap-1 rounded-sm border border-line-strong px-1.5 font-mono text-xs text-fg-muted"
                >
                  <Paperclip aria-hidden="true" className="size-3" />
                  {a.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentMessage({
  item,
  live,
  task,
}: {
  item: Of<"agent">;
  live: AgentLive | undefined;
  task: TaskFiles;
}) {
  const info = useAgentIndex().get(item.agent);
  const meta = [info?.account, live?.model ?? info?.model].filter(Boolean).join(" · ");
  return (
    <div className="flex max-w-[700px] gap-2.5">
      <AgentAvatar id={item.agent} size={28} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-2 font-mono">
          <span className="text-base font-semibold">@{item.agent}</span>
          {meta && <span className="text-xs text-fg-faint">{meta}</span>}
        </div>
        {item.text !== "" && (
          <div className="min-w-0 rounded-lg bg-raised px-3 py-2.5 text-body leading-normal text-[#e2e4e8]">
            <Markdown text={item.text} task={task} />
          </div>
        )}
        {item.media !== undefined && item.media.length > 0 && (
          <ul aria-label="Attached media" className="m-0 flex list-none flex-col items-start gap-2 p-0">
            {item.media.map((m) => (
              <li key={`${m.kind}:${m.src}`} className="max-w-full">
                <MediaView media={m} onLoad={task.onLoad} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Thought({ item }: { item: Of<"thought"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-[38px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm text-fg-faint hover:text-fg-muted"
      >
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-90")} />
        <Brain aria-hidden="true" className="size-3.5" />
        Thinking
      </button>
      {open && (
        <p className="mt-1 border-l-2 border-line-strong pl-3 text-base whitespace-pre-wrap break-words text-fg-muted">
          <TaskRefText text={item.text} />
        </p>
      )}
    </div>
  );
}

function PlanSummary({ item }: { item: Of<"plan"> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  return (
    <details className="pl-[38px] text-sm text-fg-faint">
      <summary className="flex cursor-pointer items-center gap-1.5 hover:text-fg-muted">
        <ListChecks aria-hidden="true" className="size-3.5" />
        Plan, {done} of {item.entries.length} done
      </summary>
      <PlanList entries={item.entries} />
    </details>
  );
}

function PlanList({ entries }: { entries: Of<"plan">["entries"] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: plan entries have no id and keep their order
        <li key={i} className="flex items-start gap-2 text-base">
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-xs border text-[9px] leading-none",
              entry.status === "completed" && "border-green-line bg-green-wash text-green",
              entry.status === "in_progress" && "border-amber-line bg-amber-wash text-amber",
              entry.status === "pending" && "border-line-control",
            )}
          >
            {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "•" : ""}
          </span>
          <span className={cn(entry.status === "completed" ? "text-fg-faint line-through" : "text-fg-soft")}>
            {entry.content}
            <span className="sr-only"> ({entry.status.replace("_", " ")})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The agent's plan as a checklist, pinned above the room while it has open entries. */
export function PinnedPlan({ plan }: { plan: Of<"plan"> }) {
  const done = plan.entries.filter((e) => e.status === "completed").length;
  return (
    <section
      aria-label={`Plan of ${plan.agent}`}
      className="rounded-lg border border-line-strong bg-card px-3 py-2.5"
    >
      <h3 className="flex items-center gap-2 text-xs font-normal tracking-[0.08em] text-fg-faint uppercase">
        <ListChecks aria-hidden="true" className="size-3.5" />
        Plan
        <span className="font-mono normal-case tracking-normal">
          {done} of {plan.entries.length}
        </span>
      </h3>
      <PlanList entries={plan.entries} />
    </section>
  );
}

function Permission({
  item,
  onAnswer,
  busy,
}: {
  item: Of<"permission">;
  onAnswer: (item: string, option: string) => void;
  busy: boolean;
}) {
  const summary = permissionSummary(item);
  if (!summary.pending) {
    return (
      <details className="group pl-[38px] text-sm text-fg-faint">
        <summary
          className={cn(
            "flex list-none items-center gap-2",
            summary.full ? "cursor-pointer hover:text-fg-muted" : "pointer-events-none",
          )}
        >
          <ShieldQuestion aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="shrink-0">{summary.verdict}</span>
          <code className="min-w-0 truncate font-mono text-xs">{summary.short}</code>
        </summary>
        {summary.full && (
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs whitespace-pre-wrap text-fg-soft">
            {summary.full}
          </pre>
        )}
      </details>
    );
  }
  return (
    <section
      id={permissionDomId(item.id)}
      tabIndex={-1}
      aria-label={`Permission: ${item.title}`}
      className="flex max-w-[700px] outline-none flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">
          <span className="text-fg-muted">{item.agent} asks to </span>
          <span className="text-sm">{toolLabel(item.title)}</span>
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {item.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind === "allow_once" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => onAnswer(item.id, option.id)}
          >
            {permissionOptionLabel(option)}
          </Button>
        ))}
      </div>
    </section>
  );
}

const SYSTEM_TONE = {
  info: "text-fg-faint border-line-strong",
  warn: "text-amber border-amber-line",
  error: "text-red border-red-line",
};

function SystemLine({ item }: { item: Of<"system"> }) {
  return (
    <div className="flex justify-center">
      <span
        role={item.level === "error" ? "alert" : undefined}
        className={cn(
          "max-w-[640px] rounded-full border px-2.5 py-0.5 text-center font-mono text-xs break-words",
          SYSTEM_TONE[item.level],
        )}
      >
        <TaskRefText text={item.text} />
      </span>
    </div>
  );
}
