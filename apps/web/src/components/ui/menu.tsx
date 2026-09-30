import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
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
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  /** Replaces the icon button: gets the props the trigger needs. */
  trigger?: (props: TriggerProps) => ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

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
      root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
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
          {icon}
        </Button>
      )}
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className={cn(
            "absolute top-full z-30 mt-1 flex max-h-72 min-w-40 max-w-72 flex-col overflow-y-auto rounded-lg p-1",
            GLASS_STRONG,
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
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
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
