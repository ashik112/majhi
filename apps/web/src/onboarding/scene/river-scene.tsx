import "@fontsource/baloo-da-2/latin-600.css";
import "@fontsource/baloo-da-2/latin-700.css";
import { useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Boat } from "./boat";
import { SIGN_RATIO, stopPlaces, VIEW_H, VIEW_W } from "./geometry";

export type StopState = "done" | "current" | "skipped" | "todo";

export interface SceneStop {
  id: string;
  title: string;
  state: StopState;
}

const STATE_WORD: Record<StopState, string | undefined> = {
  done: "Done",
  current: "You are here",
  skipped: "Skipped",
  todo: undefined,
};

/** The two lamps on the ghat steps in the painting, which light up when the journey arrives. */
const GHAT_LAMPS: readonly { x: number; y: number }[] = [
  { x: 360, y: 398 },
  { x: 652, y: 398 },
];

/**
 * Where the painting lands in the box it fills, as `background-size: cover` at the bottom: the sky
 * is cropped first, and a narrow panel crops the sides.
 */
interface Fit {
  scale: number;
  x: number;
  y: number;
  /** The box width, so a sign cropped by a narrow panel can slide back inside it. */
  width: number;
}

function useFit(box: React.RefObject<HTMLElement | null>): Fit | null {
  const [fit, setFit] = useState<Fit | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const scale = Math.max(width / VIEW_W, height / VIEW_H);
      setFit({ scale, x: (width - VIEW_W * scale) / 2, y: height - VIEW_H * scale, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return fit;
}

/** True while the tab is visible, so loops can pause when nobody can see them. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

const PLACES = stopPlaces(7);

/**
 * The journey as a rickshaw-art river painting, by day in the light theme and by moonlight in the
 * dark one. The stops are painted signboards on the banks, near to far, and the majhi's boat waits
 * at the current one with its robot crew. The signboards are real buttons, so the list of steps is
 * also the way back to any of them. At the end the boat reaches the ghat and its lamps light.
 */
export function RiverScene({
  stops,
  current,
  arrived,
  onPick,
  className,
}: {
  stops: readonly SceneStop[];
  current: number;
  /** The last stop is reached: the boat is at the ghat and its lamps light. */
  arrived: boolean;
  onPick: (index: number) => void;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box);
  const reduced = useReducedMotion() ?? false;
  const visible = usePageVisible();
  const places = PLACES.slice(0, stops.length);
  const here = places[Math.min(current, places.length - 1)];

  return (
    <div
      ref={box}
      className={cn("rv-scene relative isolate overflow-hidden", className)}
      data-paused={visible ? undefined : ""}
      data-arrived={arrived ? "" : undefined}
      data-still={reduced ? "" : undefined}
    >
      {/* The painting: a CSS background, so only the current theme's picture is downloaded. */}
      <div aria-hidden="true" className="rv-painting absolute inset-0" />
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 size-full"
      >
        <defs>
          <radialGradient id={`${id}-lamp`}>
            <stop offset="0" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0.9 }} />
            <stop offset="0.4" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0.35 }} />
            <stop offset="1" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        {/* The ghat's lamps and a warm pool on the water, when the journey arrives. */}
        <g className="rv-arrive">
          <ellipse cx="506" cy="440" rx="190" ry="40" fill={`url(#${id}-lamp)`} />
          {GHAT_LAMPS.map((l) => (
            <circle key={l.x} cx={l.x} cy={l.y} r="64" fill={`url(#${id}-lamp)`} className="rv-breathe" />
          ))}
        </g>

        {here && <Boat s={here.s} still={reduced} />}
      </svg>

      {fit && (
        <nav aria-label="Setup progress" className="absolute inset-0">
          <ol className="m-0 list-none p-0">
            {stops.map((s, i) => {
              const p = places[i];
              if (!p) return null;
              const word = STATE_WORD[s.state];
              const w = p.signW * fit.scale;
              const h = w * SIGN_RATIO;
              const font = Math.max(11, Math.min(15.5, w * 0.13));
              return (
                <li
                  key={s.id}
                  className="absolute"
                  style={{
                    left: Math.max(6, Math.min(fit.width - w - 6, fit.x + p.sign.x * fit.scale - w / 2)),
                    top: fit.y + p.sign.y * fit.scale - h,
                    width: w,
                    height: h,
                  }}
                >
                  <button
                    type="button"
                    aria-current={s.state === "current" ? "step" : undefined}
                    onClick={() => onPick(i)}
                    data-state={s.state}
                    className="rv-sign group size-full cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ "--rv-font": `${font.toFixed(1)}px` } as CSSProperties}
                  >
                    <span className="rv-sign-text">
                      <span className="rv-sign-title">{s.title}</span>
                      {word && <span className="rv-sign-word">{word}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
    </div>
  );
}
