import { DEFAULT_PRICES, findPrice, type Price, type PricesConfig, type ToolId } from "@majhi/shared";

/** The model-id prefix of each tool's models in the price table. */
const FAMILY: Readonly<Record<ToolId, string>> = { claude: "claude-", codex: "gpt-" };

/**
 * What the Housekeeper's model costs per million tokens, for the update's estimate. A model named in
 * settings uses its row. Otherwise the Housekeeper runs the cheapest model its account offers, which this
 * stands for with the cheapest row of that tool's family in the price table (owner rows included).
 * Undefined when there is no row: the estimate then has no dollars.
 */
export function housekeeperPrice(
  model: string | undefined,
  tool: ToolId | undefined,
  owner: PricesConfig,
): Price | undefined {
  if (model !== undefined) return findPrice(model, owner)?.price;
  if (tool === undefined) return undefined;
  const rows = { ...DEFAULT_PRICES, ...owner };
  let best: Price | undefined;
  for (const [key, price] of Object.entries(rows)) {
    if (!key.startsWith(FAMILY[tool])) continue;
    if (best === undefined || price.input + price.output < best.input + best.output) best = price;
  }
  return best;
}
