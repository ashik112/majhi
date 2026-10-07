import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { ClientIncidents } from "./incidents.ts";

type IncidentCommand = "incident.view" | "incident.cause" | "incident.editReport" | "incident.sendReport";

/** What the commands need to know of who asks: whose task it is and which captain lane it is in. */
export interface IncidentHandlerDeps {
  incidents: ClientIncidents;
  /** The workspace of a task, and the captain whose lane is that workspace's. */
  lane: (task: string) => Promise<{ boss: string; org: string } | undefined>;
  orgOf: (task: string) => string | undefined;
}

/** What clients saw and what is sent to them are the owner's: no agent reads, edits or sends them. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. A report to a client is sent only by the owner's click.`,
      409,
    );
  }
}

/** The `incident.*` commands (docs/briefs/client-chats.md, phase 2). */
export function incidentHandlers(deps: IncidentHandlerDeps): Pick<CommandHandlers, IncidentCommand> {
  return {
    "incident.view": async (input, ctx) => {
      ownerOnly(ctx);
      return deps.incidents.view(input.task);
    },
    "incident.cause": async (input, ctx) => {
      const actor = ctx.meta.actor;
      if (actor.kind === "agent") {
        // The agent working on the incident, or the captain of its workspace, may say what the cause was.
        const own = ctx.meta.task === input.task;
        const lane = ctx.meta.task === undefined ? undefined : await deps.lane(ctx.meta.task);
        const captain = lane?.boss === actor.id && lane.org === deps.orgOf(input.task);
        if (!own && !captain)
          throw new UserError(
            "Only the incident's own agent or its workspace's captain records a cause.",
            409,
          );
      }
      deps.incidents.cause(input.task, input.text, input.client);
      return { ok: true as const };
    },
    "incident.editReport": async (input, ctx) => {
      ownerOnly(ctx);
      deps.incidents.editReport(input.task, input.version, input.text);
      return { ok: true as const };
    },
    "incident.sendReport": async (input, ctx) => {
      ownerOnly(ctx);
      return deps.incidents.sendReport(input.task, input.room);
    },
  };
}
