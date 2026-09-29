import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A bordered surface one step above the canvas. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-line-strong bg-card", className)} {...props} />;
}
