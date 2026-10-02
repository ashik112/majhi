import { type AllowRule, commandLabel, isDestructiveCommand, type Settings } from "@majhi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { useAllowances, useRemoveRule, useRevokeAllowance } from "@/lib/rule-queries";

/** Where a rule applies, in words. */
export function scopeLabel(rule: AllowRule): string {
  return rule.task === undefined ? `every task in ${rule.org}` : `task ${rule.task}`;
}

/** A rule saved while the toggle was on stays saved, but does not apply once it is off. */
export function ruleIsOff(rule: AllowRule, policy: Settings["policy"]): boolean {
  return isDestructiveCommand(rule.command) && !policy.allow_destructive_rules;
}

/**
 * Saved always-allow rules, each with Remove. On an agent's page `agent` narrows the list to its
 * rules and leaves out the handle; in Hub setup it shows them all.
 */
export function RulesList({ settings, agent, label }: { settings: Settings; agent?: string; label: string }) {
  const toast = useToast();
  const remove = useRemoveRule();
  const rules = settings.policy.rules.filter((rule) => agent === undefined || rule.agent === agent);
  if (rules.length === 0) return <p className="text-sm text-fg-faint">No rules yet.</p>;
  return (
    <ul aria-label={label} className="-mx-1.5 flex flex-col">
      {rules.map((rule) => (
        <li
          key={`${rule.agent} ${rule.command} ${rule.task ?? rule.org}`}
          className="flex min-h-8 min-w-0 items-center gap-2 px-1.5 text-sm"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
            {agent === undefined && <span className="font-mono text-fg-soft">@{rule.agent}</span>}
            <span className="text-fg">{commandLabel(rule.command)}</span>
            <span className="font-mono text-xs text-fg-faint">{rule.command}</span>
            <span className="text-fg-muted">{scopeLabel(rule)}</span>
          </span>
          {ruleIsOff(rule, settings.policy) && (
            <Badge
              tone="amber"
              title="Destructive commands are off in Hub setup, so this rule does not apply"
            >
              Off
            </Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            aria-label={`Remove the rule for @${rule.agent} to run ${rule.command}, ${scopeLabel(rule)}`}
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
