import type {
  CommandInput,
  CommandOutput,
  McpInstallResult,
  McpPreview,
  McpSearchResult,
  Skill,
  SkillInstallResult,
  SkillSearchResult,
} from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd, uploadFile } from "./api";
import { queryKeys } from "./queries";

export function useSkills() {
  return useQuery<Skill[], ApiRequestError>({
    queryKey: queryKeys.skills,
    queryFn: () => cmd("skills.list", {}),
  });
}

/** Directory results for a query of at least two characters. Not refetched while it is the same query. */
export function useSkillSearch(query: string) {
  const text = query.trim();
  return useQuery<SkillSearchResult[], ApiRequestError>({
    queryKey: ["directory", "skills", text],
    queryFn: () => cmd("skills.search", { query: text }),
    enabled: text.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useMcpSearch(query: string) {
  const text = query.trim();
  return useQuery<McpSearchResult[], ApiRequestError>({
    queryKey: ["directory", "mcp", text],
    queryFn: () => cmd("mcp.search", { query: text }),
    enabled: text.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

type SkillCommand =
  | "skills.install"
  | "skills.update"
  | "skills.enable"
  | "skills.enableAll"
  | "skills.disable"
  | "skills.remove"
  | "mcp.install"
  | "mcp.enable"
  | "mcp.disable";

/**
 * A skills or MCP command that changes something. The skill list, the connections and the agents
 * refetch after it: an agent's file or a connection's agent list may have changed.
 */
export function useSkillsCommand<N extends SkillCommand>(name: N) {
  const client = useQueryClient();
  return useMutation<CommandOutput<N>, ApiRequestError, CommandInput<N>>({
    mutationFn: (input) => cmd(name, input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.skills }),
        client.invalidateQueries({ queryKey: queryKeys.connections }),
        client.invalidateQueries({ queryKey: queryKeys.agents }),
      ]),
  });
}

/** Uploads a zip and previews installing it. The preview is committed with `skills.install {confirm}`. */
export function useSkillZipPreview() {
  return useMutation<SkillInstallResult, ApiRequestError, { file: File }>({
    mutationFn: async ({ file }) => {
      const upload = await uploadFile(file);
      return cmd("skills.install", { upload: upload.id });
    },
  });
}

export type { McpInstallResult, McpPreview };
