import { pageRef } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { AgendaService } from "./service.ts";

type AgendaCommand = "agenda.today" | "agenda.configure" | "agenda.brief" | "agenda.dismissBrief";

/** The agenda is the owner's: an agent, the captain included, has no use for the owner's review time. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. Agents do not read the owner's agenda; the owner sees it on ${pageRef("today")}.`,
      409,
    );
  }
}

/** The `agenda.*` commands. The command table spreads these in. */
export function agendaHandlers(agenda: AgendaService): Pick<CommandHandlers, AgendaCommand> {
  return {
    "agenda.today": async (input, ctx) => {
      ownerOnly(ctx);
      return agenda.today(input);
    },
    "agenda.configure": async (input, ctx) => {
      ownerOnly(ctx);
      agenda.setBudgetMinutes(input.budgetMinutes);
      return agenda.today();
    },
    "agenda.brief": async (input, ctx) => {
      ownerOnly(ctx);
      await agenda.ensureBrief(input.force === true);
      return agenda.today();
    },
    "agenda.dismissBrief": async (input, ctx) => {
      ownerOnly(ctx);
      agenda.dismissBrief(input.day);
      return { day: input.day };
    },
  };
}
