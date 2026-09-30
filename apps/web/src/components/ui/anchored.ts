import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Where a floating panel sits: fixed, anchored to its trigger, below it or above when there is more
 * room there, never past the window. Floating panels render in a portal because every glass panel
 * forms its own layer, so a menu inside one is painted over by the panels after it. While open,
 * a click outside (trigger and panel both count as inside), any scroll or a resize closes it.
 */
export function useAnchoredPanel({
  open,
  close,
  trigger,
  align = "left",
  matchWidth = false,
}: {
  open: boolean;
  close: () => void;
  trigger: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  /** The panel is at least as wide as the trigger. */
  matchWidth?: boolean;
}): { panel: RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const t = trigger.current?.getBoundingClientRect();
    if (!t) return;
    const below = window.innerHeight - t.bottom - 8;
    const above = t.top - 8;
    const up = below < 240 && above > below;
    setStyle({
      position: "fixed",
      ...(up ? { bottom: window.innerHeight - t.top + 4 } : { top: t.bottom + 4 }),
      ...(align === "right" ? { right: window.innerWidth - t.right } : { left: t.left }),
      maxHeight: Math.min(288, (up ? above : below) - 4),
      ...(matchWidth ? { minWidth: t.width } : {}),
    });
  }, [open, align, matchWidth, trigger]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (trigger.current?.contains(target) || panel.current?.contains(target));
    const onOutside = (event: Event) => {
      if (!inside(event.target)) close();
    };
    document.addEventListener("pointerdown", onOutside);
    window.addEventListener("scroll", onOutside, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      window.removeEventListener("scroll", onOutside, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close, trigger]);

  return { panel, style };
}
