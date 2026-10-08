import { Lamp, type LampState } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** A count in mono after the label. */
  count?: number;
  /** A status dot before the label. */
  lamp?: LampState | undefined;
  /** Cannot be chosen; `title` says why. */
  disabled?: boolean;
  title?: string;
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
        "m-0 flex min-w-0 gap-1 rounded-[9px] border border-line-strong bg-field p-[3px]",
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
            disabled={segment.disabled}
            title={segment.title}
            onClick={() => onChange(segment.value)}
            className={cn(
              "h-8 cursor-pointer rounded-md px-2.5 text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
              on
                ? "bg-accent font-semibold text-accent-ink shadow-[0_1px_2px_rgb(0_0_0/0.18)]"
                : "text-fg-muted hover:bg-raised hover:text-fg",
            )}
          >
            {segment.lamp !== undefined && (
              <Lamp state={segment.lamp} size={6} className="mr-1.5 inline-block" />
            )}
            {segment.label}
            {segment.count !== undefined && (
              <span className={cn("tnum ml-1.5 font-mono", on ? "text-accent-ink/75" : "text-fg-faint")}>
                {segment.count}
              </span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}
