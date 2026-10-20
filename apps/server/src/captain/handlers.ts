import { pageRef, type TaskId } from "@majhi/shared";
import type { AutonomyService } from "../autonomy/service.ts";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { Lanes } from "./lanes.ts";
import type { CaptainService } from "./service.ts";

type CaptainCommand =
  | "captain.status"
  | "captain.log"
  | "captain.step"
  | "captain.stop"
  | "captain.resume"
  | "captain.startFresh"
  | "captain.undo"
  | "captain.choreOn"
  | "captain.runChore"
  | "captain.asks"
  | "captain.answerBudget";

/** The stop switch, Undo and the chores' switches are the owner's: the captain never reaches them. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. The captain never changes its own switch; the owner does it from the Autonomous menu in the top bar.`,
      409,
    );
  }
}

/** The `captain.*` commands (SPEC 5.18). The command table spreads these in. */
export function captainHandlers(
  captain: CaptainService,
  autonomy: AutonomyService,
  lanes: Pick<Lanes, "ask">,
): Pick<CommandHandlers, CaptainCommand> {
  return {
    "captain.status": async () => captain.status(),
    "captain.log": async (input) => captain.log(input),
    "captain.step": async (input) => {
      // A step is the owner's own question put to one workspace, so it works whatever Autonomous says.
      const told = await lanes.ask(input.org, input.ask);
      if (!told.sent) throw new UserError(`The step in ${input.org} did not start: ${told.why}.`, 409);
      return { org: input.org, chat: told.chat as TaskId };
    },
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
      return captain.startFresh(input.org, input.urgent === true ? "reacting" : "backlog");
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
    "captain.asks": async () => ({ budgets: await autonomy.budgetAsks() }),
    "captain.answerBudget": async (input, ctx) => {
      ownerOnly(ctx);
      return { budgets: await autonomy.answerBudget(input.scope, input.answer) };
    },
  };
}
