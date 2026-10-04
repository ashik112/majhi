import type { Settings } from "@majhi/shared";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageLink } from "@/components/ui/page-link";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Switch } from "@/components/ui/switch";
import {
  formFromSettings,
  patchFromForm,
  type SettingsErrors,
  type SettingsForm,
  type SettingsSwitch,
} from "@/features/boss/model";
import { useSaveSettings } from "@/lib/boss-queries";

const IDLE: SaveState = { kind: "idle" };
const GRID = "grid gap-3 @[480px]:grid-cols-3";

/**
 * One section's draft of the settings form: only the fields it owns, over the saved settings, so a
 * change elsewhere (the captain, an Undo) still shows in the fields it has not touched.
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
  name: Exclude<keyof SettingsForm, SettingsSwitch>;
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
  const resume = useSettingsDraft(settings, ["resumeAuto", "resumeHandoff"]);
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
        <p className="mt-3 text-sm text-fg-muted text-pretty">
          Money limits are on the{" "}
          <PageLink page="limits" className="underline">
            Limits page
          </PageLink>
          : the auto-pilot budget, each workspace's budget, account floors and weekly budgets.
        </p>
      </Section>
      <Section
        title="Resume"
        note="Runs that stopped before they finished, and accounts that ran out"
        draft={resume}
      >
        <Switch
          label="Resume interrupted runs on their own"
          checked={resume.form.resumeAuto}
          onChange={(v) => resume.set("resumeAuto", v)}
        />
        <Switch
          label="Hand off to the fallback agent at a usage limit"
          checked={resume.form.resumeHandoff}
          onChange={(v) => resume.set("resumeHandoff", v)}
        />
      </Section>
      <Section
        title="Commits"
        note="Workspaces and projects can override this. It applies to runs that start after you save."
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

/**
 * Turn limits (PRV-96): a turn over one is cancelled, checkpointed and continued in a fresh session
 * with a handoff note. Each limit has a switch; its value stays while it is off.
 */
export function TurnsSection({ settings }: { settings: Settings }) {
  const turns = useSettingsDraft(settings, [
    "turnLengthOn",
    "turnLength",
    "turnIdleOn",
    "turnIdle",
    "turnToolsOn",
    "turnTools",
  ]);
  const limits = [
    {
      on: "turnLengthOn",
      value: "turnLength",
      label: "Limit turn length",
      field: "Longest turn",
      hint: "Like 2h",
    },
    {
      on: "turnIdleOn",
      value: "turnIdle",
      label: "Stop idle turns",
      field: "Idle after",
      hint: "No output or tool activity, like 25m",
    },
    {
      on: "turnToolsOn",
      value: "turnTools",
      label: "Limit tool calls per turn",
      field: "Tool calls",
      hint: "A whole number",
    },
  ] as const;
  return (
    <Section
      first
      title="Turn limits"
      note="Orgs and agents can override these. They apply from the next turn."
      draft={turns}
    >
      {limits.map((l) => (
        <div key={l.value} className="grid items-end gap-3 @[480px]:grid-cols-[minmax(0,1fr)_200px]">
          <Switch label={l.label} checked={turns.form[l.on]} onChange={(v) => turns.set(l.on, v)} />
          {turns.form[l.on] && <NumberField label={l.field} hint={l.hint} name={l.value} draft={turns} />}
        </div>
      ))}
      <p className="text-sm text-fg-faint text-pretty">
        A turn over a limit is stopped, its work is committed as a checkpoint, and the agent continues in a
        fresh session from a handoff note. Waiting on a background process does not count as idle. A task that
        hits a limit 3 times in a row with no new commits pauses instead.
      </p>
    </Section>
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
