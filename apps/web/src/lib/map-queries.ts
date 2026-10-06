import type { JourneyStep, MapAnswer, MapEstimate, MapRole, MapView } from "@majhi/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * The project map (SPEC 5.21). `map.get` is the page's one read; the `map` topic refetches it as an
 * update moves, and a minute poll keeps "merges since" and the open tasks honest.
 */
export function useMap(org: string | undefined) {
  return useQuery<MapView, ApiRequestError>({
    queryKey: [...queryKeys.map, "view", org ?? ""],
    queryFn: () => cmd("map.get", { org: org ?? "" }),
    enabled: org !== undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Not under the `map` key: its topic fires all through an update, and the estimate is read once after it. */
const ESTIMATE_KEY = ["map-estimate"] as const;

/** What the next update would read and cost. Read once per page open and after each update. */
export function useMapEstimate(org: string | undefined) {
  return useQuery<MapEstimate, ApiRequestError>({
    queryKey: [...ESTIMATE_KEY, org ?? ""],
    queryFn: () => cmd("map.estimate", { org: org ?? "" }),
    enabled: org !== undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

function useMapCommand<I = string>(org: string, run: (input: I) => Promise<MapView>) {
  const client = useQueryClient();
  return useMutation<MapView, ApiRequestError, I>({
    mutationFn: run,
    onSuccess: (view) => {
      client.setQueryData([...queryKeys.map, "view", org], view);
      void client.invalidateQueries({ queryKey: queryKeys.map });
      void client.invalidateQueries({ queryKey: ESTIMATE_KEY });
    },
  });
}

/** The one update action. Progress arrives through `map.get` while it runs. */
export function useUpdateMap(org: string) {
  return useMapCommand(org, () => cmd("map.update", { org }, { reason: "Owner updated the project map" }));
}

export function useConfirmEdge(org: string) {
  return useMapCommand(org, (id) =>
    cmd("map.confirmEdge", { org, id }, { reason: "Owner confirmed a map line" }),
  );
}

export function useRemoveEdge(org: string) {
  return useMapCommand(org, (id) =>
    cmd("map.removeEdge", { org, id }, { reason: "Owner removed a map line" }),
  );
}

/** What an address is: one of the projects, an outside service, not a call to show; without `to`, forgotten. */
export function useAnswerAddress(org: string) {
  return useMapCommand<{ address: string; scope?: string; to?: MapAnswer }>(org, (input) =>
    cmd("map.answer", { org, ...input }, { reason: "Owner answered what an address is" }),
  );
}

/** Name a journey, or replace one (with `id`). Keeping one of majhi's examples is a save without an id. */
export function useSaveJourney(org: string) {
  return useMapCommand<{ id?: string; name: string; steps: JourneyStep[] }>(org, (input) =>
    cmd("map.saveJourney", { org, ...input }, { reason: "Owner saved a journey" }),
  );
}

export function useRemoveJourney(org: string) {
  return useMapCommand(org, (id) =>
    cmd("map.removeJourney", { org, id }, { reason: "Owner removed a journey" }),
  );
}

export function useSetRole(org: string) {
  return useMapCommand<{ project: string; role?: MapRole }>(org, (input) =>
    cmd("map.setRole", { org, ...input }, { reason: "Owner set a project's role" }),
  );
}
