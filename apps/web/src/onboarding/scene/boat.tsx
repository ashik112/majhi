import { animate } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { pointAt, scaleAt } from "./geometry";

/** Water easing: a slow push off, a long glide, a soft arrival. */
const GLIDE: [number, number, number, number] = [0.42, 0.04, 0.18, 1];

/**
 * A nouka, the Bengal river boat, with its hooded middle and the majhi at the stern pushing a long
 * bamboo pole, drawn side on with its origin on the waterline. It bobs in place (CSS), and when
 * `s` changes it glides there along the river (Motion), turning to face the way it goes, with a
 * wake that shows only while it moves. Positions are written to the DOM directly, so a glide
 * re-renders nothing.
 */
export function Boat({ s, still }: { s: number; still: boolean }) {
  const id = useId().replace(/:/g, "");
  const group = useRef<SVGGElement>(null);
  const wake = useRef<SVGGElement>(null);
  const pos = useRef({ s, flip: 1 });

  const place = () => {
    const p = pointAt(pos.current.s);
    const k = scaleAt(p.y);
    group.current?.setAttribute(
      "transform",
      `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${(k * pos.current.flip).toFixed(3)} ${k.toFixed(3)})`,
    );
  };

  // Placed once before paint; later moves come from the glide.
  useLayoutEffect(place, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `place` reads refs only
  useEffect(() => {
    const from = pos.current.s;
    if (still || Math.abs(s - from) < 0.5) {
      pos.current.s = s;
      place();
      if (wake.current) wake.current.style.opacity = "0";
      return;
    }
    const dx = pointAt(s).x - pointAt(from).x;
    const face = Math.abs(dx) < 18 ? pos.current.flip : dx > 0 ? 1 : -1;
    const span = Math.abs(s - from);
    const glide = animate(from, s, {
      duration: Math.min(3.4, 1.7 + span / 260),
      ease: GLIDE,
      onUpdate: (v) => {
        pos.current.s = v;
        place();
        const t = Math.abs(v - from) / span;
        if (wake.current)
          wake.current.style.opacity = (Math.sin(Math.PI * Math.min(1, t * 1.08)) * 0.95).toFixed(3);
      },
    });
    const turn =
      face === Math.sign(pos.current.flip)
        ? undefined
        : animate(pos.current.flip, face, {
            duration: 0.8,
            ease: [0.65, 0, 0.35, 1],
            onUpdate: (f) => {
              // The hull narrows as it turns, then swings round, so it never thins to nothing.
              pos.current.flip = Math.sign(f || face) * Math.max(0.32, Math.abs(f));
              place();
            },
          });
    return () => {
      glide.stop();
      turn?.stop();
    };
  }, [s, still]);

  return (
    <g ref={group} data-boat="">
      <defs>
        <radialGradient id={`${id}-lamp`}>
          <stop offset="0" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0.9 }} />
          <stop offset="1" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      {/* The bow lantern's light on the water. */}
      <ellipse cx="34" cy="3" rx="46" ry="7" fill={`url(#${id}-lamp)`} opacity="0.5" />
      {/* Rings spreading from the hull while it rests. */}
      <ellipse
        className="rv-ripple"
        cx="0"
        cy="1"
        rx="56"
        ry="4.5"
        fill="none"
        stroke="var(--rv-flow)"
        strokeWidth="0.9"
      />
      <ellipse
        className="rv-ripple"
        style={{ "--rv-delay": "-1.8s" } as React.CSSProperties}
        cx="0"
        cy="1"
        rx="56"
        ry="4.5"
        fill="none"
        stroke="var(--rv-flow)"
        strokeWidth="0.9"
      />
      {/* The wake behind the stern, shown only while gliding. */}
      <g ref={wake} style={{ opacity: 0 }} fill="none" stroke="var(--rv-flow)" strokeLinecap="round">
        <path d="M-42 -1 C -60 -2, -82 -1, -108 1" strokeWidth="1.1" />
        <path d="M-40 2 C -58 5, -80 9, -104 14" strokeWidth="0.9" />
        <path d="M-30 3 C -44 7, -60 12, -78 19" strokeWidth="0.7" opacity="0.6" />
      </g>
      <g className="rv-bob">
        {/* Reflection: the hull flipped on the water, faint. */}
        <use href={`#${id}-hull`} transform="matrix(1 0 0 -0.5 0 1.5)" opacity="0.2" />
        <g id={`${id}-hull`}>
          {/* The bamboo pole, planted in the river behind the stern. */}
          <path d="M-17 -48 L-53 14" stroke="var(--rv-ink)" strokeWidth="1.25" strokeLinecap="round" />
          {/* The hull: long and low, both ends sweeping up. */}
          <path
            d="M-48 -14 C -41 -1, -25 3, 0 3 C 26 3, 41 -2, 50 -16 C 43 -9, 34 -6, 0 -5 C -32 -5, -42 -8, -48 -14 Z"
            fill="var(--rv-ink)"
          />
          <path
            d="M-45 -11 C -37 -7, -20 -5.8, 0 -5.8 C 22 -5.8, 37 -8, 47 -13"
            fill="none"
            stroke="var(--rv-rim)"
            strokeWidth="0.9"
          />
          {/* The chhoi, a bamboo hood over the middle. */}
          <path d="M-17 -5 C -17 -22, 15 -22, 15 -5 Z" fill="var(--rv-ink)" />
          <path
            d="M-11.5 -5.5 C -11.5 -16.5, 9.5 -16.5, 9.5 -5.5 M-5.5 -5.5 C -5.5 -12, 3.5 -12, 3.5 -5.5"
            fill="none"
            stroke="var(--rv-ink-line)"
            strokeWidth="0.7"
          />
          {/* The majhi at the stern, leaning into the pole. */}
          <g fill="var(--rv-ink)">
            <path d="M-36.5 -5 L-34.6 -17.5 L-29.6 -17.5 L-28.2 -5 Z" />
            <path d="M-34.8 -17.5 L-33.6 -27.6 C -33 -29.6, -29.8 -29.6, -29.4 -27.6 L-29.2 -17.5 Z" />
            <circle cx="-31.2" cy="-31.6" r="2.7" />
            <ellipse cx="-31" cy="-33.4" rx="3" ry="1.3" />
          </g>
          <path
            d="M-30.8 -27 L-27.4 -31.2 M-31 -24.6 L-31.6 -21.4"
            stroke="var(--rv-ink)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* A lantern hung at the bow. */}
          <path d="M47.5 -15 L49 -24 L52 -24" fill="none" stroke="var(--rv-ink)" strokeWidth="0.9" />
          <circle cx="52" cy="-19.5" r="11" fill={`url(#${id}-lamp)`} className="rv-breathe" />
          <rect x="50.6" y="-22" width="2.8" height="4" rx="0.8" fill="var(--rv-lantern)" />
        </g>
      </g>
    </g>
  );
}
