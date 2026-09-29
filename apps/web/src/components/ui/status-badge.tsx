import type { TaskStatus } from "@majhi/shared";
import { statusInfo } from "@/features/tasks/model";
import { cn } from "@/lib/cn";

export const TONE_CLASS = {
  amber: "text-amber",
  blue: "text-blue",
  green: "text-green",
  violet: "text-violet",
  coral: "text-coral",
  neutral: "text-fg-muted",
} as const;

/** A task's status as words. Color adds, never carries, the meaning. */
export function StatusBadge({
  status,
  pausedReason,
}: {
  status: TaskStatus;
  pausedReason?: string | undefined;
}) {
  const info = statusInfo(status, pausedReason);
  return (
    <span
      className={cn(
        "rounded-full border border-line-control px-2.5 py-0.5 text-xs whitespace-nowrap",
        TONE_CLASS[info.tone],
      )}
    >
      {info.label}
    </span>
  );
}
