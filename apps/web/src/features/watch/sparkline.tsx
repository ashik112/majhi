import type { OpsSample } from "@majhi/shared";
import { formatDuration } from "@/lib/format";

const W = 480;
const H = 56;
const PAD = 3;

/**
 * The last 24 hours of an address check: the slowest answer of each quarter hour as a line, and a mark
 * for each quarter hour with a failure. The line is the accent, the marks use the message red, never a
 * lamp colour. A table of the same numbers is the accessible text.
 */
export function Sparkline({ samples, now }: { samples: readonly OpsSample[]; now: number }) {
  if (samples.length === 0) {
    return <p className="m-0 text-sm text-fg-faint">No checks yet. The first one runs within 5 minutes.</p>;
  }
  const start = now - 24 * 3_600_000;
  const slowest = Math.max(100, ...samples.map((s) => s.ms ?? 0));
  const x = (at: string) => PAD + ((Date.parse(at) - start) / (24 * 3_600_000)) * (W - 2 * PAD);
  const y = (ms: number) => H - PAD - (Math.min(ms, slowest) / slowest) * (H - 2 * PAD);
  const points = samples.filter((s) => s.ok && s.ms !== null);
  const line = points.map((s) => `${x(s.at).toFixed(1)},${y(s.ms ?? 0).toFixed(1)}`).join(" ");
  const failed = samples.filter((s) => !s.ok);
  const typical = [...points].map((s) => s.ms ?? 0).sort((a, b) => a - b)[Math.floor(points.length / 2)];
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <svg
        role="img"
        aria-label={`Latency over the last 24 hours. ${failed.length === 0 ? "No failed checks." : `${failed.length} quarter hours with a failed check.`}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-14 w-full overflow-visible"
      >
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="stroke-line" strokeWidth={1} />
        {points.length > 1 && (
          <polyline
            points={line}
            fill="none"
            className="stroke-accent-text"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {points.length === 1 && (
          <circle cx={x(points[0]?.at ?? "")} cy={y(points[0]?.ms ?? 0)} r={2} className="fill-accent-text" />
        )}
        {failed.map((s) => (
          <rect
            key={s.at}
            x={x(s.at) - 2}
            y={PAD}
            width={4}
            height={H - 2 * PAD}
            rx={1}
            className="fill-red opacity-60"
          />
        ))}
      </svg>
      <figcaption className="tnum flex justify-between font-mono text-xs text-fg-faint">
        <span>24 h ago</span>
        <span>
          {typical === undefined ? "no answers" : `typical ${formatDuration(typical)}`} · slowest{" "}
          {formatDuration(Math.max(0, ...samples.map((s) => s.ms ?? 0)))}
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
