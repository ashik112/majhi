import { PAGE_PATH } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { BossConversation } from "@/features/boss/boss-conversation";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import { NowList } from "./now-list";

/**
 * The bubble's panel: one Now list (every live task as a row with its lamp, the ones that need the owner with
 * their button, and the waits that have no task) above the Captain chat. The chat is the same room the Captain
 * drawer shows, so sending, cards and reading marks work as there. Every other conversation is on the Chats page.
 * Its code is read when the panel first opens.
 */
export default function DockPanel({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  // Focus moves into the panel when it opens, so Esc closes it; the message box takes it from there.
  useEffect(() => panel.current?.focus(), []);
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label="Captain"
      className={cn(
        "fixed right-4 bottom-[164px] z-40 flex h-[min(620px,calc(100dvh-188px))] w-[min(420px,calc(100vw-32px))] animate-fade-in flex-col overflow-hidden rounded-2xl outline-none",
        GLASS_STRONG,
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-2">
        <h2 className="min-w-0 flex-1 truncate px-1 text-md font-semibold">Captain</h2>
        <Link
          to="/chats"
          onClick={onClose}
          className="rounded-sm px-1.5 text-sm text-fg-muted hover:text-fg hover:underline"
        >
          All chats
        </Link>
        <Link
          to={PAGE_PATH.captain}
          onClick={onClose}
          className="rounded-sm px-1.5 text-sm text-fg-muted hover:text-fg hover:underline"
        >
          Captain page
        </Link>
        <Button variant="ghost" size="icon-sm" aria-label="Close the captain" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <NowList />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2.5">
        <BossConversation />
      </div>
    </div>
  );
}
