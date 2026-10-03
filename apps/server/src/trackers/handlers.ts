import type { CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { TrackerService } from "./service.ts";

type TrackerCommand =
  | "trackers.test"
  | "trackers.pull"
  | "trackers.status"
  | "trackers.take"
  | "trackers.links"
  | "trackers.push"
  | "trackers.sync"
  | "trackers.unlink";

/** The `trackers.*` commands. The command table spreads these in. */
export function trackerHandlers(trackers: TrackerService): Pick<CommandHandlers, TrackerCommand> {
  return {
    "trackers.test": (input) => trackers.test(input.org),
    "trackers.pull": (input) => trackers.pull(input.org),
    "trackers.status": async (input) => trackers.status(input.org),
    "trackers.take": (input) => trackers.take(input.org, input.key, input.project),
    "trackers.links": async () => trackers.links(),
    "trackers.push": (input) => trackers.push(input.id),
    "trackers.sync": async (input) => {
      await trackers.syncTask(input.id);
      const link = trackers.link(input.id);
      if (link === undefined) throw new UserError(`${input.id} is not linked to a tracker.`, 404);
      return link;
    },
    "trackers.unlink": async (input) => {
      trackers.unlink(input.id);
      return { unlinked: input.id };
    },
  };
}
