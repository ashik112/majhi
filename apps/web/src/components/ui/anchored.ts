import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Undoes the browser's popover placement (centred, inset 0), so the panel sits where `style` says. */
const RESET: CSSProperties = { position: "fixed", inset: "auto", margin: 0 };

/** The panel keeps this far from the window's edges. */
const EDGE = 8;

/**
 * Where a floating panel sits: fixed, anchored to its trigger, below it or above when there is more
 * room there, never past the window on any side. Floating panels render in a portal because every
 * glass panel forms its own layer, so a menu inside one is painted over by the panels after it.
 *
 * While open, it closes on a click outside (trigger and panel both count as inside) and on a window
 * resize. A scroll does not close it: a room that streams scrolls its log on every message, and a
 * menu must stay open through that. A scroll that moves the trigger moves the panel with it, and the
 * panel closes only once its trigger has left the window.
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
  maxHeight = 288,
}: {
  open: boolean;
  close: () => void;
  trigger: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  /** The panel is at least as wide as the trigger. */
  matchWidth?: boolean;
  /** The tallest the panel gets before it scrolls, when the window has the room. */
  maxHeight?: number;
}): { panel: RefObject<HTMLDivElement | null>; style: CSSProperties; container: Element } {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ ...RESET, visibility: "hidden" });

  const place = useCallback(() => {
    const t = trigger.current?.getBoundingClientRect();
    if (!t) return;
    const node = panel.current;
    if (node?.popover && !node.matches(":popover-open")) node.showPopover();
    const below = window.innerHeight - t.bottom - EDGE;
    const above = t.top - EDGE;
    const up = below < 240 && above > below;
    // The panel's own width, so a left-aligned panel near the right edge moves in rather than
    // running off the window (and a right-aligned one near the left edge).
    const width = Math.max(node?.offsetWidth ?? 0, matchWidth ? t.width : 0);
    const room = window.innerWidth - EDGE;
    const horizontal =
      align === "right"
        ? { right: Math.max(EDGE, Math.min(window.innerWidth - t.right, room - width)) }
        : { left: Math.max(EDGE, Math.min(t.left, room - width)) };
    setStyle({
      ...RESET,
      ...(up ? { bottom: window.innerHeight - t.top + 4 } : { top: t.bottom + 4 }),
      ...horizontal,
      maxHeight: Math.min(maxHeight, (up ? above : below) - 4),
      maxWidth: window.innerWidth - 2 * EDGE,
      ...(matchWidth ? { minWidth: t.width } : {}),
    });
  }, [align, matchWidth, maxHeight, trigger]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (trigger.current?.contains(target) || panel.current?.contains(target));
    const onOutside = (event: Event) => {
      if (!inside(event.target)) close();
    };
    const onScroll = (event: Event) => {
      const scrolled = event.target;
      // A scroll inside the panel, or in a region that does not hold the trigger, leaves it be.
      if (inside(scrolled)) return;
      const moved = scrolled === document || (scrolled instanceof Node && scrolled.contains(trigger.current));
      if (!moved) return;
      const t = trigger.current?.getBoundingClientRect();
      if (!t || t.bottom < 0 || t.top > window.innerHeight) close();
      else place();
    };
    document.addEventListener("pointerdown", onOutside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close, trigger, place]);

  const container = (open && trigger.current?.closest("dialog[open]")) || document.body;
  return { panel, style, container };
}
