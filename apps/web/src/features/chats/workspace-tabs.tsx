import type { Conversation, OrgView } from "@majhi/shared";
import { OrgBadge } from "@/components/ui/org-badge";
import { setChatFilter, useChatFilter } from "@/lib/chat-filter";
import { cn } from "@/lib/cn";
import { badgeText, unreadByTab, workspaces } from "./model";

const TAB = "inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3.5 text-base";

/** All, then each workspace with its badge and unread count. One click switches; the Chats page and the bubble share it. */
export function WorkspaceTabs({
  list,
  orgs,
  className,
  compact = false,
}: {
  list: readonly Conversation[];
  orgs: readonly OrgView[] | undefined;
  className?: string;
  /** The bubble: a workspace is its badge and unread count, its name in the label and title. */
  compact?: boolean;
}) {
  const { tab } = useChatFilter();
  const all = workspaces(orgs);
  const unread = unreadByTab(list);
  // A remembered workspace that no longer exists falls back to All.
  const current = tab === "all" || all.some((w) => w.id === tab) ? tab : "all";
  return (
    <fieldset
      aria-label="Workspaces"
      className={cn(
        "m-0 flex w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto rounded-xl border border-line bg-glass px-1.5 py-1",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={current === "all"}
        onClick={() => setChatFilter({ tab: "all" })}
        className={cn(
          TAB,
          current === "all"
            ? "bg-accent font-semibold text-accent-ink"
            : "font-medium text-fg-muted hover:bg-raised hover:text-fg",
        )}
      >
        All
        <Count n={unread.get("all") ?? 0} onAccent={current === "all"} />
      </button>
      {all.map((w) => (
        <button
          key={w.id}
          type="button"
          aria-pressed={current === w.id}
          aria-label={compact ? w.name : undefined}
          title={compact ? w.name : undefined}
          onClick={() => setChatFilter({ tab: w.id })}
          className={cn(
            TAB,
            compact && "px-2.5",
            current === w.id
              ? "bg-accent font-semibold text-accent-ink"
              : "font-medium text-fg-muted hover:bg-raised hover:text-fg",
          )}
        >
          <OrgBadge label={w.letters} color={w.color} size="lg" />
          {!compact && w.name}
          <Count n={unread.get(w.id) ?? 0} onAccent={current === w.id} />
        </button>
      ))}
    </fieldset>
  );
}

function Count({ n, onAccent }: { n: number; onAccent: boolean }) {
  if (n === 0) return null;
  return (
    <span
      className={cn(
        "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-2xs font-semibold tabular-nums",
        onAccent ? "bg-glass-strong text-fg" : "bg-accent text-accent-ink",
      )}
    >
      {badgeText(n)}
    </span>
  );
}
