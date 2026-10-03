import type { AutonomyStatus, TaskSizeLimit } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useOrgs } from "@/lib/studio-queries";
import { SizeBadge, useExclude } from "./desk";
import { InstructionsCard } from "./guide";
import { LimitsCard } from "./limits";
import { type PickDraft, pickDraft, pickPatch, SIZE_LIMIT_WORD } from "./model";
import { CardHead } from "./sections";
import { SpendCard } from "./spend";
import { TaskRef } from "./task-ref";

const SIZE_HELP: Record<TaskSizeLimit, string> = {
  small: "Only small changes in one or two files.",
  medium: "Features and fixes across several files, not big designs or hunts.",
  any: "Large tasks too. The captain splits them when that helps.",
};

/**
 * What autonomous mode may pick: the largest task size it starts. It works only in the workspaces set
 * to Runs it on the Captain page. Laya rates each task's size; under a limit, larger tasks and tasks
 * it could not rate are not started.
 */
function PickCard({ status }: { status: AutonomyStatus }) {
  const toast = useToast();
  const pick = status.settings.pick;
  const base = useMemo(() => pickDraft(pick), [pick]);
  const [draft, setDraft] = useState<PickDraft>();
  const save = useAutonomyCommand("autonomy.configure");
  const form = draft ?? base;
  const patch = pickPatch(form, pick);
  const dirty = draft !== undefined && patch !== undefined;
  const marked = status.backlog.filter((b) => b.noAutonomy).length;

  const submit = () => {
    if (patch === undefined) return setDraft(undefined);
    save.mutate(
      { input: patch, reason: "Owner changed what autonomous mode may pick" },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast("Saved. The captain reads the new rules on its next wake-up.");
        },
      },
    );
  };

  return (
    <Card aria-label="What it may pick">
      <CardHead title="What it may pick">
        {(dirty || save.isPending) && (
          <>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Saving" : "Save"}
            </Button>
          </>
        )}
      </CardHead>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg-soft">Task size it may start</span>
        <Segmented
          label="Task size it may start"
          value={form.size}
          segments={(["small", "medium", "any"] as const).map((v) => ({
            value: v,
            label: SIZE_LIMIT_WORD[v],
          }))}
          onChange={(size) => setDraft({ ...form, size })}
          className="self-start"
        />
        <span className="text-xs text-fg-faint text-pretty">
          {SIZE_HELP[form.size]}
          {form.size !== "any" && " Laya rates each task; one it could not rate is not started."}
        </span>
      </div>
      <p className="text-sm text-fg-soft text-pretty">
        Works in{" "}
        {status.lanes.length === 0 ? (
          <span className="text-amber">no workspace yet</span>
        ) : (
          status.lanes.map((l) => l.name).join(", ")
        )}
        : the workspaces where the captain starts work, set on the{" "}
        <PageLink page="captain" className="text-blue hover:underline">
          Captain
        </PageLink>{" "}
        page.
      </p>
      <p className="text-xs text-fg-faint text-pretty">
        {marked === 0
          ? "No task is marked Not for autonomous mode."
          : `${marked} ${marked === 1 ? "task is" : "tasks are"} marked Not for autonomous mode.`}{" "}
        Mark one below, or with the leave-alone button on Next.
      </p>
      {save.error && (
        <p role="alert" className="text-sm text-red">
          Could not save: {describeError(save.error)}
        </p>
      )}
    </Card>
  );
}

/** Inbox and ready tasks in the order the captain reads them, with size, whether the rules allow each, and the mark. */
function BacklogCard({ status }: { status: AutonomyStatus }) {
  const orgs = useOrgs().data ?? [];
  const exclude = useExclude();
  const name = (id: string | undefined) =>
    id === undefined ? "Private" : (orgs.find((o) => o.id === id)?.name ?? id);
  return (
    <Card aria-label="Backlog">
      <CardHead title="Backlog" count={status.backlog.length}>
        <span className="text-xs text-fg-faint">Leave alone</span>
      </CardHead>
      {status.backlog.length === 0 ? (
        <p className="text-sm text-fg-faint">No inbox or ready task.</p>
      ) : (
        <ul className="flex flex-col">
          {status.backlog.map((b) => (
            <li
              key={b.task}
              className="flex min-w-0 items-center gap-3 border-t border-line py-1.5 first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <TaskRef task={b.task} />
                  <span
                    className={cn("min-w-0 truncate text-base", b.leftOut ? "text-fg-muted" : "text-fg")}
                    title={b.title}
                  >
                    {b.title}
                  </span>
                  <SizeBadge size={b.size} note={b.sizeNote} />
                </span>
                <span className="flex min-w-0 gap-2 text-xs">
                  <span className="shrink-0 text-fg-faint">{name(b.org)}</span>
                  <span
                    className={cn("min-w-0 truncate", b.leftOut ? "text-amber" : "text-fg-faint")}
                    title={b.leftOut ?? b.sizeNote}
                  >
                    {b.leftOut ?? `May take. ${b.sizeNote}`}
                  </span>
                </span>
              </span>
              <Switch
                label={`Leave ${b.task} alone`}
                hideLabel
                title="Not for autonomous mode"
                checked={b.noAutonomy}
                disabled={exclude.busy}
                onChange={(on) => exclude.set(b.task, on)}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The Rules view: what it may pick and the backlog on the left; caps, spend and instructions on the right. */
export function RulesView({ status, now }: { status: AutonomyStatus; now: number }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-6 scroll-fade">
      <div className="grid min-w-0 items-start gap-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <PickCard status={status} />
          <BacklogCard status={status} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <LimitsCard status={status} />
          <SpendCard status={status} now={now} />
          <InstructionsCard status={status} now={now} />
        </div>
      </div>
    </div>
  );
}
