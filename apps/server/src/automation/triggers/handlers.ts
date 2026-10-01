import type { CommandHandlers } from "../../commands/handlers.ts";
import type { TriggerService } from "./service.ts";

type TriggerCommand =
  | "triggers.list"
  | "triggers.get"
  | "triggers.runs"
  | "triggers.create"
  | "triggers.update"
  | "triggers.pause"
  | "triggers.resume"
  | "triggers.runNow"
  | "triggers.delete";

/** The `triggers.*` commands. The command table spreads these in. */
export function triggerHandlers(triggers: TriggerService): Pick<CommandHandlers, TriggerCommand> {
  return {
    "triggers.list": (input) => triggers.list(input.org),
    "triggers.get": (input) => triggers.get(input.id),
    "triggers.runs": (input) => triggers.runs(input.id, input.limit),
    "triggers.create": (input) => triggers.create(input),
    "triggers.update": (input) => triggers.update(input),
    "triggers.pause": (input) => triggers.pause(input.id),
    "triggers.resume": (input) => triggers.resume(input.id),
    "triggers.runNow": (input) => triggers.runNow(input.id),
    "triggers.delete": async (input) => triggers.delete(input.id),
  };
}
