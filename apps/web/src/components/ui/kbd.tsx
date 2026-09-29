import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A key cap. Inside a primary button it takes the button's ink color. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-bright px-1",
        "font-mono text-xs font-normal leading-none text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}
