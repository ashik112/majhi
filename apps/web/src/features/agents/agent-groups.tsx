import type { AgentEntry, OrgView } from "@majhi/shared";
import { FileWarning, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import type { RosterRow } from "@/features/board/roster";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { type AgentGroup, entryId, INVALID_GROUP, ROOT_SCOPE, scopeBadge } from "./model";

/** Root first, then each org: a head with the org's badge and a New agent button, then its agents. */
export function AgentGroups({
  groups,
  orgs,
  lamps,
  selected,
  creating,
  onSelect,
  onNew,
}: {
  groups: readonly AgentGroup[];
  orgs: readonly OrgView[];
  lamps: ReadonlyMap<string, RosterRow>;
  selected: string | undefined;
  /** The scope a new agent is being made in, to mark its New button. */
  creating: string | undefined;
  onSelect: (id: string) => void;
  onNew: (scope: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const org = orgs.find((o) => o.id === group.scope);
        return (
          <section key={group.scope} aria-label={group.label} className="flex flex-col gap-px">
            <div className="flex h-8 items-center gap-2 pr-0.5 pl-2">
              <GroupBadge group={group} orgKey={org?.key} />
              <h2 className="min-w-0 truncate text-sm font-medium text-fg-soft">{group.label}</h2>
              <span className="tnum font-mono text-xs text-fg-faint">{group.entries.length}</span>
              {group.canAdd && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`New agent in ${group.label}`}
                  aria-pressed={creating === group.scope}
                  title={`New agent in ${group.label}`}
                  className={cn("ml-auto", creating === group.scope && "bg-selected text-fg")}
                  onClick={() => onNew(group.scope)}
                >
                  <Plus aria-hidden="true" />
                </Button>
              )}
            </div>
            {group.entries.length === 0 ? (
              <p className="px-2 pb-1 text-sm text-fg-faint">No agents yet.</p>
            ) : (
              <ul className="flex flex-col gap-px">
                {group.entries.map((entry) => (
                  <li key={entryId(entry)}>
                    <AgentRow
                      entry={entry}
                      lamp={lamps.get(entryId(entry))}
                      selected={selected === entryId(entry)}
                      onSelect={() => onSelect(entryId(entry))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function GroupBadge({ group, orgKey }: { group: AgentGroup; orgKey: string | undefined }) {
  if (group.scope === INVALID_GROUP) {
    return <FileWarning aria-hidden="true" className="size-[18px] shrink-0 text-red" />;
  }
  return (
    <OrgBadge
      label={orgKey ? badgeLetters(orgKey) : scopeBadge(group.scope, group.label)}
      color={group.scope === ROOT_SCOPE ? "var(--c-green)" : group.color}
      size="xs"
    />
  );
}

/** Two lines: the handle and role, then the lamp with its state word and the account. */
function AgentRow({
  entry,
  lamp,
  selected,
  onSelect,
}: {
  entry: AgentEntry;
  lamp: RosterRow | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const id = entryId(entry);
  const state = lamp?.lamp ?? "idle";
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        ROW,
        "min-h-[46px] flex-col justify-center gap-0.5 px-2.5 py-1.5",
        selected && ROW_SELECTED,
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn("min-w-0 truncate font-mono text-sm", selected ? "text-fg" : "text-fg-soft")}>
          @{id}
        </span>
        {entry.status === "ok" && (
          <span className="ml-auto shrink-0 text-xs text-fg-faint">
            {entry.agent.frontmatter.role}
            {entry.isBoss && ", captain"}
          </span>
        )}
      </span>
      {entry.status === "ok" ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <Lamp state={state} size={7} />
          <span className={cn("shrink-0", LAMP_TEXT[state])}>{lamp?.state ?? "Idle"}</span>
          <span aria-hidden="true" className="text-fg-dim">
            ·
          </span>
          <span className="min-w-0 truncate font-mono text-fg-faint">{entry.agent.frontmatter.account}</span>
        </span>
      ) : (
        <span className="text-xs text-red">Has errors, open to see them</span>
      )}
    </button>
  );
}
