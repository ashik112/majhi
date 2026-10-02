import type { OptionValue } from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Store } from "../store/index.ts";
import { readPrices } from "../usage/prices.ts";
import { resolveAgent } from "./launch.ts";
import { fallbackModel, normalizeOffered } from "./model-options.ts";
import type { AgentRun } from "./run.ts";

export interface RefusalDeps {
  store: Store;
  agents: AgentStore;
  config: ConfigService;
}

/** The CLI's name for a model, else its id. */
function nameOf(models: readonly OptionValue[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const name = models.find((m) => m.id === id)?.name.trim();
  return name === undefined || name === "" ? id : name;
}

/** The CLI's sentinel for "whatever you pick": it names no model. */
const SENTINEL = "default";

/** The model the session runs, as the room names it: "Opus", else its id. Undefined when only "default" is known. */
export function currentModelName(run: AgentRun): string | undefined {
  const offered = run.session?.models;
  const current = offered?.defaultModel;
  if (current !== undefined && current !== SENTINEL) return nameOf(offered?.models ?? [], current);
  return run.turnModel === SENTINEL ? undefined : run.turnModel;
}

/**
 * The model's safeguards refused a turn: moves the live session to the next cheaper model the
 * same account offers, and keeps it for this task only (the task's override for this agent), so a
 * later session starts on it too. Never another account. Undefined when there is nothing to switch
 * to (one model, the cheapest already, an unknown current model) or the session refused the switch.
 * Returns the name of the model it switched to.
 */
export async function switchAfterRefusal(
  deps: RefusalDeps,
  run: AgentRun,
  at: Date,
): Promise<string | undefined> {
  const session = run.session;
  const task = deps.store.tasks.get(run.task);
  if (session === undefined || run.exited || task === undefined) return undefined;
  const agent = await resolveAgent(deps, run.agent).catch(() => undefined);
  if (agent === undefined) return undefined;
  const offered = session.models;
  const allowed = agent.fm.models ?? [];
  const hidden = agent.account.hidden_models ?? [];
  // The same choice a pick has: the agent's `models` when it names some, else what the owner did not hide.
  const listed =
    allowed.length === 0
      ? offered.models.filter((m) => !hidden.includes(m.id))
      : offered.models.filter((m) => allowed.includes(m.id));
  const prices = await readPrices(deps.config.file).catch(() => ({}));
  const current = offered.defaultModel;
  const next = fallbackModel(normalizeOffered(listed), [current, run.turnModel], prices);
  if (next === undefined) return undefined;
  try {
    await session.setOption("model", next);
  } catch {
    return undefined;
  }
  const overrides = { ...task.overrides, [run.agent]: { ...task.overrides[run.agent], model: next } };
  deps.store.tasks.setOverrides(task.id, overrides, at.toISOString());
  return nameOf(offered.models, next) ?? next;
}
