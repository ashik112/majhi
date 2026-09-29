import type { ApprovalMode, RiskClass, Settings } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import {
  formFromSettings,
  MODE_LABEL,
  POLICY_ROWS,
  patchFromForm,
  type SettingsForm,
} from "@/features/boss/model";
import { useSavePolicy, useSaveSettings, useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

const MODES: readonly ApprovalMode[] = ["auto", "when-asked", "confirm"];

/** Context budget, limits, resume and the approval policy for the boss's commands. */
export function SettingsPanel() {
  const settings = useSettings();
  // Owned here, not in the forms: a save changes the settings, which remounts the forms.
  const save = useSaveSettings();
  const savePolicy = useSavePolicy();
  return (
    <section aria-label="Settings" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold">Settings</h2>
        <span className="text-sm text-fg-faint">Saved to majhi.yaml, as a change you can undo</span>
      </div>
      {settings.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {settings.isError && <p className="text-sm text-red">{describeError(settings.error)}</p>}
      {settings.data && (
        // Remount on a server change so the fields show the saved values.
        <SettingsForms
          key={JSON.stringify(settings.data)}
          settings={settings.data}
          save={save}
          savePolicy={savePolicy}
        />
      )}
    </section>
  );
}

type SaveSettings = ReturnType<typeof useSaveSettings>;
type SavePolicy = ReturnType<typeof useSavePolicy>;

function SettingsForms({
  settings,
  save,
  savePolicy,
}: {
  settings: Settings;
  save: SaveSettings;
  savePolicy: SavePolicy;
}) {
  const toast = useToast();
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(settings));
  const [showErrors, setShowErrors] = useState(false);
  const { patch, errors } = patchFromForm(settings, form);
  const changed = Object.keys(patch).length > 0;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm({ ...form, [key]: value });
  const err = (key: keyof SettingsForm) => (showErrors ? errors[key] : undefined);

  function onSubmit() {
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || !changed) return;
    save.mutate(patch, {
      onSuccess: () => toast("Settings saved"),
      onError: (error) => toast("Could not save settings", { detail: describeError(error), tone: "error" }),
    });
  }

  return (
    <>
      <form
        aria-label="Context and limits"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="flex flex-col gap-3 rounded-[10px] border border-line-strong bg-raised p-3"
      >
        <fieldset className="m-0 grid grid-cols-3 gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-semibold">Context budget</legend>
          <NumberField
            label="Compact at %"
            value={form.compactAt}
            error={err("compactAt")}
            onChange={(v) => set("compactAt", v)}
          />
          <NumberField
            label="Target after %"
            value={form.compactTarget}
            error={err("compactTarget")}
            onChange={(v) => set("compactTarget", v)}
          />
          <NumberField
            label="Fresh after turns"
            value={form.maxTurns}
            error={err("maxTurns")}
            onChange={(v) => set("maxTurns", v)}
          />
        </fieldset>
        <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-semibold">Limits</legend>
          <NumberField
            label="Agents at once"
            value={form.agentsMax}
            error={err("agentsMax")}
            onChange={(v) => set("agentsMax", v)}
          />
          <NumberField
            label="Per account"
            value={form.perAccount}
            error={err("perAccount")}
            onChange={(v) => set("perAccount", v)}
          />
          <NumberField
            label="Per task"
            value={form.perTask}
            error={err("perTask")}
            onChange={(v) => set("perTask", v)}
          />
          <Field label="Stop idle agents after" error={err("idleTimeout")}>
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={form.idleTimeout}
                onChange={(e) => set("idleTimeout", e.target.value)}
              />
            )}
          </Field>
        </fieldset>
        <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-semibold">Teams</legend>
          <NumberField
            label="Agent turns without you"
            value={form.maxAgentTurns}
            error={err("maxAgentTurns")}
            onChange={(v) => set("maxAgentTurns", v)}
          />
          <NumberField
            label="Review rounds"
            value={form.reviewRounds}
            error={err("reviewRounds")}
            onChange={(v) => set("reviewRounds", v)}
          />
        </fieldset>
        <Switch
          label="Resume interrupted runs on their own"
          checked={form.resumeAuto}
          onChange={(v) => set("resumeAuto", v)}
        />
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={!changed || save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
      <PolicyForm settings={settings} save={savePolicy} />
    </>
  );
}

function NumberField({
  label,
  value,
  error,
  onChange,
}: {
  label: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} error={error}>
      {(p) => (
        <Input
          {...p}
          inputMode="numeric"
          className="font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** The approval policy. Changing it is destructive, so saving asks first. */
function PolicyForm({ settings, save }: { settings: Settings; save: SavePolicy }) {
  const toast = useToast();
  const [modes, setModes] = useState<Record<RiskClass, ApprovalMode>>({
    read: settings.policy.read,
    change: settings.policy.change,
    destructive: settings.policy.destructive,
    outbound: settings.policy.outbound,
  });
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const changed = POLICY_ROWS.some((row) => modes[row.key] !== settings.policy[row.key]);
  const overrides = Object.keys(settings.policy.commands).length;

  return (
    <>
      <form
        aria-label="Approval policy"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) setConfirming(true);
        }}
        className="flex flex-col gap-3 rounded-[10px] border border-line-strong bg-raised p-3"
      >
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold">Approval policy</h3>
          <p className="text-xs text-fg-faint text-pretty">
            What the boss may do without a click. Anything not allowed waits for you in the room.
          </p>
        </div>
        {POLICY_ROWS.map((row) => (
          <Field key={row.key} label={row.label} hint={row.hint}>
            {(p) => (
              <Select
                {...p}
                value={modes[row.key]}
                onChange={(e) => setModes({ ...modes, [row.key]: e.target.value as ApprovalMode })}
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ))}
        {overrides > 0 && (
          <p className="text-xs text-fg-faint">
            {overrides} command {overrides === 1 ? "override is" : "overrides are"} set in majhi.yaml.
          </p>
        )}
        <div>
          <Button type="submit" size="sm" disabled={!changed || save.isPending}>
            Change policy
          </Button>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog
          title="Change the approval policy?"
          body="This decides what the boss can do without asking you. It is a destructive change, so it needs your yes."
          confirmLabel="Change policy"
          busy={save.isPending}
          error={problem}
          onCancel={() => {
            setConfirming(false);
            setProblem(undefined);
          }}
          onConfirm={() =>
            save.mutate(modes, {
              onSuccess: () => {
                setConfirming(false);
                toast("Approval policy changed");
              },
              onError: (error) => setProblem(describeError(error)),
            })
          }
        />
      )}
    </>
  );
}
