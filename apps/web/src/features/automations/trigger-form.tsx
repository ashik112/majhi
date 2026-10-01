import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_SETTLE_SECONDS,
  minPollSeconds,
  type OrgView,
  type TriggerView,
} from "@majhi/shared";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAutomationCommand } from "@/lib/automation-queries";
import { describeError } from "@/lib/errors";
import { ActionFields, actionToDraft, draftToAction, EMPTY_ACTION } from "./action-fields";
import { FormGroup, FormShell } from "./form-shell";
import { draftToWatch, EMPTY_WATCH, pollHint, WatchFields, watchToDraft } from "./watch-fields";

/** Seconds typed in a box: empty is "not set", anything else a whole number of seconds or an error. */
function seconds(text: string): number | undefined | "bad" {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 86_400 ? n : "bad";
}

/** Make a watch trigger, or edit one. */
export function TriggerForm({
  trigger,
  orgs,
  defaultOrg,
  onClose,
}: {
  trigger?: TriggerView | undefined;
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onClose: () => void;
}) {
  const create = useAutomationCommand("triggers.create");
  const update = useAutomationCommand("triggers.update");
  const [name, setName] = useState(trigger?.name ?? "");
  const [org, setOrg] = useState(trigger?.org ?? defaultOrg ?? orgs[0]?.id ?? "private");
  const [watch, setWatch] = useState(() =>
    trigger === undefined ? EMPTY_WATCH : watchToDraft(trigger.watch),
  );
  const [action, setAction] = useState(() =>
    trigger === undefined ? EMPTY_ACTION : actionToDraft(trigger.action),
  );
  const [skip, setSkip] = useState((trigger?.overlap ?? "skip") === "skip");
  const [poll, setPoll] = useState(trigger === undefined ? "" : String(trigger.pollSeconds));
  const [settle, setSettle] = useState(String(trigger?.settleSeconds ?? DEFAULT_SETTLE_SECONDS));
  const [cooldown, setCooldown] = useState(String(trigger?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS));
  const [problem, setProblem] = useState<string>();

  const save = () => {
    setProblem(undefined);
    if (name.trim() === "") return setProblem("Give the trigger a name.");
    const watched = draftToWatch(watch);
    if ("error" in watched) return setProblem(watched.error);
    const built = draftToAction(action);
    if ("error" in built) return setProblem(built.error);
    const pollSeconds = seconds(poll);
    const settleSeconds = seconds(settle);
    const cooldownSeconds = seconds(cooldown);
    if (pollSeconds === "bad" || settleSeconds === "bad" || cooldownSeconds === "bad") {
      return setProblem("Seconds are whole numbers from 0 to 86400.");
    }
    const least = minPollSeconds(watch.kind);
    if (pollSeconds !== undefined && pollSeconds < least) {
      return setProblem(`Check at least every ${least} s for this kind of watch.`);
    }
    const done = { onSuccess: onClose, onError: (e: unknown) => setProblem(describeError(e)) };
    const overlap = skip ? "skip" : "allow";
    const timing = {
      ...(pollSeconds === undefined ? {} : { pollSeconds }),
      ...(settleSeconds === undefined ? {} : { settleSeconds }),
      ...(cooldownSeconds === undefined ? {} : { cooldownSeconds }),
    };
    if (trigger === undefined) {
      create.mutate(
        { org, name: name.trim(), watch: watched.watch, action: built.action, overlap, ...timing },
        done,
      );
      return;
    }
    const watchChanged = JSON.stringify(watched.watch) !== JSON.stringify(trigger.watch);
    update.mutate(
      {
        id: trigger.id,
        name: name.trim(),
        action: built.action,
        overlap,
        ...timing,
        ...(watchChanged ? { watch: watched.watch } : {}),
      },
      done,
    );
  };

  return (
    <FormShell
      title={trigger === undefined ? "New trigger" : `Edit ${trigger.name}`}
      saveLabel={trigger === undefined ? "Create trigger" : "Save"}
      busy={create.isPending || update.isPending}
      problem={problem}
      onSave={save}
      onClose={onClose}
    >
      <FormGroup title="Trigger">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tell the lead when a build fails"
              />
            )}
          </Field>
          <Field label="Org" hint={trigger === undefined ? undefined : "An org cannot change."}>
            {(p) => (
              <Select
                {...p}
                value={org}
                disabled={trigger !== undefined}
                onChange={(e) => {
                  setOrg(e.target.value);
                  setWatch(EMPTY_WATCH);
                  setAction(EMPTY_ACTION);
                }}
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </FormGroup>

      <FormGroup title="What it watches">
        <WatchFields org={org} draft={watch} onChange={setWatch} />
      </FormGroup>

      <FormGroup title="How often it checks">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Check every (s)" hint={pollHint(watch.kind)}>
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                className="font-mono"
                value={poll}
                onChange={(e) => setPoll(e.target.value)}
                placeholder="default"
              />
            )}
          </Field>
          <Field label="Settle (s)" hint="A change must hold this long before it fires.">
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                className="font-mono"
                value={settle}
                onChange={(e) => setSettle(e.target.value)}
              />
            )}
          </Field>
          <Field label="Cooldown (s)" hint="Wait this long after a firing before the next.">
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                className="font-mono"
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
              />
            )}
          </Field>
        </div>
      </FormGroup>

      <FormGroup title="What it does">
        <ActionFields org={org} draft={action} onChange={setAction} eventHelp />
      </FormGroup>

      <FormGroup title="Overlap">
        <Switch label="Skip if the last run is still going" checked={skip} onChange={setSkip} />
      </FormGroup>
    </FormShell>
  );
}
