import { avatarTone, initialOf } from "@/features/tasks/model";
import { cn } from "@/lib/cn";

/** A round initial in the agent's color. `working` adds a soft pulsing ring. */
export function AgentAvatar({
  id,
  working = false,
  size = 20,
  className,
}: {
  id: string;
  working?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={working ? `${id}, working` : id}
      title={id}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.45)) }}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-sunken",
        avatarTone(id),
        className,
      )}
    >
      {initialOf(id)}
      {working && (
        <span
          aria-hidden="true"
          className="absolute -inset-[3px] animate-shimmer rounded-full border-2 border-amber"
        />
      )}
    </span>
  );
}
