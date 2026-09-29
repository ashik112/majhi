import { Link } from "@tanstack/react-router";
import type { OkAgent } from "@/features/agents/model";
import { cn } from "@/lib/cn";
import { chipSplit } from "./used-by-model";

/** Agent chips linking to their editor: three at most, then "+N". "Not used" when empty. */
export function UsedByChips({ agents }: { agents: readonly OkAgent[] }) {
  if (agents.length === 0) return <span className="text-fg-faint">Not used</span>;
  const { shown, more } = chipSplit(agents);
  return (
    <ul aria-label="Used by" className="flex flex-wrap items-center gap-1">
      {shown.map((a) => (
        <li key={a.agent.frontmatter.id}>
          <AgentChip agent={a} />
        </li>
      ))}
      {more > 0 && (
        <li
          className="text-sm text-fg-faint"
          title={agents
            .slice(3)
            .map((a) => a.agent.frontmatter.id)
            .join(", ")}
        >
          +{more}
        </li>
      )}
    </ul>
  );
}

export function AgentChip({ agent, className }: { agent: OkAgent; className?: string }) {
  const id = agent.agent.frontmatter.id;
  return (
    <Link
      to="/studio/$tab"
      params={{ tab: "agents" }}
      search={{ agent: id }}
      className={cn(
        "inline-flex h-5 max-w-[150px] items-center gap-1 rounded-sm border px-1.5 font-mono text-xs hover:border-line-hover",
        agent.isBoss ? "border-amber-line bg-amber-wash text-amber" : "border-line-strong text-fg-muted",
        className,
      )}
      aria-label={agent.isBoss ? `${id}, boss` : id}
    >
      <span className="truncate">@{id}</span>
      {agent.isBoss && <span aria-hidden="true">boss</span>}
    </Link>
  );
}
