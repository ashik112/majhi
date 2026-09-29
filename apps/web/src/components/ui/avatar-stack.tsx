import type { Role } from "@majhi/shared";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/cn";

/** A row of agent avatars, 2 px apart like the board cards. `working` ids get the pulsing ring. */
export function AvatarStack({
  ids,
  working = [],
  roles,
  size = 20,
  max = 5,
  className,
}: {
  ids: readonly string[];
  working?: readonly string[];
  roles?: ReadonlyMap<string, Role> | undefined;
  size?: number;
  /** More than this many collapse into a "+N". */
  max?: number;
  className?: string;
}) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={cn("flex items-center gap-0.5", className)}>
      {shown.map((id) => (
        <AgentAvatar key={id} id={id} role={roles?.get(id)} size={size} working={working.includes(id)} />
      ))}
      {rest > 0 && <span className="tnum ml-1 text-xs text-fg-faint">+{rest}</span>}
    </span>
  );
}
