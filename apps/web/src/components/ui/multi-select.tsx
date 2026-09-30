import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";

export interface MultiOption {
  value: string;
  label: string;
  /** Set the label in mono (ids, model names). */
  mono?: boolean;
}

/**
 * A pick-many dropdown: a select-sized button that names what is picked, over a floating list of
 * check rows. The list stays open while the owner ticks rows; Esc or a click outside closes it.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  emptyText,
  clearText,
  className,
  disabled = false,
}: {
  /** The accessible name of the button. */
  label: string;
  options: readonly MultiOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** What the button says when nothing is picked, like "Every model". */
  emptyText: string;
  /** The row that clears the picks, like "Allow every model". */
  clearText: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const close = useCallback(() => setOpen(false), []);
  const { panel, style } = useAnchoredPanel({ open, close, trigger: button, matchWidth: true });

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
  }, [open, panel]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const rows = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  }

  const picked = options.filter((o) => value.includes(o.value));
  const unknown = value.filter((v) => !options.some((o) => o.value === v));
  const summary =
    value.length === 0
      ? emptyText
      : value.length <= 2
        ? [...picked.map((o) => o.label), ...unknown].join(", ")
        : `${value.length} picked`;

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only relays keys from the rows
    <div ref={root} className={cn("relative min-w-0", className)} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={`${label}: ${summary}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-[34px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-line-control bg-field pr-2 pl-2.5 text-left text-base text-fg",
          "transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-accent",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", value.length === 0 && "text-fg-muted")}>
          {summary}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={listId}
            role="menu"
            aria-label={label}
            style={style}
            className={cn("z-50 flex min-w-56 flex-col overflow-y-auto rounded-lg p-1", GLASS_STRONG)}
          >
            {[...options, ...unknown.map((v) => ({ value: v, label: `${v} (not offered)`, mono: true }))].map(
              (option) => {
                const on = value.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => toggle(option.value)}
                    className="flex h-8 min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-base text-fg hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-xs border",
                        on ? "border-accent bg-accent text-accent-ink" : "border-line-bright bg-field",
                      )}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className={cn("min-w-0 truncate", option.mono && "font-mono text-sm")}>
                      {option.label}
                    </span>
                  </button>
                );
              },
            )}
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="mt-1 flex h-8 shrink-0 cursor-pointer items-center rounded-sm border-t border-line px-2 text-left text-sm text-fg-muted hover:bg-raised hover:text-fg"
              >
                {clearText}
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
