import * as m from "motion/react-m";
import { OrgBadge } from "@/components/ui/org-badge";
import { cn } from "@/lib/cn";
import { type AgentGroup, INVALID_GROUP, scopeBadge } from "./model";

/** One tab per scope: Root, each org, and any group of files with errors. */
export function ScopeTabs({
  groups,
  active,
  onPick,
}: {
  groups: readonly AgentGroup[];
  active: string;
  onPick: (scope: string) => void;
}) {
  return (
    <div role="tablist" aria-label="Agent scope" className="flex gap-1">
      {groups.map((group) => {
        const selected = group.scope === active;
        return (
          <button
            key={group.scope}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onPick(group.scope)}
            className={cn(
              "relative flex h-11 cursor-pointer items-center gap-2 px-3.5 text-base font-medium transition-colors duration-150",
              selected ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {group.scope === INVALID_GROUP ? (
              <span
                aria-hidden="true"
                className="flex size-[18px] items-center justify-center rounded-[5px] bg-red font-mono text-[0.5rem] font-semibold text-sunken"
              >
                !
              </span>
            ) : (
              <OrgBadge
                label={scopeBadge(group.scope, group.label)}
                color={group.scope === "root" ? "#7fd1b9" : group.color}
                size="xs"
              />
            )}
            {group.label}
            <span className="font-mono text-xs text-fg-faint tabular-nums">{group.entries.length}</span>
            {selected && (
              <m.span
                layoutId="agent-scope-underline"
                aria-hidden="true"
                className="absolute inset-x-0 -bottom-px h-0.5 bg-accent"
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
