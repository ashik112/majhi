import { pageRef } from "@majhi/shared";
import type { AutonomyService } from "../autonomy/service.ts";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { CaptainService } from "./service.ts";

type CaptainCommand =
  | "captain.status"
  | "captain.log"
  | "captain.stop"
  | "captain.resume"
  | "captain.startFresh"
  | "captain.undo"
  | "captain.choreOn"
  | "captain.runChore"
  | "captain.asks"
  | "captain.answerCap"
  | "captain.answerBudget";

/** The stop switch, Undo and the chores' switches are the owner's: the captain never reaches them. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. The captain never changes its own switch; the owner does it on ${pageRef("captain")}.`,
      409,
    );
  }
}

/** The `captain.*` commands (SPEC 5.18). The command table spreads these in. */
export function captainHandlers(
  captain: CaptainService,
  autonomy: AutonomyService,
): Pick<CommandHandlers, CaptainCommand> {
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
    "captain.startFresh": async (input, ctx) => {
      ownerOnly(ctx);
      return captain.startFresh(input.org);
    },
    "captain.undo": async (input, ctx) => {
      ownerOnly(ctx);
      return captain.undo(input.id, ctx.meta);
    },
    "captain.choreOn": async (input, ctx) => {
      ownerOnly(ctx);
      return captain.choreOn(input.org, input.chore);
    },
    "captain.runChore": async (input, ctx) => {
      ownerOnly(ctx);
      return captain.runChore(input.org, input.chore);
    },
    "captain.asks": async () => ({ ...(await captain.asks()), budgets: await autonomy.budgetAsks() }),
    "captain.answerCap": async (input, ctx) => {
      ownerOnly(ctx);
      const asks = await captain.answerCap(input.org, input.chore, input.answer);
      return { ...asks, budgets: await autonomy.budgetAsks() };
    },
    "captain.answerBudget": async (input, ctx) => {
      ownerOnly(ctx);
      const budgets = await autonomy.answerBudget(input.scope, input.answer);
      return { ...(await captain.asks()), budgets };
    },
  };
}
