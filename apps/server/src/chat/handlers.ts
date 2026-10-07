import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { ClientChat } from "./service.ts";

type ChatCommand =
  | "chat.list"
  | "chat.link"
  | "chat.ignore"
  | "chat.holder"
  | "chat.send"
  | "chat.editReply"
  | "chat.samePerson"
  | "chat.confirmWebhook"
  | "chat.proposeRules"
  | "contacts.list"
  | "contacts.merge"
  | "contacts.undoMerge";

/** Client chats are the owner's: what the clients wrote and who they are never reaches an agent's tools. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(`${ctx.command} is the owner's. Client chats are never read or changed by an agent.`, 409);
  }
}

/** The `chat.*` and `contacts.*` commands (docs/briefs/client-chats.md). */
export function chatHandlers(chat: ClientChat): Pick<CommandHandlers, ChatCommand> {
  return {
    "chat.list": async (_input, ctx) => {
      ownerOnly(ctx);
      return chat.list();
    },
    "chat.link": async (input, ctx) => {
      ownerOnly(ctx);
      return chat.link(input.room, input.org);
    },
    "chat.ignore": async (input, ctx) => {
      ownerOnly(ctx);
      chat.ignore(input.room);
      return { ok: true as const };
    },
    "chat.holder": async (input, ctx) => {
      ownerOnly(ctx);
      return chat.holder(input.room, input.holder);
    },
    "chat.send": async (input, ctx) => {
      ownerOnly(ctx);
      const out = await chat.send(input.room, input.text, input.replyTo);
      return { draft: out.draft, state: out.state === "held" ? ("held" as const) : out.state };
    },
    "chat.editReply": async (input, ctx) => {
      ownerOnly(ctx);
      chat.editReply(input.draft, input.text);
      return { ok: true as const };
    },
    "chat.samePerson": async (input, ctx) => {
      ownerOnly(ctx);
      chat.samePerson(input.room, input.item, input.answer);
      return { ok: true as const };
    },
    "chat.confirmWebhook": async (input, ctx) => {
      ownerOnly(ctx);
      await chat.confirmWebhook(input.connection);
      return { ok: true as const };
    },
    "chat.proposeRules": async (input, ctx) => {
      if (ctx.meta.actor.kind !== "agent" || ctx.meta.task === undefined) {
        throw new UserError("Only the captain proposes this, from its workspace lane.", 409);
      }
      return chat.proposeRules(input, { agent: ctx.meta.actor.id, task: ctx.meta.task });
    },
    "contacts.list": async (input, ctx) => {
      ownerOnly(ctx);
      return chat.contacts(input.org);
    },
    "contacts.merge": async (input, ctx) => {
      ownerOnly(ctx);
      return chat.merge(input.keep, input.merge);
    },
    "contacts.undoMerge": async (input, ctx) => {
      ownerOnly(ctx);
      chat.undoMerge(input.merge);
      return { ok: true as const };
    },
  };
}
