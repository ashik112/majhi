import type { AutonomyReport, AutonomyStatus, SlotCapacity } from "@majhi/shared";
import type { ReactNode } from "react";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { capTone, MODE_LAMP, MODE_WORD } from "@/features/autonomy/model";
import { cn } from "@/lib/cn";
import { formatAgo, formatMoney, plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { atTime, pace } from "./model";
import { Bars } from "./sparkline";

const LABEL = "text-xs font-medium tracking-wide text-fg-faint uppercase";
const LINK = "rounded-xs hover:underline underline-offset-2";

function Segment({
  label,
  aside,
  className,
  children,
}: {
  label: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col gap-1 px-3.5 py-2.5 max-[1279px]:border-line max-[1279px]:odd:border-r max-[1279px]:nth-[n+3]:border-t min-[1280px]:border-l min-[1280px]:border-line min-[1280px]:first:border-l-0",
        className,
      )}
    >
      <div className="flex min-h-4 items-center gap-2">
        <h2 className={LABEL}>{label}</h2>
        {aside && <div className="ml-auto flex min-w-0 items-center text-xs text-fg-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Why the Auto-pilot runs, waits or is off, in one line each, worst reason first. */
function stateOf(
  autonomy: AutonomyStatus,
  machineBusy: string | undefined,
  nowMs: number,
  tz: string,
): { lamp: LampState; word: string; why: string } {
  const caps = autonomy.holds.filter((h) => h.kind !== "account");
  const held = autonomy.holds.filter((h) => h.kind === "account");
  const first = caps[0];
  if (autonomy.mode === "off")
    return { lamp: "idle", word: "Off", why: autonomy.why ?? "The captain works only when you ask." };
  if (autonomy.mode === "stopping")
    return { lamp: "paused", word: "Turning off", why: "Current steps finish, nothing new starts." };
  if (first !== undefined) {
    const until = first.until === undefined ? "" : `, back ${atTime(first.until, nowMs, tz)}`;
    return {
      lamp: "needs",
      word: first.kind === "day-cap" ? "Held by today's budget" : `Held by ${plural(caps.length, "cap")}`,
      why: `${first.text}${until}`,
    };
  }
  if (machineBusy !== undefined) return { lamp: "needs", word: "Held, machine busy", why: machineBusy };
  if (held.length > 0 && held.length >= autonomy.accounts.length && autonomy.accounts.length > 0)
    return { lamp: "needs", word: "Held by limits", why: held[0]?.text ?? "Every account is at a floor." };
  return {
    lamp: MODE_LAMP[autonomy.mode],
    word: MODE_WORD[autonomy.mode],
    why:
      autonomy.lastTick === undefined
        ? `Since ${autonomy.since === undefined ? "now" : formatAgo(autonomy.since, nowMs)}`
        : `Woke the captain ${formatAgo(autonomy.lastTick, nowMs)}`,
  };
}

function dollars(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : formatMoney(n);
}

function pct(n: number | undefined): string {
  return n === undefined ? "–" : `${Math.round(n)}%`;
}

function tone(n: number | undefined): string {
  return n === undefined
    ? "text-fg-muted"
    : n >= 100
      ? "text-red"
      : n >= 80
        ? "text-lamp-needs"
        : "text-fg-soft";
}

/**
 * The one strip on top: Auto-pilot state and why, spend with its pace, every account's slots and
 * windows, and the machine. Every number opens the page that lists what is behind it.
 */
export function StatusStrip({
  autonomy,
  report,
  slots,
  nowMs,
}: {
  autonomy: AutonomyStatus;
  report: AutonomyReport | undefined;
  slots: SlotCapacity | undefined;
  nowMs: number;
}) {
  const tz = autonomy.spend.tz;
  const total = autonomy.spend.total;
  const cap = total.cap?.cost;
  const machine = report?.machine;
  const state = stateOf(autonomy, machine?.busy, nowMs, tz);
  const p =
    report === undefined
      ? undefined
      : pace(report.hours, total.used.cost, cap, nowMs, autonomy.spend.resetsAt);
  const finished = report?.days.map((d) => d.orgs.reduce((n, o) => n + o.count, 0)) ?? [];
  const finishedTotal = finished.reduce((n, c) => n + c, 0);
  const slotOf = (id: string) => slots?.accounts.find((a) => a.account === id);
  const spendTone = capTone(total);
  return (
    <div
      className={cn(
        "grid shrink-0 grid-cols-2 rounded-2xl min-[1280px]:grid-cols-[1fr_1.15fr_1.5fr_1fr]",
        GLASS,
      )}
    >
      <Segment label="Auto-pilot">
        <PageLink page="limits" className="flex min-w-0 items-center gap-2" title="Open Limits">
          <Lamp state={state.lamp} size={9} />
          <span className="min-w-0 truncate text-lg leading-6 font-semibold text-fg">{state.word}</span>
        </PageLink>
        <p className="m-0 min-h-8 text-xs leading-4 text-fg-muted" title={state.why}>
          <span className="line-clamp-2">{state.why}</span>
        </p>
        <PageLink
          page="audit"
          title="Open the audit log"
          className={cn("flex items-center gap-2 text-xs text-fg-muted", LINK)}
        >
          <Bars
            width={84}
            height={16}
            slots={14}
            values={finished}
            labels={(report?.days ?? []).map((d, i) => `${d.day}: ${finished[i] ?? 0} finished`)}
            color="var(--c-lamp-done)"
          />
          <span className="tnum">
            <span className="font-mono text-fg-soft">{finishedTotal}</span> finished in 14 d
          </span>
        </PageLink>
      </Segment>

      <Segment
        label="Spend today"
        aside={<span className="tnum">{cap === undefined ? "no budget" : `cap ${dollars(cap)}`}</span>}
      >
        <PageLink page="usage" title="Open Usage" className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "tnum font-mono text-xl leading-6 font-medium text-fg",
              spendTone === "red" && "text-red",
              spendTone === "amber" && "text-lamp-needs",
            )}
          >
            {formatMoney(total.used.cost)}
          </span>
          {cap !== undefined && (
            <span className="tnum font-mono text-xs text-fg-faint">{Math.round(total.percent)}%</span>
          )}
        </PageLink>
        {cap !== undefined && (
          <div className="h-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
            <div
              className={cn(
                "h-full rounded-full",
                spendTone === "calm" ? "bg-accent" : spendTone === "amber" ? "bg-lamp-needs" : "bg-red",
              )}
              style={{ width: `${Math.min(100, total.percent)}%` }}
            />
          </div>
        )}
        <div className="flex min-w-0 items-end justify-between gap-2">
          <p className="tnum m-0 min-w-0 text-xs leading-4 text-fg-muted">
            {p === undefined ? (
              "No spend yet today"
            ) : (
              <>
                <span className="font-mono text-fg-soft">{formatMoney(p.perHour)}/h</span> now.
                {p.capAt === undefined ? (
                  <>
                    {" "}
                    Ends near <span className="font-mono text-fg-soft">{dollars(p.projected)}</span>
                  </>
                ) : (
                  <span className="text-lamp-needs">
                    {" "}
                    Hits the cap near {atTime(new Date(p.capAt).toISOString(), nowMs, tz)}
                  </span>
                )}
              </>
            )}
          </p>
          <Bars
            width={84}
            height={20}
            slots={24}
            values={(report?.hours ?? []).map((h) => h.cost)}
            labels={(report?.hours ?? []).map((h) => `${atTime(h.start, nowMs, tz)}: ${formatMoney(h.cost)}`)}
          />
        </div>
      </Segment>

      <Segment
        label="Accounts"
        aside={
          slots === undefined ? undefined : (
            <span className="tnum">
              <span className="font-mono text-fg-soft">{slots.agents.inUse}</span> of {slots.agents.limit}{" "}
              slots
              {slots.agents.waiting > 0 && `, ${slots.agents.waiting} waiting`}
            </span>
          )
        }
      >
        {autonomy.accounts.length === 0 ? (
          <PageLink page="accounts" className={cn("text-sm text-fg-muted", LINK)}>
            No accounts yet
          </PageLink>
        ) : (
          <ul className="m-0 flex max-h-[68px] min-h-0 list-none flex-col gap-px overflow-y-auto overscroll-contain p-0">
            {autonomy.accounts.map((a) => {
              const room = slotOf(a.id);
              const reset = a.blocked?.until ?? a.weekly?.resetsAt ?? a.window?.resetsAt;
              return (
                <li key={a.id} className="min-w-0">
                  <PageLink
                    page="accounts"
                    search={{ account: a.id }}
                    title={a.blocked?.why ?? `Open ${a.id}`}
                    className="tnum grid min-w-0 grid-cols-[8px_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 rounded-xs text-xs leading-[17px] hover:bg-raised"
                  >
                    <Lamp
                      state={a.blocked ? "needs" : room !== undefined && room.inUse > 0 ? "working" : "done"}
                      size={7}
                    />
                    <span className="min-w-0 truncate font-mono text-fg">{a.id}</span>
                    <span className="font-mono text-fg-muted">
                      {room === undefined ? "" : `${room.inUse}/${room.limit}`}
                    </span>
                    <span className={cn("font-mono", tone(a.window?.usedPct))} title="5-hour window">
                      5h {pct(a.window?.usedPct)}
                    </span>
                    <span
                      className={cn("font-mono", tone(a.weekly?.usedPct))}
                      title={reset === undefined ? "" : `Resets ${atTime(reset, nowMs, tz)}`}
                    >
                      wk {pct(a.weekly?.usedPct)}
                      {reset !== undefined && (
                        <span className="text-fg-faint"> {atTime(reset, nowMs, tz)}</span>
                      )}
                    </span>
                  </PageLink>
                </li>
              );
            })}
          </ul>
        )}
      </Segment>

      <Segment
        label="Machine"
        aside={
          machine === undefined ? undefined : (
            <span className="tnum">{plural(machine.containers, "container")}</span>
          )
        }
      >
        {machine === undefined ? (
          <p className="m-0 text-xs leading-4 text-fg-muted">Not read. The host helper is not connected.</p>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <Lamp state={machine.busy === undefined ? "done" : "needs"} size={9} />
              <span className="tnum min-w-0 truncate font-mono text-lg leading-6 font-medium text-fg">
                {machine.load1.toFixed(1)}
                <span className="text-xs font-normal text-fg-faint"> / {machine.cores} cores</span>
              </span>
            </div>
            <p className="tnum m-0 min-h-8 text-xs leading-4 text-fg-muted" title={machine.busy}>
              {machine.busy ?? (
                <>
                  {machine.idleCpuPct !== undefined && `CPU ${Math.round(machine.idleCpuPct)}% idle. `}
                  {machine.memFreePct !== undefined && `Memory ${Math.round(machine.memFreePct)}% free. `}
                  {machine.diskFreeGb !== undefined && `Disk ${Math.round(machine.diskFreeGb)} GB free.`}
                </>
              )}
            </p>
            {machine.usage !== undefined && (
              <p
                className="tnum m-0 truncate text-xs leading-4 text-fg-muted"
                title={usageLine(machine.usage)}
              >
                {usageLine(machine.usage)}
              </p>
            )}
          </>
        )}
      </Segment>
    </div>
  );
}

/** "majhi uses 40 GB: tasks 20, Docker 20". */
function usageLine(u: { tasksGb: number; dockerGb?: number | undefined }): string {
  const total = Math.round(u.tasksGb + (u.dockerGb ?? 0));
  const docker = u.dockerGb === undefined ? "" : `, Docker ${Math.round(u.dockerGb)}`;
  return `majhi uses ${total} GB: tasks ${Math.round(u.tasksGb)}${docker}`;
}
