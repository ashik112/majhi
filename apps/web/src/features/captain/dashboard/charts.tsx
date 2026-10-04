import type { AutonomyReport, TaskSummary } from "@majhi/shared";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/format";
import {
  finishedRows,
  hourRows,
  type OrgInfo,
  orgColor,
  orgName,
  STAT_LABEL,
  STAT_ORDER,
  type StatId,
  statusRows,
} from "./model";

/**
 * The three charts, in their own module so the chart library loads only when the dashboard opens.
 * Colors are theme tokens (CSS variables), so both themes and every accent read well.
 */

const STAT_COLOR: Record<StatId, string> = {
  working: "var(--c-lamp-working)",
  review: "var(--c-lamp-needs)",
  paused: "var(--c-lamp-paused)",
  inbox: "var(--c-lamp-idle)",
};

const AXIS = { fill: "var(--c-fg-muted)", fontSize: 11, fontFamily: "var(--font-mono)" } as const;
const GRID = "var(--c-line)";

const TOOLTIP = {
  contentStyle: {
    background: "var(--c-glass-strong)",
    border: "1px solid var(--c-line-strong)",
    borderRadius: 8,
    color: "var(--c-fg)",
    fontSize: 12,
    boxShadow: "none",
  },
  labelStyle: { color: "var(--c-fg-muted)", marginBottom: 2 },
  itemStyle: { color: "var(--c-fg)", padding: 0 },
  cursor: { fill: "var(--c-raised)", opacity: 0.6 },
} as const;

/** Dollars for an axis: no cents from $10 up. */
function axisMoney(n: number): string {
  return n >= 10 ? `$${Math.round(n)}` : `$${Number(n.toFixed(2))}`;
}

function LegendWord({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-xs text-fg-soft">
      <span aria-hidden="true" className="size-2 rounded-xs" style={{ background: color }} />
      {label}
    </li>
  );
}

function legendOf(items: readonly { color: string; label: string }[]) {
  return (
    <ul className="m-0 flex list-none flex-wrap justify-center gap-x-3 gap-y-1 p-0 pt-1">
      {items.map((i) => (
        <LegendWord key={i.label} color={i.color} label={i.label} />
      ))}
    </ul>
  );
}

/** Auto-pilot spend today: each hour as a bar, the running total as a line, the daily cap as a rule. */
export function SpendChart({ report, cap }: { report: AutonomyReport; cap: number | undefined }) {
  const rows = hourRows(report.hours, report.tz);
  const top = Math.max(cap ?? 0, rows.at(-1)?.total ?? 0, 0.01);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
        <YAxis
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={axisMoney}
          domain={[0, top * 1.1]}
        />
        <Tooltip
          {...TOOLTIP}
          formatter={(value, name) => [
            formatMoney(Number(value)),
            name === "cost" ? "This hour" : "Total today",
          ]}
        />
        <Bar dataKey="cost" name="cost" fill="var(--c-blue)" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
        <Area
          dataKey="total"
          name="total"
          type="monotone"
          stroke="none"
          fill="var(--c-accent)"
          fillOpacity={0.12}
        />
        <Line
          dataKey="total"
          name="total"
          type="monotone"
          stroke="var(--c-accent)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        {cap !== undefined && (
          <ReferenceLine
            y={cap}
            stroke="var(--c-red)"
            strokeDasharray="4 3"
            label={{
              value: `Cap ${axisMoney(cap)}`,
              position: "insideTopLeft",
              fill: "var(--c-red)",
              fontSize: 11,
            }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function SpendLegend({ cap }: { cap: boolean }) {
  return legendOf([
    { color: "var(--c-blue)", label: "Each hour" },
    { color: "var(--c-accent)", label: "Total today" },
    ...(cap ? [{ color: "var(--c-red)", label: "Daily cap" }] : []),
  ]);
}

/** Tasks finished per day, stacked by workspace. */
export function FinishedChart({ days, orgs }: { days: AutonomyReport["days"]; orgs: readonly OrgInfo[] }) {
  const { rows, orgs: ids } = finishedRows(days);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
        <Tooltip {...TOOLTIP} formatter={(value, name) => [String(value), orgName(orgs, String(name))]} />
        {ids.map((id) => (
          <Bar key={id} dataKey={id} stackId="done" fill={orgColor(orgs, id)} maxBarSize={28} />
        ))}
        <Legend
          content={() => legendOf(ids.map((id) => ({ color: orgColor(orgs, id), label: orgName(orgs, id) })))}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Where open tasks are now, one bar per workspace split by state. */
export function StatusChart({ tasks, orgs }: { tasks: readonly TaskSummary[]; orgs: readonly OrgInfo[] }) {
  const rows = statusRows(tasks, orgs);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ ...AXIS, fontFamily: "inherit", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={96}
        />
        <Tooltip {...TOOLTIP} formatter={(value, name) => [String(value), STAT_LABEL[name as StatId]]} />
        {STAT_ORDER.map((s) => (
          <Bar key={s} dataKey={s} stackId="now" fill={STAT_COLOR[s]} maxBarSize={22} />
        ))}
        <Legend
          content={() => legendOf(STAT_ORDER.map((s) => ({ color: STAT_COLOR[s], label: STAT_LABEL[s] })))}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
