import { type HoldFix, type HoldView, lifecycle } from "@majhi/shared";

type Hold = lifecycle.Hold;

/** A cause in a few words. Typed over every cause, so a new hold without a word fails typecheck. */
const HOLD_LABEL: { readonly [C in lifecycle.HoldCause]: string } = {
  "owner-stop": "stopped by you",
  "captain-stop": "paused by the captain",
  "autonomous-off": "Autonomous is off",
  "budget-limit": "budget",
  "account-limit": "usage limit",
  offline: "offline",
  "signed-out": "signed out",
  error: "stopped with an error",
  "autonomous-stop": "stopped by Autonomous",
  "loop-guard": "going in circles",
  idle: "nobody is working on it",
  preempted: "paused for an urgent task",
  "agents-down": "every agent is down",
  "dependency-closed": "a task it waited for was closed",
  "dependency-removed": "a link was removed",
};

/**
 * The step that ends each hold. Typed over every cause, so a new hold without a fix fails typecheck:
 * a hold is never a dead end that only says "see the room".
 */
const HOLD_FIX: { readonly [C in lifecycle.HoldCause]: (h: lifecycle.HoldOf<C>) => HoldFix } = {
  "owner-stop": () => ({ kind: "resume" }),
  "captain-stop": () => ({ kind: "resume" }),
  "autonomous-off": (h) => (h.mode === "step" ? { kind: "wait" } : { kind: "resume" }),
  "budget-limit": (h) => ({
    kind: "raise-budget",
    scope: h.scope,
    ...(h.scopeId === undefined ? {} : { scopeId: h.scopeId }),
  }),
  "account-limit": (h) => ({ kind: "open-account", account: h.account }),
  offline: () => ({ kind: "wait" }),
  "signed-out": (h) => ({ kind: "sign-in", account: h.account }),
  error: () => ({ kind: "resume" }),
  "autonomous-stop": () => ({ kind: "resume" }),
  "loop-guard": () => ({ kind: "resume" }),
  idle: () => ({ kind: "resume" }),
  preempted: () => ({ kind: "wait" }),
  "agents-down": (h) => {
    const signedOut = h.down.find((d) => d.state === "signed-out");
    if (signedOut !== undefined) return { kind: "sign-in", account: signedOut.account };
    const other = h.down[0];
    return other === undefined ? { kind: "wait" } : { kind: "open-account", account: other.account };
  },
  "dependency-closed": (h) => ({ kind: "remove-links", tasks: h.on }),
  "dependency-removed": (h) => ({ kind: "remove-links", tasks: h.on }),
};

// The table is indexed by a union of causes, so each call needs the row for this hold's own cause.
// biome-ignore lint/suspicious/noExplicitAny: a discriminated union cannot narrow a mapped-type lookup
const fixOf = (h: Hold): HoldFix => (HOLD_FIX[h.cause] as (h: any) => HoldFix)(h);

/**
 * The hold as the board reads it. Majhi lifts a hold by itself when the lifecycle table lists it as a
 * lifter and its condition is something it can watch. A hold that clears on activity waits for a
 * person to speak, so it is the owner's.
 */
export function holdViewOf(hold: Hold): HoldView {
  // A dependency hold clears only when its blockers are gone: while one exists, the owner ends it.
  const waits = lifecycle.autoClears(hold).kind;
  const byItself =
    lifecycle.liftersOf(hold).includes("majhi") &&
    waits !== "activity-after" &&
    waits !== "dependencies-resolved";
  return {
    lifter: byItself ? "system" : "owner",
    label: HOLD_LABEL[hold.cause],
    sentence: lifecycle.sentenceOf(hold),
    fix: fixOf(hold),
  };
}
