import { AllowancesList, RulesList } from "@/features/rules/rules-list";
import { useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

/**
 * What approval cards and the CLIs no longer ask about: the always-allow rules of every agent and the
 * CLI "allow for this task" choices. Deletes and removals always ask, so no rule covers them.
 */
export function RulesPanel() {
  const settings = useSettings();
  const policy = settings.data?.policy;
  return (
    <section aria-label="Auto-allow" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold">Auto-allow</h2>
        <span className="text-sm text-fg-faint">Saved to majhi.yaml, as a change you can undo</span>
      </div>
      {settings.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {settings.isError && <p className="text-sm text-red">{describeError(settings.error)}</p>}
      {settings.data && policy && (
        <div className="flex flex-col gap-3 rounded-[10px] border border-line-strong bg-card p-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Rules from approval cards</h3>
            <p className="text-xs text-fg-faint text-pretty">
              An agent with a rule runs that command without a card, in the task or workspace the rule names.
            </p>
            <RulesList settings={settings.data} label="Always-allow rules" />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">CLI permissions allowed for a task</h3>
            <p className="text-xs text-fg-faint text-pretty">
              Choices from the agent CLIs' own prompts. Revoke one and the CLI asks again.
            </p>
            <AllowancesList />
          </div>
        </div>
      )}
    </section>
  );
}
