import type {
  CommandInput,
  CommandOutput,
  ProjectView,
  Task,
  TaskAreas,
  TaskSummary,
  TaskType,
} from "@majhi/shared";
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { needsOwner } from "@/features/board/model";
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

/** Chats live in Chats. On the board and in counts they show only while they need the owner: they ask, are paused or ready to ship. */
const withoutQuietChats = (list: TaskSummary[]) => list.filter((t) => t.chat !== true || needsOwner(t));
const onlyChats = (list: TaskSummary[]) => list.filter((t) => t.chat === true);

/**
 * The one read of the task list. The feed keeps it current (it patches the tasks an event names, and
 * reads it again after a lost frame), so it never goes stale on its own.
 */
const SAFETY_REFETCH_MS = 60_000;
const taskListQuery = {
  queryKey: [...queryKeys.tasks, "list"],
  queryFn: () => cmd("tasks.list", { includeDone: true }),
  staleTime: Number.POSITIVE_INFINITY,
  // A slow safety net, not the way the board stays current: an unchanged answer costs no render.
  refetchInterval: SAFETY_REFETCH_MS,
  refetchIntervalInBackground: false,
} as const;

/** Every task, done ones included: the list collapses the done group itself. Chats show only when they need you. */
export function useTasks(enabled = true) {
  return useQuery<TaskSummary[], ApiRequestError, TaskSummary[]>({
    ...taskListQuery,
    select: withoutQuietChats,
    enabled,
  });
}

/** The chats with agents, newest first, done ones included. */
export function useChats(enabled = true) {
  return useQuery<TaskSummary[], ApiRequestError, TaskSummary[]>({
    ...taskListQuery,
    select: onlyChats,
    enabled,
  });
}

const byIdCache = new WeakMap<readonly TaskSummary[], Map<string, TaskSummary>>();
function indexOf(list: TaskSummary[]): Map<string, TaskSummary> {
  let index = byIdCache.get(list);
  if (index === undefined) {
    index = new Map(list.map((t) => [t.id, t]));
    byIdCache.set(list, index);
  }
  return index;
}

/**
 * One task's row from the list, for a card that shows a bit of it. The row is the same object until that
 * task changes, so the card renders again only for its own task.
 */
export function useTaskRow(id: string | undefined): TaskSummary | undefined {
  return useQuery<TaskSummary[], ApiRequestError, TaskSummary | undefined>({
    ...taskListQuery,
    select: (list) => (id === undefined ? undefined : indexOf(list).get(id)),
  }).data;
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
    ...taskListQuery,
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

/**
 * One task's origin, the parts of the system it touches and its whole trail (`tasks.detail`). Under the
 * tasks key, so a change the owner makes refreshes it; the feed marks it stale with the task itself.
 */
export function useTaskDetail(id: string, enabled = true) {
  return useQuery<CommandOutput<"tasks.detail">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "detail", id],
    queryFn: () => cmd("tasks.detail", { id }),
    staleTime: 10_000,
    retry: false,
    enabled,
  });
}

/** `tasks.areas` takes at most this many ids. */
const AREAS_MAX = 100;
const AREAS_STALE_MS = 30_000;

/**
 * The parts of the system the tasks on screen touch. Every id costs a read of the task's worktree on the
 * server, so the screen names only the tasks it draws (the first 100) and the answer is kept for 30 seconds,
 * as long as the server keeps its own. The key is the ids, so an event on one task does not ask again.
 */
export function useAreas(ids: readonly string[]): ReadonlyMap<string, TaskAreas> {
  const named = useMemo(() => [...new Set(ids)].toSorted().slice(0, AREAS_MAX), [ids]);
  const data = useQuery<CommandOutput<"tasks.areas">, ApiRequestError>({
    queryKey: ["task-areas", named.join(" ")],
    queryFn: () => cmd("tasks.areas", { ids: named }),
    enabled: named.length > 0,
    staleTime: AREAS_STALE_MS,
    refetchInterval: AREAS_STALE_MS * 2,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  }).data;
  return useMemo(() => new Map((data ?? []).map((a) => [a.task, a.areas])), [data]);
}

/**
 * REPORT.md of a task, or null before the agent writes it. The file has no event, so it is read
 * again every few seconds while the page is visible.
 */
export function useReport(id: string) {
  return useQuery<CommandOutput<"tasks.report">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "report", id],
    queryFn: () => cmd("tasks.report", { id }),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
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

/** The list is read again at most once per this long while the room socket keeps sending tasks. */
const LIST_REFRESH_MS = 1000;
let listRefresh: number | undefined;
let listDirty = false;

/** Writes a task the room socket just sent into the cache, so the header and the list follow at once. A burst is read once more at its end. */
export function setTaskInCache(client: QueryClient, task: Task): void {
  client.setQueryData([...queryKeys.tasks, "one", task.id], task);
  if (listRefresh !== undefined) {
    listDirty = true;
    return;
  }
  const refresh = () => {
    void client.invalidateQueries({ queryKey: [...queryKeys.tasks, "list"] });
    listRefresh = window.setTimeout(() => {
      listRefresh = undefined;
      if (listDirty) {
        listDirty = false;
        refresh();
      }
    }, LIST_REFRESH_MS);
  };
  refresh();
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
      // Not returned: the caller closes the dialog and opens the room now, not after the list refetch.
      void refreshTasks(client);
    },
  });
}

type TaskAction = "tasks.start" | "tasks.stop" | "tasks.reopen";

function useTaskAction(name: TaskAction) {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, string>({
    mutationKey: [name],
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

/**
 * What Ship can do now, read again whenever the task changes. The last answer stays while the next
 * one loads: a task update arrives on every turn of a busy room, and Ship (with its panel open) must
 * not vanish and come back each time.
 */
export function useShipOptions(task: Pick<Task, "id" | "updatedAt" | "status">, enabled: boolean) {
  return useQuery<CommandOutput<"tasks.shipOptions">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "ship", task.id, task.updatedAt, task.status],
    queryFn: () => cmd("tasks.shipOptions", { id: task.id }),
    enabled,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
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

/** The public keys in the owner's ~/.ssh, to pick the key an SSH host uses. */
export function useSshKeys() {
  return useQuery<CommandOutput<"ssh.keys">, ApiRequestError>({
    queryKey: ["ssh-keys"],
    queryFn: () => cmd("ssh.keys", {}),
    staleTime: 60_000,
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

/** Sets a task's type. The answer is the task, so the page and the lists follow at once. */
export function useSetType() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, { id: string; type: TaskType }>({
    mutationFn: (input) => cmd("tasks.setType", input),
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
  return useMutation<CommandOutput<"tasks.remove">, ApiRequestError, CommandInput<"tasks.remove">>({
    mutationFn: (input) => cmd("tasks.remove", input),
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
