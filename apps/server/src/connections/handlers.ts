import { CONNECTION_LISTS, CONNECTION_TYPES } from "@majhi/shared";
import type { CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { SecretService } from "../secrets/service.ts";
import type { ConnectionService } from "./service.ts";
import type { ConnectionTester } from "./tester.ts";

type ConnectionCommand =
  | "connections.types"
  | "connections.list"
  | "connections.get"
  | "connections.create"
  | "connections.update"
  | "connections.remove"
  | "connections.setSecret"
  | "connections.setFile"
  | "connections.allow"
  | "connections.test";

/**
 * Fields that decide what majhi's gate checks, or which identity a run gets: the CLIs an env
 * connection is for, an MCP server's tool exceptions, a kubeconfig's context. Only the owner changes them.
 */
const GATE_FIELDS = ["clis", "read_tools", "write_tools", "context", "products"];

/** Fields that say where a connection's secrets go or what runs with them. */
const DESTINATION_FIELDS = ["transport", "url", "command", "test", "imap_host", "smtp_host"];

/** The `connections.*` commands. The command table spreads these in. */
export function connectionHandlers(
  connections: ConnectionService,
  tester: ConnectionTester,
  secrets: SecretService,
): Pick<CommandHandlers, ConnectionCommand> {
  return {
    "connections.types": async () => [...CONNECTION_TYPES],
    "connections.list": (input) => connections.list(input.org),
    "connections.get": (input) => connections.get(input.id),
    "connections.create": (input, ctx) => connections.create(input, ctx.command, ctx.meta),
    "connections.update": async (input, ctx) => {
      if (ctx.meta.actor.kind === "agent") {
        const given = (keys: readonly string[]) =>
          keys.filter((key) => input.fields !== undefined && key in input.fields);
        // An agent could otherwise loosen the gate that checks its own commands.
        const gate = [...given(GATE_FIELDS), ...(input.agentsOff === undefined ? [] : ["agents"])];
        if (gate.length > 0) {
          throw new UserError(
            `Only the owner changes the ${gate.join(", ")} of a connection, on the Connections page.`,
            409,
          );
        }
        // Otherwise an agent could send the owner's secret to a server of its choosing, through a
        // field or a variable like AWS_ENDPOINT_URL.
        const moved = [
          ...given(DESTINATION_FIELDS),
          ...CONNECTION_LISTS.filter((key) => input[key] !== undefined),
        ];
        if (moved.length > 0 && (await connections.holdsSecret(input.id))) {
          throw new UserError(
            `Connection ${input.id} holds a secret, so only the owner changes its ${moved.join(", ")}, on the Connections page.`,
            409,
          );
        }
      }
      return connections.update(input, ctx.command, ctx.meta);
    },
    "connections.remove": (input, ctx) => connections.remove(input.id, ctx.command, ctx.meta),
    "connections.setSecret": async (input, ctx) => {
      if (ctx.meta.actor.kind === "agent") {
        // A value from an agent has passed through its chat. Agents get a reference from a secret request.
        if (input.value !== undefined) {
          throw new UserError(
            "Agents cannot pass a secret's value. Ask the owner for it with a secret request, then pass its secret: reference.",
            409,
          );
        }
        // A secret the config already uses belongs to something else, like an account's API key.
        const name = input.ref?.slice("secret:".length) ?? "";
        const users = await secrets.referencedBy(name);
        if (users.length > 0) {
          throw new UserError(
            `secret:${name} is already used by ${users.join(", ")}. Pass the reference of a secret the owner gave for this connection.`,
            409,
          );
        }
      }
      return connections.setSecret(input, ctx.command, ctx.meta);
    },
    "connections.setFile": (input, ctx) => connections.setFile(input, ctx.command, ctx.meta),
    "connections.allow": (input, ctx) => connections.setAllow(input.id, input.allow, ctx.command, ctx.meta),
    "connections.test": (input) => tester.test(input.id),
  };
}
