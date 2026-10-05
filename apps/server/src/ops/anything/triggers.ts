import {
  type AutomationRun,
  type TriggerCreateInput,
  type TriggerUpdateInput,
  type TriggerView,
  triggerWatchDef,
  type WatchDef,
  type WatchView,
} from "@majhi/shared";
import { watchIdOf } from "../../automation/migrate.ts";
import type { CommandHandlers } from "../../commands/handlers.ts";
import { UserError } from "../../errors.ts";
import type { WatchEngine } from "./engine.ts";

/**
 * Triggers are Watch now. The `triggers.*` commands stay for the captain and for anything that
 * already names them: each one makes or changes a watch whose action is the trigger's, and a `trg-`
 * id finds the watch its trigger became.
 */

const idOf = (id: string): string => (id.startsWith("trg-") ? watchIdOf(id) : id);

function view(w: WatchView): TriggerView {
  const run = w.def.fire.run;
  if (run === undefined) throw new UserError(`${w.id} is a watch with no action, not a trigger.`, 409);
  return {
    id: w.id,
    org: w.org,
    name: w.def.name,
    watch: w.def.spec,
    watching: w.how,
    action: run,
    overlap: w.def.fire.runOverlap,
    paused: w.status === "paused" && w.quietUntil === undefined,
    pollSeconds: w.def.everyMin * 60,
    settleSeconds: w.def.fire.settleMin * 60,
    cooldownSeconds: w.def.fire.cooldownMin * 60,
    lastCheckedAt: w.lastAt ?? null,
    checkError: w.unavailable ?? null,
    lastRun: w.runs[0] ?? null,
  };
}

export class TriggerAlias {
  constructor(private readonly engine: WatchEngine) {}

  async list(org?: string): Promise<TriggerView[]> {
    const { watches } = await this.engine.overview(org);
    return watches.filter((w) => w.def.fire.run !== undefined).map(view);
  }

  async get(id: string): Promise<TriggerView> {
    return view(await this.engine.show(idOf(id)));
  }

  runs(id: string, limit: number): AutomationRun[] {
    return this.engine.runsOf(idOf(id), limit);
  }

  async create(input: TriggerCreateInput): Promise<TriggerView> {
    return view(await this.engine.save({ org: input.org, def: triggerWatchDef(input) }));
  }

  async update(input: TriggerUpdateInput): Promise<TriggerView> {
    const id = idOf(input.id);
    const now = await this.engine.show(id);
    const run = now.def.fire.run;
    if (run === undefined) throw new UserError(`${id} is a watch with no action, not a trigger.`, 409);
    // What was not named stays as it is: a new check replaces the old one only when one is given.
    const next: WatchDef =
      input.watch === undefined
        ? now.def
        : triggerWatchDef({
            name: now.def.name,
            watch: input.watch,
            action: run,
            overlap: now.def.fire.runOverlap,
          });
    const def: WatchDef = {
      ...next,
      name: (input.name ?? now.def.name).slice(0, 100),
      everyMin:
        input.pollSeconds === undefined ? now.def.everyMin : Math.max(1, Math.ceil(input.pollSeconds / 60)),
      fire: {
        ...next.fire,
        run: input.action ?? run,
        runOverlap: input.overlap ?? now.def.fire.runOverlap,
        settleMin:
          input.settleSeconds === undefined ? now.def.fire.settleMin : Math.ceil(input.settleSeconds / 60),
        cooldownMin:
          input.cooldownSeconds === undefined
            ? now.def.fire.cooldownMin
            : Math.ceil(input.cooldownSeconds / 60),
      },
    };
    return view(await this.engine.save({ id, org: now.org, def }));
  }

  async pause(id: string, paused: boolean, by: "owner" | "agent" = "owner"): Promise<TriggerView> {
    return view(
      await this.engine.pause(
        idOf(id),
        paused,
        by,
        by === "agent" ? "paused through triggers.pause" : undefined,
      ),
    );
  }

  runNow(id: string): Promise<AutomationRun> {
    return this.engine.runNow(idOf(id));
  }

  async delete(id: string): Promise<{ removed: string }> {
    const wid = idOf(id);
    await this.engine.remove(wid);
    return { removed: wid };
  }
}

type TriggerCommand =
  | "triggers.list"
  | "triggers.get"
  | "triggers.runs"
  | "triggers.create"
  | "triggers.update"
  | "triggers.pause"
  | "triggers.resume"
  | "triggers.runNow"
  | "triggers.delete";

/** The `triggers.*` commands. The command table spreads these in. */
export function triggerHandlers(triggers: TriggerAlias): Pick<CommandHandlers, TriggerCommand> {
  return {
    "triggers.list": (input) => triggers.list(input.org),
    "triggers.get": (input) => triggers.get(input.id),
    "triggers.runs": async (input) => triggers.runs(input.id, input.limit),
    "triggers.create": (input) => triggers.create(input),
    "triggers.update": (input) => triggers.update(input),
    "triggers.pause": (input, ctx) =>
      triggers.pause(input.id, true, ctx.meta.actor.kind === "agent" ? "agent" : "owner"),
    "triggers.resume": (input) => triggers.pause(input.id, false),
    "triggers.runNow": (input) => triggers.runNow(input.id),
    "triggers.delete": (input) => triggers.delete(input.id),
  };
}
