import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { CaptainPanel } from "@/features/captain/panel";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { GLASS_STRONG } from "@/lib/glass";
import { useBoss } from "./boss-context";

/**
 * The Captain panel as a right-side drawer over any page. Cmd+J or the sidebar opens it. Esc closes
 * it, and focus goes back to where it was.
 */
export function BossDrawer() {
  const { open, hide, tab } = useBoss();
  const panel = useRef<HTMLElement>(null);

  // Focus moves into the drawer when it opens (the message box of the tab, else the tab itself), and
  // back to what had it when it closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the field exists only after the tab loaded
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    const timer = window.setTimeout(() => {
      const field = panel.current?.querySelector<HTMLElement>("textarea");
      (field ?? panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [open]);

  // A tab change keeps the focus in the drawer: the message box of the new tab when it has one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the tab only
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.getAttribute("role") === "tab") return;
    const timer = window.setTimeout(
      () => panel.current?.querySelector<HTMLElement>("textarea")?.focus(),
      150,
    );
    return () => window.clearTimeout(timer);
  }, [open, tab]);

  if (!open) return null;
  return (
    <aside
      ref={panel}
      aria-label="Captain"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) hide();
      }}
      className={cn(
        "fixed top-3 right-3 bottom-3 z-40 flex w-[min(480px,calc(100vw-24px))] animate-fade-in flex-col gap-3 rounded-2xl p-4",
        GLASS_STRONG,
      )}
    >
      <header className="flex items-center gap-2.5">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold">Captain</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close the captain panel" onClick={hide}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <CaptainPanel />
      <p className="shrink-0 text-xs text-fg-faint">
        <Kbd>{MOD_KEY} J</Kbd> opens and closes this. Arrow keys switch tabs. Changes wait for your approval.
      </p>
    </aside>
  );
}
