import { pageRef } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { AgendaService } from "./service.ts";

type AgendaCommand = "agenda.today" | "agenda.configure" | "agenda.brief" | "agenda.dismissBrief";

export interface AgendaHandlerDeps extends FindingsHandlerDeps {
  agenda: AgendaService;
}

/**
 * The `agenda.*` commands. The command table spreads these in. The captain reads the owner's day
 * and schedules the owner's review through the owner's approval policy like any change: nothing
 * here raises its own power or limits. Other agents never read it: it spans every workspace.
 */
export function agendaHandlers(deps: AgendaHandlerDeps): Pick<CommandHandlers, AgendaCommand> {
  const { agenda } = deps;
  /**
   * What the caller sees: the owner the workspace asked for, the captain outside a lane any, a
   * captain lane its own without the brief, which spans every workspace.
   */
  const scope = async (ctx: CommandContext, asked?: string): Promise<{ org?: string; lane: boolean }> => {
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "agent") {
      throw new UserError(
        `${ctx.command} is the owner's day across every workspace, so only the captain reads it. Read your workspace's findings and deadlines instead.`,
        409,
      );
    }
    if (actor.kind === "owner" || actor.org === undefined) {
      return { ...(asked === undefined ? {} : { org: asked }), lane: false };
    }
    if (asked !== undefined && asked !== actor.org) {
      throw new UserError("You read your own workspace only.", 409);
    }
    return { org: actor.org, lane: true };
  };
  const today = (seen: { org?: string; lane: boolean }) =>
    agenda.today(seen.org === undefined ? {} : { org: seen.org }, !seen.lane);
  return {
    "agenda.today": async (input, ctx) => today(await scope(ctx, input.org)),
    "agenda.configure": async (input, ctx) => {
      const seen = await scope(ctx);
      agenda.setBudgetMinutes(input.budgetMinutes);
      return today(seen);
    },
    "agenda.brief": async (input, ctx) => {
      const seen = await scope(ctx);
      await agenda.ensureBrief(input.force === true);
      return today(seen);
    },
    "agenda.dismissBrief": async (input, ctx) => {
      await scope(ctx);
      agenda.dismissBrief(input.day);
      return { day: input.day };
    },
  };
}
