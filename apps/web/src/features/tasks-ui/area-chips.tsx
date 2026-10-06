import type { TaskAreas } from "@majhi/shared";
import { cn } from "@/lib/cn";

/** The names of the parts of the system a task touches, each once, in the order of how many files fall in it. */
export function areaNames(areas: TaskAreas | undefined): string[] {
  if (areas === undefined) return [];
  const files = new Map<string, number>();
  for (const a of areas.areas) files.set(a.component, (files.get(a.component) ?? 0) + a.files);
  return [...files].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/** Small chips for the parts of the system a task touches. */
export function AreaChips({
  names,
  max = 3,
  big = false,
  className,
}: {
  names: readonly string[];
  /** Chips before "+N". */
  max?: number;
  big?: boolean;
  className?: string;
}) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  const chip = cn(
    "inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-line-strong bg-raised text-fg-muted",
    big ? "h-6 px-2 text-sm text-fg-soft" : "h-5 px-1.5 text-xs",
  );
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} title={names.join(", ")}>
      {shown.map((name) => (
        <span key={name} className={chip}>
          {name}
        </span>
      ))}
      {more > 0 && <span className={chip}>+{more}</span>}
    </span>
  );
}
