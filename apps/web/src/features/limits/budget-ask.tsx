import type { Budget, BudgetAsk } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { useAnswerBudget } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { formatTokens } from "@/lib/format";

/** "$40", "$7.50", "2M tokens", or both. Whole dollars drop the cents. */
export function budgetShort(b: Budget): string {
  const parts: string[] = [];
  if (b.cost !== undefined) parts.push(Number.isInteger(b.cost) ? `$${b.cost}` : `$${b.cost.toFixed(2)}`);
  if (b.tokens !== undefined) parts.push(`${formatTokens(b.tokens)} tokens`);
  return parts.join(" / ");
}

/** Raise to the doubled budget for today, or leave it. */
export function BudgetAskButtons({ ask, compact = false }: { ask: BudgetAsk; compact?: boolean }) {
  const toast = useToast();
  const answer = useAnswerBudget();
  const send = (choice: "raise" | "leave") =>
    answer.mutate(
      { scope: ask.scope, answer: choice },
      {
        onSuccess: () =>
          toast(
            choice === "raise"
              ? `${ask.name}: up to ${budgetShort(ask.raiseTo)} for today`
              : `${ask.name} stays at ${budgetShort(ask.cap)} today`,
          ),
        onError: (error) => toast("Could not answer it", { detail: describeError(error), tone: "error" }),
      },
    );
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={answer.isPending} onClick={() => send("raise")}>
        Raise to {budgetShort(ask.raiseTo)} for today
      </Button>
      <Button
        size="sm"
        variant={compact ? "ghost" : "secondary"}
        disabled={answer.isPending}
        onClick={() => send("leave")}
      >
        Leave it
      </Button>
    </span>
  );
}

/**
 * A budget that ran out while work waits, and the captain's question: raise it for today only, or
 * leave it. The same card sits on the Captain page and on the Limits screen.
 */
export function BudgetAskCard({ ask }: { ask: BudgetAsk }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-line bg-amber-wash px-3 py-2">
      <span className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-sm text-fg-soft">
        <Lamp state="needs" size={7} />
        <span className="min-w-0 text-pretty break-words">{ask.text}</span>
      </span>
      <BudgetAskButtons ask={ask} />
    </div>
  );
}
