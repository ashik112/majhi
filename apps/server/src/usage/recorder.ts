import type { TurnUsage } from "@majhi/acp";
import {
  type AuthMode,
  type CostSource,
  findPrice,
  type PricesConfig,
  priceTokens,
  type ToolId,
} from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { Store } from "../store/index.ts";
import type { UsageRepo } from "./repo.ts";

/**
 * Who ran the turn. The org and project come from the task. A pseudo task id (`card:acme-api`, a wiki
 * update) has no task row, so a caller that knows the workspace names it here: the spend then counts
 * against that workspace's budget. A real task's own row wins.
 */
export interface TurnContext {
  task: string;
  org?: string | undefined;
  project?: string | undefined;
  agent: string;
  account: string;
  tool: ToolId;
  auth: AuthMode;
  runId?: number | undefined;
}

/**
 * The cost of one turn (Phase 2c):
 * - the agent reported it: that amount. Real for API-key accounts; for sign-in accounts it is the
 *   API price of the same tokens, so it is marked estimated.
 * - else the price table, marked estimated.
 * - else no cost; the turn counts as unpriced.
 */
export function costTurn(
  usage: TurnUsage,
  auth: AuthMode,
  prices: PricesConfig,
): { costUsd: number | null; costSource: CostSource; estimated: boolean } {
  if (usage.costUsd !== undefined) {
    return { costUsd: usage.costUsd, costSource: "reported", estimated: auth !== "api-key" };
  }
  const row = usage.reported ? findPrice(usage.model, prices) : undefined;
  if (row === undefined) return { costUsd: null, costSource: "none", estimated: true };
  return { costUsd: priceTokens(usage, row.price), costSource: "table", estimated: true };
}

export interface RecorderDeps {
  repo: UsageRepo;
  store: Store;
  /** The owner's price rows. A read that fails falls back to the defaults. */
  prices: () => Promise<PricesConfig>;
  /** A turn was written: tell open pages. */
  onRecorded?: () => void;
  /** After the row is written, with who it counts for: the budget check. Its failure is logged, not thrown. */
  afterRecord?: (turn: { org: string | null; account: string; task: string }) => Promise<void>;
  now?: () => Date;
}

/** Writes one `turns` row per finished prompt. Never throws: a lost row must not end a run. */
export class UsageRecorder {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RecorderDeps) {}

  /** Queues the write, so rows land in the order turns finished. */
  record(ctx: TurnContext, usage: TurnUsage): Promise<void> {
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const next = this.pending.then(() => this.write(ctx, usage, at));
    this.pending = next;
    return next;
  }

  /** Resolves when every queued write is done. For tests and shutdown. */
  flush(): Promise<void> {
    return this.pending;
  }

  private async write(ctx: TurnContext, usage: TurnUsage, at: string): Promise<void> {
    try {
      let prices: PricesConfig = {};
      try {
        prices = await this.deps.prices();
      } catch (err) {
        console.error(`Price table unreadable, using the defaults: ${errorMessage(err)}`);
      }
      const task = this.deps.store.tasks.get(ctx.task);
      const cost = costTurn(usage, ctx.auth, prices);
      const org = task?.org ?? ctx.org ?? null;
      this.deps.repo.insert({
        at,
        task: ctx.task,
        agent: ctx.agent,
        account: ctx.account,
        tool: ctx.tool,
        auth: ctx.auth,
        org,
        project: task?.repos[0]?.project ?? ctx.project ?? null,
        runId: ctx.runId ?? null,
        model: usage.model ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        ...cost,
      });
      this.deps.onRecorded?.();
      await this.deps.afterRecord?.({ org, account: ctx.account, task: ctx.task });
    } catch (err) {
      console.error(`Could not record a turn of ${ctx.agent} in ${ctx.task}: ${errorMessage(err)}`);
    }
  }
}
