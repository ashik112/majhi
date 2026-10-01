import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Undoes the browser's popover placement (centred, inset 0), so the panel sits where `style` says. */
const RESET: CSSProperties = { position: "fixed", inset: "auto", margin: 0 };

/**
 * Where a floating panel sits: fixed, anchored to its trigger, below it or above when there is more
 * room there, never past the window. Floating panels render in a portal because every glass panel
 * forms its own layer, so a menu inside one is painted over by the panels after it. While open,
 * a click outside (trigger and panel both count as inside), any scroll or a resize closes it.
 *
 * The panel is a manual popover (`popover="manual"` on it) shown in the top layer, and the portal
 * goes into the open `<dialog>` around the trigger when there is one. A modal dialog makes the rest
 * of the page inert and sits in the top layer itself, so a panel portaled to `body` would be painted
 * under the dialog and could not be clicked.
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
}): { panel: RefObject<HTMLDivElement | null>; style: CSSProperties; container: Element } {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ ...RESET, visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const t = trigger.current?.getBoundingClientRect();
    if (!t) return;
    const below = window.innerHeight - t.bottom - 8;
    const above = t.top - 8;
    const up = below < 240 && above > below;
    const node = panel.current;
    if (node?.popover && !node.matches(":popover-open")) node.showPopover();
    setStyle({
      ...RESET,
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

  const container = (open && trigger.current?.closest("dialog[open]")) || document.body;
  return { panel, style, container };
}
