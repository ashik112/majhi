import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";

/**
 * A panel that slides over the right edge of the page, on the native dialog like `Modal`: a title,
 * a close button and a body that scrolls on its own. Esc and a click outside close it.
 */
export function Sheet({
  title,
  subtitle,
  actions,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Buttons next to the close button. */
  actions?: ReactNode;
  onClose: () => void;
  /** 760 px instead of 560 px, for a table. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      label={title}
      onClose={onClose}
      className={cn(
        "fixed top-3 right-3 bottom-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none max-w-[calc(100vw-24px)] flex-col open:flex",
        wide ? "w-[min(760px,100vw)]" : "w-[min(560px,100vw)]",
      )}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line-strong px-5 py-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md font-semibold">{title}</span>
          {subtitle && <span className="truncate text-xs text-fg-faint">{subtitle}</span>}
        </span>
        {actions}
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${title}`} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 pt-3 pb-6 scroll-fade">
        {children}
      </div>
    </Modal>
  );
}
