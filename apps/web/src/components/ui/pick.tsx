import { Check, ChevronDown } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";

export interface PickOption {
  value: string;
  label: string;
  /** Small mono text at the right of the row: a count, a state. */
  detail?: string;
  /** Options with a group get its name as a small heading above the first of them. */
  group?: string;
  /** Something before the label: a tile, a lamp. */
  lead?: ReactNode;
}

const ITEM = '[role="menuitemradio"]';

/**
 * A select that opens a glass menu, for a page's own pickers (the workspace and the project of the Wiki). The
 * button shows the chosen option; the menu lists every option with its detail. Arrow keys move, Home and End
 * jump, Enter picks, Esc closes and returns focus to the button. Prefer it over a native select whenever the
 * options carry more than a name.
 */
export function Pick({
  label,
  value,
  options,
  onChange,
  lead,
  className,
  align = "left",
  menuWidth,
}: {
  /** Names the control for assistive tech. */
  label: string;
  value: string | undefined;
  options: readonly PickOption[];
  onChange: (value: string) => void;
  /** Replaces the chosen option's own lead on the button. */
  lead?: ReactNode;
  className?: string;
  align?: "left" | "right";
  /** The menu is at least this wide; it is never narrower than the button. */
  menuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({
    open,
    close,
    trigger,
    align,
    matchWidth: true,
    maxHeight: 440,
  });
  const chosen = options.find((o) => o.value === value);

  // The menu is hidden until it is placed, and a hidden element cannot take focus: focus the chosen row once it shows.
  const placed = style.visibility !== "hidden";
  useEffect(() => {
    if (!open || !placed) return;
    const on = panel.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (on ?? panel.current?.querySelector<HTMLElement>(ITEM))?.focus();
  }, [open, placed, panel]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === "ArrowDown"
        ? (at + 1) % nodes.length
        : event.key === "ArrowUp"
          ? (at - 1 + nodes.length) % nodes.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? nodes.length - 1
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    nodes[to]?.focus();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}: ${chosen?.label ?? "none"}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md border border-line-control bg-field pr-2 pl-2.5 text-left text-base text-fg",
          "transition-[border-color,background-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none",
          open && "border-line-hover bg-raised",
          className,
        )}
      >
        {(lead ?? chosen?.lead) !== undefined && (
          <span className="flex shrink-0">{lead ?? chosen?.lead}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{chosen?.label ?? ""}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="menu"
            aria-label={label}
            style={{ ...style, ...(menuWidth === undefined ? {} : { minWidth: menuWidth }) }}
            onKeyDown={onKeyDown}
            className={cn("z-50 flex max-w-[360px] flex-col overflow-y-auto rounded-lg p-1.5", GLASS_STRONG)}
          >
            {options.map((option, i) => {
              const checked = option.value === value;
              const heading = option.group !== undefined && option.group !== options[i - 1]?.group;
              return [
                heading && (
                  <p
                    key={`group:${option.group}`}
                    role="presentation"
                    className="mt-1 shrink-0 border-t border-line px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase"
                  >
                    {option.group}
                  </p>
                ),
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                    onChange(option.value);
                  }}
                  className={cn(
                    "flex h-8 min-w-0 shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-base hover:bg-raised focus-visible:bg-raised focus-visible:outline-none",
                    checked ? cn(ROW_SELECTED, "font-medium") : "text-fg-soft",
                  )}
                >
                  {option.lead !== undefined && <span className="flex shrink-0">{option.lead}</span>}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.detail !== undefined && (
                    <span className="tnum shrink-0 font-mono text-sm font-normal text-fg-faint">
                      {option.detail}
                    </span>
                  )}
                  {checked && option.detail === undefined && (
                    <Check
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-accent-text"
                      strokeWidth={2.5}
                    />
                  )}
                </button>,
              ];
            })}
          </div>,
          container,
        )}
    </>
  );
}
