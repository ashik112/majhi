import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  ACCENT_LABEL,
  ACCENTS,
  type Accent,
  setAppearance,
  type ThemeChoice,
  useAppearance,
} from "@/lib/appearance";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";

const THEME_ROWS: readonly { value: ThemeChoice; label: string; icon: typeof Moon }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

/** Swatch colors: the accent as it shows in the dark theme, where the swatches are picked most. */
const SWATCH: Record<Accent, string> = {
  amber: "#f0b455",
  cyan: "#4cc9e8",
  violet: "#a98bf5",
  green: "#5fd39f",
  rose: "#f47a9b",
};

/** The sidebar's Appearance button: a popover with the theme and the accent. Saved in this browser. */
export function AppearanceButton() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const appearance = useAppearance();

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[aria-pressed='true']")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only closes the popover on Esc
    <div
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label="Appearance"
        title="Appearance: theme and accent"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-raised hover:text-fg",
          open && "bg-selected text-fg",
        )}
      >
        <Palette aria-hidden="true" className="size-4" />
      </button>
      {open && (
        <section
          id={id}
          aria-label="Appearance"
          className={cn(
            "absolute bottom-0 left-full z-40 ml-4 flex w-[232px] animate-rise flex-col gap-3 rounded-xl p-3",
            GLASS_STRONG,
          )}
        >
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 text-sm font-medium text-fg-soft">Theme</legend>
            <div className="grid grid-cols-3 gap-1 rounded-[9px] border border-line-strong bg-field p-[3px]">
              {THEME_ROWS.map(({ value, label, icon: Icon }) => {
                const on = appearance.theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setAppearance({ theme: value })}
                    className={cn(
                      "flex h-12 cursor-pointer flex-col items-center justify-center gap-1 rounded-md text-xs transition-colors duration-150",
                      on
                        ? "bg-selected text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
                        : "text-fg-muted hover:bg-raised hover:text-fg",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="m-0 flex flex-col border-0 p-0">
            <legend className="mb-2 text-sm font-medium text-fg-soft">Accent</legend>
            <div className="flex items-center gap-2">
              {ACCENTS.map((accent) => {
                const on = appearance.accent === accent;
                return (
                  <button
                    key={accent}
                    type="button"
                    aria-pressed={on}
                    aria-label={ACCENT_LABEL[accent]}
                    title={ACCENT_LABEL[accent]}
                    onClick={() => setAppearance({ accent })}
                    style={{ backgroundColor: SWATCH[accent] }}
                    className={cn(
                      "grid size-7 cursor-pointer place-items-center rounded-full text-[#10141b] transition-transform duration-150 hover:scale-110",
                      on && "ring-2 ring-fg ring-offset-2 ring-offset-[var(--c-glass-strong)]",
                    )}
                  >
                    {on && <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
            <p className="mt-2.5 text-xs text-fg-faint">Saved in this browser.</p>
          </fieldset>
        </section>
      )}
    </div>
  );
}
