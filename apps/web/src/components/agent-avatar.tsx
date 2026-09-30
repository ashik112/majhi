import type { Role } from "@majhi/shared";
import { avatarTone, initialOf } from "@/features/tasks/model";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { Dot, type DotTone } from "./ui/status-dot";

/** Role colors of the design: Lead violet, Builder amber, Reviewer blue, Tester pink, Root green. */
export const ROLE_BG: Record<Role, string> = {
  Lead: "bg-violet",
  Builder: "bg-amber",
  Reviewer: "bg-blue",
  Tester: "bg-pink",
  Root: "bg-green",
};

/**
 * The one agent avatar: a round initial (the last word of the id) in the agent's role color, with an
 * optional state dot on its corner. The role comes from the agents list unless it is passed. `working`
 * adds a soft pulsing ring. `decorative` hides it from assistive tech when the id is written beside it.
 */
export function AgentAvatar({
  id,
  role,
  working = false,
  size = 20,
  dot,
  ring = "border-card",
  decorative = false,
  className,
}: {
  id: string;
  role?: Role | undefined;
  working?: boolean;
  size?: number;
  dot?: DotTone | undefined;
  /** Border class of the dot, matching what the avatar sits on. */
  ring?: string;
  decorative?: boolean;
  className?: string;
}) {
  const known = useAgentIndex().get(id)?.role;
  const shown = role ?? known;
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": working ? `${id}, working` : id, title: id } as const);
  return (
    <span
      {...a11y}
      style={{ width: size, height: size, fontSize: size <= 22 ? 10 : Math.round(size * 0.39) }}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-canvas",
        shown ? ROLE_BG[shown] : avatarTone(id),
        className,
      )}
    >
      {initialOf(id)}
      {working && (
        <span
          aria-hidden="true"
          className="absolute -inset-[3px] animate-shimmer rounded-full border-2 border-lamp-working"
        />
      )}
      {dot && (
        <Dot
          tone={dot}
          size={size >= 34 ? 12 : 10}
          className={cn("absolute -right-0.5 -bottom-0.5 border-2", ring)}
        />
      )}
    </span>
  );
}
