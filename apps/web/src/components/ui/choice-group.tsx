import { useId } from "react";
import { cn } from "@/lib/cn";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** One-of-few choice as native radio buttons drawn as chips, so arrow keys and screen readers just work. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  choices,
  onChange,
  className,
}: {
  label: string;
  value: T | undefined;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <legend className="mb-1.5 p-0 text-sm text-fg-faint">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((choice) => (
          <label key={choice.value} className={cn("relative", choice.disabled && "opacity-45")}>
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              disabled={choice.disabled ?? false}
              onChange={() => onChange(choice.value)}
              className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
            <span
              className={cn(
                "flex min-h-[34px] flex-col justify-center rounded-md border border-line-strong bg-card px-3 text-sm text-fg-muted",
                "transition-colors peer-hover:border-line-hover peer-checked:border-blue peer-checked:bg-[#23324a] peer-checked:text-fg",
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue",
              )}
            >
              {choice.label}
              {choice.hint && <span className="text-xs text-fg-faint">{choice.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
