import type { WatchSample } from "@majhi/shared";
import { useState } from "react";
import { cn } from "@/lib/cn";

const W = 480;
const H = 64;
const PAD = 4;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * A watch's numbers over 24 hours or 90 days as one line, with the alert threshold as a dashed line.
 * The line is the accent, the limit uses the message red, never a lamp colour. A watch with no number
 * (a page's text) has no chart.
 */
export function HistoryChart({
  day,
  quarter,
  threshold,
  caption,
  now,
}: {
  day: readonly WatchSample[];
  quarter: readonly WatchSample[];
  threshold: number | undefined;
  /** What the line is: "p95 query time". */
  caption: string;
  now: number;
}) {
  const [range, setRange] = useState<"24h" | "90d">("24h");
  const span = range === "24h" ? 24 * 3_600_000 : 90 * 86_400_000;
  const samples = (range === "24h" ? day : quarter).filter((s) => s.v !== null);
  const values = samples.map((s) => s.v ?? 0);
  if (samples.length === 0 && threshold === undefined) return null;
  const all = threshold === undefined ? values : [...values, threshold];
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all, lo + 1);
  const pad = (hi - lo) * 0.1;
  const x = (at: string) =>
    PAD + Math.max(0, Math.min(1, (Date.parse(at) - (now - span)) / span)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi + pad - lo)) * (H - 2 * PAD);
  const line = samples.map((s) => `${x(s.at).toFixed(1)},${y(s.v ?? 0).toFixed(1)}`).join(" ");
  const typical = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <svg
        role="img"
        aria-label={`${caption} over the last ${range === "24h" ? "24 hours" : "90 days"}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full overflow-visible"
      >
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="stroke-line" strokeWidth={1} />
        {threshold !== undefined && (
          <line
            x1={PAD}
            x2={W - PAD}
            y1={y(threshold)}
            y2={y(threshold)}
            className="stroke-red"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {samples.length > 1 && (
          <polyline
            points={line}
            fill="none"
            className="stroke-accent-text"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {samples.length === 1 && (
          <circle
            cx={x(samples[0]?.at ?? "")}
            cy={y(samples[0]?.v ?? 0)}
            r={2}
            className="fill-accent-text"
          />
        )}
      </svg>
      <figcaption className="flex min-w-0 items-center gap-2 text-xs text-fg-faint">
        <span className="min-w-0 truncate">
          {caption}, last {range === "24h" ? "24 h" : "90 days"}
          {threshold === undefined ? "" : ` · dashed line is your ${fmt(threshold)} limit`}
          {typical === undefined ? "" : ` · typical ${fmt(typical)}`}
        </span>
        <span className="ml-auto flex shrink-0 gap-1">
          {(["24h", "90d"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={cn(
                "h-5 cursor-pointer rounded px-1.5 font-mono text-xs",
                range === r ? "bg-accent-wash text-fg" : "text-fg-faint hover:text-fg",
              )}
            >
              {r}
            </button>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}
