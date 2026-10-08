import { useRouterState } from "@tanstack/react-router";
import { MessageCircle, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useBoss } from "@/features/boss/boss-context";
import { badgeText } from "@/features/chats/model";
import { cn } from "@/lib/cn";
import { useUnreadTotal } from "@/lib/conversation-queries";
import { GLASS_STRONG } from "@/lib/glass";

const loadPanel = () => import("./dock-panel");
const DockPanel = lazy(loadPanel);

/** The panel's frame while its code loads, so the first click shows the panel at once. */
function PanelShell({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Chats"
      aria-busy="true"
      className={cn(
        "fixed right-4 bottom-[72px] z-40 flex h-[min(620px,calc(100dvh-72px-72px))] w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl outline-none",
        GLASS_STRONG,
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-2">
        <h2 className="min-w-0 flex-1 truncate px-1 text-md font-semibold">Chats</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close the chats" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="px-3 py-3">
        <RowsSkeleton rows={5} height={52} />
      </div>
    </div>
  );
}

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
  const onChats = useRouterState({ select: (state) => state.location.pathname.startsWith("/chats") });
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
  // On the Chats page the list is the page itself, so the button would only cover its actions.
  if (bossOpen || onChats) return null;
  return (
    <div data-chat-dock="">
      {open && (
        <Suspense fallback={<PanelShell onClose={close} />}>
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
          "fixed right-4 bottom-4 z-40 flex size-11 cursor-pointer items-center justify-center rounded-full text-fg-soft transition-colors hover:border-line-hover hover:text-fg",
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
