import type { AccountView, HealthCheck } from "@majhi/shared";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import { type AgentGroup, agentDot, entryId } from "./model";

/** Agents grouped by scope, each with a status dot. Selecting one opens it in the editor. */
export function AgentList({
  groups,
  accounts,
  health,
  selected,
  onSelect,
  onNew,
}: {
  groups: AgentGroup[];
  accounts: readonly AccountView[];
  health: ReadonlyMap<string, HealthCheck>;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onNew: (scope: string) => void;
}) {
  return (
    <nav
      aria-label="Agents"
      className="flex w-[280px] shrink-0 flex-col gap-1 overflow-auto border-r border-line-strong p-3"
    >
      {groups.map((group) => (
        <section key={group.scope} aria-label={group.label} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 px-2 pt-3 pb-1.5 text-xs tracking-[0.08em] text-fg-faint uppercase">
            {group.color && (
              <span
                aria-hidden="true"
                className="size-2 rounded-xs"
                style={{ backgroundColor: group.color }}
              />
            )}
            <h3 className="font-normal">{group.label}</h3>
            {group.canAdd && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-1.5 text-xs tracking-normal normal-case"
                aria-label={`New agent in ${group.label}`}
                onClick={() => onNew(group.scope)}
              >
                <Plus aria-hidden="true" />
                New
              </Button>
            )}
          </div>
          {group.entries.length === 0 && <p className="px-2 pb-1 text-sm text-fg-faint">No agents</p>}
          {group.entries.map((entry) => {
            const id = entryId(entry);
            const dot = agentDot(entry, accounts, health.get(id));
            const boss = entry.status === "ok" && entry.isBoss;
            return (
              <button
                key={id}
                type="button"
                aria-current={selected === id ? "true" : undefined}
                onClick={() => onSelect(id)}
                className={cn(
                  "flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised",
                  selected === id && "bg-selected",
                )}
              >
                <StatusDot tone={dot.tone} />
                <span className="sr-only">{dot.label}. </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-base">@{id}</span>
                  <span className="truncate text-sm text-fg-faint">
                    {entry.status === "ok"
                      ? `${entry.agent.frontmatter.role} on ${entry.agent.frontmatter.account}`
                      : "Has errors"}
                  </span>
                </span>
                {boss && <Badge tone="amber">Boss</Badge>}
              </button>
            );
          })}
        </section>
      ))}
    </nav>
  );
}
