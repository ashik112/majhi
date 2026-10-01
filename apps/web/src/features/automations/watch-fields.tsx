import { defaultPollSeconds, minPollSeconds, type WatchSpec } from "@majhi/shared";
import { useMemo } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useProjects, useTasks } from "@/lib/task-queries";
import { WATCH_KINDS } from "./model";

/** The watch as the form holds it: strings, whatever the kind, so switching keeps what was typed. */
export interface WatchDraft {
  kind: WatchSpec["kind"];
  task: string;
  to: "done" | "failed" | "needs-you";
  project: string;
  branch: string;
  path: string;
  process: string;
  on: "any" | "failure";
  metric: "costUsd" | "totalTokens";
  period: "today" | "week" | "month";
  limit: string;
  url: string;
  command: string;
  cwd: string;
}

export const EMPTY_WATCH: WatchDraft = {
  kind: "task.status",
  task: "",
  to: "done",
  project: "",
  branch: "",
  path: "",
  process: "",
  on: "any",
  metric: "costUsd",
  period: "today",
  limit: "",
  url: "",
  command: "",
  cwd: "",
};

export function watchToDraft(w: WatchSpec): WatchDraft {
  const base = { ...EMPTY_WATCH, kind: w.kind };
  switch (w.kind) {
    case "task.status":
      return { ...base, task: w.task ?? "", to: w.to };
    case "mr.changed":
      return { ...base, task: w.task ?? "" };
    case "branch.changed":
      return { ...base, project: w.project, branch: w.branch };
    case "path.changed":
      return { ...base, project: w.project, path: w.path };
    case "process.exit":
      return { ...base, task: w.task, process: w.process ?? "", on: w.on };
    case "usage.over":
      return { ...base, metric: w.metric, period: w.period, limit: String(w.limit) };
    case "url.changed":
      return { ...base, url: w.url };
    case "command.changed":
      return { ...base, task: w.task, command: w.command, cwd: w.cwd ?? "" };
  }
}

/** The watch, or the first thing missing from it. */
export function draftToWatch(d: WatchDraft): { watch: WatchSpec } | { error: string } {
  switch (d.kind) {
    case "task.status":
      return { watch: { kind: "task.status", ...(d.task === "" ? {} : { task: d.task }), to: d.to } };
    case "mr.changed":
      return { watch: { kind: "mr.changed", ...(d.task === "" ? {} : { task: d.task }) } };
    case "branch.changed":
      if (d.project === "") return { error: "Pick a project." };
      if (d.branch.trim() === "") return { error: "Name the branch." };
      return { watch: { kind: "branch.changed", project: d.project, branch: d.branch.trim() } };
    case "path.changed":
      if (d.project === "") return { error: "Pick a project." };
      if (d.path.trim() === "") return { error: "Name the file or folder." };
      return { watch: { kind: "path.changed", project: d.project, path: d.path.trim() } };
    case "process.exit":
      if (d.task === "") return { error: "Pick a task." };
      return {
        watch: {
          kind: "process.exit",
          task: d.task,
          ...(d.process.trim() === "" ? {} : { process: d.process.trim() }),
          on: d.on,
        },
      };
    case "usage.over": {
      const limit = Number(d.limit);
      if (!(limit > 0)) return { error: "Set a limit above 0." };
      return { watch: { kind: "usage.over", metric: d.metric, period: d.period, limit } };
    }
    case "url.changed":
      if (!/^https?:\/\/\S+$/i.test(d.url.trim())) return { error: "Use an http or https address." };
      return { watch: { kind: "url.changed", url: d.url.trim() } };
    case "command.changed":
      if (d.task === "") return { error: "Pick a task." };
      if (d.command.trim() === "") return { error: "Write the command." };
      return {
        watch: {
          kind: "command.changed",
          task: d.task,
          command: d.command.trim(),
          ...(d.cwd.trim() === "" ? {} : { cwd: d.cwd.trim() }),
        },
      };
  }
}

/** What to watch: the kind and its fields. Everything offered belongs to `org`. */
export function WatchFields({
  org,
  draft,
  onChange,
}: {
  org: string;
  draft: WatchDraft;
  onChange: (next: WatchDraft) => void;
}) {
  const projects = useProjects().data;
  const tasks = useTasks().data;
  const set = <K extends keyof WatchDraft>(key: K, value: WatchDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const orgProjects = useMemo(() => (projects ?? []).filter((p) => p.org === org), [projects, org]);
  const orgTasks = useMemo(() => (tasks ?? []).filter((t) => t.org === org), [tasks, org]);

  const taskSelect = (optional: boolean) => (
    <Field
      label="Task"
      hint={optional ? "Leave empty for every task of this org." : "Only tasks of this org are offered."}
    >
      {(p) => (
        <Select {...p} value={draft.task} onChange={(e) => set("task", e.target.value)}>
          <option value="">{optional ? "Any task of this org" : "Pick a task"}</option>
          {orgTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} · {t.title}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const projectSelect = (
    <Field label="Project">
      {(p) => (
        <Select {...p} value={draft.project} onChange={(e) => set("project", e.target.value)}>
          <option value="">Pick a project</option>
          {orgProjects.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.id}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-3">
      <Field label="Fires when">
        {(p) => (
          <Select
            {...p}
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value as WatchDraft["kind"])}
          >
            {WATCH_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {draft.kind === "task.status" && (
        <div className="grid grid-cols-2 gap-3">
          {taskSelect(true)}
          <Field
            label="Becomes"
            hint="Needs you: in review, an MR is open, or it paused. Failed: it paused on an error."
          >
            {(p) => (
              <Select {...p} value={draft.to} onChange={(e) => set("to", e.target.value as WatchDraft["to"])}>
                <option value="done">Done</option>
                <option value="failed">Failed</option>
                <option value="needs-you">Needs you</option>
              </Select>
            )}
          </Field>
        </div>
      )}
      {draft.kind === "mr.changed" && taskSelect(true)}
      {draft.kind === "branch.changed" && (
        <div className="grid grid-cols-2 gap-3">
          {projectSelect}
          <Field label="Branch" hint="A local branch of the project's checkout.">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.branch}
                onChange={(e) => set("branch", e.target.value)}
                placeholder="main"
              />
            )}
          </Field>
        </div>
      )}
      {draft.kind === "path.changed" && (
        <div className="grid grid-cols-2 gap-3">
          {projectSelect}
          <Field label="File or folder" hint="Relative to the project. A folder counts everything in it.">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.path}
                onChange={(e) => set("path", e.target.value)}
                placeholder="docs/"
              />
            )}
          </Field>
        </div>
      )}
      {draft.kind === "process.exit" && (
        <>
          {taskSelect(false)}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Process (optional)"
              hint="An id like p1, or its name. Empty: any process of the task."
            >
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={draft.process}
                  onChange={(e) => set("process", e.target.value)}
                />
              )}
            </Field>
            <Field label="Exits">
              {(p) => (
                <Select
                  {...p}
                  value={draft.on}
                  onChange={(e) => set("on", e.target.value as WatchDraft["on"])}
                >
                  <option value="any">For any reason</option>
                  <option value="failure">With an error</option>
                </Select>
              )}
            </Field>
          </div>
        </>
      )}
      {draft.kind === "usage.over" && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Measure">
            {(p) => (
              <Select
                {...p}
                value={draft.metric}
                onChange={(e) => set("metric", e.target.value as WatchDraft["metric"])}
              >
                <option value="costUsd">Cost (USD)</option>
                <option value="totalTokens">Tokens</option>
              </Select>
            )}
          </Field>
          <Field label="Over">
            {(p) => (
              <Select
                {...p}
                value={draft.period}
                onChange={(e) => set("period", e.target.value as WatchDraft["period"])}
              >
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="month">This month</option>
              </Select>
            )}
          </Field>
          <Field label="Limit" hint="This org only. Fires once per crossing.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="any"
                className="font-mono"
                value={draft.limit}
                onChange={(e) => set("limit", e.target.value)}
              />
            )}
          </Field>
        </div>
      )}
      {draft.kind === "url.changed" && (
        <Field
          label="Address"
          hint="http or https. The status and the first megabyte of the page are compared."
        >
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              value={draft.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="https://status.example.com"
            />
          )}
        </Field>
      )}
      {draft.kind === "command.changed" && (
        <>
          {taskSelect(false)}
          <Field label="Command" hint="Runs in the task's folder as a process. Its output is compared.">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.command}
                onChange={(e) => set("command", e.target.value)}
                placeholder="git status --short"
              />
            )}
          </Field>
          <Field label="Folder (optional)">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.cwd}
                onChange={(e) => set("cwd", e.target.value)}
              />
            )}
          </Field>
        </>
      )}
    </div>
  );
}

/** The check interval's hint: what the kind checks by default, and the least allowed. */
export function pollHint(kind: WatchSpec["kind"]): string {
  return `Default ${defaultPollSeconds(kind)} s, at least ${minPollSeconds(kind)} s.`;
}
