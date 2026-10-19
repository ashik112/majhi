import {
  type lifecycle,
  type PlanStep,
  type Role,
  STEP_SEND_BACKS_MAX,
  type TeamPlan,
  WORKERS_MAX,
} from "@majhi/shared";
import { limitClock } from "../runs/limit.ts";
import type { Limits } from "./team-facts.ts";

/** An account that cannot run, and what fixes it (signed out: sign in; at a limit: it resets at `until`). */
export type DownAccount = lifecycle.DownAccount;

/**
 * Lead and workers (workflow reset, step 1b). The lead's plan is the only way a worker gets work: each
 * step names its owner, one step runs at a time, and a worker that finishes posts one result line and
 * the next step starts. Pure: the plan in, the plan out. `crew-run.ts` does the handoffs.
 */

/** What staffing sees of one agent of the task: whether it can run now and what it has left. */
export interface Hand {
  id: string;
  /** Its account can run now (signed in, reachable, under its limits). */
  up: boolean;
  /** 0 to 100: the least left of its plan windows; an API key counts as 100, unknown limits as 50. */
  headroom: number;
  /** What the agent cost this task so far, in USD. */
  costUsd: number;
  /** Why it cannot run, with the account and the reset when it is at a limit. */
  down?: DownAccount | undefined;
}

/** The headroom of an account from its limits (team facts), in whole percent. */
export function headroomOf(limits: Limits): number {
  if (limits.kind === "api-key") return 100;
  if (limits.kind === "unknown") return 50;
  if (limits.status === "needs-login" || limits.status === "unreachable" || limits.status === "at-limit")
    return 0;
  const left = [limits.window?.leftPct, limits.weekly?.leftPct].filter((n): n is number => n !== undefined);
  return left.length === 0 ? 50 : Math.min(...left);
}

/**
 * Whether an account can run now, and if not what is wrong with it and when it resets. `marked` is the end of
 * the limit mark a run's limit error put on the account: it wins over what the windows say.
 */
export function downOf(account: string, limits: Limits, marked?: string): DownAccount | undefined {
  if (limits.kind !== "plan") return undefined;
  if (limits.status === "needs-login") return { account, state: "signed-out" };
  if (limits.status === "unreachable") return { account, state: "unreachable" };
  if (limits.status !== "at-limit") return undefined;
  // At its limit until the full window resets (the weekly one when both are full).
  const full = [limits.window, limits.weekly].filter((w) => w?.leftPct === 0);
  const until = full.map((w) => w?.resetsAt).filter((t): t is string => t !== undefined);
  const latest = marked ?? (until.length === 0 ? undefined : [...until].sort().at(-1));
  return { account, state: "at-limit", ...(latest === undefined ? {} : { until: latest }) };
}

/**
 * Best first: an agent that can run, then the most headroom, then the least spent, then workers before
 * the lead (a worker is the cheaper hand), then the id so the order is the same every time.
 */
export function byFit(lead: string): (a: Hand, b: Hand) => number {
  return (a, b) =>
    Number(b.up) - Number(a.up) ||
    b.headroom - a.headroom ||
    a.costUsd - b.costUsd ||
    Number(a.id === lead) - Number(b.id === lead) ||
    a.id.localeCompare(b.id);
}

/** Who takes a step when its owner is down: the best hand that can run, any worker or the lead. */
export function replacement(hands: readonly Hand[], down: string, lead: string): string | undefined {
  const pick = hands
    .filter((h) => h.id !== down && h.up)
    .sort(byFit(lead))
    .at(0);
  return pick?.id;
}

/** Who leads when the lead is down: the worker with the most headroom that can run. */
export function newLead(hands: readonly Hand[], lead: string): string | undefined {
  return replacement(
    hands.filter((h) => h.id !== lead),
    lead,
    lead,
  );
}

/** The agents of the team that cannot run, with what each one needs. Empty when any can. */
export function allDown(hands: readonly Hand[]): DownAccount[] {
  if (hands.length === 0 || hands.some((h) => h.up)) return [];
  return hands.flatMap((h) => (h.down === undefined ? [] : [h.down]));
}

/** An agent that could review the work: on the team, or one that could join. */
export interface ReviewerCandidate {
  id: string;
  role: Role;
  inTeam: boolean;
  up: boolean;
  /** What its model costs per million output tokens, when the price table knows the model. */
  price: number | undefined;
}

/**
 * Who reviews: an agent that can run, a Reviewer by role, the cheapest model, never the lead when
 * another can, one already on the team (it takes no place), then the id.
 */
export function pickReviewer(
  candidates: readonly ReviewerCandidate[],
  lead: string,
): ReviewerCandidate | undefined {
  const cmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
  return [...candidates].sort(
    (a, b) =>
      cmp(Number(!a.up), Number(!b.up)) ||
      cmp(Number(a.role !== "Reviewer"), Number(b.role !== "Reviewer")) ||
      cmp(a.price ?? Number.POSITIVE_INFINITY, b.price ?? Number.POSITIVE_INFINITY) ||
      cmp(Number(a.id === lead), Number(b.id === lead)) ||
      cmp(Number(!a.inTeam), Number(!b.inTeam)) ||
      a.id.localeCompare(b.id),
  )[0];
}

/**
 * What the paused card says when every agent is down: each account and the one fix or reset time that
 * brings it back, in the owner's clock. "Every agent is down. Sign in claude-acme, or wait for codex-acme
 * (resets 3:40 PM). It resumes by itself when one is back."
 */
export function downText(down: readonly DownAccount[], now: Date): string {
  const fixes = down.map((d) =>
    d.state === "signed-out"
      ? `sign in ${d.account}`
      : d.state === "unreachable"
        ? `reach ${d.account}`
        : `wait for ${d.account}${d.until === undefined ? "" : ` (resets ${limitClock(d.until, now)})`}`,
  );
  const [first, ...rest] = fixes;
  const head = first === undefined ? "" : `${first.slice(0, 1).toUpperCase()}${first.slice(1)}`;
  return `Every agent is down. ${[head, ...rest].join(", or ")}. It resumes by itself when one is back.`;
}

/** Whether the team has room for one more worker. */
export function hasRoomForWorker(team: readonly string[]): boolean {
  return team.length < WORKERS_MAX + 1;
}

/** The agent a step names: `me` is the lead. An id the team lacks has no owner. */
export function ownerOf(step: Pick<PlanStep, "who">, team: readonly string[]): string | undefined {
  const lead = team[0];
  const who = step.who.trim().replace(/^@/, "").toLowerCase();
  if (who === "me" || who === "") return lead;
  return team.find((a) => a.toLowerCase() === who);
}

export const statusOf = (step: PlanStep) => step.status ?? "todo";

/** The step an agent is working on now, if any. */
export function doingBy(plan: TeamPlan, agent: string, team: readonly string[]): number | undefined {
  const i = plan.steps.findIndex((s) => statusOf(s) === "doing" && ownerOf(s, team) === agent);
  return i === -1 ? undefined : i;
}

/** The step in progress, whoever owns it. */
export function doing(plan: TeamPlan): number | undefined {
  const i = plan.steps.findIndex((s) => statusOf(s) === "doing");
  return i === -1 ? undefined : i;
}

/** The first step that has not started. */
export function next(plan: TeamPlan): number | undefined {
  const i = plan.steps.findIndex((s) => statusOf(s) === "todo");
  return i === -1 ? undefined : i;
}

/** Whether any step is still to do or in progress. */
export function unfinished(plan: TeamPlan): boolean {
  return plan.steps.some((s) => statusOf(s) === "todo" || statusOf(s) === "doing");
}

function withStep(plan: TeamPlan, i: number, change: (s: PlanStep) => PlanStep): TeamPlan {
  return { ...plan, steps: plan.steps.map((s, j) => (j === i ? change(s) : s)) };
}

/** Step `i` starts with `owner` (a step handed to a replacement names the replacement from now on). */
export function begin(plan: TeamPlan, i: number, owner: string, lead: string): TeamPlan {
  return withStep(plan, i, (s) => ({ ...s, who: owner === lead ? "me" : owner, status: "doing" }));
}

/** Step `i` is done, with the one line its owner posted. */
export function finish(plan: TeamPlan, i: number, result: string): TeamPlan {
  return withStep(plan, i, (s) => ({ ...s, status: "done", result: oneLine(result) }));
}

/** A worker's result for its step, before it ends its turn: kept on the step. */
export function noteResult(plan: TeamPlan, i: number, result: string): TeamPlan {
  return withStep(plan, i, (s) => ({ ...s, result: oneLine(result) }));
}

/**
 * Step `target` is sent back by the agent running step `by`: every step from `target` to `by` runs again,
 * in order. The second time one step is sent back it stops instead, and the task goes to the owner with
 * the reason.
 */
export function sendBack(
  plan: TeamPlan,
  target: number,
  by: number,
  reason: string,
): { plan: TeamPlan; stopped: boolean } {
  const times = (plan.steps[target]?.sentBack ?? 0) + 1;
  const stopped = times >= STEP_SEND_BACKS_MAX;
  const why = oneLine(reason, 600);
  const steps = plan.steps.map((s, j) => {
    if (j === target)
      return {
        ...s,
        sentBack: times,
        reason: why,
        status: stopped ? ("stopped" as const) : ("todo" as const),
      };
    if (j > target && j <= by) return { ...s, status: "todo" as const };
    return s;
  });
  return { plan: { ...plan, steps }, stopped };
}

/** The step a stopped plan waits on, if any. */
export function stoppedStep(plan: TeamPlan): number | undefined {
  const i = plan.steps.findIndex((s) => statusOf(s) === "stopped");
  return i === -1 ? undefined : i;
}

/** One line of at most `max` characters: the first non-empty line, cut with an ellipsis. */
export function oneLine(text: string, max = 300): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The plan as a short list for a prompt or a handoff note: each step with who and where it stands. */
export function progressLines(plan: TeamPlan): string[] {
  return plan.steps.map((s, i) => {
    const mark = { todo: "[ ]", doing: "[>]", done: "[x]", stopped: "[!]" }[statusOf(s)];
    const who = s.who === "me" ? "lead" : `@${s.who.replace(/^@/, "")}`;
    const result = s.result === undefined ? "" : ` Result: ${s.result}`;
    const back = s.sentBack === undefined || s.sentBack === 0 ? "" : ` Sent back ${s.sentBack}x.`;
    return `${mark} ${i + 1}. ${who}: ${s.what}${result}${back}`;
  });
}

/** The prompt a step's owner gets: the step, the plan around it, and how to report. */
export function stepPrompt(plan: TeamPlan, i: number, owner: string, why?: string): string {
  const step = plan.steps[i];
  const total = plan.steps.length;
  const back =
    step?.reason === undefined || (step.sentBack ?? 0) === 0
      ? []
      : [
          "",
          `This step was sent back (${step.sentBack} time${step.sentBack === 1 ? "" : "s"}). Why: ${step.reason}`,
        ];
  return [
    `Your step: step ${i + 1} of ${total}. ${step?.what ?? ""}`,
    ...(why === undefined ? [] : ["", why]),
    ...back,
    "",
    `The plan, @${owner}, with where each step stands:`,
    ...progressLines(plan),
    "",
    "Do this step and nothing else; the next one starts when you end your turn. Finish with one line saying what you did, or what you found. Do not hand work to anyone: majhi hands the next step on.",
  ].join("\n");
}
