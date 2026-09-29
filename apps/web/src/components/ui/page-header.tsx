import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The top of every page: a 22 px title, a one-line subtitle, actions on the right and a rule below.
 * With `bottom`, the children sit on the bottom edge so tabs can carry their underline over the rule.
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
        "flex shrink-0 gap-6 border-b border-line-strong px-8",
        bottom ? "items-end pt-5" : "items-center py-[22px]",
        className,
      )}
    >
      <div className={cn("flex min-w-0 flex-col gap-1", bottom && "pb-3.5")}>
        <h1 className="text-xl leading-[26px] font-semibold text-fg">{title}</h1>
        {subtitle && <div className="text-base leading-[19px] text-fg-muted">{subtitle}</div>}
      </div>
      {children && (
        <div className={cn("ml-auto flex shrink-0 items-center gap-3", bottom && "self-end")}>{children}</div>
      )}
    </header>
  );
}
