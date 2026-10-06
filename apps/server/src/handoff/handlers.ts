import { PRIVATE } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { HandoffService } from "./service.ts";

type HandoffCommand = "handoff.get" | "handoff.check" | "handoff.rerun";

/** Agent tool calls that run without a card: a read, and a check the captain asks for. */
export const HANDOFF_TOOL_COMMANDS: ReadonlySet<string> = new Set([
  "handoff.get",
  "handoff.check",
  "handoff.rerun",
]);

export interface HandoffHandlerDeps extends FindingsHandlerDeps {
  handoff: HandoffService;
}

/** The `handoff.*` commands. The command table spreads these in. */
export function handoffHandlers(deps: HandoffHandlerDeps): Pick<CommandHandlers, HandoffCommand> {
  /** The owner any task, the captain and an agent the tasks of their own workspace. */
  const scope = async (task: string, ctx: CommandContext, check: boolean): Promise<void> => {
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner") return;
    if (check && actor.kind !== "captain") {
      throw new UserError("Only the owner and the captain ask for a check again.", 409);
    }
    const org = deps.store.tasks.get(task)?.org ?? PRIVATE;
    if (actor.org !== undefined && actor.org !== org) {
      throw new UserError(
        `Refused: ${task} belongs to another workspace, and this one reads its own only.`,
        409,
      );
    }
  };
  return {
    "handoff.get": async (input, ctx) => {
      await scope(input.task, ctx, false);
      return deps.handoff.state(input.task);
    },
    "handoff.check": async (input, ctx) => {
      await scope(input.task, ctx, true);
      // Tests can take minutes: the check runs in the background and the state says when it ends.
      deps.handoff.start(input.task, input.force === true);
      return deps.handoff.state(input.task);
    },
    "handoff.rerun": async (input, ctx) => {
      await scope(input.task, ctx, true);
      // The same queue and limits as a check: the step runs in the background and the state says when.
      deps.handoff.start(input.task, true, input.step === undefined ? {} : { only: [input.step] });
      return deps.handoff.state(input.task);
    },
  };
}
