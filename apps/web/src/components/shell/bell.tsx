import { type Notice, PAGE_PATH } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Bell as BellIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { Button } from "@/components/ui/button";
import { groupNotices, noticeAction } from "@/features/notices/model";
import { NoticeRow } from "@/features/notices/notice-row";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import { useMarkNoticesRead, useNotices } from "@/lib/notice-queries";
import { setNoticesOpen, useNoticesOpen } from "@/lib/notices";
import { useNow } from "@/lib/use-now";
import { useRunAttention } from "./banner";

/** Where the panel sits: 12px right of the sidebar, just under the bell, as tall as the window allows. */
function besideSidebar(trigger: HTMLElement | null): React.CSSProperties | undefined {
  const aside = trigger?.closest("aside")?.getBoundingClientRect();
  const bell = trigger?.getBoundingClientRect();
  if (aside === undefined || bell === undefined) return undefined;
  const top = bell.bottom + 8;
  return {
    top,
    bottom: "auto",
    left: aside.right + 12,
    right: "auto",
    maxHeight: Math.min(680, window.innerHeight - top - 12),
  };
}

/** "99+" past two digits, so the badge stays a small round tag. */
function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function GroupLabel({ children }: { children: string }) {
  return (
    <li
      aria-hidden="true"
      className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-xs font-medium text-fg-faint"
    >
      {children}
      <span className="h-px flex-1 bg-line" />
    </li>
  );
}

/**
 * The bell in the sidebar head: what happened since the owner last looked, newest first, in two
 * groups (New, Earlier). The badge counts the unread rows and is red while one of them waits for the
 * owner. Opening the panel reads nothing; a row is read when it is opened, and "Mark all read" reads all.
 */
export function Bell() {
  const feed = useNotices().data;
  const mark = useMarkNoticesRead().mutate;
  const run = useRunAttention();
  const open = useNoticesOpen();
  const now = useNow(60_000);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setNoticesOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({ open, close, trigger });
  const notices = feed?.notices ?? [];
  const unread = feed?.unread ?? 0;
  const urgent = (feed?.unreadNeedsYou ?? 0) > 0;
  const { fresh, earlier } = groupNotices(notices);
  const side = open ? besideSidebar(trigger.current) : undefined;

  // The panel is hidden until it is placed, and a hidden element cannot take focus: focus the first row in the
  // same commit that shows it. A browser that is not ready yet gets another try on the next frames.
  useLayoutEffect(() => {
    if (!open || style.visibility === "hidden") return;
    let frame = 0;
    let tries = 0;
    const focusFirst = () => {
      const node = panel.current;
      if (node === null) return;
      const target = node.querySelector<HTMLElement>("[data-notice]") ?? node;
      target.focus();
      if (document.activeElement !== target && tries < 30) {
        tries += 1;
        frame = window.requestAnimationFrame(focusFirst);
      }
    };
    focusFirst();
    return () => window.cancelAnimationFrame(frame);
  }, [open, panel, style.visibility]);

  // Esc closes wherever focus is: a button that went away under the pointer (Mark all read) leaves it on the page.
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      trigger.current?.focus();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [open, close]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-notice]") ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    nodes[(next + nodes.length) % nodes.length]?.focus();
  }

  function openRow(notice: Notice) {
    if (!notice.read) mark({ id: notice.id });
    close();
    run(noticeAction(notice.link));
  }

  function readAll() {
    mark({ upTo: new Date().toISOString() });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={unread === 0 ? "Notifications, nothing new" : `Notifications, ${unread} unread`}
        title={unread === 0 ? "Nothing new" : `${unread} unread`}
        onClick={() => setNoticesOpen(!open)}
        className={cn(
          "relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-raised hover:text-fg",
          open && "bg-selected text-fg",
        )}
      >
        <BellIcon aria-hidden="true" className="size-4" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            data-urgent={urgent ? "" : undefined}
            className={cn(
              "tnum absolute -top-1 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] leading-none font-semibold text-canvas",
              urgent ? "bg-lamp-needs" : "bg-fg-muted",
            )}
          >
            {countText(unread)}
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
            tabIndex={-1}
            aria-label="Notifications"
            style={{ ...style, ...side }}
            onKeyDown={onKeyDown}
            className={cn(
              "z-50 flex w-[420px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl",
              GLASS_STRONG,
            )}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 pt-3 pb-2.5">
              <h2 className="text-md font-semibold">Notifications</h2>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-xs text-fg"
                disabled={unread === 0}
                onClick={readAll}
              >
                Mark all read
              </Button>
            </div>
            {notices.length === 0 ? (
              <p className="px-4 py-6 text-base text-fg-muted">Nothing happened this week.</p>
            ) : (
              <ul
                aria-label="What happened"
                className="flex min-h-0 flex-col overflow-y-auto overscroll-contain scroll-fade"
              >
                {fresh.length > 0 && <GroupLabel>New</GroupLabel>}
                {fresh.map((notice) => (
                  <li key={notice.id}>
                    <NoticeRow notice={notice} now={now} onOpen={openRow} />
                  </li>
                ))}
                {earlier.length > 0 && <GroupLabel>Earlier</GroupLabel>}
                {earlier.map((notice) => (
                  <li key={notice.id}>
                    <NoticeRow notice={notice} now={now} onOpen={openRow} />
                  </li>
                ))}
              </ul>
            )}
            <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-2">
              <Link
                to={PAGE_PATH.decisions}
                onClick={close}
                className="rounded-sm text-xs text-fg-muted hover:text-fg hover:underline"
              >
                Needs you
              </Link>
              <Link
                to={PAGE_PATH.setup}
                search={{ section: "notifications" }}
                onClick={close}
                className="rounded-sm text-xs text-fg-muted hover:text-fg hover:underline"
              >
                Alert settings
              </Link>
            </div>
          </div>,
          container,
        )}
    </>
  );
}
