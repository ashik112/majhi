import { PRIVATE, pageRef } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { GoalsService } from "./goals.ts";
import type { OutboundGate } from "./outbound.ts";
import type { PlaybookService } from "./service.ts";

type PlaybookCommand =
  | "playbooks.list"
  | "playbooks.update"
  | "playbooks.plan"
  | "playbooks.create"
  | "playbooks.remove"
  | "playbooks.activity"
  | "playbooks.run"
  | "playbooks.runs"
  | "playbooks.report"
  | "goals.list"
  | "goals.create"
  | "goals.update"
  | "goals.remove"
  | "outbound.list"
  | "outbound.setMode"
  | "outbound.submit"
  | "outbound.decide"
  | "outbound.decideBatch";

/**
 * The commands an agent's tool call runs without a card. They only touch the caller's own workspace
 * (the handlers scope them), and nothing among them sends anything: the gate queues.
 */
export const PLAYBOOK_TOOL_COMMANDS: ReadonlySet<string> = new Set([
  "playbooks.list",
  "playbooks.runs",
  "playbooks.activity",
  "playbooks.report",
  "goals.list",
  "goals.create",
  "goals.update",
  "outbound.list",
  "outbound.submit",
]);

export interface PlaybookHandlerDeps extends FindingsHandlerDeps {
  playbooks: PlaybookService;
  goals: GoalsService;
  outbound: OutboundGate;
}

/** These are the owner's. The captain proposes and reports; it never changes its own playbooks, the gate or a decision. */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. The captain proposes; the owner decides on ${pageRef("playbooks")}.`,
      409,
    );
  }
}

/** The `playbooks.*`, `goals.*` and `outbound.*` commands. The command table spreads these in. */
export function playbookHandlers(deps: PlaybookHandlerDeps): Pick<CommandHandlers, PlaybookCommand> {
  const { playbooks, goals, outbound } = deps;
  /** The workspace an actor reads: a lane its own, the owner the one asked for or Private. */
  const orgOf = async (asked: string | undefined, ctx: CommandContext): Promise<string> => {
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner") return asked ?? PRIVATE;
    if (asked !== undefined && asked !== actor.org && actor.org !== undefined) {
      throw new UserError("You work in your own workspace only.", 409);
    }
    return actor.org ?? asked ?? PRIVATE;
  };
  return {
    "playbooks.list": async (input, ctx) => playbooks.list(await orgOf(input.org, ctx)),
    "playbooks.update": async (input, ctx) => {
      ownerOnly(ctx);
      return playbooks.update(input);
    },
    "playbooks.plan": async (input, ctx) => {
      ownerOnly(ctx);
      return playbooks.plan(input.org ?? PRIVATE, input.text);
    },
    "playbooks.create": async (input, ctx) => {
      ownerOnly(ctx);
      return playbooks.create(input.org, input.spec);
    },
    "playbooks.remove": async (input, ctx) => {
      ownerOnly(ctx);
      playbooks.remove(input.id);
      return { id: input.id };
    },
    "playbooks.activity": async (input, ctx) => playbooks.activity(await orgOf(input.org, ctx), input.id),
    "playbooks.run": async (input, ctx) => {
      ownerOnly(ctx);
      return playbooks.runNow(input.org, input.id);
    },
    "playbooks.runs": async (input, ctx) => {
      const org = await orgOf(input.org, ctx);
      return { runs: playbooks.runs(org, input.id, input.limit) };
    },
    "playbooks.report": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "agent") {
        throw new UserError("Only the captain in a workspace lane closes a playbook run.", 409);
      }
      return { run: await playbooks.report(input, actor) };
    },
    "goals.list": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "agent")
        throw new UserError("Goals are the captain's and the owner's to read.", 409);
      return { goals: goals.list(input, actor) };
    },
    "goals.create": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "agent") throw new UserError("Only the captain proposes a goal.", 409);
      return goals.create(input, actor);
    },
    "goals.update": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "agent") throw new UserError("Only the owner and the captain change a goal.", 409);
      return goals.update(input, actor);
    },
    "goals.remove": async (input, ctx) => {
      ownerOnly(ctx);
      goals.remove(input.id);
      return { id: input.id };
    },
    "outbound.list": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      const org = actor.kind === "owner" ? input.org : (actor.org ?? input.org);
      return {
        channels: org === undefined ? [] : outbound.channels(org),
        drafts: outbound.list(org),
      };
    },
    "outbound.setMode": async (input, ctx) => {
      ownerOnly(ctx);
      return { channels: outbound.setMode(input) };
    },
    "outbound.submit": async (input, ctx) => {
      const actor = await findingActor(deps, ctx);
      return outbound.submit(input, actor);
    },
    "outbound.decide": async (input, ctx) => {
      ownerOnly(ctx);
      await outbound.decide(input.id, input.decision);
      return { drafts: outbound.list(undefined, 50) };
    },
    "outbound.decideBatch": async (input, ctx) => {
      ownerOnly(ctx);
      await outbound.decideBatch(input.org, input.channel, input.decision);
      return { drafts: outbound.list(input.org, 50) };
    },
  };
}
