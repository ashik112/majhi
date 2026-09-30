import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/** A panel of the task view and the pages: one step above the canvas, 12 px corners, roomy padding. */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("flex flex-col gap-2.5 rounded-xl px-4 py-3.5", GLASS, className)} {...props} />
  );
}
