import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import { useConsole } from "./data-context";

interface Urgent {
  key: string;
  what: string;
  line: string;
  /** Where it lives: a decision in Needs you, or a chat. */
  to: { id: string } | { chat: string };
}

/**
 * What cannot wait, from data the console already has: an incident that is open, a paused captain, a client
 * message nobody answered. The bell counts them and lists each, and a row opens where the thing lives.
 */
export function useUrgent(): Urgent[] {
  const { needs, tasks, conversations } = useConsole();
  return useMemo(() => {
    const out: Urgent[] = [];
    for (const row of needs.incident) {
      const d = row.decisions[0];
      if (d !== undefined)
        out.push({ key: `i:${row.id}`, what: "Incident", line: row.name, to: { id: d.id } });
    }
    for (const row of needs.decide) {
      // A pause of the captain's own thread: its decision opens the captain, whether or not the list holds that thread.
      const d = row.decisions.find(
        (x) =>
          x.kind === "paused" &&
          (x.link.kind === "captain" || (x.task !== undefined && tasks.get(x.task)?.lane === true)),
      );
      if (d !== undefined)
        out.push({ key: `p:${row.id}`, what: "Captain paused", line: row.name, to: { id: d.id } });
    }
    // A client message nobody answered waits as a decision ("Handled"), and as unread in its chat.
    const counted = new Set<string>();
    for (const row of needs.decide) {
      for (const d of row.decisions) {
        if (d.kind !== "reply" || d.link.kind !== "chat" || !d.options.some((o) => o.id === "handled"))
          continue;
        if (counted.has(d.link.id)) continue;
        counted.add(d.link.id);
        out.push({ key: `c:${d.link.id}`, what: "Client message", line: d.title, to: { id: d.id } });
      }
    }
    for (const c of conversations ?? []) {
      if (counted.has(c.id)) continue;
      if (c.kind === "client" && c.unread > 0 && c.archived !== true && c.unlinked !== true) {
        out.push({ key: `c:${c.id}`, what: "Client message", line: c.title, to: { chat: c.id } });
      }
    }
    return out;
  }, [needs, tasks, conversations]);
}

/** The bell in the top bar: a red count of what is urgent, and a list that opens each one where it lives. */
export function NotificationBell() {
  const urgent = useUrgent();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  // The panel renders in a portal in the top layer: the glass panes each form a stacking context.
  const { panel, style, container } = useAnchoredPanel({ open, close, trigger, align: "right" });
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={urgent.length === 0 ? "Notifications" : `Notifications, ${urgent.length} urgent`}
        onClick={() => setOpen((v) => !v)}
        className="cs-iconbtn cs-bell"
      >
        <Bell aria-hidden="true" className="size-[15px]" />
        {urgent.length > 0 && <span className="cs-badge cs-bell-n">{urgent.length}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="dialog"
            aria-label="Notifications"
            style={style}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }}
            className={cn("z-[var(--z-float)] flex w-[320px] flex-col rounded-xl p-1.5", GLASS_STRONG)}
          >
            {urgent.length === 0 ? (
              <p className="m-0 px-3 py-4 text-sm text-fg-muted">Nothing urgent.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {urgent.map((u) => (
                  <li key={u.key}>
                    <Link
                      to="/"
                      search={u.to}
                      onClick={() => setOpen(false)}
                      className="flex min-w-0 flex-col gap-0.5 rounded-md px-3 py-2 hover:bg-raised"
                    >
                      <span className="text-xs font-semibold tracking-wide text-red uppercase">{u.what}</span>
                      <span className="truncate text-base text-fg">{u.line}</span>
                    </Link>
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
