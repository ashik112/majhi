import type { Authority, AuthorityRow } from "./authority.ts";
import type { AutonomyMode } from "./autonomy.ts";
import type { CaptainChore } from "./chores.ts";
import type { Freeze, WorkHours } from "./settings.ts";

/**
 * May the captain do this now? The one place that answers it (rule set of 2026-10-08).
 *
 * Two jobs. `reacting`: something came in (an incident, a finding, an agent's question, an owner's task
 * reaching review, a fix task a lead opened). It never waits for Auto-pilot. `backlog`: the captain picks
 * tasks from the backlog by the owner's rules, drives them to done and ships them, and runs upkeep on
 * schedule. It needs Auto-pilot on.
 *
 * Each action then checks only its own Permissions line (`act`). `read` is the actions that change
 * nothing (investigating, triage, answering from the wiki, reviewing, planning a deploy): no line, no
 * hours. The Stop switch halts every job. Hours and freeze dates hold changes, never reads, and never an
 * incident. Pure: callers pass the facts they read now.
 */

export type Job = "reacting" | "backlog";

/** A Permissions line, or `read` for work that changes nothing. */
export type Act = AuthorityRow | "read";

/**
 * The one typed value `may` reads. `captainPolicyOf` (apps/server/src/captain/policy.ts) builds it from the
 * settings in one place, so a caller never reads the settings itself and a later change of where the
 * settings live replaces that adapter only.
 */
export interface CaptainPolicy {
  /** The workspace's name, for the lines the owner reads. */
  name: string;
  authority: Authority;
  /** Auto-pilot's switch. Only backlog work reads it. */
  autopilot: AutonomyMode;
  /** The owner pressed Stop everything. */
  stopped: boolean;
  /** Working hours and freeze dates, in `tz`. Absent: any time. */
  hours?: WorkHours | undefined;
  freeze?: readonly Freeze[] | undefined;
  tz: string;
}

/** What is true now, read by the caller from live state. */
export interface CaptainFacts {
  now: Date;
}

export interface MayAsk {
  job: Job;
  act: Act;
  /** An incident's own work: hours do not hold it. */
  incident?: boolean;
}

export type May =
  | { ok: true }
  | { ok: false; because: "stopped" | "autopilot" | "line" | "rest"; why: string; row?: AuthorityRow };

export const STOPPED_WHY = "Stop everything is on";
export const AUTOPILOT_WHY = "Auto-pilot is off, so the captain takes no backlog work";

/** What Auto-pilot and the Stop switch alone say: no line, no hours. */
export function mayWork(policy: Pick<CaptainPolicy, "autopilot" | "stopped">, job: Job): May {
  if (policy.stopped) return { ok: false, because: "stopped", why: STOPPED_WHY };
  if (job === "backlog" && policy.autopilot !== "on") {
    return { ok: false, because: "autopilot", why: AUTOPILOT_WHY };
  }
  return { ok: true };
}

/** The answer for one action, in the order the owner would look: the switches, the line, then the hours. */
export function may(
  policy: CaptainPolicy,
  facts: CaptainFacts,
  ask: MayAsk,
  lineWhy: (row: AuthorityRow, name: string) => string,
): May {
  const work = mayWork(policy, ask.job);
  if (!work.ok) return work;
  if (ask.act === "read") return work;
  if (policy.authority[ask.act] !== "decide") {
    return { ok: false, because: "line", row: ask.act, why: lineWhy(ask.act, policy.name) };
  }
  const rest = ask.incident === true ? undefined : restOf(policy, facts.now);
  if (rest !== undefined) return { ok: false, because: "rest", why: `${policy.name} is resting: ${rest}` };
  return { ok: true };
}

/** Why the workspace rests now (a freeze date, or outside working hours), or undefined. */
export function restOf(
  policy: Pick<CaptainPolicy, "hours" | "freeze" | "tz">,
  now: Date,
): string | undefined {
  const day = dayIn(now, policy.tz);
  const frozen = (policy.freeze ?? []).find((f) => f.from <= day && day <= f.to);
  if (frozen !== undefined) {
    return frozen.from === frozen.to
      ? `${day} is a freeze date`
      : `${frozen.from} to ${frozen.to} is a freeze`;
  }
  if (policy.hours !== undefined && !withinHours(policy.hours, clockIn(now, policy.tz))) {
    return `outside working hours (${policy.hours.from} to ${policy.hours.to})`;
  }
  return undefined;
}

/** `YYYY-MM-DD` of an instant in a zone. */
function dayIn(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `HH:MM` now in the zone. */
export function clockIn(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** Whether `clock` is in `[from, to)`, with hours that may run over midnight. */
export function withinHours(hours: { from: string; to: string }, clock: string): boolean {
  return hours.from < hours.to
    ? clock >= hours.from && clock < hours.to
    : clock >= hours.from || clock < hours.to;
}

/** Task origins whose work is a reaction to something that came in, not a pick from the backlog. */
const REACTING_ORIGINS: ReadonlySet<string> = new Set(["finding", "watch", "client", "chat", "deploy"]);

/** The job of starting a task: a task made from an incident, finding, client or chat is a reaction; a follow-up fix too. */
export function jobOfStart(task: {
  origin?: { kind: string } | undefined;
  followUpOf?: string | undefined;
}): Job {
  if (task.followUpOf !== undefined) return "reacting";
  return task.origin !== undefined && REACTING_ORIGINS.has(task.origin.kind) ? "reacting" : "backlog";
}

/**
 * Each chore's job. Cards, questions and ship react to what agents and owner-started tasks do; memory and
 * cleanup have always run with Auto-pilot off. The rest is upkeep on a schedule: backlog work.
 */
export const CHORE_JOB: Readonly<Record<CaptainChore, Job>> = {
  ship: "reacting",
  cards: "reacting",
  questions: "reacting",
  memory: "reacting",
  cleanup: "reacting",
  projects: "backlog",
  triage: "backlog",
  followups: "backlog",
  discover: "backlog",
  tidy: "backlog",
  health: "backlog",
  checklist: "backlog",
  wiki: "backlog",
  watches: "backlog",
};

/** Chores that only look and file findings, proposals or drafts: working hours never hold them. */
export const READ_ONLY_CHORES: ReadonlySet<CaptainChore> = new Set([
  "triage",
  "followups",
  "checklist",
  "discover",
  "watches",
]);

/** Why a chore may not run now for the switches alone, or undefined. */
export function choreSwitchWhy(
  policy: Pick<CaptainPolicy, "autopilot" | "stopped">,
  chore: CaptainChore,
): string | undefined {
  const work = mayWork(policy, CHORE_JOB[chore]);
  return work.ok ? undefined : work.why;
}
