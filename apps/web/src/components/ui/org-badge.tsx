import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

const SIZE = {
  xs: "size-[18px] rounded-[5px] text-[8px]",
  sm: "size-5 rounded-[5px] text-[9px]",
  md: "size-6 rounded-md text-[10px]",
  lg: "size-[22px] rounded-md text-[10px]",
} as const;

/** The org's two-letter tile in its color. Decorative: the org name always sits next to it. */
export function OrgBadge({
  label,
  color,
  size = "lg",
  className,
}: {
  label: string;
  color?: string | undefined;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const style: CSSProperties | undefined = color ? { backgroundColor: color } : undefined;
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "flex shrink-0 items-center justify-center bg-fg-muted font-mono font-semibold text-canvas",
        SIZE[size],
        className,
      )}
    >
      {label}
    </span>
  );
}
