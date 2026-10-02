import type { Settings } from "@majhi/shared";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Switch } from "@/components/ui/switch";
import {
  formFromSettings,
  patchFromForm,
  type SettingsErrors,
  type SettingsForm,
} from "@/features/boss/model";
import { useSaveSettings } from "@/lib/boss-queries";

const IDLE: SaveState = { kind: "idle" };
const GRID = "grid gap-3 @[480px]:grid-cols-3";

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
  name: Exclude<keyof SettingsForm, "resumeAuto" | "commitsAttribution">;
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

/** Context budget, agent limits, resume and commits: four sections, each saved on its own. */
export function ContextSection({ settings }: { settings: Settings }) {
  const context = useSettingsDraft(settings, ["contextCap", "compactAt", "compactTarget", "maxTurns"]);
  const limits = useSettingsDraft(settings, ["agentsMax", "perAccount", "perTask", "idleTimeout"]);
  const resume = useSettingsDraft(settings, ["resumeAuto"]);
  const commits = useSettingsDraft(settings, ["commitsAttribution"]);
  return (
    <>
      <Section
        first
        title="Context budget"
        note="How much context an agent may use, when it is compacted, and when it starts fresh"
        draft={context}
      >
        <div className={GRID}>
          <NumberField
            label="Context cap (k tokens)"
            hint="0 is no cap: the model's full window. Orgs and agents can set their own."
            name="contextCap"
            draft={context}
          />
          <NumberField label="Compact at %" name="compactAt" draft={context} />
          <NumberField label="Target after %" name="compactTarget" draft={context} />
          <NumberField label="Fresh after turns" name="maxTurns" draft={context} />
        </div>
      </Section>
      <Section title="Limits" note="How many agents run at once" draft={limits}>
        <div className="grid gap-3 @[480px]:grid-cols-2">
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
      <Section
        title="Commits"
        note="Orgs and projects can override this. It applies to runs that start after you save."
        draft={commits}
      >
        <Switch
          label="Agent attribution in commits"
          checked={commits.form.commitsAttribution}
          onChange={(v) => commits.set("commitsAttribution", v)}
        />
        <p className="text-sm text-fg-faint text-pretty">
          Commits keep your identity as the author. The agent becomes the committer and a Majhi-Task line
          links each commit to its task. Off: your identity is both, with no task line.
        </p>
      </Section>
    </>
  );
}

/** How long a team may hand work around without the owner. */
export function TeamsSection({ settings }: { settings: Settings }) {
  const teams = useSettingsDraft(settings, ["maxAgentTurns", "reviewRounds"]);
  return (
    <Section first title="Teams" note="How long agents may pass work between them without you" draft={teams}>
      <div className="grid gap-3 @[480px]:grid-cols-2">
        <NumberField label="Handoffs in a row with no changes" name="maxAgentTurns" draft={teams} />
        <NumberField label="Review rounds" name="reviewRounds" draft={teams} />
      </div>
    </Section>
  );
}
