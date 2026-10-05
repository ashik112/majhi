import { PRIVATE } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { ToolInstaller } from "./installer.ts";

type ToolsCommand = "toolbox.list" | "toolbox.install" | "toolbox.remove";

export interface ToolsHandlerDeps extends FindingsHandlerDeps {
  tools: ToolInstaller;
}

/** The `tools.*` commands. An agent installs for its own workspace only; the owner names one. */
export function toolsHandlers(deps: ToolsHandlerDeps): Pick<CommandHandlers, ToolsCommand> {
  const orgOf = async (ctx: CommandContext, asked: string | undefined): Promise<string> => {
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner" || actor.org === undefined) return asked ?? PRIVATE;
    if (asked !== undefined && asked !== actor.org) {
      throw new UserError("You work in your own workspace only.", 409);
    }
    return actor.org;
  };
  return {
    "toolbox.list": async (input, ctx) => deps.tools.list(await orgOf(ctx, input.org)),
    "toolbox.install": async (input, ctx) => deps.tools.install(await orgOf(ctx, input.org), input),
    "toolbox.remove": async (input, ctx) => deps.tools.remove(await orgOf(ctx, input.org), input.name),
  };
}
