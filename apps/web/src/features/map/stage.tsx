import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

export interface StageHandle {
  zoom(factor: number): void;
  fit(): void;
}

interface Props {
  w: number;
  h: number;
  /** Room above the picture for the title row and lane titles. */
  top: number;
  /** Room under it for the legend and the not-connected strip. */
  bottom: number;
  /** The most "fit" may enlarge a small picture. */
  maxScale: number;
  /** Keep the smallest text of the boxes at least `min` px on screen: `size` is its size at scale 1. */
  minText?: { size: number; min: number };
  /** Fit again when this changes (a new picture). */
  fitKey: string;
  onBackground: () => void;
  children: ReactNode;
}

const INTERACTIVE = ".node,.edge,.jhead,[data-step],.pill,.badge,.entry-more";

/**
 * Pan, wheel zoom and fit for one picture. The transform lives in refs and is written straight to the
 * element, so dragging never renders React. The picture is centered between its top and bottom room.
 */
export const Stage = forwardRef<StageHandle, Props>(function Stage(
  { w, h, top, bottom, maxScale, minText, fitKey, onBackground, children },
  handle,
) {
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const t = useRef({ fit: 1, z: 1, px: 0, py: 0, sw: 0, sh: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const dims = useRef({ w, h, top, bottom, maxScale, minText });
  dims.current = { w, h, top, bottom, maxScale, minText };

  const apply = useCallback(() => {
    const el = world.current;
    const d = dims.current;
    const c = t.current;
    if (el === null) return;
    const s = c.fit * c.z;
    const tx = (c.sw - d.w * s) / 2 + c.px;
    const ty = d.top + (c.sh - d.top - d.bottom - d.h * s) / 2 + c.py;
    el.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    el.classList.toggle("lod-low", s < 0.7);
    const boost =
      d.minText === undefined ? 1 : Math.min(1.3, Math.max(1, d.minText.min / (d.minText.size * s)));
    el.style.setProperty("--fz", String(boost));
  }, []);

  const fit = useCallback(() => {
    const el = stage.current;
    if (el === null) return;
    const d = dims.current;
    const sw = el.clientWidth;
    const sh = el.clientHeight;
    const s = Math.min((sw - 24) / d.w, (sh - d.top - d.bottom) / d.h, d.maxScale);
    t.current = { fit: Math.max(0.2, s), z: 1, px: 0, py: 0, sw, sh };
    apply();
  }, [apply]);

  useImperativeHandle(
    handle,
    () => ({
      zoom: (f) => {
        t.current.z = Math.max(0.4, Math.min(2.4, t.current.z * f));
        apply();
      },
      fit,
    }),
    [apply, fit],
  );

  // A new picture or a new size of it: fit again. A resize of the canvas too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit exactly when the picture or its room changes
  useLayoutEffect(fit, [fit, fitKey, w, h, top, bottom]);
  useEffect(() => {
    const el = stage.current;
    if (el === null) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      t.current.z = Math.max(0.4, Math.min(2.4, t.current.z * (e.deltaY < 0 ? 1.08 : 0.93)));
      apply();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, [fit, apply]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard clearing is Esc, handled by the page
    // biome-ignore lint/a11y/noStaticElementInteractions: the canvas background pans and clears the pick
    <div
      ref={stage}
      className="stage"
      onPointerDown={(e) => {
        if ((e.target as Element).closest(INTERACTIVE)) return;
        drag.current = { x: e.clientX, y: e.clientY, px: t.current.px, py: t.current.py, moved: false };
        dragged.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d === null) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          d.moved = true;
          dragged.current = true;
          e.currentTarget.classList.add("drag");
        }
        if (d.moved) {
          t.current.px = d.px + dx;
          t.current.py = d.py + dy;
          apply();
        }
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.classList.remove("drag");
      }}
      onClick={(e) => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        if (!(e.target as Element).closest(INTERACTIVE)) onBackground();
      }}
    >
      <div ref={world} className="world" style={{ width: w, height: h }}>
        {children}
      </div>
    </div>
  );
});
