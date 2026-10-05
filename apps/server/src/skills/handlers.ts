import type { CommandHandlers } from "../commands/handlers.ts";
import type { SkillService } from "./service.ts";

type SkillCommand =
  | "skills.search"
  | "skills.install"
  | "skills.list"
  | "skills.runs"
  | "skills.enable"
  | "skills.enableAll"
  | "skills.disable"
  | "skills.setMany"
  | "skills.remove"
  | "skills.update";

/** The `skills.*` commands. The command table spreads these in. */
export function skillHandlers(skills: SkillService): Pick<CommandHandlers, SkillCommand> {
  return {
    "skills.search": (input) => skills.search(input.query, input.limit),
    "skills.install": (input, ctx) => skills.install(input, ctx.meta),
    "skills.list": (input) => skills.list(input.agent),
    "skills.runs": (input) => skills.runs(input.task),
    "skills.enable": (input, ctx) => skills.enable(input.name, input.agent, ctx.meta),
    "skills.enableAll": (input, ctx) => skills.enableAll(input.name, ctx.meta),
    "skills.disable": (input, ctx) => skills.disable(input.name, input.agent, ctx.meta),
    "skills.setMany": (input, ctx) => skills.setMany(input, ctx.meta),
    "skills.remove": (input, ctx) => skills.remove(input.name, ctx.meta),
    "skills.update": (input, ctx) => skills.update(input, ctx.meta),
  };
}
