import type { CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { BriefService } from "./service.ts";

export interface BriefHandlerDeps extends FindingsHandlerDeps {
  brief: BriefService;
}

/**
 * The `brief.list` command. The owner and the captain read every workspace's briefs; a captain lane reads its own
 * workspace's only, and any other agent reads none.
 */
export function briefHandlers(deps: BriefHandlerDeps): Pick<CommandHandlers, "brief.list"> {
  return {
    "brief.list": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "agent") {
        throw new UserError("brief.list is for the owner and the captain.", 409);
      }
      if (actor.kind === "owner" || actor.org === undefined) return { briefs: deps.brief.list(input) };
      if (input.org !== undefined && input.org !== actor.org) {
        throw new UserError("You read your own workspace only.", 409);
      }
      return { briefs: deps.brief.list({ org: actor.org }) };
    },
  };
}
