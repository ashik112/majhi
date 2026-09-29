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
