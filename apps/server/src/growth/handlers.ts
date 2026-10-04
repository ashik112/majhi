import { PRIVATE, pageRef } from "@majhi/shared";
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

/**
 * The `economics.get`, `findings.proposal` and `findings.deadline` commands. An agent drafts a
 * proposal or adds a deadline through the owner's approval policy, for a finding of its own
 * workspace; the proposal still waits in the outbound gate.
 */
export function growthHandlers(deps: GrowthHandlerDeps): Pick<CommandHandlers, GrowthCommand> {
  const ownFinding = async (ctx: CommandContext, id: number): Promise<void> => {
    const actor = await findingActor(deps, ctx);
    // The captain outside a lane works for every workspace, as in the playbooks.
    if (actor.kind === "owner" || actor.org === undefined) return;
    if (deps.growth.findings.get(id).org !== actor.org) {
      throw new UserError("You work on your own workspace's findings only.", 409);
    }
  };
  return {
    "economics.get": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "owner") return deps.economics.get(input.range, input.org);
      const own = actor.org ?? PRIVATE;
      if (input.org !== undefined && input.org !== own)
        throw new UserError("You read your own workspace only.", 409);
      return deps.economics.get(input.range, own);
    },
    "findings.proposal": async (input, ctx) => {
      await ownFinding(ctx, input.id);
      return draftProposal(deps.growth, input.id);
    },
    "findings.deadline": async (input, ctx) => {
      await ownFinding(ctx, input.id);
      return { deadline: await confirmDeadline(deps.growth, input.id) };
    },
  };
}
