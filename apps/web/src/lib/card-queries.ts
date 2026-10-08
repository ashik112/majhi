import type { CommandOutput, ProjectCard } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";

export const cardKeys = { all: ["project-cards"] } as const;

/** The knowledge card of every project, by project id. One request for the whole page. */
export function useProjectCards() {
  return useQuery<CommandOutput<"projects.cards">, ApiRequestError, Map<string, ProjectCard>>({
    queryKey: cardKeys.all,
    queryFn: () => cmd("projects.cards", {}),
    select: (cards) => new Map(cards.map((c) => [c.project, c])),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Reads the repo's files again and rewrites the card. */
export function useRefreshCard() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.cardRefresh">, ApiRequestError, string>({
    mutationFn: (project) => cmd("projects.cardRefresh", { project }, { reason: "Owner pressed Refresh" }),
    onSuccess: () => client.invalidateQueries({ queryKey: cardKeys.all }),
  });
}

/** What a check command runs before ship, in its read-only form (nothing is run to find out). */
export function useCheckLine(project: string, command: string) {
  return useQuery<CommandOutput<"projects.checkLine">, ApiRequestError>({
    queryKey: [...cardKeys.all, "line", project, command],
    queryFn: () => cmd("projects.checkLine", { project, command }),
    enabled: command !== "",
    staleTime: 60_000,
  });
}
