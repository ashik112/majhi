import { type AllowRule, currentRules, RISK_LABEL, type Settings } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { useAllowances, useRemoveRule, useRevokeAllowance } from "@/lib/rule-queries";

/** A rule in words: the kind of action and the workspace it holds in. */
export function ruleLabel(rule: AllowRule): string {
  return `${RISK_LABEL[rule.kind]} in ${rule.org}`;
}

/** Saved Always rules, one per workspace and kind of action, each with Remove. */
export function RulesList({ settings, label }: { settings: Settings; label: string }) {
  const toast = useToast();
  const remove = useRemoveRule();
  const rules = currentRules(settings.policy);
  if (rules.length === 0) return <p className="text-sm text-fg-faint">No rules yet.</p>;
  return (
    <ul aria-label={label} className="-mx-1.5 flex flex-col">
      {rules.map((rule) => (
        <li
          key={`${rule.org} ${rule.kind}`}
          className="flex min-h-8 min-w-0 items-center gap-2 px-1.5 text-sm"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
            <span className="text-fg">{ruleLabel(rule)}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            aria-label={`Remove the rule: ${ruleLabel(rule)}`}
            onClick={() =>
              remove.mutate(rule, {
                onSuccess: () => toast("Rule removed"),
                onError: (error) =>
                  toast("Could not remove the rule", { detail: describeError(error), tone: "error" }),
              })
            }
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The CLI permission prompts remembered as "allow for this task", each with Revoke. */
export function AllowancesList() {
  const toast = useToast();
  const allowances = useAllowances();
  const revoke = useRevokeAllowance();
  if (allowances.isPending) return <p className="text-sm text-fg-faint">Loading</p>;
  if (allowances.isError) return <p className="text-sm text-red">{describeError(allowances.error)}</p>;
  if (allowances.data.length === 0) return <p className="text-sm text-fg-faint">Nothing remembered yet.</p>;
  return (
    <ul aria-label="CLI permissions allowed for a task" className="-mx-1.5 flex flex-col">
      {allowances.data.map((a) => (
        <li key={`${a.task} ${a.kind}`} className="flex min-h-8 min-w-0 items-center gap-2 px-1.5 text-sm">
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
            <span className="font-mono text-fg">{a.kind}</span>
            <span className="min-w-0 truncate text-fg-muted" title={`${a.task}: ${a.title}`}>
              <span className="font-mono text-xs">{a.task}</span> {a.title}
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={revoke.isPending}
            aria-label={`Revoke ${a.kind} for ${a.task}`}
            onClick={() =>
              revoke.mutate(
                { task: a.task, kind: a.kind },
                {
                  onSuccess: () => toast("The CLI will ask again"),
                  onError: (error) =>
                    toast("Could not revoke", { detail: describeError(error), tone: "error" }),
                },
              )
            }
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}
