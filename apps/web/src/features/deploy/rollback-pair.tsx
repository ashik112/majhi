import { cn } from "@/lib/cn";
import type { RollbackKind } from "./deploy-model";

const SEGMENTS: readonly { value: RollbackKind; label: string }[] = [
  { value: "redeploy-previous", label: "Redeploy previous" },
  { value: "ssh", label: "My command" },
];

/**
 * The rollback pair in the look of the app's Segmented control. Without `onChange` it only shows
 * the saved choice. `blocked` switches Redeploy previous off and says why in its title.
 */
export function RollbackPair({
  value,
  label,
  blocked,
  size = "md",
  onChange,
}: {
  value: RollbackKind;
  label: string;
  blocked?: string | undefined;
  size?: "sm" | "md";
  onChange?: (value: RollbackKind) => void;
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn(
        "m-0 flex min-w-0 max-w-full gap-1 rounded-[9px] border border-line-strong bg-field",
        size === "sm" ? "gap-0.5 p-0.5" : "p-[3px]",
      )}
    >
      {SEGMENTS.map((s) => {
        const on = s.value === value;
        const off = s.value === "redeploy-previous" && blocked !== undefined;
        return (
          <button
            key={s.value}
            type="button"
            aria-pressed={on}
            disabled={off || onChange === undefined}
            title={off ? blocked : undefined}
            onClick={() => onChange?.(s.value)}
            className={cn(
              "min-w-0 truncate rounded-md whitespace-nowrap transition-colors duration-150 disabled:cursor-default",
              size === "sm" ? "h-[22px] px-2 text-sm" : "h-8 px-2.5 text-sm",
              off && "opacity-45",
              on
                ? "bg-selected font-medium text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
                : cn(
                    "text-fg-muted",
                    !off && onChange !== undefined && "cursor-pointer hover:bg-raised hover:text-fg",
                  ),
            )}
          >
            {s.label}
          </button>
        );
      })}
    </fieldset>
  );
}
