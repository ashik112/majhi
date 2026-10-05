import type { lifecycle, PausedReason } from "@majhi/shared";

type Effect = lifecycle.Effect;

/**
 * What an effect needs beyond the event: who acted, and the words a card says. Plain data, because it
 * is stored with the effect in the outbox and read back after a restart.
 */
export interface EffectContext {
  /** Who did it, as the room shows it: `owner`, an agent id, `autonomy`, `majhi`. */
  by: string;
  /** Why, for the paused card. Display only. */
  why?: string | undefined;
  /** The paused card's reason, in the old vocabulary the card still speaks. */
  reason?: PausedReason | undefined;
  /** What the settled card says (a resumed pause, an opened merge request, a closed review card). */
  settle?: string | undefined;
  /** What the closed paused card says, when a task is closed while paused. */
  settlePaused?: string | undefined;
  /** The task ended for good (closed): its services and volumes go, not just stop. */
  ending?: boolean | undefined;
}

export type EffectKind = Effect["kind"];

/** One effect with the context it runs under, as the outbox keeps it. */
export interface OutboxItem {
  effect: Effect;
  ctx: EffectContext;
}

/**
 * Effects that must survive a crash between the write and their run: what they do cannot be derived
 * again from the stored state. The rest are either re-derived (a run, a worktree, a published task)
 * or re-run by the restart reconcile.
 */
export const DURABLE: ReadonlySet<EffectKind> = new Set<EffectKind>([
  "card",
  "containers",
  "processes.stop",
  "terminals.stop",
  "parkServices",
  "dropPendingShip",
  "budgets.exempt",
  "statusChanged",
]);
