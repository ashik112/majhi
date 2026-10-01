import {
  type AgentReceipt,
  cacheHitRate,
  EMPTY_TOTALS,
  type ReceiptAgent,
  type ReceiptCompaction,
  type ReceiptContext,
  type ReceiptDecisions,
  type UsageTotals,
} from "@majhi/shared";

/** One row of `usage_events`. */
export interface EventRow {
  at: string;
  agent: string | null;
  kind: "brief" | "memory" | "recall" | "compaction";
  tokens: number | null;
  after_tokens: number | null;
  method: string | null;
}

/** What majhi put into the context: the brief and memory section once, recall results summed. */
export function contextOf(events: readonly EventRow[]): ReceiptContext {
  const sum = (kind: EventRow["kind"]) =>
    events.filter((e) => e.kind === kind).reduce((n, e) => n + (e.tokens ?? 0), 0);
  const briefs = events.filter((e) => e.kind === "brief");
  return {
    briefTokens: briefs.length === 0 ? null : sum("brief"),
    memoryTokens: sum("memory"),
    recallTokens: sum("recall"),
    recalls: events.filter((e) => e.kind === "recall").length,
    estimated: true,
  };
}

const REASONS = new Set(["native", "handoff", "rotation", "fresh", "recovery"]);

/** Compactions oldest first. Only native compaction keeps the session; every other reason is a handoff. */
export function compactionsOf(events: readonly EventRow[]): ReceiptCompaction[] {
  return events
    .filter((e) => e.kind === "compaction" && e.agent !== null && REASONS.has(e.method ?? ""))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => {
      const reason = e.method as ReceiptCompaction["reason"];
      return {
        at: e.at,
        agent: e.agent ?? "",
        method: reason === "native" ? "native" : "handoff",
        reason,
        before: e.tokens,
        after: e.after_tokens,
      };
    });
}

/** A logged decision as stored: its provider and its answers (JSON). */
export interface DecisionRow {
  provider: string;
  answers: string;
}

/**
 * Decisions that replaced an LLM call: answered by a local or hosted provider (not the `acp`
 * stand-in, which spends a model's tokens) with at least one answer the gate accepted. Rows whose
 * answers do not parse count in the total only.
 */
export function decisionsOf(rows: readonly DecisionRow[]): ReceiptDecisions {
  let replaced = 0;
  for (const row of rows) {
    if (row.provider === "acp" || row.provider === "rules") continue;
    try {
      const answers = Object.values(
        JSON.parse(row.answers) as Record<string, { gate?: { accepted?: boolean } }>,
      );
      if (answers.some((a) => a.gate?.accepted === true)) replaced++;
    } catch {
      // A row that does not parse is not counted as saved.
    }
  }
  return { replaced, total: rows.length };
}

/** The per-agent split with each agent's own cache hit rate. */
export function agentsOf(groups: readonly { key: string | null; totals: UsageTotals }[]): ReceiptAgent[] {
  return groups.map((g) => ({
    agent: g.key ?? "unknown",
    totals: g.totals,
    cacheHitRate: cacheHitRate(g.totals),
  }));
}

/** The totals of all groups added up (the task's total when the groups are its agents). */
export function sumTotals(all: readonly UsageTotals[]): UsageTotals {
  const t = { ...EMPTY_TOTALS };
  for (const x of all) {
    t.turns += x.turns;
    t.inputTokens += x.inputTokens;
    t.outputTokens += x.outputTokens;
    t.reasoningTokens += x.reasoningTokens;
    t.cacheReadTokens += x.cacheReadTokens;
    t.cacheWriteTokens += x.cacheWriteTokens;
    t.totalTokens += x.totalTokens;
    t.costUsd = Math.round((t.costUsd + x.costUsd) * 1_000_000) / 1_000_000;
    t.estimatedUsd = Math.round((t.estimatedUsd + x.estimatedUsd) * 1_000_000) / 1_000_000;
    t.unpricedTurns += x.unpricedTurns;
  }
  return t;
}

/** The agent receipt's context part: brief sizes summed over the tasks the agent was briefed in. */
export function agentContext(events: readonly EventRow[]): AgentReceipt["context"] {
  const c = contextOf(events);
  return { ...c, briefTokens: c.briefTokens ?? 0 };
}
