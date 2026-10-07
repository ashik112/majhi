import type { CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { ownerOnly } from "../inbox/handlers.ts";
import type { ConversationsService } from "./service.ts";

/** The `conversations.*` commands of the chat dock. What the owner has read is the owner's alone. */
export function conversationsHandlers(
  conversations: ConversationsService,
): Pick<
  CommandHandlers,
  "conversations.list" | "conversations.search" | "conversations.markRead" | "conversations.archive"
> {
  return {
    "conversations.list": async (_input, ctx) => {
      ownerOnly(ctx);
      return conversations.list();
    },
    "conversations.search": async (input, ctx) => {
      ownerOnly(ctx);
      return conversations.search(input.query);
    },
    "conversations.markRead": async (input, ctx) => {
      ownerOnly(ctx);
      if (!conversations.markRead(input.id, input.upTo)) {
        throw new UserError(`No conversation "${input.id}".`, 404);
      }
      return { ok: true as const };
    },
    "conversations.archive": async (input, ctx) => {
      ownerOnly(ctx);
      if (!conversations.archive(input.id, input.archived)) {
        throw new UserError(`No conversation "${input.id}".`, 404);
      }
      return { ok: true as const };
    },
  };
}
