import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";

/**
 * The side panel over the page, where the window is narrower than 1300 px and the panel is not beside
 * it. The menu's Details opens it; the arrow or Esc folds it again.
 */
export function RoomOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className={cn(
        "absolute inset-y-0 right-0 z-30 flex w-[344px] max-w-full flex-col gap-1 overflow-hidden rounded-2xl p-2",
        GLASS_STRONG,
      )}
    >
      <button
        type="button"
        onClick={onClose}
        title="Fold the column"
        aria-label="Fold the column"
        className="grid size-7 shrink-0 cursor-pointer place-items-center self-end rounded-md text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
      {children}
    </div>
  );
}
