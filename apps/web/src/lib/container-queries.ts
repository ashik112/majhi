import type { CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

export type ContainerList = CommandOutput<"containers.list">;

/** Running previews and test services across tasks, and whether containers are available. */
export function useContainers() {
  return useQuery<ContainerList, ApiRequestError>({
    queryKey: [...queryKeys.containers, "list"],
    queryFn: () => cmd("containers.list", {}),
  });
}

/** Stops the preview (`preview`) or a service of a task. */
export function useStopContainer() {
  const client = useQueryClient();
  return useMutation<unknown, ApiRequestError, { task: string; name: string }>({
    mutationFn: (input) => cmd("containers.stop", input, { reason: "Owner stopped a container" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.containers }),
  });
}

/** Allows or stops allowing an image. Both are config commits, so the settings and history refetch. */
export function useAllowImage() {
  const client = useQueryClient();
  return useMutation<unknown, ApiRequestError, { image: string; allow: boolean }>({
    mutationFn: ({ image, allow }) =>
      allow
        ? cmd("containers.images.allow", { image }, { reason: "Owner allowed a service image" })
        : cmd("containers.images.remove", { image }, { reason: "Owner removed a service image" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.settings }),
        client.invalidateQueries({ queryKey: queryKeys.history }),
      ]),
  });
}
