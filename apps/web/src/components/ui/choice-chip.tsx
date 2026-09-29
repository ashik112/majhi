import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Tiles and toggles that mean "on": the green wash the design uses for allowed. */
export const ALLOWED = "border-green-line bg-green-wash";

/**
 * A toggle button drawn as a chip: the choices of a form (project, model, scope). The chosen one has
 * the blue wash and border, as in the design. `aria-pressed` carries the state for assistive tech.
 */
export function ChoiceChip({
  pressed,
  mono = false,
  className,
  type,
  ...props
}: Omit<ComponentProps<"button">, "aria-pressed"> & { pressed: boolean; mono?: boolean }) {
  return (
    <button
      type={type ?? "button"}
      aria-pressed={pressed}
      className={cn(
        "inline-flex min-h-[34px] cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 text-sm transition-[background-color,border-color,color] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        mono && "font-mono",
        pressed
          ? "border-blue bg-blue-wash text-fg"
          : "border-line-strong bg-card text-fg-muted hover:border-line-hover hover:text-fg active:bg-raised",
        className,
      )}
      {...props}
    />
  );
}
