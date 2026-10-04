import type { CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { ConnectService } from "./service.ts";

type ConnectCommand =
  | "connect.catalog"
  | "connect.status"
  | "connect.start"
  | "connect.flow"
  | "connect.cancel"
  | "connect.confirmAccount"
  | "connect.disconnect"
  | "connect.needScope";

/** Only the owner signs accounts in or out. An agent has no browser to approve with. */
function ownerOnly(kind: string, what: string): void {
  if (kind === "agent") {
    throw new UserError(`Only the owner ${what}, on the Connections page.`, 409);
  }
}

/** The `connect.*` commands. */
export function connectHandlers(connect: ConnectService): Pick<CommandHandlers, ConnectCommand> {
  return {
    "connect.catalog": async () => connect.catalogView(),
    "connect.status": (input) => connect.status(input.org),
    "connect.start": async (input, ctx) => {
      ownerOnly(ctx.meta.actor.kind, "connects a service");
      return connect.start(input, ctx.meta);
    },
    "connect.flow": async (input) => connect.flow(input.flow),
    "connect.cancel": async (input, ctx) => {
      ownerOnly(ctx.meta.actor.kind, "cancels a sign-in");
      return connect.cancel(input.flow);
    },
    "connect.confirmAccount": async (input, ctx) => {
      ownerOnly(ctx.meta.actor.kind, "decides which account a connection keeps");
      return connect.confirmAccount(input.flow, input.accept);
    },
    "connect.disconnect": async (input, ctx) => {
      ownerOnly(ctx.meta.actor.kind, "disconnects a service");
      return connect.disconnect(input.connection, ctx.meta);
    },
    // An agent says its tool call got 403 insufficient_scope. The text is data: it only asks the owner.
    "connect.needScope": (input) => connect.needScope(input.connection, input.scope),
  };
}
