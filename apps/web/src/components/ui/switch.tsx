import { cn } from "@/lib/cn";

/**
 * An on/off setting. The accessible name is the visible label; with `hideLabel` it is only the
 * accessible name, for a switch whose row already says what it is.
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled,
  hideLabel = false,
  title,
  mixed = false,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hideLabel?: boolean;
  title?: string | undefined;
  /** Some but not all of what the switch stands for is on. Pressing it turns everything on. */
  mixed?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? "mixed" : checked}
      aria-label={hideLabel ? label : undefined}
      title={title}
      disabled={disabled}
      onClick={() => onChange(mixed ? true : !checked)}
      className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md py-0.5 text-left text-base text-fg-soft disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors",
          mixed
            ? "border-accent bg-accent-wash"
            : checked
              ? "border-accent bg-accent"
              : "border-line-bright bg-field",
        )}
      >
        <span
          className={cn(
            "absolute top-px size-[14px] rounded-full transition-[left,background-color]",
            mixed ? "left-[8px] bg-accent" : checked ? "left-[15px] bg-accent-ink" : "left-px bg-fg-faint",
          )}
        />
      </span>
      {!hideLabel && label}
    </button>
  );
}
