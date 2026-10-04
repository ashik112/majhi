import {
  type ClockAction,
  clockPlaybookSpec,
  cronProblem,
  nextRunAfter,
  type PlaybookView,
  parseSchedulePhrase,
  type ScheduleSpec,
  upcomingRuns,
} from "@majhi/shared";
import { useMemo, useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ActionFields, actionToDraft, draftToAction, EMPTY_ACTION } from "@/features/actions/action-fields";
import { FormGroup, FormShell } from "@/features/actions/form-shell";
import { BROWSER_ZONE, formatInZone, specToPhrase, yourTime, zoneOptions } from "@/features/actions/model";
import { describeError } from "@/lib/errors";
import { useCreatePlaybook, useUpdatePlaybook } from "@/lib/playbook-queries";

type Mode = "phrase" | "cron" | "once";

const MODES = [
  { value: "phrase", label: "In words" },
  { value: "cron", label: "Cron" },
  { value: "once", label: "Once" },
] as const;

interface WhenState {
  mode: Mode;
  phrase: string;
  cron: string;
  once: string;
}

function whenOf(spec: ScheduleSpec | undefined): WhenState {
  const blank: WhenState = { mode: "phrase", phrase: "", cron: "0 9 * * 1-5", once: "" };
  if (spec === undefined) return blank;
  if (spec.kind === "once") return { ...blank, mode: "once", once: spec.at.slice(0, 16) };
  const phrase = specToPhrase(spec);
  if (phrase !== undefined) return { ...blank, phrase };
  return { ...blank, mode: "cron", cron: spec.kind === "cron" ? spec.expression : blank.cron };
}

/** The spec the form holds, or why it is not one yet. */
function specOf(when: WhenState, zone: string): { spec: ScheduleSpec } | { error: string } | undefined {
  if (when.mode === "phrase") {
    if (when.phrase.trim() === "") return undefined;
    const parsed = parseSchedulePhrase(when.phrase);
    return parsed.ok ? { spec: parsed.spec } : { error: parsed.error };
  }
  if (when.mode === "cron") {
    const problem = cronProblem(when.cron);
    return problem === undefined
      ? { spec: { kind: "cron", expression: when.cron.trim().split(/\s+/).join(" ") } }
      : { error: problem };
  }
  if (when.once === "") return undefined;
  const spec: ScheduleSpec = { kind: "once", at: when.once };
  return nextRunAfter(spec, zone, new Date()) === undefined
    ? { error: "That time has already passed." }
    : { spec };
}

/**
 * Make a playbook that runs an action on a clock (start a task, post in a room, run a process), or
 * edit one. Majhi's own code runs it, no model. The time zone defaults to the browser's.
 */
export function ClockForm({
  org,
  view,
  onClose,
  onDone,
}: {
  org: string;
  /** Editing: the clock playbook. */
  view?: PlaybookView | undefined;
  onClose: () => void;
  onDone?: ((id: string) => void) | undefined;
}) {
  const create = useCreatePlaybook();
  const update = useUpdatePlaybook();
  const clock = view?.clock;
  const [name, setName] = useState(view?.playbook.name ?? "");
  const [zone, setZone] = useState(clock?.timeZone ?? BROWSER_ZONE);
  const [when, setWhen] = useState(() => whenOf(clock?.when));
  const [action, setAction] = useState(() =>
    clock === undefined ? EMPTY_ACTION : actionToDraft(clock.action),
  );
  const [skip, setSkip] = useState((clock?.overlap ?? "skip") === "skip");
  const [problem, setProblem] = useState<string>();

  const zones = useMemo(() => zoneOptions(clock?.timeZone), [clock?.timeZone]);
  const read = specOf(when, zone);
  const preview = read !== undefined && "spec" in read ? upcomingRuns(read.spec, zone, new Date(), 3) : [];

  const save = () => {
    setProblem(undefined);
    if (name.trim() === "") return setProblem("Give it a name.");
    if (read === undefined) return setProblem("Say when it runs.");
    if ("error" in read) return setProblem(read.error);
    const built = draftToAction(action);
    if ("error" in built) return setProblem(built.error);
    const overlap = skip ? "skip" : "allow";
    const fail = (e: unknown) => setProblem(describeError(e));
    if (view === undefined) {
      const next: ClockAction = { org, when: read.spec, timeZone: zone, action: built.action, overlap };
      create.mutate(
        { org, spec: clockPlaybookSpec(name.trim(), next) },
        {
          onSuccess: (r) => {
            onDone?.(r.playbook.id);
            onClose();
          },
          onError: fail,
        },
      );
      return;
    }
    const timeChanged = zone !== clock?.timeZone || JSON.stringify(read.spec) !== JSON.stringify(clock?.when);
    update.mutate(
      {
        org: view.org,
        id: view.playbook.id,
        clock: {
          name: name.trim(),
          action: built.action,
          overlap,
          ...(timeChanged ? { spec: read.spec, timeZone: zone } : {}),
        },
      },
      { onSuccess: onClose, onError: fail },
    );
  };

  return (
    <FormShell
      title={view === undefined ? "Run an action on a schedule" : `Edit ${view.playbook.name}`}
      saveLabel={view === undefined ? "Create" : "Save"}
      busy={create.isPending || update.isPending}
      problem={problem}
      onSave={save}
      onClose={onClose}
    >
      <FormGroup title="Name">
        <Field label="Name">
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly check"
            />
          )}
        </Field>
      </FormGroup>

      <FormGroup title="When">
        <Segmented
          label="How to say when"
          value={when.mode}
          segments={MODES}
          onChange={(mode) => setWhen({ ...when, mode })}
          className="self-start"
        />
        {when.mode === "phrase" && (
          <Field
            label="Phrase"
            error={read !== undefined && "error" in read ? read.error : undefined}
            hint='Like "every 30 minutes", "daily at 18:30", "weekdays at 9:00" or "mondays at 9:00".'
          >
            {(p) => (
              <Input
                {...p}
                value={when.phrase}
                onChange={(e) => setWhen({ ...when, phrase: e.target.value })}
                placeholder="weekdays at 9:00"
              />
            )}
          </Field>
        )}
        {when.mode === "cron" && (
          <Field
            label="Cron expression"
            error={read !== undefined && "error" in read ? read.error : undefined}
            hint="Five fields: minute hour day-of-month month day-of-week."
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={when.cron}
                onChange={(e) => setWhen({ ...when, cron: e.target.value })}
                placeholder="0 9 * * 1-5"
              />
            )}
          </Field>
        )}
        {when.mode === "once" && (
          <Field
            label="Date and time"
            error={read !== undefined && "error" in read ? read.error : undefined}
            hint="On the clock of the time zone below."
          >
            {(p) => (
              <Input
                {...p}
                type="datetime-local"
                value={when.once}
                onChange={(e) => setWhen({ ...when, once: e.target.value })}
              />
            )}
          </Field>
        )}
        <Field
          label="Time zone"
          hint="It runs on this zone's clock, including its clock changes. New ones start on your browser's zone."
        >
          {(p) => (
            <Select {...p} value={zone} onChange={(e) => setZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                  {z === BROWSER_ZONE ? " (this browser)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div
          aria-live="polite"
          className="flex flex-col gap-1 rounded-md border border-line-strong bg-sunken px-3 py-2.5"
        >
          <span className="text-sm text-fg-faint">Next runs</span>
          {preview.length === 0 ? (
            <span className="text-sm text-fg-faint">Nothing to show yet.</span>
          ) : (
            preview.map((d) => {
              const iso = d.toISOString();
              const local = yourTime(iso, zone);
              return (
                <span key={iso} className="tnum text-sm text-fg">
                  {formatInZone(iso, zone)}
                  {local !== undefined && <span className="text-fg-faint"> · your time {local}</span>}
                </span>
              );
            })
          )}
        </div>
      </FormGroup>

      <FormGroup title="What it does">
        <ActionFields org={org} draft={action} onChange={setAction} />
      </FormGroup>

      <FormGroup title="Overlap">
        <Switch label="Skip if the last run is still going" checked={skip} onChange={setSkip} />
        <p className="text-sm text-fg-faint text-pretty">
          A started task counts as going until it is done or waiting for you. A command counts while it runs.
          With this off, runs may overlap.
        </p>
      </FormGroup>
    </FormShell>
  );
}
