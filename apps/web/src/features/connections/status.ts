import {
  type ConnectionHealth,
  type ConnectionView,
  FAILURE_ACTION_LABEL,
  FAILURE_FIX,
  failureAction,
  failureLine,
  TRANSIENT_FAILURES,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import { formatAgo } from "@/lib/format";

/**
 * The one status of a connection: a lamp, a word and one line of why. It reads `health` and nothing
 * else, so there is no "connected but untested": a connection with no passing check says it is being
 * checked, and one that failed says why.
 */
export interface RowStatus {
  lamp: LampState;
  word: string;
  /** One line: who, or why not. */
  line: string;
  /** The one thing to do next. */
  action: "check" | "fix" | "reconnect" | "none";
  actionLabel: string;
}

export function rowStatus(
  view: Pick<ConnectionView, "health" | "lastTest" | "type">,
  checking: boolean,
  now: number,
): RowStatus {
  const health = view.health;
  if (checking || health === undefined) {
    return {
      lamp: "working",
      word: health === undefined ? "Checking" : "Connecting",
      line: "Calling the service",
      action: "none",
      actionLabel: "",
    };
  }
  switch (health.state) {
    case "connecting":
      return {
        lamp: "working",
        word: "Connecting",
        line: "Calling the service",
        action: "none",
        actionLabel: "",
      };
    case "connected":
      return {
        lamp: "done",
        word: "Connected",
        line: `Verified ${formatAgo(health.verifiedAt, now)}`,
        action: "check",
        actionLabel: "Check now",
      };
    case "failed":
    case "needs-attention": {
      const action = failureAction(view.type, health.reason);
      return {
        lamp: action === "check" ? "paused" : "needs",
        word: health.state === "failed" ? "Failed" : "Needs attention",
        line: failureLine(view),
        action,
        actionLabel: FAILURE_ACTION_LABEL[action],
      };
    }
  }
}

/** The fix text of a failure: the check's own, else the generic one for its reason. */
export function fixOf(health: ConnectionHealth | undefined): { text: string; url?: string } | undefined {
  if (health === undefined || (health.state !== "failed" && health.state !== "needs-attention"))
    return undefined;
  return {
    text: health.fix || FAILURE_FIX[health.reason],
    ...(health.fixUrl === undefined ? {} : { url: health.fixUrl }),
  };
}

/** How many connections need the owner: failed, or worked once and fails now, and the fix is theirs. */
export function needsOwner(views: readonly ConnectionView[]): number {
  return views.filter(
    (v) =>
      (v.health?.state === "failed" || v.health?.state === "needs-attention") &&
      !TRANSIENT_FAILURES.has(v.health.reason),
  ).length;
}
