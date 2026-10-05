/**
 * A row of bars, one per value, scaled to the largest (or to `max`). Plain SVG with no axis: the
 * number beside it says what it is, the title says each bar. The last bar is drawn at full strength
 * and the rest dimmer, so the current hour or day reads first.
 */
export function Bars({
  values,
  labels,
  width,
  height = 22,
  max,
  color = "var(--c-accent)",
  slots,
}: {
  values: readonly number[];
  labels: readonly string[];
  width: number;
  height?: number;
  max?: number | undefined;
  color?: string;
  /** Reserve this many bar slots, so a day with few hours so far leaves room at the right. */
  slots?: number;
}) {
  const n = Math.max(slots ?? 0, values.length, 1);
  const gap = 1.5;
  const bar = Math.max(1, (width - gap * (n - 1)) / n);
  const top = Math.max(max ?? 0, ...values, Number.EPSILON);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={labels.join(", ")}
      className="shrink-0"
    >
      {values.map((v, i) => {
        const h = v <= 0 ? 2 : Math.max(3, (v / top) * height);
        return (
          <rect
            // Bars never reorder, so the position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed positions along a time axis
            key={i}
            x={i * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            rx={1}
            fill={v <= 0 ? "var(--c-fg-faint)" : color}
            opacity={v <= 0 ? 0.45 : i === values.length - 1 ? 1 : 0.6}
          >
            <title>{labels[i]}</title>
          </rect>
        );
      })}
    </svg>
  );
}
