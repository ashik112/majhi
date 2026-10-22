import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { CaseService } from "./service.ts";

type CaseCommand =
  | "case.status"
  | "case.followUp"
  | "case.ask"
  | "case.close"
  | "case.stop"
  | "case.help"
  | "case.deploy"
  | "case.rollback"
  | "case.makeTask";

/** The captain's lane a case call comes from. Only the captain, in its workspace lane, works a case. */
function lane(ctx: CommandContext): string {
  if (ctx.meta.actor.kind !== "agent" || ctx.meta.task === undefined) {
    throw new UserError("Only the captain works a case, from its workspace lane.", 409);
  }
  return ctx.meta.task;
}

/** The `case.*` commands (docs/briefs/case-flow.md, docs/briefs/instructions.md). */
export function caseHandlers(cases: CaseService): Pick<CommandHandlers, CaseCommand> {
  return {
    "case.status": (input, ctx) => cases.status(lane(ctx), input),
    "case.followUp": async (input, ctx) => cases.followUp(lane(ctx), input),
    "case.ask": (input, ctx) => cases.ask(lane(ctx), input),
    "case.close": (input, ctx) => cases.close(lane(ctx), input),
    "case.stop": (input, ctx) => cases.stop(lane(ctx), input),
    "case.help": (input, ctx) => cases.help(lane(ctx), input),
    "case.deploy": (input, ctx) => cases.deploy(lane(ctx), input),
    "case.rollback": (input, ctx) => cases.rollback(lane(ctx), input),
    "case.makeTask": async (input, ctx) => {
      if (ctx.meta.actor.kind === "agent") {
        throw new UserError("Making a task of a follow-up is the owner's: press Make it a task.", 409);
      }
      return cases.makeTask(input.case, input.followUp);
    },
  };
}
