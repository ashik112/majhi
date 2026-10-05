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

/**
 * A channel's mode and sending or discarding drafts are the owner's: an agent never lets its own
 * drafts out. Playbooks and goals an agent changes through the owner's approval policy like any change.
 */
function ownerOnly(ctx: CommandContext): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(
      `${ctx.command} is the owner's. The owner sets a channel's mode and sends or discards drafts on ${pageRef("playbooks")}.`,
      409,
    );
  }
}

const RESUMES = "A playbook that resumes tasks a limit paused";
const ownersLine = (what: string) => `${what} is the owner's, on the Playbooks page.`;

/**
 * What in a playbook call from an agent would raise its own limits or power, from the input alone,
 * or undefined. The admin service asks before a card is posted; the handler asks again.
 */
export function playbookLimitRefusal(command: string, input: Record<string, unknown>): string | undefined {
  if (command === "playbooks.update") {
    const outcomes = (input.outcomes ?? {}) as Record<string, unknown>;
    if (Object.values(outcomes).some((on) => on === true)) return ownersLine("Turning an outcome rule on");
    const clock = input.clock as { action?: { kind?: unknown } } | undefined;
    if (clock?.action?.kind === "tasks.resume") return ownersLine(RESUMES);
  }
  if (command === "playbooks.create") {
    const spec = input.spec as { clock?: { action?: { kind?: unknown } } } | undefined;
    if (spec?.clock?.action?.kind === "tasks.resume") return ownersLine(RESUMES);
  }
  return undefined;
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
  /** An agent's playbook in its own workspace, or a refusal. */
  const ownPlaybook = async (org: string, id: string) => {
    const view = (await playbooks.list(org)).playbooks.find((p) => p.playbook.id === id);
    if (view === undefined || (view.clock !== undefined && view.clock.org !== org)) {
      throw new UserError(`There is no playbook "${id}" in ${org}.`, 404);
    }
    return view;
  };
  /** Refuses what would raise an agent's own limits or power, however the owner's policy answered. */
  const limitsStay = async (
    ctx: CommandContext,
    input: Record<string, unknown>,
    org: string,
    id?: string,
  ) => {
    if (ctx.meta.actor.kind !== "agent") return;
    const refused = playbookLimitRefusal(ctx.command, input);
    if (refused !== undefined) throw new UserError(refused, 409);
    // Switching on or running one that already resumes paused tasks raises the limit just the same.
    const switchesOn = ctx.command === "playbooks.run" || input.enabled === true;
    if (
      id !== undefined &&
      switchesOn &&
      (await ownPlaybook(org, id)).clock?.action.kind === "tasks.resume"
    ) {
      throw new UserError(ownersLine(RESUMES), 409);
    }
  };
  return {
    "playbooks.list": async (input, ctx) => playbooks.list(await orgOf(input.org, ctx)),
    "playbooks.update": async (input, ctx) => {
      const org = await orgOf(input.org, ctx);
      await limitsStay(ctx, input, org, input.id);
      return playbooks.update({ ...input, org });
    },
    "playbooks.plan": async (input, ctx) => playbooks.plan(await orgOf(input.org, ctx), input.text),
    "playbooks.create": async (input, ctx) => {
      const org = await orgOf(input.org, ctx);
      await limitsStay(ctx, input, org);
      return playbooks.create(org, input.spec);
    },
    "playbooks.remove": async (input, ctx) => {
      if (ctx.meta.actor.kind === "agent") await ownPlaybook(await orgOf(input.org, ctx), input.id);
      playbooks.remove(input.id);
      return { id: input.id };
    },
    "playbooks.activity": async (input, ctx) => playbooks.activity(await orgOf(input.org, ctx), input.id),
    "playbooks.run": async (input, ctx) => {
      const org = await orgOf(input.org, ctx);
      await limitsStay(ctx, input, org, input.id);
      return playbooks.runNow(org, input.id);
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
      const actor = await findingActor(deps, ctx);
      if (actor.kind === "agent") throw new UserError("Only the owner and the captain remove a goal.", 409);
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
