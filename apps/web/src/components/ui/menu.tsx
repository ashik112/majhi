import { Check, MoreHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: "danger";
  disabled?: boolean;
  /** Marks the current choice in a pick-one list. */
  checked?: boolean;
  /** Items with a group get its name as a small heading above the first of them. */
  group?: string;
  /** A small mark before the label. */
  icon?: ReactNode;
}

export interface TriggerProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
}

/** A small menu button. Arrow keys move, Enter picks, Esc closes and returns focus. */
export function Menu({
  label,
  icon,
  items,
  trigger,
  align = "right",
  maxHeight,
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  /** Replaces the icon button: gets the props the trigger needs. */
  trigger?: (props: TriggerProps) => ReactNode;
  align?: "left" | "right";
  /** Taller than the default before it scrolls, for a list that should show whole. */
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({
    open,
    close,
    trigger: triggerRef,
    align,
    ...(maxHeight === undefined ? {} : { maxHeight }),
  });

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open, panel]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nodes = Array.from(
      panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    );
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    nodes[(next + nodes.length) % nodes.length]?.focus();
  }

  const triggerProps: TriggerProps = {
    ref: triggerRef,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onClick: () => setOpen((v) => !v),
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only relays keys from the menu items
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      {trigger ? (
        trigger(triggerProps)
      ) : (
        <Button variant="ghost" size="icon" aria-label={label} {...triggerProps}>
          {icon ?? <MoreHorizontal aria-hidden="true" />}
        </Button>
      )}
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="menu"
            aria-label={label}
            style={style}
            className={cn(
              "z-50 flex min-w-40 max-w-72 flex-col overflow-y-auto rounded-lg p-1",
              GLASS_STRONG,
            )}
          >
            {items.map((item, i) => [
              item.group !== undefined && item.group !== items[i - 1]?.group && (
                <p
                  key={`group:${item.group}`}
                  role="presentation"
                  className={cn(
                    "shrink-0 px-2.5 pt-1.5 pb-1 text-xs font-medium tracking-[0.08em] text-fg-faint uppercase",
                    i > 0 && "mt-1 border-t border-line pt-2",
                  )}
                >
                  {item.group}
                </p>
              ),
              <button
                key={`${item.group ?? ""}:${item.label}`}
                type="button"
                {...(item.checked === undefined
                  ? { role: "menuitem" }
                  : { role: "menuitemradio", "aria-checked": item.checked })}
                disabled={item.disabled}
                title={item.label}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-sm px-2.5 text-left text-base whitespace-nowrap hover:bg-raised focus-visible:bg-raised focus-visible:outline-none disabled:opacity-45",
                  item.tone === "danger" ? "text-red" : "text-fg",
                )}
              >
                {item.checked !== undefined && (
                  <span aria-hidden="true" className="flex w-3 justify-center text-accent-text">
                    {item.checked && <Check className="size-3.5" strokeWidth={2.5} />}
                  </span>
                )}
                {item.icon !== undefined && (
                  <span aria-hidden="true" className="flex shrink-0 items-center">
                    {item.icon}
                  </span>
                )}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>,
            ])}
          </div>,
          container,
        )}
    </div>
  );
}
