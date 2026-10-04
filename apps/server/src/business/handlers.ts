import { PRIVATE } from "@majhi/shared";
import type { Lanes } from "../captain/lanes.ts";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import type { Store } from "../store/index.ts";
import type { CrmService } from "./crm.ts";
import type { DeadlinesService } from "./deadlines.ts";
import type { KbService } from "./kb.ts";
import type { BusinessActor } from "./scope.ts";
import type { VoiceService } from "./voice.ts";

type BusinessCommand =
  | "kb.list"
  | "kb.get"
  | "kb.search"
  | "kb.upsert"
  | "kb.verify"
  | "kb.remove"
  | "kb.restore"
  | "voice.get"
  | "voice.set"
  | "voice.propose"
  | "voice.decide"
  | "crm.list"
  | "crm.get"
  | "crm.upsert"
  | "crm.log"
  | "crm.merge"
  | "crm.remove"
  | "crm.nextSteps"
  | "deadlines.list"
  | "deadlines.upsert"
  | "deadlines.remove";

/**
 * The commands an agent's tool call runs without a card: they read, or write only inside the caller's own
 * workspace (the handler ties them to it), and what an agent adds waits as a proposal for the owner.
 */
export const BUSINESS_TOOL_COMMANDS: ReadonlySet<string> = new Set([
  "kb.list",
  "kb.get",
  "kb.search",
  "kb.upsert",
  "voice.get",
  "voice.propose",
  "crm.list",
  "crm.get",
  "crm.upsert",
  "crm.log",
  "crm.nextSteps",
  "deadlines.list",
  "deadlines.upsert",
]);

export interface BusinessHandlerDeps {
  kb: KbService;
  voice: VoiceService;
  crm: CrmService;
  deadlines: DeadlinesService;
  lanes: Lanes;
  store: Store;
}

/**
 * Who is calling: the owner, the captain (in a lane it is tied to the lane's workspace) or an agent
 * (tied to its task's workspace).
 */
export async function businessActor(
  deps: Pick<BusinessHandlerDeps, "lanes" | "store">,
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

/** The `kb.*`, `voice.*`, `crm.*` and `deadlines.*` commands. The command table spreads these in. */
export function businessHandlers(deps: BusinessHandlerDeps): Pick<CommandHandlers, BusinessCommand> {
  const { kb, voice, crm, deadlines } = deps;
  const who = (ctx: CommandContext) => businessActor(deps, ctx);
  return {
    "kb.list": async (input, ctx) => kb.list(input, await who(ctx)),
    "kb.get": async (input, ctx) => kb.get(input.id, input.version, await who(ctx)),
    "kb.search": async (input, ctx) => kb.search(input, await who(ctx)),
    "kb.upsert": async (input, ctx) => kb.upsert(input, await who(ctx)),
    "kb.verify": async (input, ctx) => kb.verify(input.id, input.verified, await who(ctx)),
    "kb.remove": async (input, ctx) => kb.remove(input.id, await who(ctx)),
    "kb.restore": async (input, ctx) => kb.restore(input.id, input.version, await who(ctx)),
    "voice.get": async (input, ctx) => voice.get(input.org, await who(ctx)),
    "voice.set": async (input, ctx) => voice.set(input, await who(ctx)),
    "voice.propose": async (input, ctx) => voice.propose(input, await who(ctx)),
    "voice.decide": async (input, ctx) => voice.decide(input, await who(ctx)),
    "crm.list": async (input, ctx) => crm.list(input, await who(ctx)),
    "crm.get": async (input, ctx) => crm.get(input.id, await who(ctx)),
    "crm.upsert": async (input, ctx) => crm.upsert(input, await who(ctx)),
    "crm.log": async (input, ctx) => crm.log(input, await who(ctx)),
    "crm.merge": async (input, ctx) => crm.merge(input.keep, input.drop, await who(ctx)),
    "crm.remove": async (input, ctx) => crm.remove(input.id, await who(ctx)),
    "crm.nextSteps": async (input, ctx) => crm.nextSteps(input, await who(ctx)),
    "deadlines.list": async (input, ctx) => deadlines.list(input, await who(ctx)),
    "deadlines.upsert": async (input, ctx) => deadlines.upsert(input, await who(ctx)),
    "deadlines.remove": async (input, ctx) => deadlines.remove(input.id, await who(ctx)),
  };
}
