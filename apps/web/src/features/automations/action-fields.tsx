import { type AutomationAction, canWorkIn } from "@majhi/shared";
import { useMemo } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Segmented } from "@/components/ui/segmented";
import { Select, Textarea } from "@/components/ui/select";
import { useAgents } from "@/lib/studio-queries";
import { useProjects, useTasks } from "@/lib/task-queries";

/** The action's fields as the form holds them: strings, whatever the kind, so switching keeps what was typed. */
export interface ActionDraft {
  kind: AutomationAction["kind"];
  project: string;
  agent: string;
  also: string[];
  title: string;
  text: string;
  task: string;
  command: string;
  cwd: string;
  post: string;
}

export const EMPTY_ACTION: ActionDraft = {
  kind: "task.start",
  project: "",
  agent: "",
  also: [],
  title: "",
  text: "",
  task: "",
  command: "",
  cwd: "",
  post: "",
};

export function actionToDraft(action: AutomationAction): ActionDraft {
  switch (action.kind) {
    case "task.start": {
      const [lead, ...rest] = action.team ?? (action.agent === undefined ? [] : [action.agent]);
      return {
        ...EMPTY_ACTION,
        kind: "task.start",
        project: action.project,
        agent: lead ?? "",
        also: rest,
        title: action.title,
        text: action.text,
      };
    }
    case "room.post":
      return { ...EMPTY_ACTION, kind: "room.post", task: action.task, post: action.text };
    case "process.run":
      return {
        ...EMPTY_ACTION,
        kind: "process.run",
        task: action.task,
        command: action.command,
        cwd: action.cwd ?? "",
      };
  }
}

/** The action, or the first thing missing from it. */
export function draftToAction(d: ActionDraft): { action: AutomationAction } | { error: string } {
  switch (d.kind) {
    case "task.start": {
      if (d.project === "") return { error: "Pick a project." };
      if (d.title.trim() === "") return { error: "Give the task a title." };
      if (d.text.trim() === "") return { error: "Write what the task should do." };
      const team = d.agent === "" ? [] : [d.agent, ...d.also.filter((a) => a !== d.agent)];
      return {
        action: {
          kind: "task.start",
          project: d.project,
          ...(team.length > 1 ? { team } : team.length === 1 ? { agent: team[0] } : {}),
          title: d.title.trim(),
          text: d.text.trim(),
        } as AutomationAction,
      };
    }
    case "room.post":
      if (d.task === "") return { error: "Pick a task." };
      if (d.post.trim() === "") return { error: "Write the message." };
      return { action: { kind: "room.post", task: d.task, text: d.post.trim() } };
    case "process.run":
      if (d.task === "") return { error: "Pick a task." };
      if (d.command.trim() === "") return { error: "Write the command." };
      return {
        action: {
          kind: "process.run",
          task: d.task,
          command: d.command.trim(),
          ...(d.cwd.trim() === "" ? {} : { cwd: d.cwd.trim() }),
        },
      };
  }
}

const KINDS = [
  { value: "task.start", label: "Start a task" },
  { value: "room.post", label: "Post to a room" },
  { value: "process.run", label: "Run a command" },
] as const;

/**
 * What a schedule or trigger does: start a task from a template, post to an existing task's room,
 * or run a command in an existing task. Everything offered belongs to `org`.
 */
export function ActionFields({
  org,
  draft,
  onChange,
  eventHelp = false,
}: {
  org: string;
  draft: ActionDraft;
  onChange: (next: ActionDraft) => void;
  /** Triggers: explain `{{event}}` under the text boxes. */
  eventHelp?: boolean;
}) {
  const projects = useProjects().data;
  const agents = useAgents().data;
  const tasks = useTasks().data;
  const set = <K extends keyof ActionDraft>(key: K, value: ActionDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const orgProjects = useMemo(() => (projects ?? []).filter((p) => p.org === org), [projects, org]);
  const orgAgents = useMemo(
    () =>
      (agents ?? []).flatMap((e) =>
        e.status === "ok" && canWorkIn(e.agent.frontmatter, org) ? [e.agent.frontmatter.id] : [],
      ),
    [agents, org],
  );
  const orgTasks = useMemo(
    () => (tasks ?? []).filter((t) => t.org === org && (t.status !== "done" || t.id === draft.task)),
    [tasks, org, draft.task],
  );
  const taskSelect = (
    <Field label="Task" hint="Only tasks of this workspace are offered.">
      {(p) => (
        <Select {...p} value={draft.task} onChange={(e) => set("task", e.target.value)}>
          <option value="">Pick a task</option>
          {orgTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} · {t.title}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const help = eventHelp ? (
    <>
      {" "}
      <code className="font-mono">{"{{event}}"}</code> becomes a line about what matched, like "task ACM-4
      reached done".
    </>
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label="What it does"
        value={draft.kind}
        segments={KINDS}
        onChange={(kind) => set("kind", kind)}
        className="self-start"
      />
      {draft.kind === "task.start" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project" hint="The task works in this project's repo.">
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
            <Field label="Agent" hint="Leave empty for the workspace's default agent.">
              {(p) => (
                <Select {...p} value={draft.agent} onChange={(e) => set("agent", e.target.value)}>
                  <option value="">Default agent</option>
                  {orgAgents.map((a) => (
                    <option key={a} value={a}>
                      @{a}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {draft.agent !== "" && (
            <Field label="Also on the team">
              {() => (
                <MultiSelect
                  label="Also on the team"
                  options={orgAgents
                    .filter((a) => a !== draft.agent)
                    .map((a) => ({ value: a, label: `@${a}`, mono: true }))}
                  value={draft.also}
                  onChange={(next) => set("also", next)}
                  emptyText="Only the agent above"
                  clearText="Only the agent above"
                />
              )}
            </Field>
          )}
          <Field label="Title">
            {(p) => (
              <Input
                {...p}
                value={draft.title}
                maxLength={120}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Nightly dependency check"
              />
            )}
          </Field>
          <Field
            label="What the task should do"
            hint={
              <>
                Name no other project here. The agent reads this like a task you typed.
                {help}
              </>
            }
          >
            {(p) => (
              <Textarea {...p} rows={4} value={draft.text} onChange={(e) => set("text", e.target.value)} />
            )}
          </Field>
        </>
      )}
      {draft.kind === "room.post" && (
        <>
          {taskSelect}
          <Field
            label="Message"
            hint={
              <>
                The task's lead gets it as a message from the scheduler. It wakes the task.
                {help}
              </>
            }
          >
            {(p) => (
              <Textarea {...p} rows={3} value={draft.post} onChange={(e) => set("post", e.target.value)} />
            )}
          </Field>
        </>
      )}
      {draft.kind === "process.run" && (
        <>
          {taskSelect}
          <Field label="Command" hint="Runs with /bin/sh -c in the task's folder, like majhi-processes.">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.command}
                onChange={(e) => set("command", e.target.value)}
                placeholder="pnpm test"
              />
            )}
          </Field>
          <Field label="Folder (optional)" hint="Inside the task folder. Default: the task folder itself.">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.cwd}
                onChange={(e) => set("cwd", e.target.value)}
                placeholder="acme-api"
              />
            )}
          </Field>
        </>
      )}
    </div>
  );
}
