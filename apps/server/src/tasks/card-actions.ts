import type { CardAction, MergeMethod, RoomItem } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { MrService } from "../mrs/service.ts";
import type { RoomService } from "../room/service.ts";
import type { TaskService } from "./service.ts";

type Result = {
  project: string;
  into: string;
  ok: boolean;
  detail: string;
  conflicts?: string[] | undefined;
  skipped?: boolean | undefined;
  notPushed?: boolean | undefined;
};

/**
 * The buttons on a review or paused card (`room.cardAction`). Refused when the card was already
 * answered, or the task moved on and no longer allows the action. One action per card at a time,
 * so a second click never merges or pushes twice.
 */
export class CardActions {
  private readonly acting = new Set<string>();

  constructor(private readonly deps: { tasks: TaskService; mrs: MrService; room: RoomService }) {}

  async act(input: {
    task: string;
    item: string;
    action: CardAction;
    into?: string | undefined;
    targets?: Readonly<Record<string, string>> | undefined;
    method?: MergeMethod | undefined;
    deleteAfter?: boolean | undefined;
    /** For done: the owner confirmed closing with work not shipped. */
    unshipped?: "keep" | undefined;
    by: string;
    agent: boolean;
  }): Promise<{ item: RoomItem; results?: Result[] }> {
    const key = `${input.task}\u0000${input.item}`;
    if (this.acting.has(key)) throw new UserError("That card is already being handled.", 409);
    this.acting.add(key);
    try {
      return await this.run(input);
    } finally {
      this.acting.delete(key);
    }
  }

  private async run(input: {
    task: string;
    item: string;
    action: CardAction;
    into?: string | undefined;
    targets?: Readonly<Record<string, string>> | undefined;
    method?: MergeMethod | undefined;
    deleteAfter?: boolean | undefined;
    /** For done: the owner confirmed closing with work not shipped. */
    unshipped?: "keep" | undefined;
    by: string;
    agent: boolean;
  }): Promise<{ item: RoomItem; results?: Result[] }> {
    const { tasks, mrs, room } = this.deps;
    const card = room.get(input.task, input.item);
    if (card === undefined) throw new UserError("The card is gone.", 404);
    const kind = input.action === "resume" ? "paused" : "review";
    if (card.type !== kind) throw new UserError(`That is not a ${kind} card.`, 409);
    if (card.state !== "pending") throw new UserError("This card was already answered.", 409);
    const task = tasks.get(input.task);
    const current = () => room.get(input.task, input.item) ?? card;

    if (input.action === "resume") {
      if (task.status !== "paused") throw new UserError(`${task.id} is not paused any more.`, 409);
      await tasks.start(task.id, input.by);
      return { item: current() };
    }
    if (task.status !== "review") throw new UserError(`${task.id} is not waiting for review any more.`, 409);
    const options = await mrs.shipOptions(task.id);
    const option = options[input.action];
    if (!option.ok) throw new UserError(option.why ?? "Not now.", 409);

    switch (input.action) {
      case "done":
        await tasks.close(task.id, {
          whenSubtasksOpen: "refuse",
          by: input.by,
          agent: input.agent,
          whenUnshipped: input.unshipped ?? "refuse",
        });
        return { item: current() };
      case "merge": {
        const out = await tasks.merge({
          id: task.id,
          into: input.into,
          targets: input.targets,
          done: true,
          by: input.by,
          method: input.method,
          deleteAfter: input.deleteAfter,
        });
        return { item: current(), results: out.results };
      }
      case "mergePush": {
        const out = await mrs.mergeAndPush({
          id: task.id,
          into: input.into,
          targets: input.targets,
          done: true,
          by: input.by,
          method: input.method,
          deleteAfter: input.deleteAfter,
        });
        return { item: current(), results: out.results };
      }
      case "push": {
        const out = await mrs.push(task.id, input.deleteAfter === true);
        return { item: current(), results: out.results };
      }
      case "mr": {
        const out = await mrs.open(task.id, { into: input.into, targets: input.targets }, input.by);
        return {
          item: current(),
          results: out.repos.map((r) => ({
            project: r.project,
            into: input.targets?.[r.project] ?? input.into ?? options.base ?? "",
            ok: r.outcome !== "failed",
            detail: r.detail,
          })),
        };
      }
    }
  }
}
