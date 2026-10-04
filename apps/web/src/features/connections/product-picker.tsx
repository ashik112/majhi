import type { ServiceProduct } from "@majhi/shared";
import { ChoiceChip } from "@/components/ui/choice-chip";

/** The products a service connection turns on, picked as chips; at least one stays on. */
export function ProductPicker({
  products,
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  products: readonly ServiceProduct[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Under a section that already names it: no visible heading and no first-time note. */
  compact?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className={compact ? "sr-only" : "mb-2 text-base font-medium text-fg"}>
        Products agents get
      </legend>
      <div className="flex flex-wrap gap-2">
        {products.map((p) => {
          const on = value.includes(p.id);
          return (
            <ChoiceChip
              key={p.id}
              pressed={on}
              title={on && value.length === 1 ? "Keep at least one product" : undefined}
              onClick={() => {
                if (on && value.length === 1) return;
                onChange(
                  on
                    ? value.filter((id) => id !== p.id)
                    : products.map((x) => x.id).filter((id) => id === p.id || value.includes(id)),
                );
              }}
            >
              {p.name}
            </ChoiceChip>
          );
        })}
      </div>
      {!compact && (
        <p className="text-sm text-fg-faint">
          One sign-in covers every product. Change them later without signing in again.
        </p>
      )}
    </fieldset>
  );
}

/** The products picked by default: the first four the service lists. */
export function defaultProducts(products: readonly ServiceProduct[] | undefined): string[] {
  return (products ?? []).slice(0, 4).map((p) => p.id);
}
