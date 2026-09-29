import type { AccountView, AgentEntry, HealthCheck } from "@majhi/shared";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/cn";
import { type AgentGroup, type AgentState, agentDot, agentSubline, entryId } from "./model";

/** The agents of one scope. Each shows its role color, its state on a dot and where it runs. */
export function AgentList({
  group,
  accounts,
  health,
  states,
  selected,
  onSelect,
  onNew,
}: {
  group: AgentGroup;
  accounts: readonly AccountView[];
  health: ReadonlyMap<string, HealthCheck>;
  states: ReadonlyMap<string, AgentState>;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onNew: (scope: string) => void;
}) {
  return (
    <nav
      aria-label="Agents in scope"
      className="flex w-[278px] shrink-0 flex-col gap-1 overflow-auto border-r border-line-strong px-3.5 py-4"
    >
      {group.entries.map((entry) => {
        const id = entryId(entry);
        return (
          <Row
            key={id}
            entry={entry}
            selected={selected === id}
            tone={rowTone(entry, accounts, health.get(id), states.get(id))}
            onSelect={() => onSelect(id)}
          />
        );
      })}
      {group.entries.length === 0 && (
        <p className="px-2.5 py-2 text-sm text-fg-faint">No agents in {group.label} yet.</p>
      )}
      {group.canAdd && (
        <button
          type="button"
          aria-label={`New agent in ${group.label}`}
          onClick={() => onNew(group.scope)}
          className="mt-1.5 h-9 cursor-pointer rounded-lg border border-dashed border-line-hover text-sm text-fg-soft transition-colors hover:border-fg-faint hover:bg-raised hover:text-fg"
        >
          + New agent in {group.label}
        </button>
      )}
    </nav>
  );
}

function rowTone(
  entry: AgentEntry,
  accounts: readonly AccountView[],
  health: HealthCheck | undefined,
  state: AgentState | undefined,
) {
  if (state && state.kind !== "idle") return state.tone;
  const dot = agentDot(entry, accounts, health);
  return dot.tone;
}

function Row({
  entry,
  selected,
  tone,
  onSelect,
}: {
  entry: AgentEntry;
  selected: boolean;
  tone: "green" | "amber" | "red" | "neutral" | "coral";
  onSelect: () => void;
}) {
  const id = entryId(entry);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150",
        selected ? "bg-[#272a31]" : "hover:bg-raised",
      )}
    >
      {entry.status === "ok" ? (
        <AgentAvatar
          id={id}
          role={entry.agent.frontmatter.role}
          dot={tone === "green" ? "neutral" : tone}
          decorative
          ring="border-canvas"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-red-wash font-mono text-sm font-semibold text-red"
        >
          !
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-sm font-medium">@{id}</span>
        <span className="truncate text-xs text-fg-faint">
          {entry.status === "ok" ? agentSubline(entry.agent) : "Has errors, open to see them"}
        </span>
      </span>
    </button>
  );
}
