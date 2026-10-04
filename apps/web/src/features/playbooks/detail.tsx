import { type Cadence, cadenceLabel, type PlaybookView, type QuietHours } from "@majhi/shared";
import { ArrowLeft, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { Select, Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useCaptainUndo } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { formatTokens } from "@/lib/format";
import {
  useGoals,
  usePlaybookActivity,
  usePlaybooksAcross,
  useRemovePlaybook,
  useRunPlaybook,
  useUpdatePlaybook,
} from "@/lib/playbook-queries";
import { CadenceFields } from "./cadence-fields";
import { KIND_LABEL, kindOf, LIMIT_CHOICES, shortWhen } from "./model";

/** One setting: its label on the left, its control on the right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-x-4 gap-y-1 @[560px]:grid-cols-[130px_minmax(0,1fr)]">
      <div className="pt-[7px] text-sm text-fg-faint">{label}</div>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {hint && <p className="m-0 text-xs text-fg-faint text-pretty">{hint}</p>}
      </div>
    </div>
  );
}

/** Which workspaces it is on in: one chip each, a click switches it there. */
function Workspaces({
  view,
  workspaces,
}: {
  view: PlaybookView;
  workspaces: readonly { id: string; name: string }[];
}) {
  const lists = usePlaybooksAcross(workspaces.map((w) => w.id));
  const update = useUpdatePlaybook();
  const toast = useToast();
  if (view.playbook.scope === "business")
    return <p className="m-0 pt-[7px] text-base text-fg-soft">The whole business, from Private</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {workspaces.map((w, i) => {
        const on =
          lists[i]?.data?.playbooks.find((p) => p.playbook.id === view.playbook.id)?.enabled ?? false;
        return (
          <ChoiceChip
            key={w.id}
            className="min-h-7 max-w-[170px] px-2.5 text-xs"
            pressed={on}
            disabled={update.isPending || view.playbook.needs !== undefined}
            onClick={() =>
              update.mutate(
                { org: w.id, id: view.playbook.id, enabled: !on },
                { onError: (e) => toast("Could not change it", { detail: describeError(e), tone: "error" }) },
              )
            }
          >
            <span className="min-w-0 truncate">{w.name}</span>
          </ChoiceChip>
        );
      })}
    </div>
  );
}

function QuietRow({ view }: { view: PlaybookView }) {
  const update = useUpdatePlaybook();
  const toast = useToast();
  const [quiet, setQuiet] = useState<QuietHours | undefined>(view.quiet);
  const save = (next: QuietHours | undefined) =>
    update.mutate(
      { org: view.org, id: view.playbook.id, quiet: next ?? null },
      { onError: (e) => toast("Could not save it", { detail: describeError(e), tone: "error" }) },
    );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch
        label={quiet === undefined ? "Off" : "On"}
        checked={quiet !== undefined}
        onChange={(on) => {
          const next = on ? { from: "22:00", to: "07:00" } : undefined;
          setQuiet(next);
          save(next);
        }}
      />
      {quiet !== undefined && (
        <>
          <Input
            aria-label="Quiet from"
            type="time"
            className="w-[120px]"
            value={quiet.from}
            onChange={(e) => e.target.value && setQuiet({ ...quiet, from: e.target.value })}
            onBlur={() => save(quiet)}
          />
          <span className="text-sm text-fg-faint">until</span>
          <Input
            aria-label="Quiet until"
            type="time"
            className="w-[120px]"
            value={quiet.to}
            onChange={(e) => e.target.value && setQuiet({ ...quiet, to: e.target.value })}
            onBlur={() => save(quiet)}
          />
        </>
      )}
    </div>
  );
}

function GoalRow({ view }: { view: PlaybookView }) {
  const goals = useGoals().data?.goals ?? [];
  const update = useUpdatePlaybook();
  const toast = useToast();
  const choices = goals.filter((g) => g.status === "active" && (g.org === view.org || g.org === "business"));
  return (
    <Select
      aria-label="Goal"
      className="w-[260px] max-w-full"
      value={view.goal ?? ""}
      onChange={(e) =>
        update.mutate(
          { org: view.org, id: view.playbook.id, goal: e.target.value === "" ? null : e.target.value },
          { onError: (err) => toast("Could not link it", { detail: describeError(err), tone: "error" }) },
        )
      }
    >
      <option value="">None</option>
      {choices.map((g) => (
        <option key={g.id} value={g.id}>
          {g.title}
        </option>
      ))}
    </Select>
  );
}

/** The owner's text settings, like the feed addresses of a watch: one value per line, saved together. */
function TextSettings({ view }: { view: PlaybookView }) {
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
    <>
      {view.playbook.settings.map((s) => (
        <Row key={s.key} label={s.label}>
          <Field label={s.label} hint={s.hint} error={problem} className="[&>label]:sr-only">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={drafts[s.key] ?? ""}
                onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
              />
            )}
          </Field>
        </Row>
      ))}
      {changed && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" disabled={update.isPending} onClick={save}>
            Save
          </Button>
        </div>
      )}
    </>
  );
}

/** What it does when it finds something: each rule has a switch, and "Or do this" is what the captain does after a run. */
function Outcomes({ view }: { view: PlaybookView }) {
  const update = useUpdatePlaybook();
  const toast = useToast();
  const [orDo, setOrDo] = useState(view.orDo ?? "");
  const fail = (e: unknown) => toast("Could not save it", { detail: describeError(e), tone: "error" });
  return (
    <DetailSection title="When it finds something">
      {view.outcomes.length === 0 && (
        <p className="m-0 text-base text-fg-soft text-pretty">
          {view.playbook.outputs.includes("finding")
            ? "It files what it finds in Needs you."
            : view.playbook.outputs.includes("draft")
              ? "Its drafts wait in Needs you. Nothing is sent without you."
              : "It writes what it did in the captain's log."}
        </p>
      )}
      {view.outcomes.map((o) => (
        <Switch
          key={o.id}
          label={o.text}
          checked={o.on}
          disabled={update.isPending}
          onChange={(on) =>
            update.mutate(
              { org: view.org, id: view.playbook.id, outcomes: { [o.id]: on } },
              { onError: fail },
            )
          }
        />
      ))}
      <div className="flex items-center gap-2.5">
        <label htmlFor={`ordo-${view.playbook.id}`} className="shrink-0 text-sm text-fg-soft">
          Or do this
        </label>
        <Input
          id={`ordo-${view.playbook.id}`}
          value={orDo}
          maxLength={500}
          placeholder="Like: post what shipped in the team chat"
          onChange={(e) => setOrDo(e.target.value)}
          onBlur={() => {
            if (orDo.trim() !== (view.orDo ?? "")) {
              update.mutate(
                { org: view.org, id: view.playbook.id, orDo: orDo.trim() === "" ? null : orDo.trim() },
                { onError: fail },
              );
            }
          }}
        />
      </div>
    </DetailSection>
  );
}

function LastRuns({ view, now }: { view: PlaybookView; now: number }) {
  const query = usePlaybookActivity(view.org, view.playbook.id);
  const undo = useCaptainUndo();
  const toast = useToast();
  const runs = query.data?.runs ?? [];
  const week = query.data?.week;
  return (
    <>
      <DetailSection title="Last runs">
        {query.isError ? (
          <p className="m-0 text-sm text-red">Could not load the runs: {describeError(query.error)}</p>
        ) : runs.length === 0 ? (
          <p className="m-0 text-base text-fg-muted">Has not run yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {runs.map((r) => (
              <li
                key={r.at}
                className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line py-1.5 first:border-t-0"
              >
                <span className="tnum w-[84px] shrink-0 font-mono text-xs text-fg-faint">
                  {shortWhen(r.at, now)}
                </span>
                <span
                  className={`min-w-0 flex-1 text-base text-pretty ${r.bad ? "text-amber" : "text-fg-soft"}`}
                >
                  {r.text}
                </span>
                {r.undo.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    title={u.text}
                    disabled={undo.isPending}
                    className="shrink-0 cursor-pointer text-sm text-accent-text hover:underline disabled:opacity-50"
                    onClick={() =>
                      undo.mutate(
                        { id: u.id },
                        {
                          onSuccess: (r2) => toast("Undone", { detail: r2.detail }),
                          onError: (e) =>
                            toast("Could not undo it", { detail: describeError(e), tone: "error" }),
                        },
                      )
                    }
                  >
                    Undo{r.undo.length > 1 ? ` ${u.text.slice(0, 24)}` : ""}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      {week !== undefined && (
        <DetailSection title="This week">
          <p className="m-0 text-base text-fg-soft">
            {week.runs} {week.runs === 1 ? "run" : "runs"} · {week.results}{" "}
            {week.results === 1 ? "result" : "results"} · you undid {week.undone} ·{" "}
            {week.tokens === 0 ? "no model used" : `${formatTokens(week.tokens)} tokens`}
          </p>
        </DetailSection>
      )}
    </>
  );
}

/** The selected playbook: what it does, when it runs, what happens when it finds something, and its last runs. */
export function PlaybookDetail({
  view,
  now,
  workspaces,
  onBack,
  onGone,
}: {
  view: PlaybookView;
  now: number;
  workspaces: readonly { id: string; name: string }[];
  onBack: (() => void) | undefined;
  onGone: () => void;
}) {
  const { playbook: pb } = view;
  const update = useUpdatePlaybook();
  const run = useRunPlaybook();
  const remove = useRemovePlaybook();
  const toast = useToast();
  const locked = pb.needs !== undefined;
  const [cadence, setCadence] = useState<Cadence>(view.cadence);
  const saveCadence = (next: Cadence) => {
    if (JSON.stringify(next) === JSON.stringify(view.cadence)) return;
    update.mutate(
      { org: view.org, id: pb.id, cadence: next },
      { onError: (e) => toast("Could not save it", { detail: describeError(e), tone: "error" }) },
    );
  };
  const limitUnit = pb.runner.kind === "chore" && view.dailyLimit !== undefined ? "a day" : "";
  const choices = [
    ...new Set([...(view.dailyLimit == null ? [] : [view.dailyLimit]), ...LIMIT_CHOICES]),
  ].sort((a, b) => a - b);
  const head = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      {onBack && (
        <Button variant="ghost" size="icon-sm" aria-label="Back to the playbooks" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
      )}
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
      <span className="text-sm text-fg-faint">{KIND_LABEL[kindOf(pb.pack)]}</span>
      <div className="ml-auto flex items-center gap-2">
        {pb.custom === true && (
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(
                { org: view.org, id: pb.id },
                {
                  onSuccess: onGone,
                  onError: (e) => toast("Could not delete it", { detail: describeError(e), tone: "error" }),
                },
              )
            }
          >
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        )}
        <Button
          size="sm"
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
      </div>
    </div>
  );
  return (
    <DetailPane label={pb.name} head={head}>
      <div className="flex flex-col gap-2 pt-4 pb-4">
        <h2 className="m-0 text-lg font-semibold text-fg">{pb.name}</h2>
        <p className="m-0 text-base text-fg-soft text-pretty">{pb.purpose}</p>
        {view.held !== undefined && (
          <p className="m-0 text-sm text-amber text-pretty">
            {view.enabled ? `Held now: ${view.held}` : view.held}
          </p>
        )}
        {!view.enabled && !locked && <p className="m-0 text-sm text-fg-muted text-pretty">{pb.turnOn}</p>}
      </div>
      <div className="flex flex-col gap-3 pb-5">
        <Row
          label="Runs"
          hint={
            pb.trigger.events.length > 0
              ? `Also when: ${pb.trigger.events.join("; ").toLowerCase()}`
              : undefined
          }
        >
          <CadenceFields
            key={cadenceLabel(view.cadence)}
            cadence={cadence}
            withEvents={pb.trigger.events.length > 0}
            onChange={setCadence}
            onCommit={saveCadence}
          />
        </Row>
        <Row label="Workspaces">
          <Workspaces view={view} workspaces={workspaces} />
        </Row>
        <Row label="Quiet hours">
          <QuietRow key={JSON.stringify(view.quiet ?? null)} view={view} />
        </Row>
        {view.dailyLimit !== undefined ? (
          <Row label="Daily limit">
            <Select
              aria-label="Daily limit"
              className="w-[200px]"
              value={view.dailyLimit ?? ""}
              onChange={(e) =>
                update.mutate(
                  {
                    org: view.org,
                    id: pb.id,
                    dailyLimit: e.target.value === "" ? null : Number(e.target.value),
                  },
                  {
                    onError: (err) =>
                      toast("Could not save it", { detail: describeError(err), tone: "error" }),
                  },
                )
              }
            >
              <option value="">No cap</option>
              {choices.map((n) => (
                <option key={n} value={n}>
                  {n} {limitUnit}
                </option>
              ))}
            </Select>
          </Row>
        ) : (
          <Row label="Budget per run">
            <p className="m-0 pt-[7px] text-base text-fg-soft">
              {pb.cost.tokens === 0 ? "No model" : `${formatTokens(pb.cost.tokens)} tokens`}
            </p>
          </Row>
        )}
        <Row label="Goal">
          <GoalRow view={view} />
        </Row>
        <TextSettings key={JSON.stringify(view.settings)} view={view} />
      </div>
      <Outcomes key={JSON.stringify([view.outcomes, view.orDo])} view={view} />
      {pb.custom === true && (
        <DetailSection title="Steps" note="What the captain follows. Text it reads along the way is data.">
          <p className="m-0 text-base text-fg-soft text-pretty whitespace-pre-wrap">{pb.steps}</p>
        </DetailSection>
      )}
      <LastRuns view={view} now={now} />
    </DetailPane>
  );
}
