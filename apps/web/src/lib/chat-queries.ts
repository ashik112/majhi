import type { Task } from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Starts a chat with an agent. An untitled chat nobody wrote in comes back instead of a second one. */
export function useNewChat() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, string>({
    mutationFn: (agent) => cmd("chats.create", { agent }),
    onSuccess: (task) => {
      client.setQueryData([...queryKeys.tasks, "one", task.id], task);
      return client.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useRenameChat() {
  const client = useQueryClient();
  return useMutation<Task, ApiRequestError, { id: string; title: string }>({
    mutationFn: (input) => cmd("chats.rename", input),
    onSuccess: (task) => {
      client.setQueryData([...queryKeys.tasks, "one", task.id], task);
      return client.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}
