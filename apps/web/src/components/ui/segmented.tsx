import { cn } from "@/lib/cn";

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** A count in mono after the label. */
  count?: number;
}

/** The pill switch of the board header ("All 8", "Local 1"): one group, one pressed segment. */
export function Segmented<T extends string>({
  label,
  value,
  segments,
  onChange,
  className,
}: {
  label: string;
  value: T;
  segments: readonly Segment<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn(
        "m-0 flex min-w-0 gap-1 rounded-[9px] border border-line-strong bg-card p-[3px]",
        className,
      )}
    >
      {segments.map((segment) => {
        const on = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(segment.value)}
            className={cn(
              "h-8 cursor-pointer rounded-md px-2.5 text-sm transition-colors duration-150",
              on ? "bg-line-strong text-fg" : "text-fg-muted hover:bg-raised hover:text-fg",
            )}
          >
            {segment.label}
            {segment.count !== undefined && (
              <span className="tnum ml-1.5 font-mono text-fg-faint">{segment.count}</span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}
