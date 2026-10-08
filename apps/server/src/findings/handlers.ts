import { PRIVATE } from "@majhi/shared";
import { resolveActor } from "../actor.ts";
import type { Lanes } from "../captain/lanes.ts";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import type { Store } from "../store/index.ts";
import type { FindingActor, FindingsService } from "./service.ts";

type FindingsCommand =
  | "findings.list"
  | "findings.report"
  | "findings.update"
  | "findings.toTask"
  | "findings.dismiss";

/** The commands an agent's tool call runs without a card: they only touch the caller's own workspace. */
export const FINDINGS_TOOL_COMMANDS: ReadonlySet<string> = new Set([
  "findings.report",
  "findings.update",
  "findings.toTask",
  "findings.dismiss",
]);

export interface FindingsHandlerDeps {
  findings: FindingsService;
  lanes: Lanes;
  store: Store;
}

/**
 * Who is calling: the owner, the captain (in a lane it is tied to the lane's workspace) or an agent
 * (tied to its task's workspace).
 */
export async function findingActor(
  deps: Pick<FindingsHandlerDeps, "lanes" | "store">,
  ctx: CommandContext,
): Promise<FindingActor> {
  const actor = ctx.meta.actor;
  if (actor.kind !== "agent") return { kind: "owner" };
  const task = ctx.meta.task;
  const lane = task === undefined ? undefined : deps.lanes.orgOf(task);
  if ((await resolveActor(deps, ctx.meta)).kind === "captain")
    return { kind: "captain", ...(lane === undefined ? {} : { org: lane }) };
  const org = task === undefined ? PRIVATE : (deps.store.tasks.get(task)?.org ?? PRIVATE);
  return { kind: "agent", id: actor.id, org: lane ?? org };
}

/** The `findings.*` commands. The command table spreads these in. */
export function findingsHandlers(deps: FindingsHandlerDeps): Pick<CommandHandlers, FindingsCommand> {
  const { findings } = deps;
  return {
    "findings.list": async (input, ctx) => findings.list(input, await findingActor(deps, ctx)),
    "findings.report": async (input, ctx) => findings.report(input, await findingActor(deps, ctx)),
    "findings.update": async (input, ctx) => findings.update(input, await findingActor(deps, ctx)),
    "findings.toTask": async (input, ctx) => findings.toTask(input.id, await findingActor(deps, ctx)),
    "findings.dismiss": async (input, ctx) =>
      findings.dismiss(input.id, input.reason, await findingActor(deps, ctx)),
  };
}
