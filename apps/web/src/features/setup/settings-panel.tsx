import type { ApprovalMode, RiskClass, Settings } from "@majhi/shared";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  formFromSettings,
  MODE_LABEL,
  POLICY_ROWS,
  patchFromForm,
  type SettingsErrors,
  type SettingsForm,
} from "@/features/boss/model";
import { useSavePolicy, useSaveSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

const MODES: readonly ApprovalMode[] = ["auto", "when-asked", "confirm"];
const IDLE: SaveState = { kind: "idle" };
const GRID = "grid gap-3 @[520px]:grid-cols-3";

/**
 * One section's draft of the settings form: only the fields it owns, over the saved settings, so a
 * change elsewhere (the boss, an Undo) still shows in the fields it has not touched.
 */
function useSettingsDraft(settings: Settings, keys: readonly (keyof SettingsForm)[]) {
  const save = useSaveSettings();
  const [edits, setEdits] = useState<Partial<SettingsForm>>({});
  const [state, setState] = useState<SaveState>(IDLE);
  const [showErrors, setShowErrors] = useState(false);
  const saved = formFromSettings(settings);
  const form: SettingsForm = { ...saved, ...edits };
  const { patch, errors } = patchFromForm(settings, form);
  const mine: SettingsErrors = {};
  for (const k of keys) if (errors[k] !== undefined) mine[k] = errors[k];
  const dirty = keys.some((k) => form[k] !== saved[k]);
  return {
    form,
    dirty,
    state,
    error: (key: keyof SettingsForm) => (showErrors ? mine[key] : undefined),
    set: <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
      if (state.kind !== "saving") setState(IDLE);
      setEdits((e) => ({ ...e, [key]: value }));
    },
    discard: () => {
      setEdits({});
      setShowErrors(false);
      setState(IDLE);
    },
    submit: () => {
      setShowErrors(true);
      if (Object.keys(mine).length > 0 || !dirty) return;
      setState({ kind: "saving" });
      save.mutate(patch, {
        onSuccess: () => {
          setEdits({});
          setShowErrors(false);
          setState({ kind: "saved" });
        },
        onError: (e) => setState({ kind: "error", message: e.message, details: e.details }),
      });
    },
  };
}

type Draft = ReturnType<typeof useSettingsDraft>;

function Section({
  title,
  note,
  draft,
  first = false,
  children,
}: {
  title: string;
  note: string;
  draft: Draft;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SaveSection
      title={title}
      note={note}
      dirty={draft.dirty}
      state={draft.state}
      onSave={draft.submit}
      onDiscard={draft.discard}
      {...(first ? { className: "border-t-0" } : {})}
    >
      <form
        aria-label={title}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          draft.submit();
        }}
        className="flex max-w-[640px] flex-col gap-3"
      >
        {children}
        <button type="submit" hidden />
      </form>
    </SaveSection>
  );
}

function NumberField({
  label,
  hint,
  name,
  draft,
}: {
  label: string;
  hint?: string;
  name: Exclude<keyof SettingsForm, "resumeAuto">;
  draft: Draft;
}) {
  return (
    <Field label={label} error={draft.error(name)} {...(hint ? { hint } : {})}>
      {(p) => (
        <Input
          {...p}
          inputMode="numeric"
          className="font-mono"
          value={draft.form[name]}
          onChange={(e) => draft.set(name, e.target.value)}
        />
      )}
    </Field>
  );
}

/** Context budget, agent limits and resume: three sections, each saved on its own. */
export function ContextSection({ settings }: { settings: Settings }) {
  const context = useSettingsDraft(settings, ["compactAt", "compactTarget", "maxTurns"]);
  const limits = useSettingsDraft(settings, ["agentsMax", "perAccount", "perTask", "idleTimeout"]);
  const resume = useSettingsDraft(settings, ["resumeAuto"]);
  return (
    <>
      <Section
        first
        title="Context budget"
        note="When an agent's context is compacted, and when it starts fresh"
        draft={context}
      >
        <div className={GRID}>
          <NumberField label="Compact at %" name="compactAt" draft={context} />
          <NumberField label="Target after %" name="compactTarget" draft={context} />
          <NumberField label="Fresh after turns" name="maxTurns" draft={context} />
        </div>
      </Section>
      <Section title="Limits" note="How many agents run at once" draft={limits}>
        <div className="grid gap-3 @[520px]:grid-cols-2">
          <NumberField label="Agents at once" name="agentsMax" draft={limits} />
          <NumberField label="Per account" name="perAccount" draft={limits} />
          <NumberField label="Per task" name="perTask" draft={limits} />
          <Field label="Stop idle agents after" hint="Like 10m or 1h" error={limits.error("idleTimeout")}>
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={limits.form.idleTimeout}
                onChange={(e) => limits.set("idleTimeout", e.target.value)}
              />
            )}
          </Field>
        </div>
      </Section>
      <Section title="Resume" note="Runs that stopped before they finished" draft={resume}>
        <Switch
          label="Resume interrupted runs on their own"
          checked={resume.form.resumeAuto}
          onChange={(v) => resume.set("resumeAuto", v)}
        />
      </Section>
    </>
  );
}

/** How long a team may hand work around without the owner. */
export function TeamsSection({ settings }: { settings: Settings }) {
  const teams = useSettingsDraft(settings, ["maxAgentTurns", "reviewRounds"]);
  return (
    <Section first title="Teams" note="How long agents may pass work between them without you" draft={teams}>
      <div className="grid gap-3 @[520px]:grid-cols-2">
        <NumberField label="Handoffs in a row with no changes" name="maxAgentTurns" draft={teams} />
        <NumberField label="Review rounds" name="reviewRounds" draft={teams} />
      </div>
    </Section>
  );
}

/** The approval policy. Changing it decides what the boss may do alone, so Save asks first. */
export function ApprovalsSection({ settings }: { settings: Settings }) {
  const save = useSavePolicy();
  const saved: Record<RiskClass, ApprovalMode> = {
    read: settings.policy.read,
    change: settings.policy.change,
    destructive: settings.policy.destructive,
    outbound: settings.policy.outbound,
  };
  const [edits, setEdits] = useState<Partial<Record<RiskClass, ApprovalMode>>>({});
  const [state, setState] = useState<SaveState>(IDLE);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const modes = { ...saved, ...edits };
  const dirty = POLICY_ROWS.some((row) => modes[row.key] !== saved[row.key]);
  const overrides = Object.keys(settings.policy.commands).length;

  return (
    <SaveSection
      title="Approval policy"
      note="What the boss may do without a click. Anything else waits for you in the room."
      className="border-t-0"
      dirty={dirty}
      state={state}
      onSave={() => setConfirming(true)}
      onDiscard={() => {
        setEdits({});
        setState(IDLE);
      }}
    >
      <div className="grid max-w-[640px] gap-3 @[520px]:grid-cols-2">
        {POLICY_ROWS.map((row) => (
          <Field key={row.key} label={row.label} hint={row.hint}>
            {(p) => (
              <Select
                {...p}
                value={modes[row.key]}
                onChange={(e) => {
                  setState(IDLE);
                  setEdits({ ...edits, [row.key]: e.target.value as ApprovalMode });
                }}
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
      </div>
      {overrides > 0 && (
        <p className="text-sm text-fg-faint">
          {overrides} command {overrides === 1 ? "override is" : "overrides are"} set in majhi.yaml.
        </p>
      )}
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
          onConfirm={() => {
            setState({ kind: "saving" });
            save.mutate(modes, {
              onSuccess: () => {
                setConfirming(false);
                setEdits({});
                setState({ kind: "saved" });
              },
              onError: (error) => {
                setState(IDLE);
                setProblem(describeError(error));
              },
            });
          }}
        />
      )}
    </SaveSection>
  );
}
