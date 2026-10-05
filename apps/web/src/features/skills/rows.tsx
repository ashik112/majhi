import type { ConnectionView, OrgView } from "@majhi/shared";
import { ChevronRight } from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { scopeName, WorkspaceMark } from "@/features/connections/scope-picker";
import { ServiceLogo, serviceOf } from "@/features/connections/service-logo";
import { cn } from "@/lib/cn";
import type { Item, RowAction } from "./catalog";

export function rowDomId(key: string): string {
  return `skills-row-${key}`;
}

/** The tile before the name: initials for a skill, the service mark for an MCP server. */
export function ItemMark({ item, server }: { item: Item; server: ConnectionView | undefined }) {
  if (item.kind === "mcp" && server !== undefined) {
    return <ServiceLogo service={serviceOf(server)} type={server.type} />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-raised font-mono text-[10px] font-semibold text-fg-soft uppercase"
    >
      {item.name.replace(/[^a-z0-9]/gi, "").slice(0, 2)}
    </span>
  );
}

/**
 * One line: mark, name and description, workspace, who has it, the lamp with its reason, and the one
 * button for the row's state. Below 1280px the workspace shows as its tile only.
 */
export function ItemRow({
  item,
  server,
  orgs,
  focused,
  highlighted,
  busy,
  selected,
  onSelect,
  onFocus,
  onOpen,
  onAction,
}: {
  item: Item;
  server: ConnectionView | undefined;
  orgs: readonly OrgView[];
  focused: boolean;
  highlighted: boolean;
  busy: boolean;
  /** Skills only: whether the row is ticked for a bulk change. Undefined: no checkbox. */
  selected?: boolean | undefined;
  onSelect?: ((key: string, range: boolean) => void) | undefined;
  onFocus: (key: string) => void;
  onOpen: (key: string) => void;
  onAction: (key: string, action: RowAction) => void;
}) {
  const name = scopeName(item.scope, orgs);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row only takes the keys' place on a press; its buttons do the work
    <div
      id={rowDomId(item.key)}
      aria-current={focused ? "true" : undefined}
      onMouseDown={() => onFocus(item.key)}
      className={cn(
        "group relative flex items-center gap-3 border-b border-line px-3 text-base",
        "min-h-11 py-1.5 transition-colors duration-100",
        focused ? "bg-selected" : "hover:bg-raised",
        highlighted && "bg-accent-wash",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:content-['']",
        (focused || highlighted) && "before:bg-accent",
      )}
    >
      {onSelect !== undefined && (
        <input
          type="checkbox"
          aria-label={`Select ${item.name}`}
          checked={selected === true}
          onChange={() => undefined}
          onClick={(event) => onSelect(item.key, event.shiftKey)}
          className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
        />
      )}
      <ItemMark item={item} server={server} />
      <button
        type="button"
        onClick={() => onOpen(item.key)}
        title={`${item.name}: ${item.description}`}
        className="m-0 flex min-w-0 flex-1 cursor-pointer items-baseline gap-2.5 p-0 text-left outline-none"
      >
        <span className="max-w-[40%] shrink-0 truncate font-medium text-fg group-hover:underline">
          {item.name}
        </span>
        <span className="min-w-0 truncate text-sm text-fg-muted">{item.description}</span>
      </button>
      <span
        title={name}
        className="flex w-[18px] shrink-0 items-center gap-1.5 text-xs text-fg-soft min-[1280px]:w-[112px]"
      >
        <WorkspaceMark org={item.scope} orgs={orgs} size="sm" />
        <span className="min-w-0 truncate max-[1279px]:hidden">{name}</span>
      </span>
      <span
        className="flex w-[104px] shrink-0 items-center gap-1.5 min-[1280px]:w-[148px]"
        title={`On for ${item.on.length} of ${item.reach} agents`}
      >
        <span className="flex gap-0.5 max-[1279px]:hidden">
          {item.on.slice(0, 3).map((id) => (
            <AgentAvatar key={id} id={id} size={18} decorative />
          ))}
        </span>
        <span
          className={cn(
            "tnum font-mono text-xs whitespace-nowrap",
            item.on.length === 0 ? "text-fg-faint" : "text-fg-muted",
          )}
        >
          {item.on.length} of {item.reach}
        </span>
      </span>
      <span
        className={cn(
          "flex w-[150px] shrink-0 items-center gap-2 text-xs min-[1280px]:w-[230px]",
          item.bad ? LAMP_TEXT[item.lamp] : "text-fg-muted",
        )}
        title={item.status}
      >
        <Lamp state={item.lamp} size={7} />
        <span className="min-w-0 truncate">{item.status}</span>
      </span>
      <span className="flex w-[104px] shrink-0 justify-end">
        {item.action !== undefined ? (
          <Button
            size="sm"
            variant={item.bad ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => item.action && onAction(item.key, item.action.id)}
          >
            {item.action.label}
          </Button>
        ) : (
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-fg-faint opacity-0 group-hover:opacity-100"
          />
        )}
      </span>
    </div>
  );
}
