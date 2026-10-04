import { pageRef, type WatchDef } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { PlaybookService } from "../playbooks/service.ts";
import type { WatchEngine } from "./anything/engine.ts";
import type { PhoneChannel } from "./phone.ts";
import type { OpsRepo } from "./repo.ts";
import type { OpsWatch } from "./watch.ts";

type OpsCommand =
  | "ops.overview"
  | "ops.serviceSave"
  | "ops.serviceRemove"
  | "ops.checkNow"
  | "ops.ack"
  | "ops.settings"
  | "ops.phoneSetup"
  | "ops.phoneSet"
  | "ops.phoneTest"
  | "ops.phoneForget"
  | "watch.overview"
  | "watch.plan"
  | "watch.test"
  | "watch.save"
  | "watch.remove"
  | "watch.checkNow"
  | "watch.pause"
  | "watch.snooze"
  | "watch.report";

export interface OpsHandlerDeps extends FindingsHandlerDeps {
  watch: OpsWatch;
  engine: WatchEngine;
  phone: PhoneChannel;
  playbooks: PlaybookService;
  repo: Pick<OpsRepo, "service" | "incident">;
}

/** The watch playbook that carries the owner's services. */
export const WATCH_PLAYBOOK = "ops-uptime";

/**
 * Uptime services and incidents an agent reads, adds, changes and acknowledges through the owner's
 * approval policy like any change. Who is paged and when (the phone push and the escalation
 * settings) stays the owner's. Watches an agent may add and change the same way, as long as they
 * only tell: no fix, no action, no phone page. Those stay the owner's, also on a watch the owner made.
 */
export function opsHandlers(deps: OpsHandlerDeps): Pick<CommandHandlers, OpsCommand> {
  const { watch, phone, playbooks, engine } = deps;
  const owner = (ctx: CommandContext): void => {
    if (ctx.meta.actor.kind === "agent") {
      throw new UserError(
        `${ctx.command} is the owner's: who is paged and when. The owner sets it in Alerts and phone on ${pageRef("watch")}.`,
        409,
      );
    }
  };
  /** Why an agent may not save this watch, or undefined when it only tells. */
  const actsOnItsOwn = (def: WatchDef): string | undefined => {
    const fire = def.fire;
    if (fire === undefined) return undefined;
    if (fire.fix !== undefined && fire.fix.mode !== "off") return "a fix";
    if (fire.run !== undefined) return "an action";
    if (fire.orDo !== undefined && fire.orDo.trim() !== "") return "steps to follow";
    if (fire.alert?.phone === true) return "a phone page";
    return undefined;
  };
  const agentMayChange = async (ctx: CommandContext, id: string | undefined, def?: WatchDef) => {
    if (ctx.meta.actor.kind !== "agent") return;
    const what =
      (def === undefined ? undefined : actsOnItsOwn(def)) ??
      (id === undefined ? undefined : actsOnItsOwn((await engine.show(id)).def));
    if (what !== undefined) {
      throw new UserError(
        `A watch with ${what} is the owner's to set up, on ${pageRef("watch")}. Save it to only alert, look into it or draft a status note, and tell the owner what it would do on top.`,
        409,
      );
    }
  };
  /**
   * The workspace an agent works in: a lane or a task its own, the captain outside a lane any. A
   * service or incident of another workspace is refused; one that does not exist is the call's to say.
   */
  const scope = async (ctx: CommandContext, asked: string | undefined): Promise<string | undefined> => {
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner" || actor.org === undefined) return asked;
    if (asked !== undefined && asked !== actor.org) {
      throw new UserError("You work in your own workspace only.", 409);
    }
    return actor.org;
  };
  return {
    "ops.overview": async (input, ctx) => watch.overview(await scope(ctx, input.org)),
    "ops.serviceSave": async (input, ctx) => {
      await scope(ctx, input.org);
      if (input.id !== undefined) await scope(ctx, deps.repo.service(input.id)?.org);
      const view = await watch.saveService(input);
      // Watching a service means the watch runs for its workspace.
      const list = await playbooks.list(input.org).catch(() => undefined);
      const pb = list?.playbooks.find((p) => p.playbook.id === WATCH_PLAYBOOK);
      if (pb !== undefined && !pb.enabled) {
        await playbooks.update({ org: input.org, id: WATCH_PLAYBOOK, enabled: true }).catch(() => undefined);
      }
      return view;
    },
    "ops.serviceRemove": async (input, ctx) => {
      await scope(ctx, deps.repo.service(input.id)?.org);
      await watch.removeService(input.id);
      return { id: input.id };
    },
    "ops.checkNow": async (input, ctx) => {
      await scope(ctx, deps.repo.service(input.id)?.org);
      return watch.checkNow(input.id);
    },
    "ops.ack": async (input, ctx) => {
      await scope(ctx, deps.repo.incident(input.id)?.org);
      return watch.ack(input.id);
    },
    "ops.settings": async (input, ctx) => {
      owner(ctx);
      return watch.setSettings(input);
    },
    "ops.phoneSetup": async (input, ctx) => {
      owner(ctx);
      return phone.setup(input);
    },
    "ops.phoneSet": async (input, ctx) => {
      owner(ctx);
      return phone.set(input);
    },
    "ops.phoneTest": async (_input, ctx) => {
      owner(ctx);
      return phone.test();
    },
    "ops.phoneForget": async (_input, ctx) => {
      owner(ctx);
      return phone.forget();
    },
    "watch.overview": async (input) => engine.overview(input.org),
    "watch.plan": async (input) => {
      return engine.plan(input);
    },
    "watch.test": async (input) => engine.test(input.org, input.def),
    "watch.save": async (input, ctx) => {
      await agentMayChange(ctx, input.id, input.def);
      const view = await engine.save(input);
      // Watching something means the engine runs: it has its own clock, and the incidents use the uptime playbook's lane.
      return view;
    },
    "watch.remove": async (input, ctx) => {
      await agentMayChange(ctx, input.id);
      await engine.remove(input.id);
      return { id: input.id };
    },
    "watch.checkNow": async (input) => engine.checkNow(input.id),
    "watch.pause": async (input, ctx) => {
      await agentMayChange(ctx, input.id);
      return engine.pause(input.id, input.paused);
    },
    "watch.snooze": async (input, ctx) => {
      await agentMayChange(ctx, input.id);
      return engine.snooze(input.id, input.minutes, input.kind);
    },
    // The captain's own: the one watch command an agent may call.
    "watch.report": async (input) => engine.report(input),
  };
}
