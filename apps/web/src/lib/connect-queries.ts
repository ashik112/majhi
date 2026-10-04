import type {
  CommandInput,
  CommandOutput,
  ConnectCatalog,
  ConnectFlowView,
  ConnectStatus,
} from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Under the connections key, so every connections event refetches them too. */
const key = (...rest: string[]) => [...queryKeys.connections, "connect", ...rest];

export function useConnectCatalog() {
  return useQuery<ConnectCatalog, ApiRequestError>({
    queryKey: key("catalog"),
    queryFn: () => cmd("connect.catalog", {}),
  });
}

export function useConnectStatus() {
  return useQuery<ConnectStatus[], ApiRequestError>({
    queryKey: key("status"),
    queryFn: () => cmd("connect.status", {}),
  });
}

const LIVE = new Set(["waiting", "checking", "confirm-account"]);

/** One connect attempt. It is polled once a second while it waits for the owner or for the service. */
export function useConnectFlow(flow: string | undefined) {
  return useQuery<ConnectFlowView, ApiRequestError>({
    queryKey: key("flow", flow ?? ""),
    enabled: flow !== undefined,
    queryFn: () => cmd("connect.flow", { flow: flow ?? "" }),
    refetchInterval: (query) =>
      query.state.data !== undefined && LIVE.has(query.state.data.state) ? 1000 : false,
  });
}

type ConnectCommand = "connect.start" | "connect.cancel" | "connect.confirmAccount" | "connect.disconnect";

export function useConnectCommand<N extends ConnectCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}
