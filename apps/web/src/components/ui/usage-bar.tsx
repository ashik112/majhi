import * as m from "motion/react-m";
import { cn } from "@/lib/cn";

const BAR_COLOR = { green: "bg-green", amber: "bg-amber", red: "bg-red" } as const;

/** A usage bar. The number beside it carries the meaning; the fill animates when it changes. */
export function UsageBar({
  pct,
  tone,
  height = 5,
  className,
}: {
  pct: number;
  tone: "green" | "amber" | "red";
  height?: number;
  className?: string;
}) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <span
      aria-hidden="true"
      style={{ height }}
      className={cn("block w-full overflow-hidden rounded-full bg-line-strong", className)}
    >
      <m.span
        className={cn("block h-full rounded-full", BAR_COLOR[tone])}
        initial={false}
        animate={{ width: `${width}%` }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      />
    </span>
  );
}
