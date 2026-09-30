import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * The top of every page: a glass bar with a 22 px title, a one-line subtitle and actions on the right.
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
        "sticky top-0 z-20 mb-3 flex shrink-0 gap-6 rounded-2xl px-6",
        GLASS,
        bottom ? "items-end pt-4" : "min-h-[76px] items-center py-3.5",
        className,
      )}
    >
      <div className={cn("flex min-w-0 flex-col gap-1", bottom && "pb-3.5")}>
        <h1 className="text-xl leading-[26px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
        {subtitle && <div className="text-base leading-[19px] text-fg-muted">{subtitle}</div>}
      </div>
      {children && (
        <div className={cn("ml-auto flex shrink-0 items-center gap-3", bottom && "self-end")}>{children}</div>
      )}
    </header>
  );
}
