import type { CommandInput, CommandOutput, ProjectView, Task, TaskSummary } from "@majhi/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

// Reads ---------------------------------------------------------------------

export function useProjects(enabled = true) {
  return useQuery<ProjectView[], ApiRequestError>({
    queryKey: queryKeys.projects,
    queryFn: () => cmd("projects.list", {}),
    enabled,
  });
}

/** Every task, done ones included: the list collapses the done group itself. */
export function useTasks(enabled = true) {
  return useQuery<TaskSummary[], ApiRequestError>({
    queryKey: [...queryKeys.tasks, "list"],
    queryFn: () => cmd("tasks.list", { includeDone: true }),
    enabled,
  });
}

const idsOf = (list: TaskSummary[]) =>
  list
    .map((t) => t.id)
    .toSorted()
    .join(" ");

/**
 * The ids of every task, for turning ids in messages into links. A string compares by value, so
 * messages render again only when a task is added or removed, not on every status change.
 */
export function useTaskIds(): ReadonlySet<string> {
  const key = useQuery<TaskSummary[], ApiRequestError, string>({
    queryKey: [...queryKeys.tasks, "list"],
    queryFn: () => cmd("tasks.list", { includeDone: true }),
    select: idsOf,
  }).data;
  return useMemo(() => new Set(key ? key.split(" ") : []), [key]);
}

export function useTask(id: string | undefined) {
  return useQuery<Task, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "one", id],
    queryFn: () => cmd("tasks.get", { id: id ?? "" }),
    enabled: id !== undefined,
    retry: false,
  });
}

/** Loads a task ahead of a click, so opening it from the board shows the header at once. */
export function prefetchTask(client: QueryClient, id: string): void {
  void client.prefetchQuery({
    queryKey: [...queryKeys.tasks, "one", id],
    queryFn: () => cmd("tasks.get", { id }),
    staleTime: 30_000,
  });
}

/** Writes a task the room socket just sent into the cache, so the header and list follow at once. */
export function setTaskInCache(client: QueryClient, task: Task): void {
  client.setQueryData([...queryKeys.tasks, "one", task.id], task);
  void client.invalidateQueries({ queryKey: [...queryKeys.tasks, "list"] });
}

// Writes --------------------------------------------------------------------

function refreshTasks(client: QueryClient) {
  return client.invalidateQueries({ queryKey: queryKeys.tasks });
}

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"tasks.create">, ApiRequestError, CommandInput<"tasks.create">>({
    mutationFn: (input) => cmd("tasks.create", input),
    onSuccess: (task) => {
      client.setQueryData([...queryKeys.tasks, "one", task.id], task);
      return refreshTasks(client);
    },
  });
}

type TaskAction = "tasks.start" | "tasks.stop" | "tasks.reopen";

function useTaskAction(name: TaskAction) {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, string>({
    mutationFn: (id) => cmd(name, { id }),
    onSuccess: (task) => {
      client.setQueryData([...queryKeys.tasks, "one", task.id], task);
      return refreshTasks(client);
    },
  });
}

export const useStartTask = () => useTaskAction("tasks.start");
export const useStopTask = () => useTaskAction("tasks.stop");
/** Marks a task done. `unshipped: "keep"` is the owner's yes to closing with commits not shipped. */
export function useCloseTask() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, CommandInput<"tasks.close">>({
    mutationFn: (input) => cmd("tasks.close", input),
    onSuccess: (task) => {
      client.setQueryData([...queryKeys.tasks, "one", task.id], task);
      return refreshTasks(client);
    },
  });
}
export const useReopenTask = () => useTaskAction("tasks.reopen");

/** Opens the task's shell, or the one that runs. */
export function useOpenTaskTerminal() {
  return useMutation<CommandOutput<"tasks.terminal.open">, ApiRequestError, string>({
    mutationFn: (task) => cmd("tasks.terminal.open", { task }),
  });
}

/** What Ship can do now, read again whenever the task changes. */
export function useShipOptions(task: Pick<Task, "id" | "updatedAt" | "status">, enabled: boolean) {
  return useQuery<CommandOutput<"tasks.shipOptions">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "ship", task.id, task.updatedAt, task.status],
    queryFn: () => cmd("tasks.shipOptions", { id: task.id }),
    enabled,
    staleTime: 5_000,
  });
}

/** Local branches of each repo of a task, and its MR remote's, for picking where to ship. */
export function useTaskBranches(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.tasks, "branches", id],
    queryFn: () => cmd("tasks.branches", { id }),
    enabled,
  });
}

/** The Host entries of the owner's ~/.ssh/config, for a remote's SSH alias. */
export function useSshHosts() {
  return useQuery<CommandOutput<"ssh.hosts">, ApiRequestError>({
    queryKey: ["ssh-hosts"],
    queryFn: () => cmd("ssh.hosts", {}),
    staleTime: 60_000,
  });
}

/** Refreshes the task and its lists after a Ship action or a card button. */
export function useAfterTaskChange() {
  const client = useQueryClient();
  return (task?: Task) => {
    if (task !== undefined) setTaskInCache(client, task);
    return refreshTasks(client);
  };
}

export function useUpdateTask() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, CommandInput<"tasks.update">>({
    mutationFn: (input) => cmd("tasks.update", input),
    onSuccess: (task) => {
      setTaskInCache(client, task);
      return refreshTasks(client);
    },
  });
}

/** `team.add`, `team.remove`, `team.swap` and `team.set` (5.3). Each answers with the task. */
export function useTeamCommand<N extends "team.add" | "team.remove" | "team.swap" | "team.set">(name: N) {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input) as Promise<Task>,
    onSuccess: (task) => {
      setTaskInCache(client, task);
      return refreshTasks(client);
    },
  });
}

export function useLinkTask() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, CommandInput<"tasks.link">>({
    mutationFn: (input) => cmd("tasks.link", input),
    onSuccess: () => refreshTasks(client),
  });
}

export function useUnlinkTask() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, CommandInput<"tasks.unlink">>({
    mutationFn: (input) => cmd("tasks.unlink", input),
    onSuccess: () => refreshTasks(client),
  });
}

export function useRemoveTask() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"tasks.remove">, ApiRequestError, { id: string; force?: boolean }>({
    mutationFn: ({ id, force }) => cmd("tasks.remove", force ? { id, force } : { id }),
    onSuccess: () => refreshTasks(client),
  });
}

export function useRegisterProject() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.register">, ApiRequestError, CommandInput<"projects.register">>({
    mutationFn: (input) => cmd("projects.register", input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.projects }),
        client.invalidateQueries({ queryKey: queryKeys.repos }),
      ]),
  });
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.update">, ApiRequestError, CommandInput<"projects.update">>({
    mutationFn: (input) => cmd("projects.update", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useRemoveProject() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.remove">, ApiRequestError, string>({
    mutationFn: (id) => cmd("projects.remove", { id }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.projects }),
        client.invalidateQueries({ queryKey: queryKeys.repos }),
      ]),
  });
}

// Merge requests (5.5) ------------------------------------------------------

/** What each repo of the task changed against its base, as git diffs. Refetched when the tab opens. */
export function useTaskDiff(id: string, enabled: boolean) {
  return useQuery<CommandOutput<"tasks.diff">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "diff", id],
    queryFn: () => cmd("tasks.diff", { id }),
    enabled,
    staleTime: 0,
  });
}

/** The order the task's repos merge in, and whether the owner set it by hand. */
export function useMergeOrder(id: string, enabled: boolean) {
  return useQuery<CommandOutput<"tasks.mergeOrder">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "mergeOrder", id],
    queryFn: () => cmd("tasks.mergeOrder", { id }),
    enabled,
    retry: false,
  });
}

type MrCommand =
  | "tasks.setMergeOrder"
  | "tasks.openMrs"
  | "tasks.refreshMrs"
  | "tasks.mergeMrs"
  | "tasks.markMerged";

/** Every MR command changes the task's repos, so each one refreshes the task and its lists. */
export function useMrCommand<N extends MrCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: (out) => {
      const task = "task" in out ? out.task : out;
      setTaskInCache(client, task as Task);
      return refreshTasks(client);
    },
  });
}
