import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** The small uppercase label above a group: "ORGS", "AGENTS RIGHT NOW", "TASK". */
export function SectionLabel({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-xs leading-[1.25] font-medium tracking-[0.08em] text-fg-faint uppercase",
        className,
      )}
      {...props}
    />
  );
}
