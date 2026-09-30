import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/** A bordered surface one step above the canvas. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg", GLASS, className)} {...props} />;
}
