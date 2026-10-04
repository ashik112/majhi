import { randomUUID } from "node:crypto";
import type { Actor, CardOutcome, CardState, PausedReason, RoomItem, Task, TaskId } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { RoomPayload, Store } from "../store/index.ts";

type Card = Extract<RoomItem, { type: "review" | "paused" }>;
type CardType = Card["type"];

/** Who did something to a card, as the room shows it: `owner`, an agent id, or `majhi`. */
export function actorName(actor: Actor | undefined): string {
  if (actor === undefined || actor.kind === "owner") return "owner";
  return actor.id;
}

/**
 * The cards majhi itself posts when a task needs the owner (review, paused). A task has at most
 * one pending card of each kind: a new one replaces the pending one before it, and any change of
 * the task's state settles it with what happened, by whom and when.
 */
export class OwnerCards {
  constructor(
    private readonly deps: {
      store: Store;
      room: RoomService;
      now: () => Date;
      /** The captain's agent id now, so its actions show as "Captain", not as the owner or an agent (5.18). */
      captain?: () => string | undefined;
    },
  ) {}

  /**
   * True when `by` is the captain: its agent id (`@id` too), or `autonomy`, which acts for it.
   * Recorded on the item when it is written, so a later change of captain does not relabel history.
   */
  byCaptain(by: string): boolean {
    if (by === "autonomy" || by === "autonomy-off") return true;
    const captain = this.deps.captain?.();
    return captain !== undefined && by.replace(/^@/, "") === captain;
  }

  /**
   * "Ready to ship", with the lead that "Ask for changes" addresses, and `why` when majhi meant
   * to ship the task itself and could not.
   */
  review(task: Task, why?: string): RoomItem {
    this.replace(task.id, "review");
    const id = `review:${randomUUID()}`;
    this.deps.room.post(task.id, id, {
      type: "review",
      ...(task.team[0] === undefined ? {} : { lead: task.team[0] }),
      ...(why === undefined ? {} : { why }),
      state: "pending",
    });
    return this.must(task.id, id);
  }

  /**
   * The task paused. A pending review card settles: the task is not waiting for review any more.
   * `by` is who paused it, for a card the captain caused.
   */
  paused(task: Task, reason: PausedReason, why?: string, by = "owner"): RoomItem {
    this.settle(task.id, "review", "Paused before a review", "majhi");
    this.replace(task.id, "paused");
    const id = `paused:${randomUUID()}`;
    this.deps.room.post(task.id, id, {
      type: "paused",
      reason,
      ...(why === undefined ? {} : { why }),
      ...(this.byCaptain(by) ? { by: "captain" as const } : {}),
      state: "pending",
    });
    return this.must(task.id, id);
  }

  /** The pending card of this kind, if any. */
  pending(task: string, type: CardType): Card | undefined {
    this.deps.room.flush(task);
    const found = this.deps.store.room.pendingOfType(task, type).at(-1);
    return found?.type === type ? (found as Card) : undefined;
  }

  /** Settles the task's pending card of this kind. Returns it, or undefined when none was pending. */
  settle(task: string, type: CardType, text: string, by: string): RoomItem | undefined {
    const card = this.pending(task, type);
    if (card === undefined) return undefined;
    const outcome: CardOutcome = {
      text,
      by,
      at: this.deps.now().toISOString(),
      ...(this.byCaptain(by) ? { captain: true as const } : {}),
    };
    this.deps.room.post(task as TaskId, card.id, withState(card, "settled", outcome));
    return this.deps.room.get(task, card.id);
  }

  /**
   * The captain's line on the pending review card: its checks pass and it asks the owner to ship
   * (5.18). False when no review card waits.
   */
  shipReady(task: string, line: string): boolean {
    const card = this.pending(task, "review");
    if (card?.type !== "review") return false;
    this.deps.room.post(task as TaskId, card.id, {
      type: "review",
      ...(card.lead === undefined ? {} : { lead: card.lead }),
      ...(card.why === undefined ? {} : { why: card.why }),
      ready: line,
      state: "pending",
    });
    return true;
  }

  /** Pending owner questions of a task stop waiting: the owner wrote back instead. */
  replied(task: string): void {
    this.deps.room.flush(task);
    for (const q of this.deps.store.room.pendingOfType(task, "owner-question")) {
      if (q.type !== "owner-question") continue;
      this.deps.room.post(task as TaskId, q.id, {
        type: "owner-question",
        agent: q.agent,
        choices: q.choices,
        state: "replied",
      });
    }
  }

  private replace(task: TaskId, type: CardType): void {
    this.deps.room.flush(task);
    for (const old of this.deps.store.room.pendingOfType(task, type)) {
      if (old.type !== "review" && old.type !== "paused") continue;
      this.deps.room.post(task, old.id, withState(old, "replaced"));
    }
  }

  private must(task: string, id: string): RoomItem {
    const item = this.deps.room.get(task, id);
    if (item === undefined) throw new Error(`The card ${id} was not stored`);
    return item;
  }
}

/** A card written back with a new state, and the outcome when it has one. */
function withState(card: Card, state: CardState, outcome?: CardOutcome): RoomPayload {
  const end = outcome === undefined ? {} : { outcome };
  return card.type === "review"
    ? {
        type: "review",
        ...(card.lead === undefined ? {} : { lead: card.lead }),
        ...(card.why === undefined ? {} : { why: card.why }),
        ...(card.ready === undefined ? {} : { ready: card.ready }),
        state,
        ...end,
      }
    : {
        type: "paused",
        reason: card.reason,
        ...(card.why === undefined ? {} : { why: card.why }),
        ...(card.by === undefined ? {} : { by: card.by }),
        state,
        ...end,
      };
}

/** The answer on a card the captain answered, in words: the option's label, or what it typed. */
function answerLabel(item: RoomItem): string {
  switch (item.type) {
    case "permission":
      return item.options.find((o) => o.id === item.chosen)?.name ?? item.chosen ?? "answered";
    case "choice":
      return item.options.find((o) => o.id === item.chosen)?.label ?? item.chosen ?? "answered";
    case "owner-question":
      return item.chosen ?? "answered";
    case "ask":
      return item.questions
        .map((q) => {
          const answer = item.answers?.[q.id];
          return q.options.find((o) => o.id === answer)?.label ?? answer;
        })
        .filter((a): a is string => a !== undefined)
        .join(", ");
    default:
      return "answered";
  }
}

/** The room line when the captain answered a card: "Captain answered: Rebuild (the plan says so)". */
export function captainAnsweredLine(item: RoomItem, reason: string): string {
  return `Captain answered: ${answerLabel(item)}${reason.trim() === "" ? "" : ` (${reason.trim()})`}`;
}
