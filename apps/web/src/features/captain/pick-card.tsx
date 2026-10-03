import type { AutonomyStatus, TaskSizeLimit } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { SizeBadge, useExclude } from "@/features/autonomy/desk";
import { type PickDraft, pickDraft, pickPatch, SIZE_LIMIT_WORD } from "@/features/autonomy/model";
import { CardHead } from "@/features/autonomy/sections";
import { TaskRef } from "@/features/autonomy/task-ref";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";

const SIZE_HELP: Record<TaskSizeLimit, string> = {
  small: "Only small changes in one or two files.",
  medium: "Features and fixes across several files, not big designs or hunts.",
  any: "Large tasks too. The captain splits them when that helps.",
};

/**
 * What the captain may pick: the largest task size it starts, the same in every workspace. Laya
 * rates each task's size; under a limit, larger tasks and tasks it could not rate are not started.
 */
export function PickCard({ status }: { status: AutonomyStatus }) {
  const toast = useToast();
  const pick = status.settings.pick;
  const base = useMemo(() => pickDraft(pick), [pick]);
  const [draft, setDraft] = useState<PickDraft>();
  const save = useAutonomyCommand("autonomy.configure");
  const form = draft ?? base;
  const patch = pickPatch(form, pick);
  const dirty = draft !== undefined && patch !== undefined;

  const submit = () => {
    if (patch === undefined) return setDraft(undefined);
    save.mutate(
      { input: patch, reason: "Owner changed what the captain may pick" },
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
        <span className="text-sm text-fg-soft">Largest task it starts, in every workspace</span>
        <Segmented
          label="Largest task it starts"
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
      <p className="text-xs text-fg-faint text-pretty">
        It starts work only where "Pick and start work" is set to Captain decides.
      </p>
      {save.error && (
        <p role="alert" className="text-sm text-red">
          Could not save: {describeError(save.error)}
        </p>
      )}
    </Card>
  );
}

/**
 * The tasks of one workspace the captain may start (inbox and ready), in the order it reads them,
 * with size, whether the rules allow each, and a switch to leave one alone.
 */
export function LeaveAloneList({ status, org }: { status: AutonomyStatus; org: string | undefined }) {
  const exclude = useExclude();
  const items = status.backlog.filter((b) => (org === undefined ? b.org === undefined : b.org === org));
  if (items.length === 0) return <p className="text-sm text-fg-faint">No inbox or ready task here.</p>;
  return (
    <ul className="flex flex-col">
      {items.map((b) => (
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
            <span
              className={cn("min-w-0 truncate text-xs", b.leftOut ? "text-amber" : "text-fg-faint")}
              title={b.leftOut ?? b.sizeNote}
            >
              {b.leftOut ?? `May take. ${b.sizeNote}`}
            </span>
          </span>
          <Switch
            label={`Leave ${b.task} alone`}
            hideLabel
            title="Leave alone: the captain will not touch this task"
            checked={b.noAutonomy}
            disabled={exclude.busy}
            onChange={(on) => exclude.set(b.task, on)}
          />
        </li>
      ))}
    </ul>
  );
}
