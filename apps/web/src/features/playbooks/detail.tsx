import {
  type Cadence,
  COST_TIER_LABEL,
  cadenceLabel,
  PLAYBOOK_PACK_LABEL,
  type PlaybookView,
  type QuietHours,
} from "@majhi/shared";
import { ArrowLeft, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { Select, Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { formatAgo, formatTokens } from "@/lib/format";
import { useGoals, usePlaybookRuns, useRunPlaybook, useUpdatePlaybook } from "@/lib/playbook-queries";
import {
  CADENCE_CHOICES,
  cadenceFrom,
  choiceOf,
  formatIn,
  outcomeText,
  RUN_LAMP,
  RUN_WORD,
  WEEKDAYS,
} from "./model";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-base text-fg-soft text-pretty break-words">{children}</dd>
    </div>
  );
}

/** When it runs: the cadence, the time for daily and weekly ones, and the quiet hours. */
function WhenSection({ view }: { view: PlaybookView }) {
  const update = useUpdatePlaybook();
  const toast = useToast();
  const [cadence, setCadence] = useState<Cadence>(view.cadence);
  const [quiet, setQuiet] = useState<QuietHours | undefined>(view.quiet);
  const dirty =
    JSON.stringify(cadence) !== JSON.stringify(view.cadence) ||
    JSON.stringify(quiet ?? null) !== JSON.stringify(view.quiet ?? null);
  const hasEvents = view.playbook.trigger.events.length > 0;
  const choices = CADENCE_CHOICES.filter((c) => c.id !== "events" || hasEvents);
  const save = () =>
    update.mutate(
      { org: view.org, id: view.playbook.id, cadence, quiet: quiet ?? null },
      { onError: (e) => toast("Could not save it", { detail: describeError(e), tone: "error" }) },
    );
  return (
    <DetailSection
      title="When"
      note={hasEvents ? `Also when: ${view.playbook.trigger.events.join("; ")}` : undefined}
      actions={
        dirty && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCadence(view.cadence);
                setQuiet(view.quiet);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={update.isPending} onClick={save}>
              Save
            </Button>
          </>
        )
      }
    >
      <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-3">
        <Field label="Runs">
          {(p) => (
            <Select
              {...p}
              value={choiceOf(cadence)}
              onChange={(e) => setCadence(cadenceFrom(e.target.value, cadence))}
            >
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {cadence.kind === "weekly" && (
          <Field label="On">
            {(p) => (
              <Select
                {...p}
                value={cadence.day}
                onChange={(e) => setCadence({ ...cadence, day: Number(e.target.value) })}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {(cadence.kind === "daily" || cadence.kind === "weekly") && (
          <Field label="From">
            {(p) => (
              <Input
                {...p}
                type="time"
                value={cadence.at}
                onChange={(e) => e.target.value && setCadence({ ...cadence, at: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Switch
          label="Quiet hours"
          checked={quiet !== undefined}
          onChange={(on) => setQuiet(on ? { from: "22:00", to: "07:00" } : undefined)}
        />
        {quiet !== undefined && (
          <>
            <Field label="From">
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  className="w-[120px]"
                  value={quiet.from}
                  onChange={(e) => e.target.value && setQuiet({ ...quiet, from: e.target.value })}
                />
              )}
            </Field>
            <Field label="Until">
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  className="w-[120px]"
                  value={quiet.to}
                  onChange={(e) => e.target.value && setQuiet({ ...quiet, to: e.target.value })}
                />
              )}
            </Field>
          </>
        )}
      </div>
    </DetailSection>
  );
}

/** The owner's values for the playbook's settings, like the URLs of the uptime check. */
function SettingsSection({ view }: { view: PlaybookView }) {
  const update = useUpdatePlaybook();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(view.playbook.settings.map((s) => [s.key, (view.settings[s.key] ?? []).join("\n")])),
  );
  const [problem, setProblem] = useState<string>();
  if (view.playbook.settings.length === 0) return null;
  const changed = view.playbook.settings.some(
    (s) => drafts[s.key] !== (view.settings[s.key] ?? []).join("\n"),
  );
  const save = () => {
    setProblem(undefined);
    const settings = Object.fromEntries(
      view.playbook.settings.map((s) => [
        s.key,
        (drafts[s.key] ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== ""),
      ]),
    );
    update.mutate(
      { org: view.org, id: view.playbook.id, settings },
      { onError: (e) => setProblem(describeError(e)), onSuccess: () => toast("Saved") },
    );
  };
  return (
    <DetailSection
      title="Settings"
      actions={
        changed && (
          <Button size="sm" variant="primary" disabled={update.isPending} onClick={save}>
            Save
          </Button>
        )
      }
    >
      {view.playbook.settings.map((s) => (
        <Field key={s.key} label={s.label} hint={s.hint} error={problem}>
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              value={drafts[s.key] ?? ""}
              onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
            />
          )}
        </Field>
      ))}
    </DetailSection>
  );
}

function GoalSection({ view }: { view: PlaybookView }) {
  const goals = useGoals().data?.goals ?? [];
  const update = useUpdatePlaybook();
  const toast = useToast();
  const choices = goals.filter((g) => g.status === "active" && (g.org === view.org || g.org === "business"));
  return (
    <DetailSection title="Goal" note="What it works toward. Findings it files carry the goal.">
      <Select
        aria-label="Goal"
        value={view.goal ?? ""}
        onChange={(e) =>
          update.mutate(
            { org: view.org, id: view.playbook.id, goal: e.target.value === "" ? null : e.target.value },
            { onError: (err) => toast("Could not link it", { detail: describeError(err), tone: "error" }) },
          )
        }
      >
        <option value="">No goal</option>
        {choices.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </Select>
    </DetailSection>
  );
}

function History({ view, now }: { view: PlaybookView; now: number }) {
  const query = useRunsOf(view);
  const runs = query.data?.runs ?? [];
  return (
    <DetailSection title="History" note={outcomeText(view.counters)}>
      {query.isError ? (
        <p className="m-0 text-sm text-red">Could not load the runs: {describeError(query.error)}</p>
      ) : runs.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">No runs yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {runs.map((r) => (
            <li
              key={r.id}
              className="flex min-w-0 items-baseline gap-2.5 border-t border-line py-1.5 first:border-t-0"
            >
              <Lamp state={RUN_LAMP[r.status]} size={7} className="translate-y-px" />
              <span className="w-[104px] shrink-0 text-sm text-fg-soft">{RUN_WORD[r.status]}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-muted" title={r.note ?? r.trigger}>
                {r.note ?? r.trigger}
              </span>
              <span className="tnum shrink-0 font-mono text-xs text-fg-faint">
                {formatAgo(r.startedAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function useRunsOf(view: PlaybookView) {
  return usePlaybookRuns(view.org, view.playbook.id);
}

/** The selected playbook in full: what it is, when it runs, what it may do, and what came of it. */
export function PlaybookDetail({
  view,
  now,
  onBack,
}: {
  view: PlaybookView;
  now: number;
  onBack: (() => void) | undefined;
}) {
  const { playbook: pb } = view;
  const update = useUpdatePlaybook();
  const run = useRunPlaybook();
  const toast = useToast();
  const locked = pb.needs !== undefined;
  const head = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      {onBack && (
        <Button variant="ghost" size="icon-sm" aria-label="Back to the playbooks" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="m-0 truncate text-lg font-semibold text-fg">{pb.name}</h2>
        <p className="m-0 text-sm text-fg-faint">
          {PLAYBOOK_PACK_LABEL[pb.pack]} · {COST_TIER_LABEL[pb.cost.tier]} · {cadenceLabel(view.cadence)}
        </p>
      </div>
      <Button
        disabled={!view.enabled || run.isPending || view.running}
        title={view.enabled ? "Run it now, whatever its schedule" : "Turn it on first"}
        onClick={() =>
          run.mutate(
            { org: view.org, id: pb.id },
            {
              onSuccess: (r) => toast(r.text),
              onError: (e) => toast("Could not run it", { detail: describeError(e), tone: "error" }),
            },
          )
        }
      >
        <Play aria-hidden="true" />
        Run now
      </Button>
      <Switch
        label={view.enabled ? "On" : "Off"}
        checked={view.enabled}
        disabled={update.isPending || locked}
        title={locked ? pb.needs : undefined}
        onChange={(enabled) =>
          update.mutate(
            { org: view.org, id: pb.id, enabled },
            { onError: (e) => toast("Could not change it", { detail: describeError(e), tone: "error" }) },
          )
        }
      />
    </div>
  );
  return (
    <DetailPane label={pb.name} head={head}>
      <div className="flex flex-col gap-3 pt-4 pb-4">
        <p className="m-0 text-base text-fg text-pretty">{pb.purpose}</p>
        {view.held !== undefined && (
          <p className="m-0 flex items-start gap-2 text-sm text-amber text-pretty">
            <Lamp state="paused" size={7} className="mt-1.5" />
            {view.enabled ? `Held now: ${view.held}` : view.held}
          </p>
        )}
        {!view.enabled && !locked && <p className="m-0 text-sm text-fg-muted text-pretty">{pb.turnOn}</p>}
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 @[560px]:grid-cols-4">
          <Fact label="Last run">{view.lastRun === undefined ? "Never" : formatAgo(view.lastRun, now)}</Fact>
          <Fact label="Next run">
            {view.nextRun !== undefined
              ? formatIn(view.nextRun, now)
              : !view.enabled
                ? "Off"
                : view.held !== undefined
                  ? "Held"
                  : "When something happens"}
          </Fact>
          <Fact label="Budget per run">
            {pb.cost.tokens === 0 ? "No model" : `${formatTokens(pb.cost.tokens)} tokens`}
          </Fact>
          <Fact label="Scope">{pb.scope === "business" ? "The whole business" : "This workspace"}</Fact>
        </dl>
      </div>
      <WhenSection key={JSON.stringify([view.cadence, view.quiet])} view={view} />
      <SettingsSection key={JSON.stringify(view.settings)} view={view} />
      <GoalSection view={view} />
      <DetailSection title="Steps" note="The instruction it follows. Text it reads along the way is data.">
        <p className="m-0 text-base text-fg-soft text-pretty whitespace-pre-wrap">{pb.steps}</p>
        <dl className="m-0 grid grid-cols-1 gap-3 @[560px]:grid-cols-2">
          <Fact label="May read">{pb.inputs.join("; ")}</Fact>
          <Fact label="May produce">{pb.outputs.join(", ")}</Fact>
        </dl>
      </DetailSection>
      <History view={view} now={now} />
    </DetailPane>
  );
}
