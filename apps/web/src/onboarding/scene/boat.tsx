import { animate } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { pointAt, scaleAt } from "./geometry";

/** Water easing: a slow push off, a long glide, a soft arrival. */
const GLIDE: [number, number, number, number] = [0.42, 0.04, 0.18, 1];

/** The boat art (public/onboarding/boat.webp) and where its waterline middle sits in it. */
const ART = { href: "/onboarding/boat.webp", w: 720, h: 411, x: 360, y: 380 };
/** The boat's width in painting pixels at full size. */
const BOAT_W = 350;
/** The paddle art (public/onboarding/paddle.webp), drawn at its length in the boat art. */
/** Drawn so the shaft is as thick as a fist; `holdY` is where the upper fist grips it. */
const PADDLE = { href: "/onboarding/paddle.webp", w: 50, h: 254, holdY: 34 };
/** Each rower's upper fist, from the waterline middle, in boat-art pixels. */
const FISTS: readonly { x: number; y: number }[] = [
  { x: -72, y: -158 },
  { x: 40, y: -156 },
  { x: 154, y: -150 },
];
/** The paddles' lean, degrees clockwise from upright: top toward the bow, blade toward the stern. */
const PADDLE_ANGLE = 32;
/** The lantern's glass, from the waterline middle, in boat-art pixels. */
const LANTERN = { x: -322, y: -184 };

/**
 * The majhi's nouka in rickshaw paint: the human captain at the stern steering with the long oar,
 * and a crew of three robot agents paddling. Paddles are their own pieces, so the crew rows while
 * the boat glides and holds still at rest. It bobs in place (CSS); when `s` changes it glides there
 * along the river (Motion), turning to face the way it goes, with a wake that shows only while it
 * moves. Positions are written to the DOM directly, so a glide re-renders nothing.
 */
export function Boat({ s, still }: { s: number; still: boolean }) {
  const id = useId().replace(/:/g, "");
  const group = useRef<SVGGElement>(null);
  const wake = useRef<SVGGElement>(null);
  const pos = useRef({ s, flip: 1 });

  const place = () => {
    const p = pointAt(pos.current.s);
    const k = (scaleAt(p.y) * BOAT_W) / ART.w;
    group.current?.setAttribute(
      "transform",
      `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${(k * pos.current.flip).toFixed(4)} ${k.toFixed(4)})`,
    );
  };

  // Placed once before paint; later moves come from the glide.
  useLayoutEffect(place, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `place` reads refs only
  useEffect(() => {
    const from = pos.current.s;
    const rowing = (on: boolean) => {
      if (on) group.current?.setAttribute("data-moving", "");
      else group.current?.removeAttribute("data-moving");
    };
    if (still || Math.abs(s - from) < 0.5) {
      pos.current.s = s;
      place();
      rowing(false);
      if (wake.current) wake.current.style.opacity = "0";
      return;
    }
    const dx = pointAt(s).x - pointAt(from).x;
    const face = Math.abs(dx) < 40 ? pos.current.flip : dx > 0 ? 1 : -1;
    const span = Math.abs(s - from);
    rowing(true);
    const glide = animate(from, s, {
      duration: Math.min(3.6, 1.8 + span / 520),
      ease: GLIDE,
      onUpdate: (v) => {
        pos.current.s = v;
        place();
        const t = Math.abs(v - from) / span;
        if (wake.current)
          wake.current.style.opacity = (Math.sin(Math.PI * Math.min(1, t * 1.08)) * 0.9).toFixed(3);
      },
      onComplete: () => rowing(false),
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
      rowing(false);
    };
  }, [s, still]);

  return (
    <g ref={group} data-boat="" className="rv-boat">
      <defs>
        <radialGradient id={`${id}-lamp`}>
          <stop offset="0" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0.85 }} />
          <stop offset="1" style={{ stopColor: "var(--rv-lantern)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      {/* The hull's shadow on the water, so the boat sits in the river rather than on it. */}
      <ellipse cx="0" cy="12" rx="330" ry="20" fill="var(--rv-hull-shadow)" />
      {/* Rings spreading from the hull while it rests. */}
      {[0, -1.8].map((delay) => (
        <ellipse
          key={delay}
          className="rv-ripple"
          style={{ "--rv-delay": `${delay}s` } as React.CSSProperties}
          cx="0"
          cy="10"
          rx="380"
          ry="26"
          fill="none"
          stroke="var(--rv-flow)"
          strokeWidth="5"
        />
      ))}
      {/* The wake behind the stern, white strokes like the painting's own waves. */}
      <g ref={wake} style={{ opacity: 0 }} fill="none" stroke="var(--rv-flow)" strokeLinecap="round">
        <path d="M-330 4 C -440 0, -560 6, -700 16" strokeWidth="8" />
        <path d="M-320 18 C -430 30, -540 48, -660 70" strokeWidth="6" />
        <path d="M-250 22 C -330 40, -420 62, -520 88" strokeWidth="5" opacity="0.6" />
      </g>
      <g className="rv-bob">
        {/* The lantern's light, at night only. */}
        <circle
          cx={LANTERN.x}
          cy={LANTERN.y}
          r="90"
          fill={`url(#${id}-lamp)`}
          className="rv-breathe"
          style={{ opacity: "var(--rv-dusk)" }}
        />
        <image href={ART.href} x={-ART.x} y={-ART.y} width={ART.w} height={ART.h} />
        {/* The crew's paddles, then their fists over the shafts so each paddle sits in its hands.
            The stroke moves paddles and fists together, so the grip never slips. */}
        <g className="rv-stroke">
          {FISTS.map((f) => (
            <g key={f.x} transform={`translate(${f.x} ${f.y}) rotate(${PADDLE_ANGLE})`}>
              <image
                href={PADDLE.href}
                x={-PADDLE.w / 2}
                y={-PADDLE.holdY}
                width={PADDLE.w}
                height={PADDLE.h}
              />
            </g>
          ))}
          <image href="/onboarding/fists.webp" x={-ART.x} y={-ART.y} width={ART.w} height={ART.h} />
        </g>
      </g>
    </g>
  );
}
