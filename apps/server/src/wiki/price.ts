import { DEFAULT_PRICES, findPrice, type Price, type PricesConfig, type ToolId } from "@majhi/shared";
import { modelForTier, normalizeOffered } from "../runs/model-options.ts";

/** The model-id prefix of each tool's models in the price table. */
const FAMILY: Readonly<Record<ToolId, string>> = { claude: "claude-", codex: "gpt-" };

/**
 * What the wiki writer's model costs per million tokens, for the update's estimate. A model named in settings
 * (`wiki.writer_model`) uses its row. Otherwise the writer runs the balanced model its account offers (the Housekeeper's
 * `repo` mode), which this stands for with the balanced row of that tool's family in the price table, ranked by the
 * same rule the session uses (owner rows included). Undefined when there is no row: the estimate then has no dollars
 * and only the token cap holds.
 */
export function writerPrice(
  model: string | undefined,
  tool: ToolId | undefined,
  owner: PricesConfig,
): Price | undefined {
  if (model !== undefined) return findPrice(model, owner)?.price;
  if (tool === undefined) return undefined;
  const ids = Object.keys({ ...DEFAULT_PRICES, ...owner }).filter((k) => k.startsWith(FAMILY[tool]));
  const chosen = modelForTier(normalizeOffered(ids.map((id) => ({ id, name: id }))), "balanced", owner);
  return chosen === undefined ? undefined : findPrice(chosen, owner)?.price;
}
