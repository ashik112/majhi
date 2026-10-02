import type { TaskPriority } from "@majhi/shared";
import { ArrowDown, ArrowUp, CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { type DueInfo, PRIORITY_LABEL } from "./schedule";

/** High in the caution tone so it reads at a glance; low stays quiet. Normal shows nothing. */
export function PriorityChip({
  priority,
  compact = false,
  className,
}: {
  priority: TaskPriority;
  /** Only the arrow, for tight rows; the word is in the tooltip and for screen readers. */
  compact?: boolean;
  className?: string;
}) {
  if (priority === "normal") return null;
  const high = priority === "high";
  return (
    <Badge
      tone={high ? "amber" : "neutral"}
      title={`${PRIORITY_LABEL[priority]} priority`}
      className={cn(
        "h-[18px] gap-0.5",
        compact ? "w-[18px] justify-center px-0" : "pr-1.5 pl-1",
        !high && "text-fg-faint",
        className,
      )}
    >
      {high ? <ArrowUp aria-hidden="true" strokeWidth={2.5} /> : <ArrowDown aria-hidden="true" />}
      <span className={compact ? "sr-only" : undefined}>{PRIORITY_LABEL[priority]}</span>
      <span className="sr-only"> priority</span>
    </Badge>
  );
}

const DUE_TONE = { late: "red", soon: "amber", later: "neutral" } as const;

/** Overdue in red, today and tomorrow in the caution tone, later days plain. */
export function DueChip({
  due,
  short = false,
  className,
}: {
  due: DueInfo;
  /** "Overdue 2d", "Today", "Oct 9", for tight rows. */
  short?: boolean;
  className?: string;
}) {
  return (
    <Badge
      tone={DUE_TONE[due.tone]}
      title={short ? due.text : undefined}
      className={cn("h-[18px] gap-1 pr-1.5 pl-1", className)}
    >
      <CalendarDays aria-hidden="true" />
      {short ? due.short : due.text}
    </Badge>
  );
}
