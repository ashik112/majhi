import type { AutonomyLane, AutonomyStatus, TaskSummary } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { RowsSkeleton, Skeleton } from "@/components/ui/skeleton";
import { capTone, clockTime, MODE_LAMP, MODE_WORD } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { useAutonomyReport } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, formatMoney, plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useLogEntries } from "../log";
import { groupByStat, type OrgInfo, orgColor, orgName, STAT_LABEL, STAT_ORDER, type StatId } from "./model";

const SpendChart = lazy(() => import("./charts").then((m) => ({ default: m.SpendChart })));
const SpendLegend = lazy(() => import("./charts").then((m) => ({ default: m.SpendLegend })));
const FinishedChart = lazy(() => import("./charts").then((m) => ({ default: m.FinishedChart })));
const StatusChart = lazy(() => import("./charts").then((m) => ({ default: m.StatusChart })));

const STAT_LAMP: Record<StatId, LampState> = {
  working: "working",
  review: "needs",
  paused: "paused",
  inbox: "idle",
};

const FEED_HOURS = 24;
const FEED_MAX = 40;

function useOrgInfo(): OrgInfo[] {
  const orgs = useOrgs().data;
  return useMemo(() => (orgs ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })), [orgs]);
}

/** A dashboard card: glass, a heading with an optional aside, then the content. */
function Card({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col rounded-2xl p-3.5", GLASS, className)}>
      <div className="mb-2 flex min-h-6 items-center gap-2">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {aside && (
          <div className="ml-auto flex min-w-0 items-center gap-2 text-sm text-fg-muted">{aside}</div>
        )}
      </div>
      {children}
    </section>
  );
}

// The status strip ----------------------------------------------------------

type Pick = StatId | "accounts" | undefined;

const TILE =
  "flex min-w-0 flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors duration-150";

function Tile({
  label,
  lamp,
  value,
  sub,
  pressed,
  onClick,
  tone,
}: {
  label: string;
  lamp: LampState;
  value: ReactNode;
  sub?: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
  tone?: "red" | "amber" | undefined;
}) {
  const inner = (
    <>
      <span className="flex items-center gap-1.5 text-sm text-fg-muted">
        <Lamp state={lamp} size={8} />
        {label}
      </span>
      <span
        className={cn("tnum font-mono text-xl leading-6 font-medium text-fg", tone === "red" && "text-red")}
      >
        {value}
      </span>
      {sub && <span className="tnum min-w-0 truncate text-xs text-fg-faint">{sub}</span>}
    </>
  );
  const frame = cn(TILE, pressed ? "border-line-control bg-selected" : "border-line bg-raised");
  if (onClick === undefined) return <div className={frame}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(frame, "cursor-pointer hover:border-line-hover")}
    >
      {inner}
    </button>
  );
}

function StatusStrip({
  autonomy,
  tasks,
  picked,
  onPick,
}: {
  autonomy: AutonomyStatus;
  tasks: readonly TaskSummary[] | undefined;
  picked: Pick;
  onPick: (p: Pick) => void;
}) {
  const needs = useNeedsYou();
  const groups = useMemo(() => groupByStat(tasks ?? []), [tasks]);
  const total = autonomy.spend.total;
  const cap = total.cap?.cost;
  const toggle = (p: Exclude<Pick, undefined>) => onPick(picked === p ? undefined : p);
  const held = autonomy.accounts.filter((a) => a.blocked !== undefined).length;
  const low = autonomy.accounts.filter(
    (a) => a.blocked === undefined && Math.max(a.window?.usedPct ?? 0, a.weekly?.usedPct ?? 0) >= 80,
  ).length;
  const capHeld = autonomy.holds.some((h) => h.kind !== "account");
  return (
    <div
      className={cn(
        "grid shrink-0 grid-cols-2 gap-2 rounded-2xl p-2.5 min-[700px]:grid-cols-4 min-[1200px]:grid-cols-8",
        GLASS,
      )}
    >
      <Tile
        label="Auto-pilot"
        lamp={MODE_LAMP[autonomy.mode]}
        value={MODE_WORD[autonomy.mode]}
        sub={autonomy.since ? `since ${formatAgo(autonomy.since, Date.now())}` : undefined}
      />
      <Tile
        label="Spent today"
        lamp={capHeld ? "needs" : "done"}
        tone={capTone(total) === "red" ? "red" : undefined}
        value={formatMoney(total.used.cost)}
        sub={cap === undefined ? "No daily cap" : `of ${formatMoney(cap)} cap`}
      />
      <Tile
        label="Accounts"
        lamp={held > 0 ? "needs" : low > 0 ? "paused" : "done"}
        value={autonomy.accounts.length - held - low}
        sub={`ready, ${held} held, ${low} low`}
        pressed={picked === "accounts"}
        onClick={() => toggle("accounts")}
      />
      {STAT_ORDER.map((s) => (
        <Tile
          key={s}
          label={STAT_LABEL[s]}
          lamp={STAT_LAMP[s]}
          value={tasks === undefined ? "–" : groups[s].length}
          pressed={picked === s}
          onClick={() => toggle(s)}
        />
      ))}
      <Link
        to="/decisions"
        className={cn(TILE, "border-line bg-raised hover:border-line-hover")}
        title="Open what needs you"
      >
        <span className="flex items-center gap-1.5 text-sm text-fg-muted">
          <Lamp state={needs ? "needs" : "idle"} size={8} />
          Needs you
        </span>
        <span className="tnum font-mono text-xl leading-6 font-medium text-fg">{needs ?? "–"}</span>
      </Link>
    </div>
  );
}

/** The tasks behind a count, or the accounts and what holds them. */
function PickedList({
  picked,
  tasks,
  autonomy,
  orgs,
}: {
  picked: Exclude<Pick, undefined>;
  tasks: readonly TaskSummary[];
  autonomy: AutonomyStatus;
  orgs: readonly OrgInfo[];
}) {
  if (picked === "accounts") {
    return (
      <Card title="Accounts" aside={<span>{plural(autonomy.holds.length, "hold")}</span>}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {autonomy.accounts.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center gap-2 text-sm">
              <Lamp state={a.blocked ? "needs" : "done"} size={8} />
              <span className="font-mono text-fg">{a.id}</span>
              <span className="min-w-0 truncate text-fg-muted">
                {a.blocked
                  ? a.blocked.why
                  : [
                      a.window ? `5-hour ${Math.round(a.window.usedPct)}% used` : undefined,
                      a.weekly ? `week ${Math.round(a.weekly.usedPct)}% used` : undefined,
                    ]
                      .filter(Boolean)
                      .join(", ") || "Ready"}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  const list = groupByStat(tasks)[picked];
  return (
    <Card title={STAT_LABEL[picked]} aside={<span className="tnum font-mono">{list.length}</span>}>
      {list.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Nothing here.</p>
      ) : (
        <ul className="m-0 grid list-none gap-x-6 gap-y-1 p-0 min-[900px]:grid-cols-2">
          {list.slice(0, 20).map((t) => (
            <li key={t.id} className="flex min-w-0 items-baseline gap-2 text-sm">
              <TaskRef task={t.id} />
              <span className="min-w-0 truncate text-fg-soft">{t.title}</span>
              <span className="ml-auto shrink-0 text-xs text-fg-faint">
                {orgName(orgs, t.org ?? "private")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.length > 20 && (
        <PageLink page="board" className="mt-1.5 self-start text-sm text-blue hover:underline">
          All {list.length} on the board
        </PageLink>
      )}
    </Card>
  );
}

// Lanes ---------------------------------------------------------------------

function LaneCard({
  lane,
  autonomy,
  tasks,
  orgs,
  last,
  now,
}: {
  lane: AutonomyLane;
  autonomy: AutonomyStatus;
  tasks: readonly TaskSummary[];
  orgs: readonly OrgInfo[];
  last: { sentence: string; at: string; task?: string | undefined } | undefined;
  now: number;
}) {
  const needs = useNeedsYou(lane.org) ?? 0;
  const working = autonomy.now.filter((n) => (n.org ?? "private") === lane.org && n.status === "running");
  const orgOf = new Map(tasks.map((t) => [t.id, t.org ?? "private"]));
  const waiting = autonomy.waiting.filter((w) => orgOf.get(w.task) === lane.org);
  const cap = lane.spend.cap?.cost;
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-raised p-3">
      <header className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-xs"
          style={{ background: orgColor(orgs, lane.org) }}
        />
        <h3 className="min-w-0 truncate text-base font-semibold text-fg">{lane.name}</h3>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-sm text-fg-muted">
          <Lamp state={lane.working ? "working" : lane.resting ? "paused" : "idle"} size={8} />
          {lane.working ? "Captain working" : lane.resting ? "Resting" : "Idle"}
        </span>
      </header>
      {lane.resting && <p className="m-0 text-xs text-fg-faint">{lane.resting}</p>}
      <div>
        <h4 className="mb-1 text-xs font-medium tracking-wide text-fg-faint uppercase">Working now</h4>
        {working.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            {lane.nowDoing ?? `Nothing running. ${plural(lane.backlog, "task")} in the backlog.`}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {working.map((w) => (
              <li key={w.task} className="flex min-w-0 flex-col text-sm">
                <span className="flex min-w-0 items-baseline gap-2">
                  <TaskRef task={w.task} />
                  <Link
                    to="/t/$taskId"
                    params={{ taskId: w.task }}
                    className="min-w-0 truncate text-fg-soft hover:underline"
                  >
                    {w.title}
                  </Link>
                </span>
                {w.agents.length > 0 && (
                  <span className="truncate text-xs text-fg-faint">
                    {w.agents.map((a) => `@${a.id}${a.nowDoing ? ` ${a.nowDoing}` : ""}`).join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="mb-1 text-xs font-medium tracking-wide text-fg-faint uppercase">Waits for you</h4>
        {needs === 0 && waiting.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">Nothing.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {waiting.slice(0, 3).map((w) => (
              <li key={`${w.task}|${w.item}`} className="flex min-w-0 items-baseline gap-2 text-sm">
                <TaskRef task={w.task} item={w.item} />
                <span className="min-w-0 truncate text-fg-soft" title={w.why}>
                  {w.text}
                </span>
              </li>
            ))}
            {needs > 0 && (
              <li>
                <PageLink page="decisions" className="text-sm text-blue hover:underline">
                  {plural(needs, "decision")} in Needs you
                </PageLink>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="mt-auto flex min-w-0 flex-col gap-0.5 border-t border-line pt-2">
        <span className="text-xs font-medium tracking-wide text-fg-faint uppercase">Last action</span>
        {last === undefined ? (
          <span className="text-sm text-fg-muted">None yet.</span>
        ) : (
          <span className="min-w-0 text-sm text-fg-soft">
            {last.task ? (
              <Link to="/t/$taskId" params={{ taskId: last.task }} className="hover:underline">
                {last.sentence}
              </Link>
            ) : (
              last.sentence
            )}
            <span className="tnum ml-2 font-mono text-xs text-fg-faint">{clockTime(last.at, now)}</span>
          </span>
        )}
        <span className="tnum text-xs text-fg-faint">
          {formatMoney(lane.spend.used.cost)}
          {cap !== undefined && ` of ${formatMoney(cap)}`} today
        </span>
      </div>
    </article>
  );
}

// The feed ------------------------------------------------------------------

const DOT = {
  neutral: "text-lamp-idle",
  blue: "text-blue",
  green: "text-lamp-done",
  amber: "text-lamp-needs",
  red: "text-red",
} as const;

function Feed({ now, orgs }: { now: number; orgs: readonly OrgInfo[] }) {
  const log = useLogEntries("", "all", true);
  const since = now - FEED_HOURS * 3_600_000;
  const entries = log.entries.filter((e) => Date.parse(e.at) >= since).slice(0, FEED_MAX);
  return (
    <Card
      title="Last hours"
      aside={<span>Newest first</span>}
      className="self-start min-[1280px]:col-start-2 min-[1280px]:row-span-2 min-[1280px]:row-start-1"
    >
      {log.loading ? (
        <RowsSkeleton rows={4} height={36} />
      ) : log.error ? (
        <p className="m-0 text-sm text-red">Could not load the log: {describeError(log.error)}</p>
      ) : entries.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Nothing in the last {FEED_HOURS} hours.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {entries.map((e) => (
            <li key={e.key} className="flex min-w-0 gap-2.5 border-t border-line py-1.5 first:border-t-0">
              <time dateTime={e.at} className="tnum w-11 shrink-0 pt-px font-mono text-xs text-fg-faint">
                {clockTime(e.at, now)}
              </time>
              <span
                aria-hidden="true"
                className={cn("mt-[7px] size-1.5 shrink-0 rounded-full bg-current", DOT[e.tone])}
              />
              <span className="min-w-0 text-sm text-fg-soft text-pretty break-words">
                {e.org && e.org !== "private" && orgs.length > 1 && (
                  <span className="mr-1.5 inline-block max-w-[40%] truncate rounded-full border border-line-control px-2 py-px align-[-2px] text-xs text-fg-muted">
                    {orgName(orgs, e.org)}
                  </span>
                )}
                {e.task ? (
                  <Link
                    to="/t/$taskId"
                    params={{ taskId: e.task.id }}
                    search={e.task.item === undefined ? {} : { item: e.task.item }}
                    className="hover:underline"
                  >
                    {e.sentence}
                  </Link>
                ) : (
                  e.sentence
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// Charts --------------------------------------------------------------------

function ChartBox({
  height,
  empty,
  children,
}: {
  height: number;
  empty?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div style={{ height: empty ? 56 : height }} className="min-w-0">
      {empty ? (
        <p className="m-0 flex h-full items-center justify-center text-sm text-fg-muted">{empty}</p>
      ) : (
        <Suspense fallback={<Skeleton className="h-full w-full rounded-lg" />}>{children}</Suspense>
      )}
    </div>
  );
}

function Charts({
  autonomy,
  tasks,
  orgs,
}: {
  autonomy: AutonomyStatus;
  tasks: readonly TaskSummary[] | undefined;
  orgs: readonly OrgInfo[];
}) {
  const report = useAutonomyReport(14);
  const data = report.data;
  const cap = autonomy.spend.total.cap?.cost;
  const finishedTotal = data?.days.reduce((n, d) => n + d.orgs.reduce((m, o) => m + o.count, 0), 0) ?? 0;
  const open = (tasks ?? []).filter((t) => t.status !== "done").length;
  const error = report.isError ? `Could not load the report: ${describeError(report.error)}` : undefined;
  const spent = data?.hours.reduce((n, h) => n + h.cost, 0) ?? 0;
  return (
    <>
      <Card
        title="Spend today"
        aside={
          <span className="tnum">
            {formatMoney(autonomy.spend.total.used.cost)}
            {cap !== undefined && ` of ${formatMoney(cap)}`}
          </span>
        }
      >
        <ChartBox
          height={220}
          empty={error ?? (data === undefined ? undefined : spent === 0 ? "No spend yet today." : undefined)}
        >
          {data && <SpendChart report={data} cap={cap} />}
        </ChartBox>
        {data && spent > 0 && (
          <Suspense fallback={null}>
            <SpendLegend cap={cap !== undefined} />
          </Suspense>
        )}
      </Card>
      <Card title="Tasks finished" aside={<span>Last 14 days</span>}>
        <ChartBox
          height={240}
          empty={
            error ??
            (data === undefined
              ? undefined
              : finishedTotal === 0
                ? "Nothing finished in 14 days."
                : undefined)
          }
        >
          {data && <FinishedChart days={data.days} orgs={orgs} />}
        </ChartBox>
      </Card>
      <Card title="Where tasks are now" aside={<span className="tnum">{plural(open, "open task")}</span>}>
        <ChartBox
          height={Math.max(150, 60 + 40 * new Set((tasks ?? []).map((t) => t.org)).size)}
          empty={tasks !== undefined && open === 0 ? "No open tasks." : undefined}
        >
          {tasks && <StatusChart tasks={tasks} orgs={orgs} />}
        </ChartBox>
      </Card>
    </>
  );
}

// The dashboard -------------------------------------------------------------

/**
 * Auto-pilot at a glance: a status strip, one card per workspace lane, the last hours of the
 * captain's log and three charts. It scrolls inside its own panel and never moves the shell.
 */
export function AutopilotDashboard({ autonomy, now }: { autonomy: AutonomyStatus | undefined; now: number }) {
  const tasks = useTasks().data;
  const orgs = useOrgInfo();
  const log = useLogEntries("", "all", true);
  const [picked, setPicked] = useState<Pick>(undefined);
  const lastByOrg = useMemo(() => {
    const out = new Map<string, { sentence: string; at: string; task?: string | undefined }>();
    for (const e of log.entries) {
      const org = e.org ?? "private";
      if (!out.has(org)) out.set(org, { sentence: e.sentence, at: e.at, task: e.task?.id });
    }
    return out;
  }, [log.entries]);

  if (autonomy === undefined)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <RowsSkeleton rows={3} height={72} />
      </div>
    );
  return (
    <section
      aria-label="Auto-pilot dashboard"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-1"
    >
      <StatusStrip autonomy={autonomy} tasks={tasks} picked={picked} onPick={setPicked} />
      {picked !== undefined && tasks !== undefined && (
        <PickedList picked={picked} tasks={tasks} autonomy={autonomy} orgs={orgs} />
      )}
      <div className="grid min-w-0 gap-3 min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <Card
          title="Workspaces"
          aside={<span>{plural(autonomy.lanes.length, "lane")}</span>}
          className="min-[1280px]:col-start-1 min-[1280px]:row-start-1"
        >
          {autonomy.lanes.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">The captain has no workspace to work in yet.</p>
          ) : (
            <div className="grid gap-2.5 min-[760px]:grid-cols-2">
              {autonomy.lanes.map((lane) => (
                <LaneCard
                  key={lane.org}
                  lane={lane}
                  autonomy={autonomy}
                  tasks={tasks ?? []}
                  orgs={orgs}
                  last={lastByOrg.get(lane.org)}
                  now={now}
                />
              ))}
            </div>
          )}
        </Card>
        <Feed now={now} orgs={orgs} />
        <div className="flex min-w-0 flex-col gap-3 min-[1280px]:col-start-1 min-[1280px]:row-start-2">
          <Charts autonomy={autonomy} tasks={tasks} orgs={orgs} />
        </div>
      </div>
    </section>
  );
}
