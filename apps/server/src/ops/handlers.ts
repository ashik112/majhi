import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import type { PlaybookService } from "../playbooks/service.ts";
import type { WatchEngine } from "./anything/engine.ts";
import type { PhoneChannel } from "./phone.ts";
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

export interface OpsHandlerDeps {
  watch: OpsWatch;
  engine: WatchEngine;
  phone: PhoneChannel;
  playbooks: PlaybookService;
}

/** The watch playbook that carries the owner's services. */
export const WATCH_PLAYBOOK = "ops-uptime";

/**
 * The `ops.*` commands. They are the owner's: an agent never changes what is watched, who is told, or
 * who may answer from a phone. The captain reads incidents as findings.
 */
export function opsHandlers(deps: OpsHandlerDeps): Pick<CommandHandlers, OpsCommand> {
  const { watch, phone, playbooks, engine } = deps;
  const owner = (ctx: CommandContext): void => {
    if (ctx.meta.actor.kind === "agent") {
      throw new UserError(`${ctx.command} is the owner's. The captain reads incidents as findings.`, 409);
    }
  };
  return {
    "ops.overview": async (input, ctx) => {
      owner(ctx);
      return watch.overview(input.org);
    },
    "ops.serviceSave": async (input, ctx) => {
      owner(ctx);
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
      owner(ctx);
      await watch.removeService(input.id);
      return { id: input.id };
    },
    "ops.checkNow": async (input, ctx) => {
      owner(ctx);
      return watch.checkNow(input.id);
    },
    "ops.ack": async (input, ctx) => {
      owner(ctx);
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
    "watch.overview": async (input, ctx) => {
      owner(ctx);
      return engine.overview(input.org);
    },
    "watch.plan": async (input, ctx) => {
      owner(ctx);
      return engine.plan(input);
    },
    "watch.test": async (input, ctx) => {
      owner(ctx);
      return engine.test(input.org, input.def);
    },
    "watch.save": async (input, ctx) => {
      owner(ctx);
      const view = await engine.save(input);
      // Watching something means the engine runs: it has its own clock, and the incidents use the uptime playbook's lane.
      return view;
    },
    "watch.remove": async (input, ctx) => {
      owner(ctx);
      await engine.remove(input.id);
      return { id: input.id };
    },
    "watch.checkNow": async (input, ctx) => {
      owner(ctx);
      return engine.checkNow(input.id);
    },
    "watch.pause": async (input, ctx) => {
      owner(ctx);
      return engine.pause(input.id, input.paused);
    },
    "watch.snooze": async (input, ctx) => {
      owner(ctx);
      return engine.snooze(input.id, input.minutes, input.kind);
    },
    // The captain's own: the one watch command an agent may call.
    "watch.report": async (input) => engine.report(input),
  };
}
