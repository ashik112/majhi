import type { BudgetRow } from "@majhi/shared";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/ui/usage-bar";
import { type BudgetChange, useBudgetStatus, useSetBudget } from "@/lib/budget-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatMoney, formatTokens } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { budgetTone, overBudget, parseDollars, parseTokens } from "./budget-model";

const TEXT_TONE = { green: "text-fg-muted", amber: "text-amber", red: "text-red" } as const;

function resets(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** "820k of 1M tokens" or "$16.50 of $20.00", for the number the percent follows. */
function amount(row: BudgetRow): string {
  return row.measure === "tokens"
    ? `${formatTokens(row.used.tokens)} of ${formatTokens(row.budget.tokens ?? 0)} tokens`
    : `${formatMoney(row.used.cost)} of ${formatMoney(row.budget.cost ?? 0)}`;
}

/**
 * Weekly budgets per org and account: a bar for each, amber from 80% and red from 100%, an edit
 * field for each, and a banner when one is over. Budgets are `budgets` in majhi.yaml, set through
 * `settings.set`, and apply at once.
 */
export function BudgetsPanel({ className }: { className?: string }) {
  const status = useBudgetStatus();
  const orgs = useOrgs();
  const accounts = useAccounts();
  const [adding, setAdding] = useState(false);
  const rows = status.data?.rows ?? [];
  const over = overBudget(rows);
  const taken = new Set(rows.map((r) => `${r.scope}:${r.id}`));
  const targets = [
    ...(orgs.data ?? []).map((o) => ({ scope: "org" as const, id: o.id, label: `Org ${o.name}` })),
    ...(accounts.data ?? []).map((a) => ({ scope: "account" as const, id: a.id, label: `Account ${a.id}` })),
  ].filter((t) => !taken.has(`${t.scope}:${t.id}`));

  return (
    <section
      aria-label="Budgets"
      className={cn("flex shrink-0 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      <div className="flex shrink-0 items-center gap-3 px-4 pt-3 pb-1">
        <h2 className="text-base font-semibold">Budgets</h2>
        <span className="text-sm text-fg-faint">per week, from Monday</span>
        {targets.length > 0 && !adding && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding(true)}>
            Add budget
          </Button>
        )}
      </div>
      {over.length > 0 && (
        <p
          role="alert"
          className="mx-4 mt-1 mb-1 flex items-start gap-2 rounded-md bg-red-wash px-3 py-2 text-sm text-red"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {over
              .map((r) =>
                r.paused
                  ? `Paused at budget: ${r.scope} ${r.id} is at ${Math.floor(r.percent)}%, so its runs wait`
                  : `${r.scope} ${r.id} is at ${Math.floor(r.percent)}% of its budget`,
              )
              .join(". ")}
            .
          </span>
        </p>
      )}
      {status.isError ? (
        <p role="alert" className="px-4 py-2 text-base text-red">
          Could not load budgets: {describeError(status.error)}
        </p>
      ) : !status.data ? (
        <div className="px-4 py-2">
          <RowsSkeleton rows={1} height={40} />
        </div>
      ) : (
        <ul className="flex flex-col pb-2">
          {rows.map((row) => (
            <BudgetItem key={`${row.scope}:${row.id}`} row={row} />
          ))}
          {rows.length === 0 && !adding && (
            <li className="px-4 py-1 text-base text-fg-muted">
              No budgets yet. Add one to get an alert at 80% and at 100% of a week's use.
            </li>
          )}
          {adding && (
            <li className="px-4 py-2">
              <BudgetForm targets={targets} onDone={() => setAdding(false)} />
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function BudgetItem({ row }: { row: BudgetRow }) {
  const [editing, setEditing] = useState(false);
  const save = useSetBudget();
  const tone = budgetTone(row.percent);
  return (
    <li className="px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-base font-medium">{row.id}</span>
        <span className="text-sm text-fg-faint">{row.scope}</span>
        <span className={cn("ml-auto shrink-0 font-mono text-base", TEXT_TONE[tone])}>
          {Math.floor(row.percent)}%
        </span>
      </div>
      <UsageBar pct={row.percent} tone={tone} height={6} className="my-1.5" />
      <div className="flex flex-wrap items-center gap-x-3 text-sm text-fg-faint">
        <span>{amount(row)}</span>
        <span>resets {resets(row.resetsAt)}</span>
        {row.paused ? (
          <span className="text-red">Paused at budget</span>
        ) : (
          row.alerts.length > 0 && <span>alert at {row.alerts.map((a) => `${a.threshold}%`).join(", ")}</span>
        )}
        {!editing && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {editing && (
        <div className="pt-2">
          <BudgetForm
            row={row}
            onDone={() => setEditing(false)}
            onRemove={() => {
              save.mutate(
                { scope: row.scope, id: row.id, budget: null },
                { onSuccess: () => setEditing(false) },
              );
            }}
          />
        </div>
      )}
    </li>
  );
}

/** Tokens and cost fields for one budget. Empty means none; at least one is needed. */
function BudgetForm({
  row,
  targets,
  onDone,
  onRemove,
}: {
  row?: BudgetRow;
  targets?: { scope: "org" | "account"; id: string; label: string }[];
  onDone: () => void;
  onRemove?: () => void;
}) {
  const save = useSetBudget();
  const ids = { target: useId(), tokens: useId(), cost: useId() };
  const [target, setTarget] = useState(targets?.[0] ? `${targets[0].scope}:${targets[0].id}` : "");
  const [tokens, setTokens] = useState(row?.budget.tokens === undefined ? "" : String(row.budget.tokens));
  const [cost, setCost] = useState(row?.budget.cost === undefined ? "" : String(row.budget.cost));
  const [problem, setProblem] = useState<string>();

  const submit = () => {
    const t = tokens.trim() === "" ? undefined : parseTokens(tokens);
    const c = cost.trim() === "" ? undefined : parseDollars(cost);
    if (tokens.trim() !== "" && t === undefined) return setProblem("Tokens: use a number like 500k or 2M.");
    if (cost.trim() !== "" && c === undefined) return setProblem("Cost: use dollars, like 25.");
    if (t === undefined && c === undefined) return setProblem("Set tokens, cost or both.");
    const [scope, id] = row ? [row.scope, row.id] : target.split(":");
    if ((scope !== "org" && scope !== "account") || !id) return setProblem("Pick an org or account.");
    const change: BudgetChange = {
      scope,
      id,
      budget: { ...(t === undefined ? {} : { tokens: t }), ...(c === undefined ? {} : { cost: c }) },
    };
    setProblem(undefined);
    save.mutate(change, { onSuccess: onDone });
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!row && targets && (
        <div className="flex min-w-[140px] flex-1 flex-col gap-1">
          <label htmlFor={ids.target} className="text-sm text-fg-faint">
            For
          </label>
          <Select id={ids.target} value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={`${t.scope}:${t.id}`} value={`${t.scope}:${t.id}`}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="flex w-[110px] flex-col gap-1">
        <label htmlFor={ids.tokens} className="text-sm text-fg-faint">
          Tokens
        </label>
        <Input id={ids.tokens} value={tokens} placeholder="2M" onChange={(e) => setTokens(e.target.value)} />
      </div>
      <div className="flex w-[110px] flex-col gap-1">
        <label htmlFor={ids.cost} className="text-sm text-fg-faint">
          Cost, $
        </label>
        <Input id={ids.cost} value={cost} placeholder="25" onChange={(e) => setCost(e.target.value)} />
      </div>
      <Button type="submit" size="md" variant="primary" disabled={save.isPending}>
        Save
      </Button>
      <Button type="button" size="md" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      {onRemove && (
        <Button type="button" size="md" variant="ghost" onClick={onRemove} disabled={save.isPending}>
          Remove
        </Button>
      )}
      {(problem ?? save.error) && (
        <p role="alert" className="w-full text-sm text-red">
          {problem ?? describeError(save.error)}
        </p>
      )}
    </form>
  );
}
