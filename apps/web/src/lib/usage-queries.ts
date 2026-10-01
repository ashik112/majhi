import type {
  CommandInput,
  CommandOutput,
  UsageBreakdown,
  UsageDimension,
  UsageFilters,
  UsageRange,
  UsageSummary,
} from "@majhi/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The browser's time zone, so today, this week and this month are the owner's own. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The filters without empty fields, so equal filters give equal query keys. */
export function cleanFilters(filters: UsageFilters): UsageFilters {
  const out: UsageFilters = {};
  for (const key of ["org", "project", "agent", "account", "model", "task"] as const) {
    const value = filters[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/** Today, this week, this month, all time, the last 30 days and this month's top tasks. */
export function useUsageSummary(filters: UsageFilters = {}, enabled = true) {
  const clean = cleanFilters(filters);
  const tz = localTimeZone();
  return useQuery<UsageSummary, ApiRequestError>({
    queryKey: [...queryKeys.usage, "summary", clean, tz],
    queryFn: () => cmd("usage.summary", { filters: clean, tz }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export interface BreakdownQuery {
  by: UsageDimension;
  range?: UsageRange;
  filters?: UsageFilters;
  limit?: number;
}

/** Totals grouped by one dimension, for a range (default this month). */
export function useUsageBreakdown(
  { by, range = "month", filters = {}, limit = 50 }: BreakdownQuery,
  enabled = true,
) {
  const clean = cleanFilters(filters);
  const tz = localTimeZone();
  return useQuery<UsageBreakdown, ApiRequestError>({
    queryKey: [...queryKeys.usage, "breakdown", by, range, clean, limit, tz],
    queryFn: () => cmd("usage.breakdown", { by, range, filters: clean, limit, tz }),
    enabled,
  });
}

/** The recorded turns behind the totals, newest first. */
export function useUsageTurns(filters: UsageFilters = {}, limit = 50, enabled = true) {
  const clean = cleanFilters(filters);
  return useQuery<CommandOutput<"usage.turns">, ApiRequestError>({
    queryKey: [...queryKeys.usage, "turns", clean, limit],
    queryFn: () => cmd("usage.turns", { filters: clean, limit }),
    enabled,
  });
}

/** Where one task's tokens went (SPEC 5.9): the token receipt. */
export function useTaskReceipt(task: string) {
  return useQuery<CommandOutput<"usage.receipt">, ApiRequestError>({
    queryKey: [...queryKeys.usage, "receipt", task],
    queryFn: () => cmd("usage.receipt", { task }),
  });
}

/** Where one agent's tokens went across tasks in a range. */
export function useAgentReceipt(agent: string, range: UsageRange = "month") {
  const tz = localTimeZone();
  return useQuery<CommandOutput<"usage.agentReceipt">, ApiRequestError>({
    queryKey: [...queryKeys.usage, "agent-receipt", agent, range, tz],
    queryFn: () => cmd("usage.agentReceipt", { agent, range, tz }),
  });
}

const pricesKey = [...queryKeys.usage, "prices"] as const;

/** The price table: majhi's defaults and the owner's rows. */
export function useUsagePrices(enabled = true) {
  return useQuery<CommandOutput<"usage.prices">, ApiRequestError>({
    queryKey: pricesKey,
    queryFn: () => cmd("usage.prices", {}),
    enabled,
  });
}

/** Sets a model's price, or removes the owner's row with `price: null`. */
export function useSetPrice() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"usage.setPrice">, ApiRequestError, CommandInput<"usage.setPrice">>({
    mutationFn: (input) =>
      cmd("usage.setPrice", input, {
        reason:
          input.price === null
            ? `Owner removed their price for ${input.model}`
            : `Owner set the price for ${input.model}`,
      }),
    onSuccess: async (table) => {
      client.setQueryData(pricesKey, table);
      await client.invalidateQueries({
        queryKey: queryKeys.usage,
        predicate: (q) => q.queryKey[1] !== "prices",
      });
    },
  });
}
