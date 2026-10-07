import {
  type ConnectionHealth,
  type ConnectionView,
  connectionFailing,
  FAILURE_FIX,
  FAILURE_LINE,
  type FailureReason,
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

/** Reasons where signing in again is the fix. */
const RECONNECT: ReadonlySet<FailureReason> = new Set<FailureReason>([
  "rejected",
  "expired",
  "insufficient-scope",
  "no-credential",
  "not-signed-in",
]);

export function rowStatus(health: ConnectionHealth | undefined, checking: boolean, now: number): RowStatus {
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
      const transient = TRANSIENT_FAILURES.has(health.reason);
      const reconnect = RECONNECT.has(health.reason);
      return {
        lamp: transient ? "paused" : "needs",
        word: health.state === "failed" ? "Failed" : "Needs attention",
        line: FAILURE_LINE[health.reason],
        action: transient ? "check" : reconnect ? "reconnect" : "fix",
        actionLabel: transient ? "Check now" : reconnect ? "Reconnect" : "Fix",
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
  return views.filter((v) => connectionFailing(v.health)).length;
}
