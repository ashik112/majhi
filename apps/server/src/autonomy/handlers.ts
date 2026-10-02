import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { AutonomyService } from "./service.ts";

type AutonomyCommand =
  | "autonomy.status"
  | "autonomy.events"
  | "autonomy.start"
  | "autonomy.pause"
  | "autonomy.stop"
  | "autonomy.configure"
  | "autonomy.guide"
  | "autonomy.forget"
  | "autonomy.exclude"
  | "autonomy.plan"
  | "autonomy.note"
  | "autonomy.answer";

/** The switch, the settings and the guidance are the owner's: an agent never reaches them. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. Autonomous mode never changes its own switch or limits.`,
      409,
    );
  }
}

/** The captain's own tools run in the admin service, for the captain in its autonomy chat only. */
async function bossOnly(ctx: CommandContext): Promise<never> {
  throw new UserError(`${ctx.command} is a tool of the captain in its autonomy chat.`, 409);
}

/** The `autonomy.*` commands (PRV-74). The command table spreads these in. */
export function autonomyHandlers(autonomy: AutonomyService): Pick<CommandHandlers, AutonomyCommand> {
  return {
    "autonomy.status": async () => {
      // The page lists each backlog task's size: the ones not rated yet are rated in the background.
      autonomy.fillSizes();
      return autonomy.status();
    },
    "autonomy.events": async (input) => autonomy.events(input),
    "autonomy.start": async (_input, ctx) => {
      ownerOnly(ctx);
      return autonomy.start();
    },
    "autonomy.pause": async (_input, ctx) => {
      ownerOnly(ctx);
      return autonomy.pause();
    },
    "autonomy.stop": async (input, ctx) => {
      ownerOnly(ctx);
      return autonomy.stop(input.how);
    },
    "autonomy.configure": async (input, ctx) => {
      ownerOnly(ctx);
      return autonomy.configure(input, ctx);
    },
    "autonomy.guide": async (input, ctx) => {
      ownerOnly(ctx);
      return autonomy.guide(input, ctx);
    },
    "autonomy.forget": async (input, ctx) => {
      ownerOnly(ctx);
      return autonomy.forget(input.id, ctx);
    },
    "autonomy.exclude": async (input, ctx) => {
      ownerOnly(ctx);
      return autonomy.exclude(input.task, input.exclude);
    },
    "autonomy.plan": (_input, ctx) => bossOnly(ctx),
    "autonomy.note": (_input, ctx) => bossOnly(ctx),
    "autonomy.answer": (_input, ctx) => bossOnly(ctx),
  };
}
