import type { CommandHandlers } from "../commands/handlers.ts";
import { ownerOnly } from "../inbox/handlers.ts";
import type { NoticesService } from "./service.ts";

/** The `notices.*` commands of the bell. What the owner has read is theirs alone. */
export function noticesHandlers(
  notices: NoticesService,
): Pick<CommandHandlers, "notices.list" | "notices.markRead"> {
  return {
    "notices.list": async (input, ctx) => {
      ownerOnly(ctx);
      return notices.list(input.org);
    },
    "notices.markRead": async (input, ctx) => {
      ownerOnly(ctx);
      notices.markRead(input);
      return { ok: true as const };
    },
  };
}
