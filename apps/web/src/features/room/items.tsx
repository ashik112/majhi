import type { AgentLive, RoomItem } from "@majhi/shared";
import { Brain, ChevronRight, ListChecks, Paperclip, ShieldQuestion } from "lucide-react";
import { memo, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { permissionSummary } from "./model";
import { ToolRow } from "./tool-row";

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

export interface ItemContext {
  agents: readonly AgentLive[];
  /** Ids of plan items shown pinned at the top, which the timeline skips. */
  pinned: ReadonlySet<string>;
  onPermission: (item: string, option: string) => void;
  answering: string | undefined;
}

/** One room item. Wrapped so a long room paints only what is on screen. */
export const RoomItemView = memo(function RoomItemView({ item, ctx }: { item: RoomItem; ctx: ItemContext }) {
  if (item.type === "plan" && ctx.pinned.has(item.id)) return null;
  return (
    <li className="list-none [contain-intrinsic-size:auto_64px] [content-visibility:auto]">
      <ItemBody item={item} ctx={ctx} />
    </li>
  );
});

function ItemBody({ item, ctx }: { item: RoomItem; ctx: ItemContext }) {
  switch (item.type) {
    case "owner":
      return <OwnerMessage item={item} />;
    case "agent":
      return <AgentMessage item={item} live={ctx.agents.find((a) => a.agent === item.agent)} />;
    case "thought":
      return <Thought item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanSummary item={item} />;
    case "permission":
      return <Permission item={item} onAnswer={ctx.onPermission} busy={ctx.answering === item.id} />;
    case "system":
      return <SystemLine item={item} />;
  }
}

function OwnerMessage({ item }: { item: Of<"owner"> }) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[640px] flex-col items-end gap-1">
        <div
          className={cn(
            "rounded-lg bg-selected px-3 py-2 text-md whitespace-pre-wrap break-words text-fg",
            item.queued && "opacity-70",
          )}
        >
          {item.text}
        </div>
        {item.attachments.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-1.5">
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
        <span className="text-xs text-fg-faint">
          {item.queued ? "Queued, waits for the agent's next turn" : "You"}
        </span>
      </div>
    </div>
  );
}

function AgentMessage({ item, live }: { item: Of<"agent">; live: AgentLive | undefined }) {
  return (
    <div className="flex max-w-[720px] gap-2.5">
      <AgentAvatar id={item.agent} size={26} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-2 font-mono">
          <span className="text-sm font-semibold">{item.agent}</span>
          {live?.model && <span className="text-xs text-fg-faint">{live.model}</span>}
        </div>
        <div className="text-md whitespace-pre-wrap break-words text-fg-soft">{item.text}</div>
      </div>
    </div>
  );
}

function Thought({ item }: { item: Of<"thought"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-9">
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
          {item.text}
        </p>
      )}
    </div>
  );
}

function PlanSummary({ item }: { item: Of<"plan"> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  return (
    <details className="pl-9 text-sm text-fg-faint">
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
      className="rounded-md border border-line-strong bg-card px-3 py-2.5"
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
      <p className="flex items-center gap-2 pl-9 text-sm text-fg-faint">
        <ShieldQuestion aria-hidden="true" className="size-3.5" />
        {summary.text}
      </p>
    );
  }
  return (
    <section
      aria-label={`Permission: ${item.title}`}
      className="flex max-w-[720px] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">
          <span className="text-fg-muted">{item.agent} asks to </span>
          <span className="font-mono text-sm">{item.title}</span>
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
            {option.name}
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
        {item.text}
      </span>
    </div>
  );
}
