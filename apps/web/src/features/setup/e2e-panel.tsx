import { type E2eMode, E2eModeSchema, type E2eRun, type E2eSettings } from "@majhi/shared";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { RunLine } from "@/features/health/e2e-panel";
import { useSaveSettings } from "@/lib/boss-queries";
import { useE2eRunNow, useE2eStatus } from "@/lib/e2e-queries";
import { describeError } from "@/lib/errors";
import { useNow } from "@/lib/use-now";

const MODES: ReadonlyArray<{ value: E2eMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "merge", label: "After each merge" },
  { value: "daily", label: "Daily" },
];

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Background e2e: the host helper runs a project's Playwright suite in its own worktree. Per project
 * it runs never on its own (the default), after each merge into the base branch, or once a day. Run
 * now starts one in any mode.
 */
export function E2eSection({ saved }: { saved: E2eSettings }) {
  const status = useE2eStatus();
  const save = useSaveSettings();
  const runNow = useE2eRunNow();
  const toast = useToast();
  const now = useNow(30_000);
  const [dailyAt, setDailyAt] = useState(saved.daily_at);
  useEffect(() => setDailyAt(saved.daily_at), [saved.daily_at]);
  const projects = status.data?.projects ?? [];
  const badClock = !CLOCK.test(dailyAt);

  function onSaved() {
    void status.refetch();
  }

  function setMode(project: string, mode: E2eMode) {
    save.mutate(
      { e2e: { projects: { ...saved.projects, [project]: mode } } },
      {
        onSuccess: onSaved,
        onError: (e) => toast("Could not save the mode", { detail: describeError(e), tone: "error" }),
      },
    );
  }

  function saveDailyAt() {
    if (badClock || dailyAt === saved.daily_at) return;
    save.mutate(
      { e2e: { daily_at: dailyAt } },
      {
        onSuccess: onSaved,
        onError: (e) => toast("Could not save the time", { detail: describeError(e), tone: "error" }),
      },
    );
  }

  function start(project: string) {
    runNow.mutate(project, {
      onSuccess: (out) =>
        toast(
          out.queued
            ? `Background e2e for ${project} is queued at ${out.run.commit.slice(0, 7)}.`
            : `Background e2e for ${project} is already ${out.run.status} at ${out.run.commit.slice(0, 7)}.`,
        ),
      onError: (e) => toast("Could not start the run", { detail: describeError(e), tone: "error" }),
    });
  }

  /** The run in progress or waiting for this project, else its newest finished one. */
  function lastRun(project: string): E2eRun | undefined {
    const data = status.data;
    if (data === undefined) return undefined;
    if (data.running?.project === project) return data.running;
    return data.queued.find((r) => r.project === project) ?? data.latest.find((r) => r.project === project);
  }

  return (
    <DetailSection
      title="Background e2e"
      note="Saved to majhi.yaml, as a change you can undo"
      className="border-t-0"
    >
      <div className="flex max-w-[640px] flex-col gap-4">
        <p className="text-base text-fg-soft">
          The host helper runs a project's whole Playwright suite on its own, one run at a time and at low
          priority. A run can take up to 90 minutes of this computer's CPU, so it is off unless you pick when.
          The result shows on Health and in the room of the task that merged. A failure opens one task with
          the traces. It never touches your checkout, majhi.db or port 7070.
        </p>
        <Field
          label="Daily runs start at"
          className="max-w-[180px]"
          {...(badClock
            ? { error: "Use a time like 03:00" }
            : status.data
              ? { hint: `In ${status.data.tz}` }
              : {})}
        >
          {(p) => (
            <Input
              {...p}
              type="time"
              value={dailyAt}
              disabled={save.isPending}
              onChange={(e) => setDailyAt(e.target.value)}
              onBlur={saveDailyAt}
            />
          )}
        </Field>
        {projects.length === 0 && <p className="text-base text-fg-faint">No projects are registered yet.</p>}
        <ul className="flex flex-col divide-y divide-line">
          {projects.map((project) => {
            const run = lastRun(project.id);
            return (
              <li key={project.id} className="flex flex-col gap-1.5 py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{project.id}</span>
                  <Select
                    aria-label={`When background e2e runs for ${project.id}`}
                    className="w-[170px]"
                    value={project.mode}
                    disabled={save.isPending}
                    onChange={(e) => setMode(project.id, E2eModeSchema.parse(e.target.value))}
                  >
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="md"
                    disabled={runNow.isPending && runNow.variables === project.id}
                    onClick={() => start(project.id)}
                  >
                    <Play aria-hidden="true" />
                    Run now
                  </Button>
                </div>
                <ul>
                  {run === undefined ? (
                    <li className="text-sm text-fg-faint">No run yet.</li>
                  ) : (
                    <RunLine run={run} now={now} hideProject />
                  )}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </DetailSection>
  );
}
