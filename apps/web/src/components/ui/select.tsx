import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A native select with the input styling. Always give it a label or `aria-label`. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-[34px] w-full min-w-0 rounded-md border border-line-control bg-field px-2.5 text-base text-fg",
        "transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      spellCheck={false}
      className={cn(
        "w-full min-w-0 resize-y rounded-md border border-line-control bg-sunken px-3 py-2 font-mono text-base text-fg",
        "transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}
