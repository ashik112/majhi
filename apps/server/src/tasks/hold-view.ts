import { type HoldView, lifecycle } from "@majhi/shared";

type Hold = lifecycle.Hold;

/** A cause in a few words. Typed over every cause, so a new hold without a word fails typecheck. */
const HOLD_LABEL: { readonly [C in lifecycle.HoldCause]: string } = {
  "owner-stop": "stopped by you",
  "captain-stop": "paused by the captain",
  "autopilot-off": "Auto-pilot is off",
  "budget-limit": "budget",
  "account-limit": "usage limit",
  offline: "offline",
  "signed-out": "signed out",
  error: "stopped with an error",
  "loop-guard": "going in circles",
  idle: "nobody is working on it",
  "dependency-closed": "a task it waited for was closed",
  "dependency-removed": "a link was removed",
};

/**
 * The hold as the board reads it. Majhi lifts a hold by itself when the lifecycle table lists it as a
 * lifter and its condition is something it can watch. A hold that clears on activity waits for a
 * person to speak, so it is the owner's.
 */
export function holdViewOf(hold: Hold): HoldView {
  const byItself =
    lifecycle.liftersOf(hold).includes("majhi") && lifecycle.autoClears(hold).kind !== "activity-after";
  return {
    lifter: byItself ? "system" : "owner",
    label: HOLD_LABEL[hold.cause],
    sentence: lifecycle.sentenceOf(hold),
  };
}
