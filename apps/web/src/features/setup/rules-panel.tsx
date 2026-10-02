import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { AllowancesList, RulesList } from "@/features/rules/rules-list";
import { useSavePolicy, useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

/**
 * What approval cards and the CLIs no longer ask about: the always-allow rules of every agent, the
 * switch that lets a rule cover destructive commands, and the CLI "allow for this task" choices.
 */
export function RulesPanel() {
  const toast = useToast();
  const settings = useSettings();
  const save = useSavePolicy();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const policy = settings.data?.policy;

  function setDestructive(on: boolean) {
    save.mutate(
      { allow_destructive_rules: on },
      {
        onSuccess: () => {
          setConfirming(false);
          toast(on ? "Destructive actions can be auto-approved" : "Destructive actions ask again");
        },
        onError: (error) => setProblem(describeError(error)),
      },
    );
  }

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
            <Switch
              label="Allow auto-approve for destructive actions"
              checked={policy.allow_destructive_rules}
              disabled={save.isPending}
              onChange={(on) => {
                if (on) setConfirming(true);
                else setDestructive(false);
              }}
            />
            <p className="text-xs text-fg-faint text-pretty">
              Off, remove, delete and forget commands always ask, and their cards have no checkbox. Rules
              saved while it was on stop applying.
            </p>
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
      {confirming && (
        <ConfirmDialog
          title="Allow auto-approve for destructive actions?"
          body="Approval cards for remove, delete and forget commands will get the Always allow checkbox. An agent with such a rule can remove things without asking you."
          confirmLabel="Turn on"
          busy={save.isPending}
          error={problem}
          onCancel={() => {
            setConfirming(false);
            setProblem(undefined);
          }}
          onConfirm={() => setDestructive(true)}
        />
      )}
    </section>
  );
}
