import type { CommandHandlers } from "../commands/handlers.ts";
import type { SkillService } from "./service.ts";

type SkillCommand =
  | "skills.search"
  | "skills.install"
  | "skills.list"
  | "skills.enable"
  | "skills.disable"
  | "skills.remove"
  | "skills.update";

/** The `skills.*` commands. The command table spreads these in. */
export function skillHandlers(skills: SkillService): Pick<CommandHandlers, SkillCommand> {
  return {
    "skills.search": (input) => skills.search(input.query, input.limit),
    "skills.install": (input, ctx) => skills.install(input, ctx.meta),
    "skills.list": (input) => skills.list(input.agent),
    "skills.enable": (input, ctx) => skills.enable(input.name, input.agent, ctx.command, ctx.meta),
    "skills.disable": (input, ctx) => skills.disable(input.name, input.agent, ctx.command, ctx.meta),
    "skills.remove": (input, ctx) => skills.remove(input.name, ctx.command, ctx.meta),
    "skills.update": (input, ctx) => skills.update(input, ctx.meta),
  };
}
