import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { MapService } from "./service.ts";

type MapCommand = "map.get" | "map.estimate" | "map.update" | "map.confirmEdge" | "map.removeEdge";

export interface MapHandlerDeps extends FindingsHandlerDeps {
  map: MapService;
  /** Ids of the workspaces that exist. */
  orgs: () => Promise<readonly string[]>;
}

/**
 * The `map.*` commands. The owner reads and changes any workspace's map. The captain does the same in
 * its own workspace (outside a lane, any). Every other agent reads its own workspace's map only and
 * changes nothing: the map shapes what the next agent is told, so only the owner and the captain edit it.
 */
export function mapHandlers(deps: MapHandlerDeps): Pick<CommandHandlers, MapCommand> {
  const { map } = deps;
  const scope = async (ctx: CommandContext, org: string, write: boolean): Promise<void> => {
    if (!(await deps.orgs()).includes(org)) throw new UserError(`Workspace "${org}" does not exist.`, 404);
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner") return;
    if (actor.org !== undefined && actor.org !== org) {
      throw new UserError("You work with your own workspace's map only.", 409);
    }
    if (actor.kind === "agent" && write) {
      throw new UserError(
        `${ctx.command} changes the map, which is the owner's and the captain's. You can read it with map.get.`,
        409,
      );
    }
  };
  return {
    "map.get": async (input, ctx) => {
      await scope(ctx, input.org, false);
      return map.view(input.org);
    },
    "map.estimate": async (input, ctx) => {
      await scope(ctx, input.org, false);
      return map.estimate(input.org);
    },
    "map.update": async (input, ctx) => {
      await scope(ctx, input.org, true);
      return map.start(input.org);
    },
    "map.confirmEdge": async (input, ctx) => {
      await scope(ctx, input.org, true);
      return map.confirmEdge(input.org, input.id);
    },
    "map.removeEdge": async (input, ctx) => {
      await scope(ctx, input.org, true);
      return map.removeEdge(input.org, input.id);
    },
  };
}
