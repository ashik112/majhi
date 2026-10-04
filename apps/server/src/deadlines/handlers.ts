import { PRIVATE } from "@majhi/shared";
import type { Lanes } from "../captain/lanes.ts";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import type { Store } from "../store/index.ts";
import type { DeadlinesService } from "./deadlines.ts";
import type { BusinessActor } from "./scope.ts";

type DeadlineCommand = "deadlines.list" | "deadlines.upsert" | "deadlines.remove";

/**
 * The commands an agent's tool call runs without a card: they read, or write only inside the caller's own
 * workspace (the handler ties them to it).
 */
export const DEADLINE_TOOL_COMMANDS: ReadonlySet<string> = new Set(["deadlines.list", "deadlines.upsert"]);

export interface DeadlineHandlerDeps {
  deadlines: DeadlinesService;
  lanes: Lanes;
  store: Store;
}

/**
 * Who is calling: the owner, the captain (in a lane it is tied to the lane's workspace) or an agent
 * (tied to its task's workspace).
 */
export async function deadlineActor(
  deps: Pick<DeadlineHandlerDeps, "lanes" | "store">,
  ctx: CommandContext,
): Promise<BusinessActor> {
  const actor = ctx.meta.actor;
  if (actor.kind !== "agent") return { kind: "owner" };
  const task = ctx.meta.task;
  const lane = task === undefined ? undefined : deps.lanes.orgOf(task);
  const boss = await deps.lanes.boss();
  if (actor.id === boss) return { kind: "captain", ...(lane === undefined ? {} : { org: lane }) };
  const org = task === undefined ? PRIVATE : (deps.store.tasks.get(task)?.org ?? PRIVATE);
  return { kind: "agent", id: actor.id, org: lane ?? org };
}

/** The `deadlines.*` commands. The command table spreads these in. */
export function deadlineHandlers(deps: DeadlineHandlerDeps): Pick<CommandHandlers, DeadlineCommand> {
  const { deadlines } = deps;
  const who = (ctx: CommandContext) => deadlineActor(deps, ctx);
  return {
    "deadlines.list": async (input, ctx) => deadlines.list(input, await who(ctx)),
    "deadlines.upsert": async (input, ctx) => deadlines.upsert(input, await who(ctx)),
    "deadlines.remove": async (input, ctx) => deadlines.remove(input.id, await who(ctx)),
  };
}
