import { Sun } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import {
  DENSITIES,
  DENSITY_LABEL,
  type Density,
  MODE_LABEL,
  MODES,
  type Mode,
  setLook,
  THEME_IDS,
  THEME_LABEL,
  type ThemeId,
  useLook,
} from "@/lib/look";

/** The top bar's sun button: a popover with the theme, the mode and the density. Saved in this browser. */
export function AppearanceButton() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  // The panel renders in a portal in the top layer: the glass panes of the console each form a
  // stacking context, and a panel inside the top bar would be painted under them.
  const { panel, style, container } = useAnchoredPanel({ open, close, trigger, align: "right" });

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("[aria-pressed='true']")?.focus();
  }, [open, panel]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label="Appearance"
        onClick={() => setOpen((v) => !v)}
        className="cs-iconbtn"
      >
        <Sun aria-hidden="true" className="size-[15px]" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="dialog"
            aria-label="Appearance"
            style={style}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }}
            className={cn(
              "z-[var(--z-float)] flex w-[248px] flex-col gap-2.5 rounded-xl p-2.5",
              GLASS_STRONG,
            )}
          >
            <AppearanceControls hint={false} />
          </div>,
          container,
        )}
    </>
  );
}

function Segment<T extends string>({
  label,
  options,
  value,
  labels,
  onPick,
}: {
  label: string;
  options: readonly T[];
  value: T;
  labels: Record<T, string>;
  onPick: (next: T) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-xs text-fg-faint">{label}</legend>
      <div className="cs-seg w-full">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onPick(option)}
            className="flex-1 justify-center"
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Theme swatches, then mode and density. In the top bar's popover and on Hub setup. */
export function AppearanceControls({ className, hint = true }: { className?: string; hint?: boolean }) {
  const look = useLook();
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs text-fg-faint">Theme</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {THEME_IDS.map((theme: ThemeId) => (
            <button
              key={theme}
              type="button"
              aria-pressed={look.theme === theme}
              data-look-swatch={theme}
              onClick={() => setLook({ theme })}
              className="cs-swatch"
            >
              <span>{THEME_LABEL[theme]}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <Segment<Mode>
        label="Mode"
        options={MODES}
        value={look.mode}
        labels={MODE_LABEL}
        onPick={(mode) => setLook({ mode })}
      />
      <Segment<Density>
        label="Density"
        options={DENSITIES}
        value={look.density}
        labels={DENSITY_LABEL}
        onPick={(density) => setLook({ density })}
      />
      {hint && <p className="text-xs text-fg-faint">Saved in this browser.</p>}
    </div>
  );
}
