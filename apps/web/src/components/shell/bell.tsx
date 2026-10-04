import { Link } from "@tanstack/react-router";
import { Bell as BellIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { DecisionRow } from "@/features/decisions/decision-row";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { GLASS_STRONG } from "@/lib/glass";
import { setNoticesOpen, useNoticesOpen } from "@/lib/notices";
import { PAGE_PATH } from "@/lib/pages";

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
 * The bell in the sidebar head: a count of the decisions that wait for the owner, and a panel that
 * lists them. Each row can be answered right there or opened.
 */
export function Bell() {
  const decisions = useDecisions().data?.decisions ?? [];
  const open = useNoticesOpen();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setNoticesOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({ open, close, trigger });
  const count = useNeedsYou() ?? decisions.length;
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
        aria-label={count === 0 ? "Decisions, nothing needs you" : `Decisions, ${count} need you`}
        title={
          count === 0
            ? "Nothing needs you"
            : `${count} ${count === 1 ? "decision needs" : "decisions need"} you`
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
            aria-label="Decisions"
            style={{ ...style, ...side }}
            onKeyDown={onKeyDown}
            className={cn("z-50 flex w-[420px] flex-col overflow-hidden rounded-xl", GLASS_STRONG)}
          >
            <div className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 pt-3 pb-2.5">
              <h2 className="text-md font-semibold">Decisions</h2>
              <span className="tnum font-mono text-sm text-fg-faint">{count}</span>
              <Link
                to={PAGE_PATH.decisions}
                onClick={close}
                className="ml-auto rounded-sm text-xs text-fg-muted hover:text-fg hover:underline"
              >
                Open all
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
            {count === 0 ? (
              <p className="px-4 py-6 text-base text-fg-muted">Nothing needs you.</p>
            ) : (
              <ul
                aria-label="What needs you"
                className="flex min-h-0 flex-col overflow-y-auto overscroll-contain scroll-fade"
              >
                {decisions.map((decision) => (
                  <li key={decision.id}>
                    <DecisionRow decision={decision} compact onOpen={close} />
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
