import type { UsageDay } from "@majhi/shared";
import { useId, useState } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/cn";
import { formatMoney, formatTokens, plural } from "@/lib/format";

/**
 * Slots 1 and 2 of the chart palette (blue, orange), stepped for dark surfaces. Checked against
 * the card surface #1e2025: both inside the dark lightness band, over 3:1, CVD delta E 26.8.
 * Most cost is estimated (sign-in accounts), so it takes the calmer blue.
 */
const ESTIMATED = "#3987e5";
const REAL = "#d95926";

const PLOT_HEIGHT = 120;
/** A cost above zero never draws thinner than this, so it stays visible. */
const MIN_SEGMENT = 2;
const GAP = 2;

/** The smallest of 1, 2, 2.5, 5 times a power of ten that is at least `value`. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * magnitude >= value - 1e-12) return m * magnitude;
  }
  return 10 * magnitude;
}

function tickLabel(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 1 && Number.isInteger(usd)) return `$${usd.toLocaleString("en-US")}`;
  return `$${usd.toFixed(usd < 0.01 ? 3 : 2)}`;
}

/** "Sep 28" (or "Sep 28, 2026" with the year) for a local day "2026-09-28". */
export function dayLabel(day: string, withYear = false): string {
  const [y, m, d] = day.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y + m + d)) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function daySentence(day: UsageDay, isToday: boolean): string {
  const name = isToday ? "Today" : dayLabel(day.day);
  if (day.turns === 0) return `${name}: nothing used.`;
  const estimated = day.estimatedUsd > 0 ? `, ${formatMoney(day.estimatedUsd)} of it estimated` : "";
  return `${name}: ${formatMoney(day.costUsd)}${estimated}, ${formatTokens(day.totalTokens)} tokens, ${plural(day.turns, "turn")}.`;
}

/** Cost per day for the last 30 days, the estimated part stacked on the real part. Today is last. */
export function DailyChart({ days, className }: { days: readonly UsageDay[]; className?: string }) {
  const [active, setActive] = useState<number>();
  const [fromKeys, setFromKeys] = useState(false);
  const titleId = useId();
  const top = niceMax(Math.max(0, ...days.map((d) => d.costUsd)));
  const last = days.length - 1;
  const total = days.reduce((sum, d) => sum + d.costUsd, 0);
  const peak = days.reduce<UsageDay | undefined>(
    (best, d) => (best === undefined || d.costUsd > best.costUsd ? d : best),
    undefined,
  );
  const summary =
    total > 0 && peak
      ? `${formatMoney(total)} over the last 30 days. Highest: ${formatMoney(peak.costUsd)} on ${dayLabel(peak.day)}. Use the arrow keys to read each day.`
      : "No cost in the last 30 days. Use the arrow keys to read each day.";
  const ticks = top > 0 ? [top, top / 2, 0] : [0];
  const activeDay = active === undefined ? undefined : days[active];

  function move(to: number) {
    setFromKeys(true);
    setActive(Math.max(0, Math.min(last, to)));
  }

  return (
    <figure aria-labelledby={titleId} className={cn("m-0 flex min-w-0 flex-col gap-3", className)}>
      <figcaption className="flex items-center gap-4">
        <SectionLabel id={titleId}>Cost per day, last 30 days</SectionLabel>
        <span className="ml-auto flex items-center gap-3 text-xs text-fg-muted">
          <LegendKey color={ESTIMATED} label="Estimated" />
          <LegendKey color={REAL} label="Real cost" />
        </span>
      </figcaption>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div aria-hidden="true" className="relative w-10" style={{ height: PLOT_HEIGHT }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-xs text-fg-faint tabular-nums"
              style={{ top: `${top > 0 ? (1 - t / top) * 100 : 100}%` }}
            >
              {tickLabel(t)}
            </span>
          ))}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a chart has no native element; the table below carries the same values */}
        <div
          role="group"
          aria-roledescription="chart"
          aria-label={summary}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move through the days, like the pointer
          tabIndex={0}
          className="relative rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue"
          style={{ height: PLOT_HEIGHT }}
          onPointerLeave={() => setActive(undefined)}
          onFocus={() => {
            setFromKeys(true);
            setActive((a) => a ?? last);
          }}
          onBlur={() => setActive(undefined)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") move((active ?? last) - 1);
            else if (e.key === "ArrowRight") move((active ?? last) + 1);
            else if (e.key === "Home") move(0);
            else if (e.key === "End") move(last);
            else return;
            e.preventDefault();
          }}
        >
          {top > 0 && <span aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-line" />}
          {top > 0 && <span aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-line" />}
          <span aria-hidden="true" className="absolute inset-x-0 bottom-0 border-t border-line-control" />
          <div aria-hidden="true" className="absolute inset-0 flex items-end gap-[2px]">
            {days.map((d, i) => (
              <Column
                key={d.day}
                day={d}
                top={top}
                active={i === active}
                onEnter={() => {
                  setFromKeys(false);
                  setActive(i);
                }}
              />
            ))}
          </div>
          {activeDay && active !== undefined && (
            <DayTooltip day={activeDay} index={active} count={days.length} isToday={active === last} />
          )}
        </div>
        <span />
        <div aria-hidden="true" className="relative mt-1.5 h-4 text-xs text-fg-faint">
          {days[0] && <span className="absolute left-0 whitespace-nowrap">{dayLabel(days[0].day)}</span>}
          {days[Math.floor(last / 2)] && (
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${((Math.floor(last / 2) + 0.5) / days.length) * 100}%` }}
            >
              {dayLabel(days[Math.floor(last / 2)]?.day ?? "")}
            </span>
          )}
          <span className="absolute right-0">Today</span>
        </div>
      </div>
      <span role="status" className="sr-only">
        {fromKeys && activeDay && active !== undefined ? daySentence(activeDay, active === last) : ""}
      </span>
      <table className="sr-only">
        <caption>Cost per day, last 30 days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Cost</th>
            <th scope="col">Estimated part</th>
            <th scope="col">Tokens</th>
            <th scope="col">Turns</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{formatMoney(d.costUsd)}</td>
              <td>{formatMoney(d.estimatedUsd)}</td>
              <td>{formatTokens(d.totalTokens)}</td>
              <td>{d.turns}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function Column({
  day,
  top,
  active,
  onEnter,
}: {
  day: UsageDay;
  top: number;
  active: boolean;
  onEnter: () => void;
}) {
  const real = Math.max(0, day.costUsd - day.estimatedUsd);
  const estimated = Math.max(0, day.estimatedUsd);
  const px = (usd: number) => (usd > 0 && top > 0 ? Math.max(MIN_SEGMENT, (usd / top) * PLOT_HEIGHT) : 0);
  let realPx = px(real);
  let estPx = px(estimated);
  // Keep the stack, with its gap, inside the plot.
  const over = realPx + estPx + (realPx > 0 && estPx > 0 ? GAP : 0) - PLOT_HEIGHT;
  if (over > 0) {
    if (estPx >= realPx) estPx = Math.max(MIN_SEGMENT, estPx - over);
    else realPx = Math.max(MIN_SEGMENT, realPx - over);
  }
  return (
    <div
      onPointerEnter={onEnter}
      className={cn(
        "flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-xs transition-colors duration-100",
        active && "bg-fg/5",
      )}
    >
      <div className={cn("flex w-full max-w-[12px] flex-col gap-[2px]", active && "brightness-115")}>
        {estPx > 0 && (
          <span
            className={cn("block rounded-t-[4px]")}
            style={{ height: estPx, backgroundColor: ESTIMATED }}
          />
        )}
        {realPx > 0 && (
          <span
            className={cn("block", estPx === 0 && "rounded-t-[4px]")}
            style={{ height: realPx, backgroundColor: REAL }}
          />
        )}
      </div>
    </div>
  );
}

function DayTooltip({
  day,
  index,
  count,
  isToday,
}: {
  day: UsageDay;
  index: number;
  count: number;
  isToday: boolean;
}) {
  const center = ((index + 0.5) / count) * 100;
  const shift = index < 4 ? "0%" : index > count - 5 ? "-100%" : "-50%";
  const real = Math.max(0, day.costUsd - day.estimatedUsd);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full z-10 mb-2 flex min-w-[150px] flex-col gap-1 rounded-md border border-line-control bg-glass-strong px-2.5 py-2 text-xs shadow-pop"
      style={{ left: `${center}%`, transform: `translateX(${shift})` }}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-fg tabular-nums">{formatMoney(day.costUsd)}</span>
        <span className="text-fg-muted">{isToday ? "Today" : dayLabel(day.day)}</span>
      </span>
      {day.turns > 0 ? (
        <>
          {real > 0 && <TooltipLine color={REAL} value={formatMoney(real)} label="real" />}
          {day.estimatedUsd > 0 && (
            <TooltipLine color={ESTIMATED} value={formatMoney(day.estimatedUsd)} label="estimated" />
          )}
          <span className="text-fg-muted tabular-nums">
            {formatTokens(day.totalTokens)} tokens · {plural(day.turns, "turn")}
          </span>
        </>
      ) : (
        <span className="text-fg-muted">Nothing used</span>
      )}
    </div>
  );
}

function TooltipLine({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className="h-0.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="font-medium text-fg-soft tabular-nums">{value}</span>
      <span className="text-fg-muted">{label}</span>
    </span>
  );
}
