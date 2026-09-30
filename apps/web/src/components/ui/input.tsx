import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type ?? "text"}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        "h-[34px] w-full min-w-0 rounded-md border border-line-control bg-field px-3 text-base text-fg",
        "transition-[border-color,background-color] duration-150 hover:border-line-hover",
        "focus-visible:border-accent focus-visible:outline-none",
        "aria-invalid:border-red aria-invalid:focus-visible:border-red",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
