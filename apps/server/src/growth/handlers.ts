import { PRIVATE } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import type { EconomicsService } from "../economics/service.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import { confirmDeadline, draftProposal } from "./opportunities.ts";
import type { GrowthDeps } from "./ports.ts";

type GrowthCommand = "economics.get" | "findings.proposal" | "findings.deadline";

/** Only the read is a tool an agent runs without a card, and a lane reads its own workspace. */
export const GROWTH_TOOL_COMMANDS: ReadonlySet<string> = new Set(["economics.get"]);

export interface GrowthHandlerDeps extends FindingsHandlerDeps {
  economics: EconomicsService;
  growth: GrowthDeps;
}

/** A proposal draft and a confirmed deadline are the owner's: the captain only offers them. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(`${ctx.command} is the owner's. Report the opportunity or the deadline as a finding.`, 409);
  }
}

/** The `economics.get`, `findings.proposal` and `findings.deadline` commands. */
export function growthHandlers(deps: GrowthHandlerDeps): Pick<CommandHandlers, GrowthCommand> {
  return {
    "economics.get": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "owner") return deps.economics.get(input.range, input.org);
      const own = actor.org ?? PRIVATE;
      if (input.org !== undefined && input.org !== own) throw new UserError("You read your own workspace only.", 409);
      return deps.economics.get(input.range, own);
    },
    "findings.proposal": async (input, ctx) => {
      ownerOnly(ctx);
      return draftProposal(deps.growth, input.id);
    },
    "findings.deadline": async (input, ctx) => {
      ownerOnly(ctx);
      return { deadline: await confirmDeadline(deps.growth, input.id) };
    },
  };
}
