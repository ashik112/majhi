import type { CommandInput, CommandOutput, ProjectView, Task, TaskSummary } from "@majhi/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

type TaskAction = "tasks.start" | "tasks.stop" | "tasks.close";

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
export const useCloseTask = () => useTaskAction("tasks.close");

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
