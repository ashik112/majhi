import { Link } from "@tanstack/react-router";
import { Bell as BellIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useRunAttention } from "@/components/shell/banner";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { type AttentionItem, attentionItems } from "@/features/shell/model";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { GLASS_STRONG } from "@/lib/glass";
import { setNoticesOpen, useNoticesOpen, usePendingNotices } from "@/lib/notices";
import { PAGE_PATH } from "@/lib/pages";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";

/** Everything that needs the owner, across every workspace, most urgent first. */
function useAttentionItems(): AttentionItem[] {
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
  const agents = useAgentIndex();
  const pending = usePendingNotices().data;
  const now = useNow(60_000);
  return useMemo(
    () =>
      attentionItems({
        tasks: tasks ?? [],
        agents,
        accounts: accounts ?? [],
        now,
        pending: pending ?? [],
      }),
    [tasks, agents, accounts, pending, now],
  );
}

/** Where the panel sits: 12px right of the sidebar, level with its top, as tall as the window allows. */
function besideSidebar(trigger: HTMLElement | null): React.CSSProperties | undefined {
  const aside = trigger?.closest("aside")?.getBoundingClientRect();
  if (aside === undefined) return undefined;
  return {
    top: aside.top,
    bottom: "auto",
    left: aside.right + 12,
    right: "auto",
    maxHeight: Math.min(640, window.innerHeight - aside.top - 12),
  };
}

/** "99+" past two digits, so the badge stays a small round tag. */
function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * The bell in the sidebar head: a count of what needs the owner, and a panel that lists it. Each row
 * names the task and what it needs, and opens the task.
 */
export function Bell() {
  const items = useAttentionItems();
  const open = useNoticesOpen();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setNoticesOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({ open, close, trigger });
  const count = items.length;
  // The panel opens beside the sidebar, from its top, rather than over the sidebar's own rows.
  const side = open ? besideSidebar(trigger.current) : undefined;

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("[data-notice]")?.focus();
  }, [open, panel]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      trigger.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-notice]") ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    nodes[(next + nodes.length) % nodes.length]?.focus();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={count === 0 ? "Notifications, nothing needs you" : `Notifications, ${count} need you`}
        title={
          count === 0 ? "Nothing needs you" : `${count} ${count === 1 ? "thing needs" : "things need"} you`
        }
        onClick={() => setNoticesOpen(!open)}
        className={cn(
          "relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-raised hover:text-fg",
          open && "bg-selected text-fg",
        )}
      >
        <BellIcon aria-hidden="true" className="size-4" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="tnum absolute -top-1 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-lamp-needs px-1 font-mono text-[10px] leading-none font-semibold text-canvas"
          >
            {countText(count)}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="dialog"
            aria-label="Needs you"
            style={{ ...style, ...side }}
            onKeyDown={onKeyDown}
            className={cn("z-50 flex w-[400px] flex-col overflow-hidden rounded-xl", GLASS_STRONG)}
          >
            <div className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 pt-3 pb-2.5">
              <h2 className="text-md font-semibold">Needs you</h2>
              <span className="tnum font-mono text-sm text-fg-faint">{count}</span>
              <Link
                to={PAGE_PATH.setup}
                search={{ section: "notifications" }}
                onClick={close}
                className="ml-auto rounded-sm text-xs text-fg-muted hover:text-fg hover:underline"
              >
                Notification settings
              </Link>
            </div>
            {count === 0 ? (
              <p className="px-4 py-6 text-base text-fg-muted">Nothing needs you right now.</p>
            ) : (
              <ul
                aria-label="What needs you"
                className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain p-1.5 scroll-fade"
              >
                {items.map((item) => (
                  <li key={item.key}>
                    <NoticeRow item={item} onOpen={close} />
                  </li>
                ))}
              </ul>
            )}
          </div>,
          container,
        )}
    </>
  );
}

function NoticeRow({ item, onOpen }: { item: AttentionItem; onOpen: () => void }) {
  const run = useRunAttention();
  const orgs = useOrgs().data;
  const org = item.task?.org === undefined ? undefined : orgs?.find((o) => o.id === item.task?.org);
  return (
    <button
      type="button"
      data-notice=""
      onClick={() => {
        onOpen();
        run(item.action);
      }}
      className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
    >
      <span className="flex h-5 shrink-0 items-center">
        <Lamp state={item.lamp} size={7} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-base break-words text-fg">{item.text}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-faint">
          {item.task ? (
            <>
              {org && <OrgBadge label={badgeLetters(org.key)} color={org.color} size="xs" />}
              <span className="min-w-0 truncate">{item.task.chat === true ? "Chat" : item.task.title}</span>
            </>
          ) : (
            <span>Accounts</span>
          )}
        </span>
      </span>
    </button>
  );
}
