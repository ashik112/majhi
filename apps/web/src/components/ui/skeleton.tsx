import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A placeholder block shaped like the content it stands in for. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn("block animate-shimmer rounded-xs bg-raised", className)}
      {...props}
    />
  );
}

/** Loading rows that keep the layout the real rows will have. */
export function RowsSkeleton({ rows = 4, height = 54 }: { rows?: number; height?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          key={i}
          style={{ height }}
          className="block animate-shimmer rounded-lg border border-line-strong bg-raised"
        />
      ))}
    </div>
  );
}
