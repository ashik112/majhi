import type { PausedBy, PausedReason } from "../tasks.ts";
import type { Hold } from "./hold.ts";
import type { LifecycleStatus } from "./transition.ts";

/**
 * Today's stored fields to (status, hold) and back. Step C dual-writes through `toStored`, step E
 * backfills through `fromStored`. Pure. The cases where the old fields cannot say enough, or say
 * more than the new model keeps, are explicit below and pinned in `stored.test.ts`.
 */

/** The old status enum, `paused` included. */
export type StoredStatus = LifecycleStatus | "paused";
export type Lane = "inbox" | "ready" | "running" | "review";

/** The hold scope that marks a task Stop now paused (`STOPPED_NOW` in autonomy/repo.ts). */
export const STOPPED_NOW = "stop-now";
/** Marks a limit migrated from a plain `limit` pause that no alert is known for. */
export const LEGACY_ALERT = "legacy";

export interface StoredFields {
  status: StoredStatus;
  pausedReason?: PausedReason | undefined;
  pausedBy?: PausedBy | undefined;
  /** `autonomy_tasks.held / held_scope / resumed_at`. */
  held?: "owner" | "limit" | undefined;
  heldScope?: string | undefined;
  resumedAt?: string | undefined;
}

/**
 * What the stored fields do not say. The migration fills it from other tables (`task_links`,
 * the accounts cache); without it each field falls back to the default named here.
 */
export interface StoredContext {
  /** The task's last update, the `at` of a derived hold. */
  at: string;
  /** The lane a paused task returns to. Default: ready for a dependency pause, else running. */
  lane?: Lane | undefined;
  /** A plain `limit` pause (no `held`) is an account usage limit, not a budget. Default: budget. */
  accountLimit?: { account: string; until?: string | undefined } | undefined;
  /** What `blocked` was. Default: dependency-closed on a never-run lane, else idle. */
  blocked?: "idle" | "dependency-closed" | "dependency-removed" | undefined;
  /** The tasks a dependency hold names. Default: a placeholder id the migration must replace. */
  on?: readonly string[] | undefined;
  /** The account a `signed-out` pause names. Default: `unknown`. */
  account?: string | undefined;
  /** The error text and phase of an `error` pause. Default: empty and `turn`. */
  error?: string | undefined;
  phase?: "start" | "turn" | "restart" | undefined;
  why?: string | undefined;
  alertId?: string | undefined;
  /** When the owner resumed it by hand, kept so `toStored` can write it back. */
  resumedAt?: string | undefined;
}

export interface Lifecycle {
  status: LifecycleStatus;
  hold: Hold | undefined;
  exemptUntilRunEnds: boolean;
}

const PLACEHOLDER_TASK = "UNKNOWN-1";

const ids = (on: readonly string[] | undefined): [string, ...string[]] => {
  const [first, ...rest] = on ?? [];
  return [first ?? PLACEHOLDER_TASK, ...rest];
};

function limitHold(f: StoredFields, c: StoredContext): Hold {
  if (f.held === "limit") {
    // The run gate's cap hold: `day` is the all-workspaces day cap, anything else names an org.
    return f.heldScope === undefined || f.heldScope === "day"
      ? { cause: "budget-limit", at: c.at, scope: "all", period: "day" }
      : { cause: "budget-limit", at: c.at, scope: "org", scopeId: f.heldScope, period: "day" };
  }
  if (c.accountLimit !== undefined)
    return {
      cause: "account-limit",
      at: c.at,
      account: c.accountLimit.account,
      ...(c.accountLimit.until === undefined ? {} : { until: c.accountLimit.until }),
    };
  // Budget or account is not stored after a restart (contradiction 4); the tick reclassifies.
  return {
    cause: "budget-limit",
    at: c.at,
    scope: "all",
    period: "day",
    alertId: c.alertId ?? LEGACY_ALERT,
  };
}

function pausedHold(f: StoredFields, c: StoredContext, lane: Lane): Hold {
  const reason = f.pausedReason ?? "owner";
  switch (reason) {
    case "owner":
      if (f.pausedBy === "captain")
        return { cause: "captain-stop", at: c.at, ...(c.why === undefined ? {} : { why: c.why }) };
      if (f.pausedBy === "autonomy-off" || (f.held === "owner" && f.heldScope === STOPPED_NOW))
        return { cause: "autopilot-off", at: c.at, mode: "now" };
      return { cause: "owner-stop", at: c.at };
    case "limit":
      return limitHold(f, c);
    case "offline":
      return { cause: "offline", at: c.at };
    case "signed-out":
      return { cause: "signed-out", at: c.at, account: c.account ?? "unknown" };
    case "error":
      return { cause: "error", at: c.at, phase: c.phase ?? "turn", error: c.error ?? "" };
    case "loop":
      return { cause: "loop-guard", at: c.at, why: c.why ?? "It was going in circles." };
    case "blocked": {
      const kind = c.blocked ?? (lane === "inbox" || lane === "ready" ? "dependency-closed" : "idle");
      if (kind === "idle") return { cause: "idle", at: c.at, why: c.why ?? "No agent is left to wake." };
      return { cause: kind, at: c.at, on: ids(c.on) };
    }
  }
}

const defaultLane = (f: StoredFields, c: StoredContext): Lane =>
  c.lane ?? (f.pausedReason === "blocked" && c.blocked !== "idle" ? "ready" : "running");

/**
 * Stored fields to the new model. A `paused` row becomes its lane plus a hold. A row that is not
 * paused but carries a run-gate `held` (the async window where the run is held and the task still
 * says running) becomes the same lane plus the matching hold: `held = owner` is Auto-pilot
 * stopping, `held = limit` a budget cap. `held` on inbox, ready, mr and done rows is stale and ignored.
 */
export function fromStored(f: StoredFields, c: StoredContext): Lifecycle {
  const exemptUntilRunEnds = f.resumedAt !== undefined;
  if (f.status === "paused") {
    const lane = defaultLane(f, c);
    return { status: lane, hold: pausedHold(f, c, lane), exemptUntilRunEnds };
  }
  let hold: Hold | undefined;
  if (f.status === "running" || f.status === "review") {
    if (f.held === "owner")
      hold =
        f.heldScope === STOPPED_NOW
          ? { cause: "autopilot-off", at: c.at, mode: "now" }
          : { cause: "autopilot-off", at: c.at, mode: "step" };
    else if (f.held === "limit") hold = limitHold({ ...f, held: "limit" }, c);
  }
  return { status: f.status, hold, exemptUntilRunEnds };
}

export interface StoredOut {
  fields: StoredFields;
  /** The lane of a paused row, so `fromStored` can put it back. */
  lane?: Lane;
}

/**
 * The new model to stored fields. Every hold but Auto-pilot `step` is written as `status = paused`
 * with its reason. `step` has no paused form: it stays in its lane with `held = owner`.
 * `mr` and `done` carry no hold in the old fields: a hold there is dropped.
 */
export function toStored(state: Lifecycle, c: Pick<StoredContext, "at" | "resumedAt">): StoredOut {
  const resumedAt = state.exemptUntilRunEnds ? (c.resumedAt ?? c.at) : undefined;
  const withResumed = (f: StoredFields): StoredFields => (resumedAt === undefined ? f : { ...f, resumedAt });
  const hold = state.hold;
  if (hold === undefined || state.status === "mr" || state.status === "done")
    return { fields: withResumed({ status: state.status }) };

  const lane = state.status;
  const paused = (fields: Omit<StoredFields, "status">): StoredOut => ({
    fields: withResumed({ status: "paused", ...fields }),
    lane,
  });
  switch (hold.cause) {
    case "owner-stop":
      return paused({ pausedReason: "owner" });
    case "captain-stop":
      return paused({ pausedReason: "owner", pausedBy: "captain" });
    case "autopilot-off":
      return hold.mode === "now"
        ? paused({ pausedReason: "owner", pausedBy: "autonomy-off", held: "owner", heldScope: STOPPED_NOW })
        : { fields: withResumed({ status: state.status, held: "owner" }) };
    case "budget-limit":
      if (hold.alertId !== undefined) return paused({ pausedReason: "limit" });
      return paused({
        pausedReason: "limit",
        held: "limit",
        heldScope: hold.scope === "org" && hold.scopeId !== undefined ? hold.scopeId : "day",
      });
    case "account-limit":
      return paused({ pausedReason: "limit" });
    case "offline":
      return paused({ pausedReason: "offline" });
    case "signed-out":
      return paused({ pausedReason: "signed-out" });
    case "error":
      return paused({ pausedReason: "error" });
    case "loop-guard":
      return paused({ pausedReason: "loop" });
    case "idle":
    case "dependency-closed":
    case "dependency-removed":
      return paused({ pausedReason: "blocked" });
  }
}
