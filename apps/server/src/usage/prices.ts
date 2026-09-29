import { readFile } from "node:fs/promises";
import {
  DEFAULT_PRICES,
  DEFAULT_PRICES_CHECKED,
  type PriceRow,
  type PricesConfig,
  PricesConfigSchema,
} from "@majhi/shared";
import { parseDocument } from "yaml";
import { ConfigConflictError } from "../config/write.ts";
import { errorCode, formatIssues } from "../errors.ts";

/** The owner's rows (`prices` in majhi.yaml). Throws ConfigConflictError when they do not parse. */
export async function readPrices(file: string): Promise<PricesConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return {};
    throw err;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ConfigConflictError(
      "majhi.yaml has YAML errors. Fix them by hand first.",
      doc.errors.map((e) => e.message.split("\n", 1)[0] ?? e.message),
    );
  }
  const raw: unknown = doc.toJS() ?? {};
  const section =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).prices : undefined;
  if (section === undefined || section === null) return {};
  const parsed = PricesConfigSchema.safeParse(section);
  if (!parsed.success) {
    throw new ConfigConflictError("majhi.yaml has an invalid price table.", formatIssues(parsed.error));
  }
  return parsed.data;
}

/** The whole table as `usage.prices` shows it: owner rows first, then the defaults they leave. */
export function priceRows(owner: PricesConfig): { checked: string; rows: PriceRow[] } {
  const rows: PriceRow[] = Object.entries(owner)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, price]) => ({ model, price, source: "owner", overridesDefault: model in DEFAULT_PRICES }));
  for (const [model, price] of Object.entries(DEFAULT_PRICES)) {
    if (!(model in owner)) rows.push({ model, price, source: "default", overridesDefault: false });
  }
  return { checked: DEFAULT_PRICES_CHECKED, rows };
}
