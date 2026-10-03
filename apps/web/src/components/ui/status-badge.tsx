import type { PausedBy, TaskStatus } from "@majhi/shared";
import { statusInfo } from "@/features/tasks/model";
import { cn } from "@/lib/cn";
import { LAMP_TEXT, Lamp } from "./lamp";

/** A task's status as its lamp and words. Color adds, never carries, the meaning. */
export function StatusBadge({
  status,
  pausedReason,
  pausedBy,
  yourTurn = false,
  className,
}: {
  status: TaskStatus;
  pausedReason?: string | undefined;
  pausedBy?: PausedBy | undefined;
  /** Running, but no agent is working: the task waits for the owner. */
  yourTurn?: boolean;
  className?: string;
}) {
  const info = statusInfo(status, pausedReason, yourTurn, pausedBy);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-line-control bg-raised py-0.5 pr-2.5 pl-2 text-xs whitespace-nowrap",
        LAMP_TEXT[info.lamp],
        className,
      )}
    >
      <Lamp state={info.lamp} size={7} />
      {info.label}
    </span>
  );
}
