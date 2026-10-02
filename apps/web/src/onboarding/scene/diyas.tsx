import { animate } from "motion/react";
import { useEffect, useRef } from "react";
import { pointAt, scaleAt, seeded, widthAt } from "./geometry";

const COUNT = 9;
/** Seconds for one lamp to float from the ghat to the near bank. */
const PASS = 34;

const LAMPS = (() => {
  const rand = seeded(41);
  return Array.from({ length: COUNT }, (_, i) => ({
    phase: i / COUNT + rand() * 0.04,
    lane: (rand() - 0.5) * 0.56,
    sway: 0.6 + rand() * 0.8,
  }));
})();

/**
 * Small oil lamps set on the water at the ghat, drifting down the whole river toward the viewer:
 * the arrive moment. Each lamp keeps a lane across the river and grows with nearness. One Motion
 * loop moves them all by writing transforms; under reduced motion they rest where they are.
 */
export function Diyas({ from, still, lamp }: { from: number; still: boolean; lamp: string }) {
  const refs = useRef<(SVGGElement | null)[]>([]);

  useEffect(() => {
    const place = (t: number) => {
      LAMPS.forEach((l, i) => {
        const el = refs.current[i];
        if (!el) return;
        const p = (t + l.phase) % 1;
        const s = from * (1 - p);
        const c = pointAt(s);
        const k = scaleAt(c.y);
        const sway = Math.sin((t * 6 + l.phase * 9) * Math.PI) * l.sway * 0.04;
        const x = c.x + (l.lane + sway) * widthAt(c.y);
        const fade = Math.min(1, p / 0.05, (1 - p) / 0.12);
        el.setAttribute(
          "transform",
          `translate(${x.toFixed(1)} ${c.y.toFixed(1)}) scale(${(k * 1.1).toFixed(3)})`,
        );
        el.style.opacity = Math.max(0, fade).toFixed(3);
      });
    };
    if (still) {
      place(0.35);
      return;
    }
    const loop = animate(0, 1, {
      duration: PASS,
      ease: "linear",
      repeat: Number.POSITIVE_INFINITY,
      onUpdate: place,
    });
    return () => loop.stop();
  }, [from, still]);

  return (
    <g>
      {LAMPS.map((l, i) => (
        <g
          key={l.phase}
          ref={(el) => {
            refs.current[i] = el;
          }}
          style={{ opacity: 0 }}
        >
          <ellipse cx="0" cy="2" rx="14" ry="3.5" fill={lamp} opacity="0.7" />
          <circle cx="0" cy="-2" r="9" fill={lamp} />
          <path d="M-4 0 Q 0 3 4 0 Z" fill="var(--rv-ink)" />
          <ellipse cx="0" cy="-1.6" rx="0.9" ry="1.8" fill="var(--rv-lantern-core)" />
        </g>
      ))}
    </g>
  );
}
