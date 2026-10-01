import type { AgentReceipt, ReceiptContext, ReceiptDecisions, TaskReceipt, UsageTotals } from "@majhi/shared";
import { formatMoney, formatTokens, plural } from "@/lib/format";
import { CostText } from "./cost";

/** "87%", or "Not reported" when the agent sent no cache numbers. */
export function hitRateText(rate: number | null): string {
  return rate === null ? "Not reported" : `${Math.round(rate * 100)}%`;
}

/** "~1.2k tokens": majhi counts characters for what it adds, so the number is an estimate. */
function estimated(tokens: number): string {
  return `~${formatTokens(tokens)} tokens`;
}

function decisionsText(d: ReceiptDecisions): string {
  if (d.total === 0) return "None asked";
  return `${plural(d.replaced, "call")} replaced an LLM call, of ${plural(d.total, "decision")}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-fg [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

function memoryText(c: ReceiptContext): string {
  const section = c.memoryTokens > 0 ? `${estimated(c.memoryTokens)} in TASK.md` : "none in TASK.md";
  return c.recalls > 0
    ? `${section}, ${plural(c.recalls, "recall")} ${estimated(c.recallTokens)}`
    : `${section}, no recalls`;
}

function tokenRows(t: UsageTotals, rate: number | null) {
  return (
    <>
      <Row label="Input">{formatTokens(t.inputTokens)}</Row>
      <Row label="Output">{formatTokens(t.outputTokens)}</Row>
      <Row label="Reasoning">{formatTokens(t.reasoningTokens)}</Row>
      <Row label="Cache read">{formatTokens(t.cacheReadTokens)}</Row>
      <Row label="Cache write">{formatTokens(t.cacheWriteTokens)}</Row>
      <Row label="Cache hit rate">
        <span title="Cache read over input plus cache read">{hitRateText(rate)}</span>
      </Row>
      <Row label="Cost">
        <CostText totals={t} />
      </Row>
    </>
  );
}

const GRID = "m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-base";

/** One task's token receipt, as the Context tab shows it. */
export function TaskReceiptView({ receipt }: { receipt: TaskReceipt }) {
  const { context, totals } = receipt;
  return (
    <div className="flex flex-col gap-4">
      <dl className={GRID}>
        <Row label="Brief at start">
          {context.briefTokens === null ? (
            <span className="text-fg-muted">Not sent yet</span>
          ) : (
            <span title="TASK.md when it was first sent. majhi counts four characters a token.">
              {estimated(context.briefTokens)}
            </span>
          )}
        </Row>
        <Row label="Recalled memory">{memoryText(context)}</Row>
        {tokenRows(totals, receipt.cacheHitRate)}
        <Row label="Decisions">{decisionsText(receipt.decisions)}</Row>
      </dl>

      {receipt.agents.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Tokens and cost per agent</caption>
          <thead>
            <tr className="text-left text-fg-faint">
              <th className="py-1 pr-3 font-normal">Agent</th>
              <th className="py-1 pr-3 text-right font-normal">In</th>
              <th className="py-1 pr-3 text-right font-normal">Out</th>
              <th className="py-1 pr-3 text-right font-normal">Cache hit</th>
              <th className="py-1 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {receipt.agents.map((a) => (
              <tr key={a.agent} className="border-t border-line">
                <td className="py-1 pr-3 font-mono">@{a.agent}</td>
                <td className="tnum py-1 pr-3 text-right">{formatTokens(a.totals.inputTokens)}</td>
                <td className="tnum py-1 pr-3 text-right">{formatTokens(a.totals.outputTokens)}</td>
                <td className="tnum py-1 pr-3 text-right">{hitRateText(a.cacheHitRate)}</td>
                <td className="py-1 text-right">
                  <CostText totals={a.totals} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-fg-faint">Compactions</span>
        {receipt.compactions.length === 0 ? (
          <span className="text-base text-fg-muted">None</span>
        ) : (
          <ul aria-label="Compactions" className="m-0 flex list-none flex-col gap-1 p-0 text-base">
            {receipt.compactions.map((c) => (
              <li key={`${c.at}-${c.agent}`}>
                <span className="font-mono">@{c.agent}</span>{" "}
                {c.before !== null && c.after !== null
                  ? `${formatTokens(c.before)} to ${formatTokens(c.after)} tokens`
                  : c.after !== null
                    ? `to ${formatTokens(c.after)} tokens`
                    : "size not known"}{" "}
                <span className="text-fg-muted">
                  ({c.method}
                  {c.reason === "native" || c.reason === "handoff" ? "" : `, ${c.reason}`})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One agent's receipt across tasks, as the agent drawer shows it. */
export function AgentReceiptView({ receipt, label }: { receipt: AgentReceipt; label: string }) {
  const { totals } = receipt;
  if (totals.turns === 0) {
    return <p className="m-0 text-sm text-fg-muted text-pretty">No turns {label}.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className={`${GRID} !grid-cols-[96px_minmax(0,1fr)] text-sm`}>
        <Row label="Tasks">{receipt.tasks}</Row>
        <Row label="Briefs">{estimated(receipt.context.briefTokens)}</Row>
        <Row label="Recalled">{estimated(receipt.context.recallTokens + receipt.context.memoryTokens)}</Row>
        {tokenRows(totals, receipt.cacheHitRate)}
        <Row label="Compactions">
          {receipt.compactions === 0
            ? "None"
            : `${receipt.compactions} (${receipt.nativeCompactions} native, ${receipt.compactions - receipt.nativeCompactions} handoff)`}
        </Row>
        <Row label="Decisions">{decisionsText(receipt.decisions)}</Row>
      </dl>
      {receipt.topTasks.length > 0 && (
        <ul aria-label="Most expensive tasks" className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
          {receipt.topTasks.slice(0, 5).map((t) => (
            <li key={t.task} className="flex items-baseline gap-2">
              <span className="font-mono text-fg-muted">{t.task}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="tnum shrink-0">{formatMoney(t.totals.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
