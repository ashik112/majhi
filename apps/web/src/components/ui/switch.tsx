import { cn } from "@/lib/cn";

/** An on/off setting. The accessible name is the visible label. */
export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md text-left text-base text-fg-soft disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors",
          checked ? "border-amber bg-amber" : "border-line-bright bg-field",
        )}
      >
        <span
          className={cn(
            "absolute top-px size-[14px] rounded-full transition-[left,background-color]",
            checked ? "left-[15px] bg-amber-ink" : "left-px bg-fg-faint",
          )}
        />
      </span>
      {label}
    </button>
  );
}
