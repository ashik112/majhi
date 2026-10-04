import { PRIVATE, pageRef } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { OutcomesService } from "./service.ts";

type OutcomesCommand =
  | "scorecard.get"
  | "scorecard.setMinutes"
  | "trust.list"
  | "trust.unmute"
  | "trust.setWindow"
  | "money.get"
  | "money.set";

/** Only reads are tools an agent runs without a card, and a lane reads its own workspace. */
export const OUTCOMES_TOOL_COMMANDS: ReadonlySet<string> = new Set(["scorecard.get", "trust.list"]);

export interface OutcomesHandlerDeps extends FindingsHandlerDeps {
  outcomes: OutcomesService;
}

/** The ceiling, the rates, the minutes and the ladder's undo are the owner's: the captain never changes its own. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    const where: Record<string, string> = {
      "money.set": " The owner sets it on the Health & usage page.",
      "scorecard.setMinutes": " The owner sets it on the Captain page.",
      "trust.unmute": " The owner does it on the Captain page.",
    };
    throw new UserError(
      `${ctx.command} is the owner's. The captain never changes its own trust or ceiling; the owner sets it on ${pageRef(ctx.command === "money.set" ? "usage" : "captain")}.`,
      409,
    );
  }
}

/** The `scorecard.*`, `trust.*` and `money.*` commands. The command table spreads these in. */
export function outcomesHandlers(deps: OutcomesHandlerDeps): Pick<CommandHandlers, OutcomesCommand> {
  const { outcomes } = deps;
  /** The workspace a caller may read: the owner any, a lane its own. */
  const scope = async (asked: string | undefined, ctx: CommandContext): Promise<string | undefined> => {
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner") return asked;
    const own = actor.org ?? PRIVATE;
    if (asked !== undefined && asked !== own) throw new UserError("You read your own workspace only.", 409);
    return own;
  };
  return {
    "scorecard.get": async (input, ctx) => outcomes.scorecard(input.range, await scope(input.org, ctx)),
    "scorecard.setMinutes": async (input, ctx) => {
      ownerOnly(ctx);
      return { minutes: outcomes.setMinutes(input.kind, input.minutes) };
    },
    "trust.list": async (input, ctx) => outcomes.trust(await scope(input.org, ctx)),
    "trust.unmute": async (input, ctx) => {
      ownerOnly(ctx);
      await outcomes.unmute(input.org, input.playbook);
      return { ok: true as const };
    },
    "trust.setWindow": async (input, ctx) => {
      ownerOnly(ctx);
      return { window: outcomes.setWindow(input.window) };
    },
    "money.get": async () => outcomes.money(),
    "money.set": async (input, ctx) => {
      ownerOnly(ctx);
      return outcomes.setMoney(input);
    },
  };
}
