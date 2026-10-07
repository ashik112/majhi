import { MessageCircle } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useBoss } from "@/features/boss/boss-context";
import { badgeText } from "@/features/chats/model";
import { cn } from "@/lib/cn";
import { useUnreadTotal } from "@/lib/conversation-queries";
import { GLASS_STRONG } from "@/lib/glass";

const loadPanel = () => import("./dock-panel");
const DockPanel = lazy(loadPanel);

/**
 * The floating chat button, bottom right on every page, with the unread count. It opens the panel with the
 * same list of conversations as the Chats page. Mounted once in the shell. It reads one number from the list, so
 * a new message re-renders this button and nothing else.
 */
export const ChatDock = memo(function ChatDock() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const unread = useUnreadTotal();
  const { open: bossOpen } = useBoss();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  // Esc closes the panel unless something inside used it (a menu, the agent stop).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Focus on the page body counts too: it lands there when the row that was clicked leaves the list.
      const active = document.activeElement;
      if (active !== document.body && !document.querySelector("[data-chat-dock]")?.contains(active)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // The Captain drawer covers the corner and is a chat of its own: the button waits until it closes.
  if (bossOpen) return null;
  return (
    <div data-chat-dock="">
      {open && (
        <Suspense fallback={null}>
          <DockPanel onClose={close} />
        </Suspense>
      )}
      <button
        ref={button}
        type="button"
        aria-label={unread > 0 ? `Chats, ${unread} unread` : "Chats"}
        aria-expanded={open}
        title="Chats"
        onPointerEnter={() => void loadPanel()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed right-4 bottom-[88px] z-40 flex size-11 cursor-pointer items-center justify-center rounded-full text-fg-soft transition-colors hover:border-line-hover hover:text-fg",
          open && "text-fg",
          GLASS_STRONG,
        )}
      >
        <MessageCircle aria-hidden="true" className="size-5" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-2xs font-semibold text-accent-ink tabular-nums shadow-[0_0_0_2px_var(--c-canvas)]"
          >
            {badgeText(unread)}
          </span>
        )}
      </button>
    </div>
  );
});
