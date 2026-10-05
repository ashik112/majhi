import { pageRef } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { InboxService } from "./service.ts";

type DecisionCommand =
  | "decisions.list"
  | "decisions.detail"
  | "decisions.answer"
  | "decisions.answerBatch"
  | "decisions.recommend";

/** The answer is the owner's click: an agent, the captain included, never answers for them here. */
export function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. Agents recommend with majhi_decisions_recommend and the owner answers on ${pageRef("decisions")}.`,
      409,
    );
  }
}

/** `decisions.recommend` runs as the captain's tool in its lane (admin service), never as a plain command. */
function captainTool(ctx: CommandContext): never {
  throw new UserError(`${ctx.command} is a tool of the captain in its lanes.`, 409);
}

/** The `decisions.*` commands of the owner's inbox (SPEC 5.18). */
export function inboxHandlers(decisions: InboxService): Pick<CommandHandlers, DecisionCommand> {
  return {
    "decisions.list": async (input) => decisions.view(input.org),
    "decisions.detail": async (input) => decisions.detail(input.id),
    "decisions.answer": async (input, ctx) => {
      ownerOnly(ctx);
      return decisions.answerView(input);
    },
    "decisions.answerBatch": async (input, ctx) => {
      ownerOnly(ctx);
      return decisions.answerBatch(input);
    },
    "decisions.recommend": async (_input, ctx) => captainTool(ctx),
  };
}
