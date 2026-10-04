import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * The top of every page: one slim glass row with a 15 px title, an inline subtitle and actions on the right.
 * It sticks to the top of the page's scroll area, so the content scrolls under it and the page never does.
 * With `bottom`, the children sit on the bottom edge so tabs can carry their underline on the bar's edge.
 */
export function PageHeader({
  title,
  subtitle,
  children,
  bottom = false,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Buttons, search and filters, or tabs with `bottom`, aligned right. */
  children?: ReactNode;
  bottom?: boolean;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-20 mb-3 flex shrink-0 gap-4 rounded-xl px-4",
        GLASS,
        bottom ? "items-end pt-2" : "min-h-11 items-center py-1.5",
        className,
      )}
    >
      <div className={cn("flex min-w-0 items-baseline gap-3", bottom && "pb-2")}>
        <h1 className="shrink-0 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg">{title}</h1>
        {subtitle && <div className="min-w-0 truncate text-sm text-fg-muted">{subtitle}</div>}
      </div>
      {children && (
        <div className={cn("ml-auto flex shrink-0 items-center gap-3", bottom && "self-end")}>{children}</div>
      )}
    </header>
  );
}
