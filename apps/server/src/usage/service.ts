import {
  DECISIONS_TASK,
  EMPTY_TOTALS,
  type Price,
  type PriceRow,
  type TurnRow,
  type UsageBreakdown,
  type UsageDay,
  type UsageDimension,
  type UsageFilters,
  type UsageRange,
  type UsageSummary,
  type UsageTotals,
} from "@majhi/shared";
import type { ChangeRecord, ConfigService } from "../config/service.ts";
import { writePrice } from "../config/write.ts";
import { UserError } from "../errors.ts";
import { priceRows, readPrices } from "./prices.ts";
import { addDays, dayBounds, defaultTimeZone, localDay, rangeDays } from "./ranges.ts";
import { addRow, type TurnQuery, type UsageRepo } from "./repo.ts";

export interface UsageServiceDeps {
  repo: UsageRepo;
  config: ConfigService;
  /** Days follow this zone when a caller names none. Default: `TZ`, else the runtime's. */
  defaultTz?: string;
  now?: () => Date;
}

const DAYS_IN_SERIES = 30;
const TOP_TASKS = 5;

/** Reads the `turns` table for Health and usage, the task view and the boss (`usage.*`). */
export class UsageService {
  private readonly defaultTz: string;

  constructor(private readonly deps: UsageServiceDeps) {
    this.defaultTz = deps.defaultTz ?? defaultTimeZone();
  }

  private today(tz: string): string {
    return localDay(this.deps.now?.() ?? new Date(), tz);
  }

  private query(
    filters: UsageFilters,
    span: { from: string; to: string } | undefined,
    tz: string,
  ): TurnQuery {
    if (span === undefined) return { filters };
    const { start, end } = dayBounds(span.from, span.to, tz);
    return { filters, start, end };
  }

  summary(filters: UsageFilters, tzIn?: string): UsageSummary {
    const tz = tzIn ?? this.defaultTz;
    const today = this.today(tz);
    const totals = (range: UsageRange) =>
      this.deps.repo.totals(this.query(filters, rangeDays(range, today), tz));
    const month = rangeDays("month", today);
    const top = this.deps.repo.groups("task", this.query(filters, month, tz), TOP_TASKS);
    return {
      tz,
      today: totals("today"),
      week: totals("week"),
      month: totals("month"),
      all: totals("all"),
      days: this.days(filters, addDays(today, 1 - DAYS_IN_SERIES), today, tz),
      topTasks: top
        .filter((t) => t.key !== null)
        .map((t) => ({
          task: t.key ?? "",
          title: t.title ?? label("task", t.key, null),
          org: t.org,
          totals: t.totals,
        })),
    };
  }

  breakdown(input: {
    by: UsageDimension;
    range: UsageRange;
    from?: string | undefined;
    to?: string | undefined;
    filters: UsageFilters;
    tz?: string | undefined;
    limit: number;
  }): UsageBreakdown {
    const tz = input.tz ?? this.defaultTz;
    let span: { from: string; to: string } | undefined;
    if (input.from !== undefined || input.to !== undefined) {
      if (input.from === undefined || input.to === undefined)
        throw new UserError("Give both from and to, or a range.", 400);
      if (input.from > input.to) throw new UserError("from must not be after to.", 400);
      span = { from: input.from, to: input.to };
    } else span = rangeDays(input.range, this.today(tz));
    const q = this.query(input.filters, span, tz);
    const total = this.deps.repo.totals(q);
    const head = { tz, ...(span === undefined ? {} : { from: span.from, to: span.to }), total };

    if (input.by === "day") {
      const first = span?.from ?? this.firstDay(input.filters, tz);
      if (first === undefined) return { ...head, rows: [] };
      const byDay = this.dayTotals(input.filters, first, span?.to ?? this.today(tz), tz);
      const rows = [...byDay.entries()]
        .filter(([, t]) => t.turns > 0)
        .slice(-input.limit)
        .map(([day, totals]) => ({ key: day, label: day, totals }));
      return { ...head, rows };
    }
    const rows = this.deps.repo.groups(input.by, q, input.limit).map((g) => ({
      key: g.key,
      label: label(input.by, g.key, g.title),
      totals: g.totals,
    }));
    return { ...head, rows };
  }

  turns(filters: UsageFilters, limit: number): TurnRow[] {
    return this.deps.repo.list({ filters }, limit);
  }

  async prices(): Promise<{ checked: string; rows: PriceRow[] }> {
    return priceRows(await readPrices(this.deps.config.file));
  }

  async setPrice(
    model: string,
    price: Price | null,
    change: ChangeRecord,
  ): Promise<{ checked: string; rows: PriceRow[] }> {
    if (price === null && !(model in (await readPrices(this.deps.config.file)))) {
      throw new UserError(`There is no price of yours for ${model} to remove.`, 404);
    }
    await this.deps.config.change(change, () => writePrice(this.deps.config.file, model, price));
    return this.prices();
  }

  /** Totals per local day from `from` to `to`, oldest first, days with nothing included. */
  private dayTotals(filters: UsageFilters, from: string, to: string, tz: string): Map<string, UsageTotals> {
    const out = new Map<string, UsageTotals>();
    for (let d = from; d <= to; d = addDays(d, 1)) out.set(d, { ...EMPTY_TOTALS });
    for (const row of this.deps.repo.forDays(this.query(filters, { from, to }, tz))) {
      const totals = out.get(localDay(row.at, tz));
      if (totals !== undefined) addRow(totals, row);
    }
    return out;
  }

  private days(filters: UsageFilters, from: string, to: string, tz: string): UsageDay[] {
    return [...this.dayTotals(filters, from, to, tz).entries()].map(([day, t]) => ({
      day,
      costUsd: t.costUsd,
      estimatedUsd: t.estimatedUsd,
      totalTokens: t.totalTokens,
      turns: t.turns,
    }));
  }

  /** The local day of the oldest matching turn. */
  private firstDay(filters: UsageFilters, tz: string): string | undefined {
    const at = this.deps.repo.firstAt({ filters });
    return at === undefined ? undefined : localDay(at, tz);
  }
}

/** A row's readable name. */
function label(by: UsageDimension, key: string | null, title: string | null): string {
  if (by === "task" && key === DECISIONS_TASK) return "Decisions by the stand-in agent";
  if (title !== null) return title;
  if (key !== null) return key;
  return by === "org"
    ? "No org"
    : by === "project"
      ? "No project"
      : by === "model"
        ? "Unknown model"
        : "Unknown";
}
