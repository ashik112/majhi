import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * The top of every page: one slim glass row with a 15 px title, an inline subtitle and actions on the right.
 * It sticks to the top of the page's scroll area, so the content scrolls under it and the page never does.
 * With `bottom`, the children sit on the bottom edge so tabs can carry their underline on the bar's edge.
 * A place with tabs (Wiki, Usage) passes `tabs` in place of the title.
 */
export function PageHeader({
  title,
  tabs,
  subtitle,
  children,
  bottom = false,
  wrapSubtitle = false,
  className,
}: {
  title?: string;
  /** The page's tab bar, shown where the title would be. */
  tabs?: ReactNode;
  subtitle?: ReactNode;
  /** Buttons, search and filters, or tabs with `bottom`, aligned right. */
  children?: ReactNode;
  bottom?: boolean;
  /** A long subtitle wraps to a second line instead of being cut. */
  wrapSubtitle?: boolean;
  className?: string;
}) {
  const edge = bottom || tabs !== undefined;
  return (
    <header
      className={cn(
        "sticky top-0 z-20 mb-3 flex shrink-0 gap-4 rounded-xl px-4",
        GLASS,
        edge ? "items-end pt-2" : "min-h-11 items-center py-1.5",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 gap-3",
          tabs !== undefined ? "items-end" : "items-baseline",
          bottom && !tabs && "pb-2",
        )}
      >
        {tabs ?? (
          <h1 className="shrink-0 text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg">{title}</h1>
        )}
        {subtitle && (
          <div
            className={cn(
              "min-w-0 text-sm text-fg-muted",
              wrapSubtitle ? "text-pretty" : "line-clamp-2",
              tabs !== undefined && "pb-2",
            )}
          >
            {subtitle}
          </div>
        )}
      </div>
      {children && (
        <div
          className={cn(
            "ml-auto flex shrink-0 items-center gap-3",
            bottom && "self-end",
            tabs !== undefined && "self-center pb-1.5",
          )}
        >
          {children}
        </div>
      )}
    </header>
  );
}
