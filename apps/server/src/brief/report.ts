import { addDays } from "../usage/ranges.ts";
import { failingMinutes } from "../chat/failing.ts";

/**
 * The weekly client report (docs/briefs/captain.md): the facts of one workspace's previous Monday to Sunday, all
 * derived from records, and two copies of the words. Pure: no clock, no database, no model. The client copy is built
 * from counts only (titles are written for the team, not for the client) and carries the agent cost only when the
 * workspace's "Show cost to client" switch is on.
 */

export interface WeekRows {
  /** Tasks that were merged or finished in the week. */
  shipped: { task: string; title: string }[];
  /** Runs of agents that ended in the week. */
  runs: { startedAt: string; endedAt: string }[];
  /** Agent cost in dollars. */
  cost: number;
  /** Incidents open at any time in the week, with the watch's timeline. */
  incidents: { openedAt: string; resolvedAt?: string | undefined; timeline: { kind: string; at: string }[] }[];
  /** The workspace has monitoring, so an uptime figure means something. */
  monitored: boolean;
}

export interface ReportFacts {
  org: string;
  orgName: string;
  /** The Monday the week begins, `2026-10-12`. */
  week: string;
  /** The span, UTC ISO, `to` excluded. */
  from: string;
  to: string;
  shipped: number;
  shippedTitles: string[];
  /** Hours of agent work, one decimal. */
  hours: number;
  /** Dollars, two decimals. */
  cost: number;
  /** Incidents that began in the week. */
  incidents: number;
  /** Percent of the week without a failing watch, two decimals. Absent without monitoring. */
  uptime?: number;
  monitored: boolean;
}

export function reportFacts(input: {
  org: string;
  orgName: string;
  week: string;
  from: string;
  to: string;
  rows: WeekRows;
}): ReportFacts {
  const { rows, from, to } = input;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const spanMs = rows.runs.reduce((n, r) => n + Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt)), 0);
  const began = rows.incidents.filter((i) => Date.parse(i.openedAt) >= fromMs && Date.parse(i.openedAt) < toMs);
  let failing = 0;
  for (const i of rows.incidents) {
    const start = new Date(Math.max(Date.parse(i.openedAt), fromMs)).toISOString();
    const end = new Date(Math.min(i.resolvedAt === undefined ? toMs : Date.parse(i.resolvedAt), toMs)).toISOString();
    if (end > start) failing += failingMinutes(start, end, i.timeline).minutes;
  }
  const totalMinutes = (toMs - fromMs) / 60_000;
  const uptime = Math.round((1 - Math.min(failing, totalMinutes) / totalMinutes) * 10_000) / 100;
  return {
    org: input.org,
    orgName: input.orgName,
    week: input.week,
    from,
    to,
    shipped: rows.shipped.length,
    shippedTitles: rows.shipped.slice(0, 5).map((s) => s.title),
    hours: Math.round((spanMs / 3_600_000) * 10) / 10,
    cost: Math.round(rows.cost * 100) / 100,
    incidents: began.length,
    ...(rows.monitored || rows.incidents.length > 0 ? { uptime } : {}),
    monitored: rows.monitored,
  };
}

/** Nothing happened in the week: no report is made and nothing is sent. */
export function quietWeek(f: ReportFacts): boolean {
  return f.shipped === 0 && f.hours === 0 && f.cost === 0 && f.incidents === 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-12` as `12 Oct`. */
function dayWord(day: string): string {
  const [, m = "1", d = "1"] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The two copies. The internal one says everything; the client one says counts, and the cost only when asked. */
export function reportTexts(f: ReportFacts, showCost: boolean): { internal: string; client: string } {
  const head = `Weekly report for ${f.orgName}, ${dayWord(f.week)} to ${dayWord(addDays(f.week, 6))}.`;
  const incidents = `Incidents: ${f.incidents}.${f.uptime === undefined ? "" : ` Uptime: ${f.uptime.toFixed(2)}%.`}`;
  const internal = [
    head,
    f.shipped === 0
      ? "Shipped: nothing."
      : `Shipped ${plural(f.shipped, "task")}: ${f.shippedTitles.join("; ")}${f.shipped > f.shippedTitles.length ? ` and ${f.shipped - f.shippedTitles.length} more` : ""}.`,
    `Agent work: ${f.hours} hours. Agent cost: ${money(f.cost)}.`,
    incidents,
  ].join("\n");
  const client = [
    head,
    `Shipped: ${plural(f.shipped, "change")}.`,
    `Agent work: ${f.hours} hours.`,
    ...(f.incidents > 0 || f.uptime !== undefined ? [incidents] : []),
    ...(showCost ? [`Agent cost: ${money(f.cost)}.`] : []),
  ].join("\n");
  return { internal, client };
}
