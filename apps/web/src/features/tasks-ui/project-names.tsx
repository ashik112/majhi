import { OrgBadge } from "@/components/ui/org-badge";
import { cn } from "@/lib/cn";

/** A workspace as its colored tile and name. */
export interface OrgTag {
  name: string;
  letters: string;
  color: string | undefined;
}

/** Projects shown before "+N". */
const SHOWN = 2;

/**
 * Where a task lives: the workspace's tile, then its project ids, two at most and "+N" for the rest.
 * Every project is in the title. The tile is decorative, so a screen that has no room for the
 * workspace's name still tells the workspaces apart by color.
 */
export function ProjectNames({
  org,
  projects,
  tile = true,
  className,
}: {
  org: OrgTag | undefined;
  projects: readonly string[];
  /** Leave the tile out where the workspace's name is drawn next to the names. */
  tile?: boolean;
  className?: string;
}) {
  const shown = projects.slice(0, SHOWN);
  const more = projects.length - shown.length;
  const title = [org?.name, projects.join(", ")].filter((p) => p !== undefined && p !== "").join(": ");
  return (
    <span title={title} className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {tile && org !== undefined && <OrgBadge label={org.letters} color={org.color} size="xs" />}
      {projects.length > 0 && (
        <span data-clip="" className="min-w-0 truncate font-mono text-xs text-fg-soft">
          {shown.join(", ")}
        </span>
      )}
      {more > 0 && <span className="shrink-0 font-mono text-xs text-fg-faint">+{more}</span>}
    </span>
  );
}
