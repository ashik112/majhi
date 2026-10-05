import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/**
 * A glass panel of the dashboard: a small heading with a count, then content that scrolls inside
 * the panel when the list is long. `flush` lets the content run to the panel's edges.
 */
export function Panel({
  title,
  aside,
  className,
  flush,
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col rounded-2xl", GLASS, className)}>
      <div className="flex min-h-9 shrink-0 items-center gap-2 px-3.5 pt-1">
        <h2 className="text-xs font-medium tracking-wide text-fg-faint uppercase">{title}</h2>
        {aside !== undefined && <div className="tnum ml-auto font-mono text-xs text-fg-muted">{aside}</div>}
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", flush ? "" : "px-3.5 pb-3")}>{children}</div>
    </section>
  );
}
