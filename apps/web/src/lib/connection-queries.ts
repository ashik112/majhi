import type { CommandInput, CommandOutput, ConnectionTypeDef, ConnectionView } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd, uploadFile } from "./api";
import { queryKeys } from "./queries";

export function useConnections() {
  return useQuery<ConnectionView[], ApiRequestError>({
    queryKey: queryKeys.connections,
    queryFn: () => cmd("connections.list", {}),
  });
}

export function useConnectionTypes() {
  return useQuery<ConnectionTypeDef[], ApiRequestError>({
    queryKey: [...queryKeys.connections, "types"],
    queryFn: () => cmd("connections.types", {}),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

type ChangeCommand =
  | "connections.create"
  | "connections.update"
  | "connections.remove"
  | "connections.setSecret"
  | "connections.setFile"
  | "connections.allow"
  | "connections.test";

/** A connections command that changes something. The list refetches after it. */
export function useConnectionCommand<N extends ChangeCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    // A Test is a read, so no change event comes for it.
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

/** Uploads a file for a connection and stores it as the value of a file field or entry. */
export function useSetConnectionFile() {
  const client = useQueryClient();
  return useMutation<
    ConnectionView,
    ApiRequestError,
    Omit<CommandInput<"connections.setFile">, "upload"> & { file: File }
  >({
    mutationFn: async ({ file, ...target }) => {
      const upload = await uploadFile(file, "connection");
      return cmd("connections.setFile", { ...target, upload: upload.id });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}
