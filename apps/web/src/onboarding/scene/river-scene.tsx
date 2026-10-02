import { useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Boat } from "./boat";
import { Diyas } from "./diyas";
import {
  FLOW_LINES,
  HORIZON,
  LEFT_BANK,
  pointAt,
  RIGHT_BANK,
  RIVER_LENGTH,
  RIVER_PATH,
  STARS,
  type StopPlace,
  stopPlaces,
  VIEW_H,
  VIEW_W,
  widthAt,
} from "./geometry";

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

/** Where the view box lands in the box it fills, with `xMidYMax slice`: the sky is cropped first. */
interface Fit {
  scale: number;
  x: number;
  y: number;
}

function useFit(box: React.RefObject<HTMLElement | null>): Fit | null {
  const [fit, setFit] = useState<Fit | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const scale = Math.max(width / VIEW_W, height / VIEW_H);
      setFit({ scale, x: (width - VIEW_W * scale) / 2, y: height - VIEW_H * scale });
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
 * The journey as a river at dusk (dark theme) or by day (light theme): the stops are lanterns on
 * the banks, near to far, and the boat waits at the current one. Done stops are lit, the current
 * one glows, skipped ones stay dim. The stop labels are real buttons over the drawing, so the list
 * of steps is also the way back to any of them.
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
  /** The last stop is reached: the ghat lights up and lamps float on the water. */
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
  const last = places[places.length - 1];
  const url = (name: string) => `url(#${id}-${name})`;
  const stop = (offset: number, color: string, opacity = 1) => (
    <stop offset={offset} style={{ stopColor: color, stopOpacity: opacity }} />
  );

  return (
    <div
      ref={box}
      className={cn("rv-scene relative isolate overflow-hidden", className)}
      data-paused={visible ? undefined : ""}
      data-arrived={arrived ? "" : undefined}
      data-still={reduced ? "" : undefined}
    >
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 size-full"
      >
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
            {stop(0, "var(--rv-sky-top)")}
            {stop(0.55, "var(--rv-sky-mid)")}
            {stop(0.92, "var(--rv-sky-low)")}
            {stop(1, "var(--rv-sky-low)")}
          </linearGradient>
          <radialGradient id={`${id}-sunglow`} cx="0.5" cy="0.5" r="0.5">
            {stop(0, "var(--rv-sun-glow)")}
            {stop(0.45, "var(--rv-sun-glow)", 0.35)}
            {stop(1, "var(--rv-sun-glow)", 0)}
          </radialGradient>
          <radialGradient id={`${id}-horizon`} cx="0.5" cy="1" r="0.75">
            {stop(0, "var(--rv-sky-glow)")}
            {stop(1, "var(--rv-sky-glow)", 0)}
          </radialGradient>
          <linearGradient id={`${id}-land`} x1="0" y1="0" x2="0" y2="1">
            {stop(0, "var(--rv-land-far)")}
            {stop(1, "var(--rv-land-near)")}
          </linearGradient>
          <linearGradient
            id={`${id}-water`}
            x1="0"
            y1={HORIZON}
            x2="0"
            y2={VIEW_H}
            gradientUnits="userSpaceOnUse"
          >
            {stop(0, "var(--rv-water-far)")}
            {stop(0.22, "var(--rv-water-mid)")}
            {stop(1, "var(--rv-water-near)")}
          </linearGradient>
          <radialGradient id={`${id}-lamp`}>
            {stop(0, "var(--rv-lantern)", 0.85)}
            {stop(0.35, "var(--rv-lantern)", 0.32)}
            {stop(1, "var(--rv-lantern)", 0)}
          </radialGradient>
          <radialGradient id={`${id}-pool`}>
            {stop(0, "var(--rv-lantern)", 0.32)}
            {stop(1, "var(--rv-lantern)", 0)}
          </radialGradient>
          <linearGradient id={`${id}-cloud`} x1="0" y1="0" x2="1" y2="0">
            {stop(0, "var(--rv-cloud)", 0)}
            {stop(0.3, "var(--rv-cloud)")}
            {stop(0.7, "var(--rv-cloud)")}
            {stop(1, "var(--rv-cloud)", 0)}
          </linearGradient>
          <clipPath id={`${id}-river`}>
            <path d={RIVER_PATH} />
          </clipPath>
          <symbol id={`${id}-palm`} overflow="visible">
            <path d="M-2.4 0 C -0.5 -40, 1.5 -72, 7 -102 L 10 -101 C 5.5 -72, 3.6 -40, 2.6 0 Z" />
            <path d="M8 -101 C -6 -110, -24 -106, -36 -90 C -22 -99, -8 -101, 8 -99 Z" />
            <path d="M8 -101 C -2 -118, -18 -124, -30 -120 C -16 -116, -4 -110, 8 -99 Z" />
            <path d="M8 -101 C 12 -120, 22 -128, 34 -126 C 24 -120, 14 -112, 9 -99 Z" />
            <path d="M8 -101 C 24 -108, 40 -102, 48 -88 C 36 -96, 22 -100, 9 -99 Z" />
            <path d="M8 -101 C 18 -96, 26 -84, 26 -70 C 20 -82, 14 -92, 8 -99 Z" />
            <path d="M8 -101 C -2 -96, -10 -84, -12 -72 C -4 -84, 2 -92, 8 -99 Z" />
          </symbol>
          <symbol id={`${id}-hut`} overflow="visible">
            <path d="M-15 0 L-15 -11 L15 -11 L15 0 Z" />
            <path d="M-21 -10 C -10 -27, 10 -27, 21 -10 Z" />
          </symbol>
        </defs>

        {/* Sky, the low sun and its glow. */}
        <rect width={VIEW_W} height={HORIZON + 2} fill={url("sky")} />
        <rect x="-40" y={HORIZON - 200} width={VIEW_W + 80} height="200" fill={url("horizon")} />
        <g style={{ opacity: "var(--rv-stars)" }}>
          {STARS.map((s) => (
            <circle
              key={`${s.x.toFixed(1)}-${s.y.toFixed(1)}`}
              cx={s.x}
              cy={s.y}
              r={s.r}
              fill="var(--rv-star)"
              className={s.twinkle ? "rv-twinkle" : undefined}
              style={
                {
                  "--rv-delay": `${s.delay.toFixed(2)}s`,
                  opacity: s.twinkle ? undefined : 0.55,
                } as CSSProperties
              }
            />
          ))}
        </g>
        <circle cx="262" cy="292" r="150" fill={url("sunglow")} />
        <circle cx="262" cy="296" r="19" fill="var(--rv-sun)" />
        <ellipse className="rv-arrive" cx="262" cy="306" rx="240" ry="120" fill={url("sunglow")} />
        <g className="rv-cloud" style={{ "--rv-dur": "80s" } as CSSProperties} fill={url("cloud")}>
          <ellipse cx="120" cy="200" rx="96" ry="5" />
          <ellipse cx="170" cy="190" rx="54" ry="3.5" />
        </g>
        <g className="rv-cloud" style={{ "--rv-dur": "110s" } as CSSProperties} fill={url("cloud")}>
          <ellipse cx="380" cy="232" rx="80" ry="4" />
          <ellipse cx="420" cy="140" rx="60" ry="3" opacity="0.7" />
        </g>
        <g style={{ opacity: "var(--rv-birds)" }} fill="none" stroke="var(--rv-ink-far)" strokeWidth="1.1">
          <path
            className="rv-bird"
            d="M0 120 q 4 -4 8 0 q 4 -4 8 0"
            style={{ "--rv-dur": "52s" } as CSSProperties}
          />
          <path
            className="rv-bird"
            d="M-20 138 q 3 -3 6 0 q 3 -3 6 0"
            style={{ "--rv-dur": "60s", "--rv-delay": "-18s" } as CSSProperties}
          />
          <path
            className="rv-bird"
            d="M-8 104 q 3 -3 6 0 q 3 -3 6 0"
            style={{ "--rv-dur": "64s", "--rv-delay": "-34s" } as CSSProperties}
          />
        </g>

        {/* Far hills, then nearer shoulders on both sides of the valley the river comes out of. */}
        <path
          d={`M0 ${HORIZON} L0 288 C 40 270, 80 284, 120 276 C 160 268, 196 290, 228 304 L 300 306 C 330 288, 370 270, 410 278 C 440 284, 462 276, 480 270 L480 ${HORIZON} Z`}
          fill="var(--rv-hill-far)"
        />
        <path
          d={`M0 ${HORIZON + 1} L0 262 C 30 254, 62 270, 100 284 C 140 298, 176 306, 214 ${HORIZON + 1} Z`}
          fill="var(--rv-hill-mid)"
        />
        <path
          d={`M480 ${HORIZON + 1} L480 252 C 452 248, 420 266, 384 284 C 350 300, 320 307, 300 ${HORIZON + 1} Z`}
          fill="var(--rv-hill-mid)"
        />

        {/* The land, with faint contour lines that tighten toward the horizon. */}
        <rect y={HORIZON} width={VIEW_W} height={VIEW_H - HORIZON} fill={url("land")} />
        <g stroke="var(--rv-contour)" strokeWidth="1">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => {
            const y = HORIZON + (VIEW_H + 80 - HORIZON) * (k / 10) ** 2;
            return <line key={k} x1="0" x2={VIEW_W} y1={y} y2={y} />;
          })}
        </g>

        {/* Far trees and a hut, small with distance. */}
        <g fill="var(--rv-ink-far)">
          <use href={`#${id}-palm`} transform="translate(176 336) scale(0.24)" />
          <use href={`#${id}-palm`} transform="translate(190 340) scale(0.2) scale(-1 1)" />
          <use href={`#${id}-palm`} transform="translate(338 344) scale(0.26)" />
          <use href={`#${id}-hut`} transform="translate(360 352) scale(0.4)" />
        </g>

        {/* The river. */}
        <path d={RIVER_PATH} fill={url("water")} />
        <g clipPath={url("river")}>
          {/* The sun's reflection, a column of light down the far water. */}
          {Array.from({ length: 12 }, (_, i) => {
            const y = HORIZON + 4 + i * 7;
            const p = pointAt(lengthNear(y));
            const w = Math.max(2, widthAt(y) * 0.5 * (1 - i / 13));
            return (
              <line
                key={y}
                x1={p.x - w / 2}
                x2={p.x + w / 2}
                y1={y}
                y2={y}
                stroke="var(--rv-shimmer)"
                strokeWidth={0.7 + i * 0.05}
                strokeLinecap="round"
                className="rv-shimmer-line"
                style={{ "--rv-delay": `${-(i * 0.47).toFixed(2)}s` } as CSSProperties}
              />
            );
          })}
          {FLOW_LINES.map((f) => (
            <g
              key={`${f.x.toFixed(1)}-${f.y.toFixed(1)}`}
              transform={`translate(${f.x.toFixed(1)} ${f.y.toFixed(1)})`}
            >
              <line
                x1={-f.length / 2}
                x2={f.length / 2}
                y1="0"
                y2="0"
                stroke="var(--rv-flow)"
                strokeWidth={f.width}
                strokeLinecap="round"
                className="rv-flow-line"
                style={
                  {
                    "--rv-delay": `${f.delay.toFixed(2)}s`,
                    "--rv-dur": `${f.duration.toFixed(2)}s`,
                    "--rv-drift": `${f.drift.toFixed(1)}px`,
                  } as CSSProperties
                }
              />
            </g>
          ))}
          {/* Light pooled on the water under each lit lantern. */}
          {places.map((p, i) => {
            const s = stops[i]?.state;
            const lit = s === "done" || s === "current";
            return (
              <ellipse
                key={stops[i]?.id ?? i}
                className="rv-glow"
                cx={p.lantern.x - p.side * 10 * p.scale}
                cy={p.boat.y + 6 * p.scale}
                rx={34 * p.scale}
                ry={7 * p.scale}
                fill={url("pool")}
                opacity={lit ? 1 : 0}
              />
            );
          })}
        </g>
        <path d={LEFT_BANK} fill="none" stroke="var(--rv-shore)" strokeWidth="1" />
        <path d={RIGHT_BANK} fill="none" stroke="var(--rv-shore)" strokeWidth="1" />

        <Ghat place={places[places.length - 1]} url={url} />

        {/* Near trees and reeds, large and dark at the bottom edge. */}
        <g fill="var(--rv-ink)">
          <use href={`#${id}-palm`} transform="translate(452 930) scale(1.2) scale(-1 1)" />
          <use href={`#${id}-palm`} transform="translate(420 944) scale(0.86)" />
          <use href={`#${id}-palm`} transform="translate(458 690) scale(0.62) scale(-1 1)" />
          <use href={`#${id}-hut`} transform="translate(56 600) scale(0.7)" />
          <use href={`#${id}-palm`} transform="translate(98 560) scale(0.46)" />
          <use href={`#${id}-palm`} transform="translate(416 470) scale(0.36) scale(-1 1)" />
        </g>
        <g stroke="var(--rv-ink)" strokeWidth="1.4" strokeLinecap="round" fill="none">
          {REEDS.map((r) => (
            <path key={r} d={r} />
          ))}
        </g>

        {places.map((p, i) => {
          const s = stops[i];
          return s ? <Lantern key={s.id} place={p} state={s.state} url={url} /> : null;
        })}

        {/* Lamps set on the water at the ghat when the journey arrives. */}
        <g className="rv-arrive">
          {arrived && last && <Diyas from={last.s - 4} still={reduced} lamp={url("lamp")} />}
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
              const left = fit.x + p.lantern.x * fit.scale;
              const top = fit.y + (p.lantern.y - 24 * p.scale) * fit.scale;
              return (
                <li
                  key={s.id}
                  className="absolute"
                  style={{
                    left,
                    top,
                    transform: p.side > 0 ? "translate(12px, -50%)" : "translate(calc(-100% - 12px), -50%)",
                  }}
                >
                  <button
                    type="button"
                    aria-current={s.state === "current" ? "step" : undefined}
                    onClick={() => onPick(i)}
                    className={cn(
                      "group flex cursor-pointer flex-col rounded-md px-1.5 py-0.5 [text-shadow:0_0_6px_var(--rv-label-halo),0_0_2px_var(--rv-label-halo)]",
                      "focus-visible:outline-2 focus-visible:outline-offset-1",
                      p.side > 0 ? "items-start text-left" : "items-end text-right",
                    )}
                  >
                    <span
                      className={cn(
                        "text-base leading-5 font-medium whitespace-nowrap transition-colors duration-300",
                        s.state === "current"
                          ? "text-fg"
                          : s.state === "todo"
                            ? "text-fg-muted group-hover:text-fg"
                            : "text-fg-soft group-hover:text-fg",
                      )}
                    >
                      {s.title}
                    </span>
                    {word && (
                      <span
                        className={cn(
                          "text-xs leading-4 whitespace-nowrap",
                          s.state === "current" ? "text-accent-text" : "text-fg-faint",
                        )}
                      >
                        {word}
                      </span>
                    )}
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

/** The arc length nearest height `y`, found by stepping down the river. Cheap enough for a dozen calls. */
function lengthNear(y: number): number {
  let best = RIVER_LENGTH;
  let gap = Number.POSITIVE_INFINITY;
  for (let s = RIVER_LENGTH; s > RIVER_LENGTH * 0.6; s -= 2) {
    const d = Math.abs(pointAt(s).y - y);
    if (d < gap) {
      gap = d;
      best = s;
    }
  }
  return best;
}

/** Reed tufts along both banks near the bottom edge. */
const REEDS: readonly string[] = (() => {
  const tufts: string[] = [];
  for (const [s, side] of [
    [40, -1],
    [70, -1],
    [130, 1],
    [170, 1],
    [250, -1],
    [300, 1],
  ] as const) {
    const p = pointAt(s);
    const x = p.x + (side * widthAt(p.y)) / 2 + side * 4;
    const h = 14 + (s % 3) * 4;
    tufts.push(
      `M${x} ${p.y} q ${-side * 2} ${-h / 2} ${-side * 1} ${-h} M${x + side * 3} ${p.y} q ${side * 1} ${-h / 2} ${side * 5} ${-h * 0.8} M${x + side * 6} ${p.y} q ${side * 2} ${-h / 3} ${side * 2} ${-h * 0.6}`,
    );
  }
  return tufts;
})();

function Lantern({
  place,
  state,
  url,
}: {
  place: StopPlace;
  state: StopState;
  url: (name: string) => string;
}) {
  const lit = state === "done" || state === "current";
  const { x, y } = place.lantern;
  const k = place.scale;
  const arm = place.side * -1;
  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(3)})`}>
      <circle
        cx={arm * 6}
        cy="-23"
        r="26"
        fill={url("lamp")}
        className={cn("rv-glow", state === "current" && "rv-breathe")}
        opacity={lit ? 1 : 0}
      />
      <path
        d={`M0 0 L0 -32 L${arm * 7} -32`}
        fill="none"
        stroke="var(--rv-ink)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d={`M${arm * 6} -32 L${arm * 6} -29`} stroke="var(--rv-ink)" strokeWidth="1" />
      <rect
        x={arm * 6 - 3.2}
        y="-29"
        width="6.4"
        height="9"
        rx="1.6"
        fill={lit ? "var(--rv-lantern)" : "var(--rv-ink)"}
        stroke={lit ? "var(--rv-lantern)" : "var(--rv-lantern-off)"}
        strokeWidth="1"
        className="rv-glow"
      />
      <rect
        x={arm * 6 - 1.3}
        y="-26.6"
        width="2.6"
        height="4.4"
        rx="1.2"
        fill="var(--rv-lantern-core)"
        className="rv-glow"
        opacity={lit ? 1 : 0}
      />
      {state === "current" && (
        <circle
          cx={arm * 6}
          cy="-24.5"
          r="11"
          fill="none"
          stroke="var(--c-accent)"
          strokeWidth="1.1"
          className="rv-breathe"
          opacity="0.9"
        />
      )}
    </g>
  );
}

/** Steps down to the water and a small shrine at the last stop: where the journey lands. */
function Ghat({ place, url }: { place: StopPlace | undefined; url: (name: string) => string }) {
  if (!place) return null;
  const k = place.scale;
  const edge = place.boat.x + (place.side * widthAt(place.boat.y)) / 2;
  const x0 = edge + place.side * 2;
  return (
    <g
      transform={`translate(${x0.toFixed(1)} ${(place.boat.y + 2).toFixed(1)}) scale(${(place.side * k).toFixed(3)} ${k.toFixed(3)})`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={i * 5} y={-3 - i * 3.4} width={58 - i * 5} height="3.4" fill="var(--rv-ink-far)" />
      ))}
      <g fill="var(--rv-ink)">
        <path d="M34 -20 L34 -32 Q 34 -48 41 -58 Q 48 -48 48 -32 L48 -20 Z" />
        <rect x="31" y="-22" width="20" height="3" />
        <path
          d="M41 -58 L41 -66 L46 -63.5 L41 -61"
          stroke="var(--rv-ink)"
          strokeWidth="0.8"
          fill="var(--rv-ink)"
        />
      </g>
      <g className="rv-arrive">
        <circle cx="41" cy="-26" r="18" fill={url("lamp")} />
        <rect x="39.6" y="-28" width="2.8" height="3.6" rx="0.8" fill="var(--rv-lantern)" />
        <circle cx="8" cy="-8" r="10" fill={url("lamp")} />
        <circle cx="24" cy="-14" r="10" fill={url("lamp")} />
      </g>
    </g>
  );
}
