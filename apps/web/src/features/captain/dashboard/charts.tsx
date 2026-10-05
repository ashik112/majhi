import type { AutonomyReport, AutonomyStatus } from "@majhi/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { accountBars, dayLabel, hourRows, stackRows } from "./chart-model";
import { atTime, type OrgInfo, orgColor, orgName } from "./model";
import { Panel } from "./panel";

/**
 * The charts under the workspaces table, in their own module so the chart library loads only when
 * the dashboard opens. Colors are theme tokens (CSS variables), so both themes read well.
 */

const AXIS = { fill: "var(--c-fg-muted)", fontSize: 11, fontFamily: "var(--font-mono)" } as const;
const GRID = "var(--c-line)";
const MARGIN = { top: 6, right: 8, bottom: 0, left: 0 } as const;

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

const FLOW: readonly { key: "started" | "finished" | "paused"; label: string; color: string }[] = [
  { key: "started", label: "Started", color: "var(--c-blue)" },
  { key: "finished", label: "Finished", color: "var(--c-lamp-done)" },
  { key: "paused", label: "Paused", color: "var(--c-lamp-needs)" },
];

function axisMoney(n: number): string {
  return n >= 10 ? `$${Math.round(n)}` : `$${Number(n.toFixed(2))}`;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-xs text-fg-soft">
      <span aria-hidden="true" className="size-2 rounded-xs" style={{ background: color }} />
      {label}
    </li>
  );
}

function Cell({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-1">
      <div className="flex min-h-5 shrink-0 items-center gap-2">
        <h3 className="m-0 text-xs font-medium text-fg-soft">{title}</h3>
        {aside !== undefined && <div className="tnum ml-auto text-xs text-fg-muted">{aside}</div>}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">{children}</div>
      </div>
    </div>
  );
}

function Toggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <span className="inline-flex rounded-md bg-raised p-px">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-[5px] px-1.5 text-xs leading-4",
            o.id === value ? "bg-glass-strong text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Spend({
  report,
  cap,
  used,
  orgs,
}: {
  report: AutonomyReport;
  cap: number | undefined;
  used: number;
  orgs: readonly OrgInfo[];
}) {
  const [view, setView] = useState<"today" | "days">("today");
  const hours = useMemo(() => hourRows(report.hours, report.tz), [report.hours, report.tz]);
  const days = useMemo(() => stackRows(report.spend), [report.spend]);
  const topToday = Math.max(cap ?? 0, hours.at(-1)?.total ?? 0, 0.01);
  const topDays = Math.max(
    cap ?? 0,
    ...report.spend.map((d) => d.orgs.reduce((n, o) => n + o.cost, 0)),
    0.01,
  );
  const capLine =
    cap === undefined ? null : (
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
    );
  return (
    <Cell
      title="Spend"
      aside={
        <span className="flex items-center gap-2">
          {view === "today" && <span className="font-mono text-fg-soft">{formatMoney(used)} today</span>}
          <Toggle
            value={view}
            onChange={setView}
            options={[
              { id: "today", label: "Today" },
              { id: "days", label: "14 days" },
            ]}
          />
        </span>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        {view === "today" ? (
          <ComposedChart data={hours} margin={MARGIN}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
            <YAxis
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={axisMoney}
              domain={[0, topToday * 1.1]}
            />
            <Tooltip
              {...TOOLTIP}
              formatter={(value, name) => [
                formatMoney(Number(value)),
                name === "cost" ? "This hour" : "Total today",
              ]}
            />
            <Bar dataKey="cost" name="cost" fill="var(--c-blue)" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
            <Line
              dataKey="total"
              name="total"
              type="monotone"
              stroke="var(--c-accent)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {capLine}
          </ComposedChart>
        ) : (
          <BarChart data={days.rows} margin={MARGIN}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
            <YAxis
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={axisMoney}
              domain={[0, topDays * 1.1]}
            />
            <Tooltip
              {...TOOLTIP}
              formatter={(value, name) => [formatMoney(Number(value)), orgName(orgs, String(name))]}
            />
            {days.orgs.map((id) => (
              <Bar key={id} dataKey={id} stackId="spend" fill={orgColor(orgs, id)} maxBarSize={28} />
            ))}
            {capLine}
          </BarChart>
        )}
      </ResponsiveContainer>
    </Cell>
  );
}

function Finished({ report, orgs }: { report: AutonomyReport; orgs: readonly OrgInfo[] }) {
  const { rows, orgs: ids } = useMemo(() => stackRows(report.days), [report.days]);
  const total = report.days.reduce((n, d) => n + d.orgs.reduce((m, o) => m + o.count, 0), 0);
  return (
    <Cell
      title="Tasks finished per day"
      aside={<span className="font-mono text-fg-soft">{total} in 14 d</span>}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={MARGIN}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <Tooltip {...TOOLTIP} formatter={(value, name) => [String(value), orgName(orgs, String(name))]} />
          {ids.map((id) => (
            <Bar key={id} dataKey={id} stackId="done" fill={orgColor(orgs, id)} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Cell>
  );
}

function Flow({ report }: { report: AutonomyReport }) {
  const rows = useMemo(() => report.flow.map((d) => ({ ...d, label: dayLabel(d.day) })), [report.flow]);
  return (
    <Cell
      title="Work flow per day"
      aside={
        <ul className="m-0 flex list-none gap-2.5 p-0">
          {FLOW.map((f) => (
            <Swatch key={f.key} color={f.color} label={f.label} />
          ))}
        </ul>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={MARGIN} barGap={1}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <Tooltip
            {...TOOLTIP}
            formatter={(value, name) => [
              String(value),
              FLOW.find((f) => f.key === name)?.label ?? String(name),
            ]}
          />
          {FLOW.map((f) => (
            <Bar key={f.key} dataKey={f.key} fill={f.color} maxBarSize={10} radius={[2, 2, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Cell>
  );
}

function barTone(n: number | undefined): string {
  return n === undefined ? "bg-fg-faint" : n >= 100 ? "bg-red" : n >= 80 ? "bg-lamp-needs" : "bg-accent";
}

function Accounts({
  accounts,
  nowMs,
  tz,
}: {
  accounts: AutonomyStatus["accounts"];
  nowMs: number;
  tz: string;
}) {
  const bars = useMemo(() => accountBars(accounts), [accounts]);
  return (
    <Cell title="Account usage" aside="used this week, and the 5-hour window">
      {bars.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">No accounts yet.</p>
      ) : (
        <ul className="m-0 flex h-full list-none flex-col gap-1.5 overflow-y-auto overscroll-contain p-0 pr-1">
          {bars.map((a) => (
            <li
              key={a.id}
              className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-x-2 text-xs"
              title={a.resetsAt === undefined ? a.id : `${a.id}. Resets ${atTime(a.resetsAt, nowMs, tz)}`}
            >
              <span className="min-w-0 truncate font-mono text-fg">{a.id}</span>
              <span className="flex flex-col gap-0.5" aria-hidden="true">
                <span className="h-2 overflow-hidden rounded-full bg-raised">
                  <span
                    className={cn("block h-full rounded-full", barTone(a.weekly))}
                    style={{ width: `${Math.min(100, a.weekly ?? 0)}%` }}
                  />
                </span>
                <span className="h-1 overflow-hidden rounded-full bg-raised">
                  <span
                    className={cn("block h-full rounded-full opacity-60", barTone(a.window))}
                    style={{ width: `${Math.min(100, a.window ?? 0)}%` }}
                  />
                </span>
              </span>
              <span
                className={cn(
                  "tnum text-right font-mono",
                  (a.weekly ?? 0) >= 80 ? "text-lamp-needs" : "text-fg-soft",
                  (a.weekly ?? 0) >= 100 && "text-red",
                )}
              >
                {a.weekly === undefined ? "–" : `${Math.round(a.weekly)}%`}
                {a.resetsAt !== undefined && (
                  <span className="text-fg-faint"> {atTime(a.resetsAt, nowMs, tz)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Cell>
  );
}

/** Four charts in a grid that fills the room under the workspaces table. */
export default function ChartsPanel({
  report,
  autonomy,
  orgs,
  nowMs,
}: {
  report: AutonomyReport;
  autonomy: AutonomyStatus;
  orgs: readonly OrgInfo[];
  nowMs: number;
}) {
  const used = autonomy.spend.total.used.cost;
  const cap = autonomy.spend.total.cap?.cost;
  const ids = useMemo(() => {
    const seen = new Set<string>();
    for (const d of [...report.days, ...report.spend]) for (const o of d.orgs) seen.add(o.org);
    return [...seen].sort();
  }, [report.days, report.spend]);
  const [compact, setCompact] = useState(false);
  const [one, setOne] = useState<"spend" | "finished" | "accounts" | "flow">("spend");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (el === null) return;
    const watch = new ResizeObserver(() => setCompact(el.clientHeight < 330));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const spend = <Spend report={report} cap={cap} used={used} orgs={orgs} />;
  const finished = <Finished report={report} orgs={orgs} />;
  const accounts = <Accounts accounts={autonomy.accounts} nowMs={nowMs} tz={report.tz} />;
  const flow = <Flow report={report} />;
  return (
    <Panel
      title="Charts"
      className="min-h-[200px] flex-1"
      aside={
        <ul className="m-0 flex list-none flex-wrap justify-end gap-x-3 gap-y-0.5 p-0">
          {ids.map((id) => (
            <Swatch key={id} color={orgColor(orgs, id)} label={orgName(orgs, id)} />
          ))}
        </ul>
      }
    >
      <div
        ref={body}
        className={cn(
          "min-h-0 flex-1",
          compact ? "flex flex-col items-stretch gap-1" : "grid grid-cols-2 grid-rows-2 gap-x-4 gap-y-2",
        )}
      >
        {compact ? (
          <>
            <Toggle
              value={one}
              onChange={setOne}
              options={[
                { id: "spend", label: "Spend" },
                { id: "finished", label: "Finished" },
                { id: "accounts", label: "Accounts" },
                { id: "flow", label: "Work flow" },
              ]}
            />
            <div className="flex min-h-0 flex-1 flex-col [&>*]:flex-1">
              {one === "spend" ? spend : one === "finished" ? finished : one === "accounts" ? accounts : flow}
            </div>
          </>
        ) : (
          <>
            {spend}
            {finished}
            {accounts}
            {flow}
          </>
        )}
      </div>
    </Panel>
  );
}
