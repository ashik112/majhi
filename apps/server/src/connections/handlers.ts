import {
  CONNECTION_LISTS,
  CONNECTION_TYPES,
  type ConnectTokenResult,
  DEFAULT_GIT_HOST,
  serviceById,
  textValue,
} from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import type { McpUrlService } from "../connect/mcp-url.ts";
import type { ConnectService } from "../connect/service.ts";
import { UserError } from "../errors.ts";
import type { GitConnect } from "../gitConnect/wire.ts";
import type { SecretService } from "../secrets/service.ts";
import type { GitLink } from "./git-link.ts";
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
  | "connections.renameVar"
  | "connections.test"
  | "connections.connectToken"
  | "connections.probeMcp"
  | "connections.connectMcpUrl";

/**
 * Fields that decide what majhi's gate checks, or which identity a run gets: the CLIs an env
 * connection is for, an MCP server's tool exceptions, a kubeconfig's context. Only the owner changes them.
 */
const GATE_FIELDS = ["clis", "read_tools", "write_tools", "context", "products", "private_network"];

/** Fields that say where a connection's secrets go or what runs with them. */
const DESTINATION_FIELDS = ["transport", "url", "command", "test", "imap_host", "smtp_host"];

/** What connecting by token or by address needs besides the connections themselves. */
export interface ConnectionExtras {
  connect: ConnectService;
  gitConnect: GitConnect;
  gitLink: GitLink;
  mcpUrl: McpUrlService;
}

/** Only the owner pastes a token or types an address: an agent has no token of its own to give. */
function ownerOnly(ctx: CommandContext, what: string): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(`Only the owner ${what}, on the Connections page.`, 409);
  }
}

const blocked = (message: string): ConnectTokenResult => ({
  state: "failed",
  failure: { reason: "blocked-host", fix: message },
  message,
});

/** The `connections.*` commands. The command table spreads these in. */
export function connectionHandlers(
  connections: ConnectionService,
  tester: ConnectionTester,
  secrets: SecretService,
  extras: ConnectionExtras,
): Pick<CommandHandlers, ConnectionCommand> {
  return {
    "connections.connectToken": async (input, ctx) => {
      ownerOnly(ctx, "connects a service with a token");
      const entry = serviceById(input.service);
      if (entry === undefined) throw new UserError(`There is no service ${input.service}.`, 404);
      if (entry.kind === "token") {
        const out = await extras.connect.connectToken(input, ctx.meta);
        return out.ok
          ? { state: "connected", connection: out.connection, account: out.account }
          : { state: "failed", failure: out.failure, message: "The service did not accept the token." };
      }
      if (entry.kind !== "git-host" || entry.gitKind === undefined) {
        throw new UserError(`${entry.name} is not connected by a token.`, 409);
      }
      const kind = entry.gitKind;
      const host = input.host !== undefined && input.host !== DEFAULT_GIT_HOST[kind] ? input.host : undefined;
      let status: Awaited<ReturnType<typeof extras.gitConnect.signIn.token>>;
      try {
        status = await extras.gitConnect.signIn.token(
          {
            org: input.org,
            kind,
            ...(host === undefined ? {} : { host }),
            token: input.token,
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.allowPrivate === true ? { allowPrivate: true } : {}),
          },
          ctx.meta,
        );
      } catch (err) {
        // A host majhi refuses (private, metadata, not found) is a refusal of the address, not a crash.
        if (err instanceof UserError && err.status === 409) return blocked(err.message);
        throw err;
      }
      if (status.state === "done") {
        const connection = await extras.gitLink.signedIn(
          {
            org: input.org,
            kind,
            host: host ?? DEFAULT_GIT_HOST[kind],
            privateNetwork: input.allowPrivate === true,
            via: "token",
          },
          ctx.meta,
        );
        return { state: "connected", connection, account: status.account };
      }
      if (status.state === "confirm") {
        return {
          state: "confirm",
          signIn: status.signIn,
          account: status.account,
          alsoUsedBy: status.alsoUsedBy,
        };
      }
      return {
        state: "failed",
        failure:
          status.state === "failed" ? (status.failure ?? { reason: "unexpected" }) : { reason: "unexpected" },
        message: status.state === "failed" ? status.reason : "The sign-in did not finish.",
      };
    },
    "connections.probeMcp": async (input, ctx) => {
      ownerOnly(ctx, "adds an MCP server by address");
      return extras.mcpUrl.probe(input);
    },
    "connections.connectMcpUrl": async (input, ctx) => {
      ownerOnly(ctx, "adds an MCP server by address");
      return extras.mcpUrl.connect(input, ctx.meta);
    },
    "connections.types": async () => [...CONNECTION_TYPES],
    "connections.list": (input) => connections.list(input.org),
    "connections.get": (input) => connections.get(input.id),
    "connections.create": async (input, ctx) => {
      const created = await connections.create(input, ctx.command, ctx.meta);
      // A service on this computer is connected only after a real check passes, so saving checks it.
      if (created.type !== "host") return created;
      await tester.test(created.id);
      return connections.get(created.id);
    },
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
      const updated = await connections.update(input, ctx.command, ctx.meta);
      if (updated.type !== "host" || input.fields === undefined) return updated;
      await tester.test(updated.id);
      return connections.get(updated.id);
    },
    "connections.remove": async (input, ctx) => {
      const found = await connections.find(input.id);
      if (found?.connection.type === "git" && ctx.meta.actor.kind === "owner") {
        // The connection is the workspace's sign-in to a host: removing it signs the workspace out there.
        const provider = textValue(found.connection, "provider");
        const kind = provider === "github" || provider === "bitbucket" ? provider : "gitlab";
        const host = textValue(found.connection, "host");
        await extras.gitConnect.signIn.signOut(
          { org: found.org, kind, ...(host === undefined ? {} : { host }) },
          { command: ctx.command, meta: ctx.meta },
        );
      }
      return connections.remove(input.id, ctx.command, ctx.meta);
    },
    // A rename keeps the value where it is: it sends no secret anywhere new, so agents may call it.
    "connections.renameVar": (input, ctx) => connections.renameVar(input, ctx.command, ctx.meta),
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
