import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { CaptainService } from "./service.ts";

type CaptainCommand =
  | "captain.status"
  | "captain.log"
  | "captain.stop"
  | "captain.resume"
  | "captain.undo"
  | "captain.choreOn";

/** The stop switch, Undo and the chores' switches are the owner's: the captain never reaches them. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(`${ctx.command} is the owner's. The captain never changes its own switch.`, 409);
  }
}

/** The `captain.*` commands (SPEC 5.18). The command table spreads these in. */
export function captainHandlers(captain: CaptainService): Pick<CommandHandlers, CaptainCommand> {
  return {
    "captain.status": async () => captain.status(),
    "captain.log": async (input) => captain.log(input),
    "captain.stop": async (_input, ctx) => {
      ownerOnly(ctx);
      return captain.stop();
    },
    "captain.resume": async (_input, ctx) => {
      ownerOnly(ctx);
      return captain.resume();
    },
    "captain.undo": async (input, ctx) => {
      ownerOnly(ctx);
      return captain.undo(input.id, ctx.meta);
    },
    "captain.choreOn": async (input, ctx) => {
      ownerOnly(ctx);
      return captain.choreOn(input.org, input.chore);
    },
  };
}
