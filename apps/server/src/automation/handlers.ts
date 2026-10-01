import type { CommandHandlers } from "../commands/handlers.ts";
import type { ScheduleService } from "./service.ts";

type ScheduleCommand =
  | "schedules.list"
  | "schedules.get"
  | "schedules.runs"
  | "schedules.create"
  | "schedules.update"
  | "schedules.pause"
  | "schedules.resume"
  | "schedules.runNow"
  | "schedules.delete";

/** The `schedules.*` commands. The command table spreads these in. */
export function scheduleHandlers(schedules: ScheduleService): Pick<CommandHandlers, ScheduleCommand> {
  return {
    "schedules.list": (input) => schedules.list(input.org),
    "schedules.get": (input) => schedules.get(input.id),
    "schedules.runs": (input) => schedules.runs(input.id, input.limit),
    "schedules.create": (input) => schedules.create(input),
    "schedules.update": (input) => schedules.update(input),
    "schedules.pause": (input) => schedules.pause(input.id),
    "schedules.resume": (input) => schedules.resume(input.id),
    "schedules.runNow": (input) => schedules.runNow(input.id),
    "schedules.delete": async (input) => schedules.delete(input.id),
  };
}
