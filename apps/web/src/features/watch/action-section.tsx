import type { AutomationRun, WatchView } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ActionFields, actionToDraft, draftToAction, EMPTY_ACTION } from "@/features/actions/action-fields";
import { describeAction, RUN_STATUS } from "@/features/actions/model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useSaveWatch } from "@/lib/watch-queries";

/**
 * What majhi's own code does when the watch fires, no model: start a task, post in a room or run a
 * process. Shown in the detail's "When it fires" section with the last runs of it.
 */
export function ActionSection({ watch, now }: { watch: WatchView; now: number }) {
  const save = useSaveWatch();
  const toast = useToast();
  const { def } = watch;
  const fire = def.fire;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => (fire.run === undefined ? EMPTY_ACTION : actionToDraft(fire.run)));
  const [problem, setProblem] = useState<string>();

  const put = (patch: Partial<typeof fire>, done?: () => void) => {
    const next = { ...fire, ...patch };
    if (patch.run === undefined && "run" in patch) delete next.run;
    save.mutate(
      { id: watch.id, org: watch.org, def: { ...def, fire: next } },
      {
        ...(done === undefined ? {} : { onSuccess: done }),
        onError: (e) => toast("Could not save it", { detail: describeError(e), tone: "error" }),
      },
    );
  };

  const submit = () => {
    const built = draftToAction(draft);
    if ("error" in built) return setProblem(built.error);
    setProblem(undefined);
    put({ run: built.action }, () => setEditing(false));
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 mt-1 text-sm font-semibold text-fg">Run an action</h4>
      {fire.run !== undefined && !editing && (
        <>
          <p className="m-0 text-base text-fg-soft text-pretty">{describeAction(fire.run)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              label="Skip if the last run is still going"
              checked={fire.runOverlap === "skip"}
              onChange={(skip) => put({ runOverlap: skip ? "skip" : "allow" })}
            />
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit action
            </Button>
            <Button size="sm" variant="ghost" onClick={() => put({ run: undefined })}>
              Remove
            </Button>
          </div>
        </>
      )}
      {fire.run === undefined && !editing && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg-faint">Start a task, post in a room or run a process.</span>
          <Button size="sm" onClick={() => setEditing(true)}>
            Add an action
          </Button>
        </div>
      )}
      {editing && (
        <div className="flex min-w-0 flex-col gap-3">
          <ActionFields org={watch.org} draft={draft} onChange={setDraft} eventHelp />
          {problem !== undefined && (
            <p role="alert" className="m-0 text-sm text-red">
              {problem}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={submit}>
              Save action
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {watch.runs.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {watch.runs.slice(0, 5).map((run) => (
            <RunLine key={run.id} run={run} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunLine({ run, now }: { run: AutomationRun; now: number }) {
  const status = RUN_STATUS[run.status];
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className={cn("flex shrink-0 items-center gap-1.5 font-medium", LAMP_TEXT[status.lamp])}>
        <Lamp state={status.lamp} size={7} />
        {status.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={run.detail}>
        {run.detail}
      </span>
      <span className="shrink-0 text-fg-faint">{formatAgo(run.startedAt, now)}</span>
    </li>
  );
}
