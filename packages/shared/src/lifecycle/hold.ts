import { z } from "zod";
import { IdSchema } from "../ids.ts";
import { TaskIdSchema } from "../tasks.ts";

/**
 * Holds (docs/design/task-lifecycle.md, section 4.2 and 4.3). A hold is a persisted cause that keeps
 * a task from moving, with the data its lifter needs. A task has at most one. Anything that is only
 * a function of the world now (machine busy, no free slot) is a blocker, not a hold.
 *
 * Free text on a hold (`why`, `error`) is display only: no code reads it back.
 */

const At = z.string().datetime();
const AccountId = IdSchema;

/** An account that cannot run: signed out (the fix is a sign-in) or at a usage limit (it resets at `until`). */
export const DownAccountSchema = z.object({
  account: AccountId,
  state: z.enum(["signed-out", "at-limit", "unreachable"]),
  until: At.optional(),
});
export type DownAccount = z.infer<typeof DownAccountSchema>;

export const HoldSchema = z.discriminatedUnion("cause", [
  z.object({ cause: z.literal("owner-stop"), at: At }),
  z.object({ cause: z.literal("captain-stop"), at: At, why: z.string().optional() }),
  // The Autonomous switch: `now` paused it at once, `step` lets the run finish its step.
  z.object({ cause: z.literal("autonomous-off"), at: At, mode: z.enum(["now", "step"]) }),
  // One budget model: scope x period, plus the per-account reserve. `scopeId` names the org or
  // account when the scope is one. `alertId` is set when a budget alert fired it; the run gate's
  // own cap hold (Autonomous day and org caps until they fold in) has none.
  z.object({
    cause: z.literal("budget-limit"),
    at: At,
    scope: z.enum(["task", "org", "account", "all", "reserve"]),
    scopeId: z.string().optional(),
    period: z.enum(["day", "week", "month"]),
    until: At.optional(),
    alertId: z.string().optional(),
  }),
  z.object({ cause: z.literal("account-limit"), at: At, account: AccountId, until: At.optional() }),
  z.object({ cause: z.literal("offline"), at: At }),
  // Raised only when the lead's hand-off to a fallback or a teammate found nobody (runs/manager.ts).
  z.object({ cause: z.literal("signed-out"), at: At, account: AccountId }),
  z.object({
    cause: z.literal("error"),
    at: At,
    phase: z.enum(["start", "turn", "restart"]),
    error: z.string().max(2000),
  }),
  z.object({ cause: z.literal("loop-guard"), at: At, why: z.string() }),
  // Autonomous stopped a task it was working on: it failed twice, or it spent the budget of its size. The owner decides.
  z.object({ cause: z.literal("autonomous-stop"), at: At, why: z.string() }),
  z.object({ cause: z.literal("idle"), at: At, why: z.string() }),
  // A more urgent task took this one's running place (priority preemption). It resumes through the line.
  z.object({ cause: z.literal("preempted"), at: At }),
  // Every agent of the task is down. `down` names each account and what fixes it, so the owner reads the
  // exact step or reset time; the hold lifts by itself when any of them is back.
  z.object({ cause: z.literal("agents-down"), at: At, down: z.array(DownAccountSchema) }),
  z.object({ cause: z.literal("dependency-closed"), at: At, on: z.array(TaskIdSchema).min(1) }),
  z.object({ cause: z.literal("dependency-removed"), at: At, on: z.array(TaskIdSchema).min(1) }),
]);
export type Hold = z.infer<typeof HoldSchema>;
export type HoldCause = Hold["cause"];
export type HoldOf<C extends HoldCause> = Extract<Hold, { cause: C }>;

export type Lifter = "owner" | "captain" | "majhi";

/** What the world reads like right now. The tick fills it from the sensors that stay. */
export interface ClearReading {
  now: string;
  online: boolean;
  accounts: Readonly<Record<string, { signedIn: boolean; limitedUntil?: string | undefined }>>;
  /** Whether the budget behind a `budget-limit` hold has room again (limit raised or period rolled). */
  budgetHasRoom: boolean;
  autonomous: "on" | "off" | "stopping";
  /** The held run reached the end of its current step. */
  runAtStep: boolean;
  /** A running place is free (the running cap has room). Absent: not known, so a slot hold does not lift. */
  slotFree?: boolean | undefined;
  /**
   * Some agent of the held task can run (an account signed in, a limit reset). Absent: only the accounts the
   * hold names count. A hold read back from storage names none, so its caller checks the team itself.
   */
  anyAccountUp?: boolean | undefined;
  /** When an agent last spoke in the task or a message last arrived for it. */
  lastActivityAt?: string | undefined;
  /** Tasks that no longer hold anything back: gone, or met. A dependency hold whose blockers are all in here has nothing left to wait for. */
  resolvedTasks?: readonly string[] | undefined;
}

/** A typed condition under which majhi lifts a hold on its own. */
export type AutoClear =
  | { kind: "never" }
  | { kind: "online" }
  | { kind: "account-signed-in"; account: string }
  | { kind: "account-available"; account: string }
  | { kind: "budget-room"; until?: string | undefined }
  | { kind: "step-or-autonomous-on" }
  | { kind: "slot-free" }
  | { kind: "any-account-available"; accounts: readonly string[] }
  | { kind: "activity-after"; at: string }
  /** Every one of these tasks is gone or met, so a link to it holds nothing. */
  | { kind: "dependencies-resolved"; ids: readonly string[] };

/** Whether `condition` holds in `reading`. Pure. */
export function conditionMet(condition: AutoClear, reading: ClearReading): boolean {
  switch (condition.kind) {
    case "never":
      return false;
    case "online":
      return reading.online;
    case "account-signed-in":
      return reading.accounts[condition.account]?.signedIn === true;
    case "account-available": {
      const a = reading.accounts[condition.account];
      if (a === undefined || !a.signedIn) return false;
      return a.limitedUntil === undefined || a.limitedUntil <= reading.now;
    }
    case "budget-room":
      return reading.budgetHasRoom || (condition.until !== undefined && condition.until <= reading.now);
    case "step-or-autonomous-on":
      return reading.runAtStep || reading.autonomous === "on";
    case "slot-free":
      return reading.slotFree === true;
    case "any-account-available":
      return (
        reading.anyAccountUp === true ||
        condition.accounts.some((account) => conditionMet({ kind: "account-available", account }, reading))
      );
    case "activity-after":
      return reading.lastActivityAt !== undefined && reading.lastActivityAt > condition.at;
    case "dependencies-resolved":
      return condition.ids.every((id) => reading.resolvedTasks?.includes(id) === true);
  }
}

interface HoldRow<C extends HoldCause> {
  /** Who may lift it. Derived from the cause (and mode), never stored. */
  lifters: (h: HoldOf<C>) => readonly Lifter[];
  /** What majhi clears it on by itself. */
  autoClears: (h: HoldOf<C>) => AutoClear;
  /** The one sentence the owner reads. */
  sentence: (h: HoldOf<C>) => string;
}

/** What is down and what fixes each: "Every agent is down. Sign in claude-acme, or wait for codex-acme (resets ...)." */
function downSentence(down: readonly DownAccount[]): string {
  if (down.length === 0) return "Every agent is down.";
  const parts = down.map((d) =>
    d.state === "signed-out"
      ? `sign in ${d.account}`
      : d.state === "unreachable"
        ? `reach ${d.account}`
        : `wait for ${d.account}${d.until === undefined ? "" : ` (resets ${d.until})`}`,
  );
  const [first, ...rest] = parts;
  const head = first === undefined ? "" : `${first.slice(0, 1).toUpperCase()}${first.slice(1)}`;
  return `Every agent is down. ${[head, ...rest].join(", or ")}.`;
}

const sentenceEnd = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The single table. Keyed by cause and typed as a mapped type over every `HoldCause`, so a new
 * kind without a row fails typecheck.
 */
export const HOLD_TABLE: { readonly [C in HoldCause]: HoldRow<C> } = {
  "owner-stop": {
    lifters: () => ["owner"],
    autoClears: () => ({ kind: "never" }),
    sentence: () => "You stopped it. Continue when you are ready.",
  },
  "captain-stop": {
    lifters: () => ["owner", "captain"],
    autoClears: () => ({ kind: "never" }),
    sentence: (h) =>
      h.why === undefined ? "The captain paused it." : `The captain paused it: ${sentenceEnd(h.why)}`,
  },
  "autonomous-off": {
    lifters: (h) => (h.mode === "now" ? ["owner", "captain"] : ["owner", "majhi"]),
    autoClears: (h) => (h.mode === "now" ? { kind: "never" } : { kind: "step-or-autonomous-on" }),
    sentence: (h) =>
      h.mode === "now"
        ? "Paused when Autonomous was turned off."
        : "Autonomous is stopping. It stops at the end of this step.",
  },
  "budget-limit": {
    lifters: () => ["owner", "majhi"],
    autoClears: (h) => ({ kind: "budget-room", until: h.until }),
    sentence: (h) =>
      `The ${h.scope === "all" ? "overall" : (h.scopeId ?? h.scope)} budget for the ${h.period} is used up. Raise it${
        h.until === undefined ? " or wait for the next period." : ` or wait until ${h.until}.`
      }`,
  },
  "account-limit": {
    lifters: () => ["majhi", "owner"],
    autoClears: (h) => ({ kind: "account-available", account: h.account }),
    sentence: (h) => `${h.account} hit its usage limit. It resumes by itself.`,
  },
  offline: {
    lifters: () => ["majhi", "owner"],
    autoClears: () => ({ kind: "online" }),
    sentence: () => "No network. It resumes when you are back online.",
  },
  "signed-out": {
    lifters: () => ["majhi", "owner"],
    autoClears: (h) => ({ kind: "account-signed-in", account: h.account }),
    sentence: (h) => `${h.account} is signed out. Sign in again and it resumes.`,
  },
  error: {
    lifters: () => ["owner", "captain"],
    autoClears: () => ({ kind: "never" }),
    sentence: (h) =>
      h.error.trim() === ""
        ? "It stopped with an error."
        : `It stopped with an error: ${sentenceEnd(h.error)}`,
  },
  "autonomous-stop": {
    lifters: () => ["owner"],
    autoClears: () => ({ kind: "never" }),
    sentence: (h) => `${sentenceEnd(h.why)} Autonomous stopped it. Say what to change, then resume it.`,
  },
  "loop-guard": {
    lifters: () => ["owner"],
    autoClears: () => ({ kind: "never" }),
    sentence: (h) => `${sentenceEnd(h.why)} It was stopped. Say what to change.`,
  },
  preempted: {
    lifters: () => ["majhi", "owner"],
    autoClears: () => ({ kind: "slot-free" }),
    sentence: () => "Paused for a more urgent task. It resumes when a running place frees.",
  },
  "agents-down": {
    lifters: () => ["majhi", "owner"],
    autoClears: (h) => ({ kind: "any-account-available", accounts: h.down.map((d) => d.account) }),
    sentence: (h) => `${downSentence(h.down)} It resumes by itself when one is back.`,
  },
  idle: {
    // The design lists O and C; majhi is added because the cause auto-clears on activity.
    lifters: () => ["owner", "captain", "majhi"],
    autoClears: (h) => ({ kind: "activity-after", at: h.at }),
    sentence: (h) => `Nothing is moving and nobody is left to wake. ${sentenceEnd(h.why)}`,
  },
  "dependency-closed": {
    // The owner removes the link or merges the blocker; majhi lifts it when the blocker no longer exists.
    lifters: () => ["owner", "majhi"],
    autoClears: (h) => ({ kind: "dependencies-resolved", ids: h.on }),
    sentence: (h) => `${h.on.join(", ")} was closed without merging. Merge it or remove the link.`,
  },
  "dependency-removed": {
    lifters: () => ["owner", "majhi"],
    autoClears: (h) => ({ kind: "dependencies-resolved", ids: h.on }),
    sentence: (h) =>
      `${h.on.join(", ")} no longer ${h.on.length === 1 ? "exists" : "exist"}. Remove the ${h.on.length === 1 ? "link" : "links"} to continue.`,
  },
};

// The table is indexed by a union of causes, so each call needs the row for this hold's own cause.
// biome-ignore lint/suspicious/noExplicitAny: a discriminated union cannot narrow a mapped-type lookup
const rowOf = (h: Hold): HoldRow<any> => HOLD_TABLE[h.cause];

export const liftersOf = (h: Hold): readonly Lifter[] => rowOf(h).lifters(h);
export const autoClears = (h: Hold): AutoClear => rowOf(h).autoClears(h);
export const sentenceOf = (h: Hold): string => rowOf(h).sentence(h);

/** Whether majhi may lift `h` right now: it is a lifter and its condition holds. */
export const majhiMayLift = (h: Hold, reading: ClearReading): boolean =>
  liftersOf(h).includes("majhi") && conditionMet(autoClears(h), reading);

/**
 * Which hold stays when a second one arrives for the same task. The same cause: the newer one
 * (fresher data; for Autonomous, `now` beats `step`). Otherwise the one fewer parties can lift, so an owner-only hold is never
 * replaced by one majhi can clear. A tie keeps the existing hold, except that a removed
 * dependency replaces a closed one (it is the later fact).
 */
export function mergeHold(existing: Hold | undefined, incoming: Hold): Hold {
  if (existing === undefined) return incoming;
  if (existing.cause === "autonomous-off" && incoming.cause === "autonomous-off")
    return existing.mode === "now" ? existing : incoming;
  if (existing.cause === incoming.cause) return incoming;
  if (existing.cause === "dependency-closed" && incoming.cause === "dependency-removed") return incoming;
  return liftersOf(incoming).length < liftersOf(existing).length ? incoming : existing;
}
