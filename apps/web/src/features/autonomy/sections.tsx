import type { ReactNode } from "react";

/** A card's heading: its title, a count in mono, and a note or action at the right. */
export function CardHead({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {count !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{count}</span>}
      {children && <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>}
    </div>
  );
}
