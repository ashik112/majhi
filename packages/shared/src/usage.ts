import { z } from "zod";

/**
 * Tokens and cost (SPEC 5.8, Phase 2c). majhi records one row per agent turn; every total on
 * Health and usage, in the task view and from `usage.*` is a sum of those rows.
 */

/** The `task` of turns spent by the ACP stand-in answering decisions (5.12). Task ids never look like this. */
export const DECISIONS_TASK = "decisions";

/** Dollars per million tokens. Cache fields are required: providers differ too much to guess them. */
export const PriceSchema = z.strictObject({
  input: z.number().min(0).max(10_000),
  output: z.number().min(0).max(10_000),
  cache_read: z.number().min(0).max(10_000),
  cache_write: z.number().min(0).max(10_000),
});
export type Price = z.infer<typeof PriceSchema>;

/** A price-table key: a model id, or the start of one (`claude-opus-4-8` covers `claude-opus-4-8-20260101`). */
export const PriceKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/, "Use a model id like claude-sonnet-5-5 or gpt-5.5");

/** `prices` in majhi.yaml: the owner's rows, on top of the defaults below. */
export const PricesConfigSchema = z.record(PriceKeySchema, PriceSchema);
export type PricesConfig = z.infer<typeof PricesConfigSchema>;

/** Where a group of default rows comes from, and when it was last compared with that page. */
interface PriceSource {
  url: string;
  /** YYYY-MM-DD */
  checked: string;
}

const ANTHROPIC: PriceSource = {
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  checked: "2026-09-30",
};
const OPENAI: PriceSource = {
  url: "https://developers.openai.com/api/docs/pricing",
  checked: "2026-09-30",
};

/**
 * Default rows, by the page they come from. Anthropic's are first-party API prices with 5-minute
 * cache writes. OpenAI's are standard, short-context rates; `gpt-5.5` has no cache-write price on the
 * page, so its `cache_write` is 0. Both are dollars per million tokens. The owner can change or
 * replace any row in the table.
 */
const DEFAULT_GROUPS: readonly { source: PriceSource; rows: Record<string, Price> }[] = [
  {
    source: ANTHROPIC,
    rows: {
      "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
      "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
      "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
    },
  },
  {
    source: OPENAI,
    rows: {
      "gpt-6-astra": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      "gpt-6-sol": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      "gpt-6-luna": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
      "gpt-5.6-sol": { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
      "gpt-5.6-terra": { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 },
      "gpt-5.6-luna": { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
      "gpt-5.5": { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
    },
  },
];

export const DEFAULT_PRICES: Readonly<Record<string, Price>> = Object.fromEntries(
  DEFAULT_GROUPS.flatMap((g) => Object.entries(g.rows)),
);

/** The page and check date of each default row, by the same keys as `DEFAULT_PRICES`. */
export const DEFAULT_PRICE_SOURCES: Readonly<Record<string, PriceSource>> = Object.fromEntries(
  DEFAULT_GROUPS.flatMap((g) => Object.keys(g.rows).map((key) => [key, g.source])),
);

/** The latest date any default row was checked. */
export const DEFAULT_PRICES_CHECKED =
  DEFAULT_GROUPS.map((g) => g.source.checked)
    .sort()
    .at(-1) ?? "";

/**
 * A model id as the price table sees it: lower case, without a context suffix (`[1m]`) or a
 * provider prefix (`anthropic/`, `anthropic.`).
 */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(anthropic|openai)[./]/, "");
}

/** What may follow a price key in a model id: a date (`-20260101`), `-latest`, or a version pin (`@...`). */
const SNAPSHOT_SUFFIX = /^(-\d{6,8}|-latest|@.+)$/;

/**
 * The row for a model: an exact key, else a key followed only by a snapshot suffix. So
 * `claude-opus-4-8-20260101` uses `claude-opus-4-8`, but a newer `claude-sonnet-5-6` never uses
 * `claude-sonnet-5`. Owner rows win over defaults with the same key.
 */
export function findPrice(
  model: string | undefined,
  owner: PricesConfig = {},
): { key: string; price: Price; source: "owner" | "default" } | undefined {
  if (model === undefined || model.trim() === "") return undefined;
  const id = normalizeModel(model);
  let best: { key: string; price: Price; source: "owner" | "default" } | undefined;
  const consider = (key: string, price: Price, source: "owner" | "default") => {
    const matches = id === key || (id.startsWith(key) && SNAPSHOT_SUFFIX.test(id.slice(key.length)));
    if (!matches) return;
    if (
      best === undefined ||
      key.length > best.key.length ||
      (key.length === best.key.length && source === "owner")
    )
      best = { key, price, source };
  };
  for (const [key, price] of Object.entries(DEFAULT_PRICES)) consider(key, price, "default");
  for (const [key, price] of Object.entries(owner)) consider(key, price, "owner");
  return best;
}

/** Token counts of one turn. Reasoning is part of output where the provider bills it that way, so it is never added twice. */
export interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Dollars for these tokens at this price. */
export function priceTokens(t: TurnTokens, p: Price): number {
  return (
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * p.cache_read +
      t.cacheWriteTokens * p.cache_write) /
    1_000_000
  );
}

/** Everything that counts toward the context and the bill: input, output and both cache kinds. */
export function totalTokens(t: TurnTokens): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/**
 * Where a turn's cost came from. `reported`: the agent reported it (real for API-key accounts,
 * the API equivalent for sign-in accounts). `table`: priced by majhi from the price table.
 * `none`: no cost reported and no price for the model.
 */
export const CostSourceSchema = z.enum(["reported", "table", "none"]);
export type CostSource = z.infer<typeof CostSourceSchema>;

const Count = z.number().int().nonnegative();

export const TurnRowSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  task: z.string(),
  agent: z.string(),
  account: z.string(),
  org: z.string().nullable(),
  project: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  /** Null when no cost was reported and the model has no price. */
  costUsd: z.number().nullable(),
  costSource: CostSourceSchema,
  /** True unless an API-key account reported the cost itself. */
  estimated: z.boolean(),
});
export type TurnRow = z.infer<typeof TurnRowSchema>;

export const UsageTotalsSchema = z.object({
  turns: Count,
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  /** Input, output, cache read and cache write. */
  totalTokens: Count,
  /** Every known cost, real and estimated. */
  costUsd: z.number(),
  /** The part of `costUsd` that is estimated. */
  estimatedUsd: z.number(),
  /** Turns with no cost: no report and no price for their model. */
  unpricedTurns: Count,
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const EMPTY_TOTALS: UsageTotals = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  estimatedUsd: 0,
  unpricedTurns: 0,
};

/** Narrow the rows. Every field is an exact id. */
export const UsageFiltersSchema = z.strictObject({
  org: z.string().trim().min(1).optional(),
  project: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).optional(),
  account: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
});
export type UsageFilters = z.infer<typeof UsageFiltersSchema>;

/** An IANA time zone, like Europe/Berlin. Days, weeks (from Monday) and months follow it. */
export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Use an IANA time zone like Europe/Berlin" },
  );

/** A local day, `YYYY-MM-DD`. */
export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a day like 2026-09-29");

export const UsageRangeSchema = z.enum([
  "today",
  "yesterday",
  "week",
  "last-week",
  "month",
  "last-month",
  "30d",
  "all",
]);
export type UsageRange = z.infer<typeof UsageRangeSchema>;

export const UsageDimensionSchema = z.enum(["org", "project", "agent", "account", "model", "task", "day"]);
export type UsageDimension = z.infer<typeof UsageDimensionSchema>;

export const UsageDaySchema = z.object({
  day: DaySchema,
  costUsd: z.number(),
  estimatedUsd: z.number(),
  totalTokens: Count,
  turns: Count,
});
export type UsageDay = z.infer<typeof UsageDaySchema>;

export const UsageSummarySchema = z.object({
  tz: z.string(),
  today: UsageTotalsSchema,
  week: UsageTotalsSchema,
  month: UsageTotalsSchema,
  all: UsageTotalsSchema,
  /** The last 30 days, today last, including days with nothing. */
  days: z.array(UsageDaySchema),
  /** This month's most expensive tasks, at most 5. */
  topTasks: z.array(
    z.object({
      task: z.string(),
      title: z.string().nullable(),
      org: z.string().nullable(),
      totals: UsageTotalsSchema,
    }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageBreakdownSchema = z.object({
  tz: z.string(),
  /** First and last local day of the range; absent for `all`. */
  from: DaySchema.optional(),
  to: DaySchema.optional(),
  total: UsageTotalsSchema,
  rows: z.array(
    z.object({
      /** The id, the model, or the day. Null for turns without one (a task with no org or project). */
      key: z.string().nullable(),
      /** A readable name: the task title, or the key. */
      label: z.string(),
      totals: UsageTotalsSchema,
    }),
  ),
});
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>;

export const PriceRowSchema = z.object({
  model: z.string(),
  price: PriceSchema,
  source: z.enum(["default", "owner"]),
  /** An owner row with the same key as a default. */
  overridesDefault: z.boolean(),
  /** The page a default row's numbers come from. An owner's row has none: the numbers are theirs. */
  url: z.string().optional(),
  /** When a default row was last compared with that page, YYYY-MM-DD. */
  checked: z.string().optional(),
});
export type PriceRow = z.infer<typeof PriceRowSchema>;
