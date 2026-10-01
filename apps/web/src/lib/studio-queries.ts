import type {
  AccountModels,
  AccountUsage,
  AccountView,
  AgentEntry,
  CommandInput,
  CommandOutput,
  OrgView,
  ToolInfo,
} from "@majhi/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

// Reads ---------------------------------------------------------------------

export function useTools() {
  return useQuery<ToolInfo[], ApiRequestError>({
    queryKey: queryKeys.tools,
    queryFn: () => cmd("tools.list", {}),
    staleTime: 5 * 60_000,
  });
}

export function useOrgs() {
  return useQuery<OrgView[], ApiRequestError>({
    queryKey: queryKeys.orgs,
    queryFn: () => cmd("orgs.list", {}),
  });
}

export function useAccounts(enabled = true) {
  return useQuery<AccountView[], ApiRequestError>({
    queryKey: queryKeys.accounts,
    queryFn: () => cmd("accounts.list", {}),
    enabled,
  });
}

export function useAgents(enabled = true) {
  return useQuery<AgentEntry[], ApiRequestError>({
    queryKey: queryKeys.agents,
    queryFn: () => cmd("agents.list", {}),
    enabled,
  });
}

/** Models and efforts an account offers. Read over ACP by the server and cached there. */
export function useAccountModels(accountId: string | undefined) {
  return useQuery<AccountModels, ApiRequestError>({
    queryKey: [...queryKeys.accountModels, accountId],
    queryFn: () => cmd("accounts.models", { id: accountId ?? "" }),
    enabled: accountId !== undefined && accountId !== "",
    staleTime: 60_000,
    retry: false,
  });
}

export function useSuggestAccountId(tool: string, org: string) {
  return useQuery<{ id: string }, ApiRequestError>({
    queryKey: ["account-suggest-id", tool, org],
    queryFn: () => cmd("accounts.suggestId", { tool: tool as "claude" | "codex", org }),
    enabled: tool !== "" && org !== "",
    staleTime: 0,
    gcTime: 0,
  });
}

// Writes --------------------------------------------------------------------

function refresh(client: QueryClient, ...keys: (readonly string[])[]) {
  return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useCreateOrg() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"orgs.create">, ApiRequestError, CommandInput<"orgs.create">>({
    mutationFn: (input) => cmd("orgs.create", input),
    onSuccess: () => refresh(client, queryKeys.orgs),
  });
}

export function useUpdateOrg() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"orgs.update">, ApiRequestError, CommandInput<"orgs.update">>({
    mutationFn: (input) => cmd("orgs.update", input),
    onSuccess: () => refresh(client, queryKeys.orgs),
  });
}

export function useRenameOrg() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"orgs.rename">, ApiRequestError, CommandInput<"orgs.rename">>({
    mutationFn: (input) => cmd("orgs.rename", input),
    onSuccess: () =>
      refresh(
        client,
        queryKeys.orgs,
        queryKeys.agents,
        queryKeys.accounts,
        queryKeys.projects,
        queryKeys.tasks,
        queryKeys.settings,
      ),
  });
}

export function useRenameAgent() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"agents.rename">, ApiRequestError, CommandInput<"agents.rename">>({
    mutationFn: (input) => cmd("agents.rename", input),
    onSuccess: () =>
      refresh(
        client,
        queryKeys.agents,
        queryKeys.accounts,
        queryKeys.orgs,
        queryKeys.tasks,
        queryKeys.settings,
      ),
  });
}

export function useCreateAccount() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"accounts.create">, ApiRequestError, CommandInput<"accounts.create">>({
    mutationFn: (input) => cmd("accounts.create", input),
    onSuccess: () => refresh(client, queryKeys.accounts, queryKeys.orgs),
  });
}

export function useRemoveAccount() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"accounts.remove">, ApiRequestError, string>({
    mutationFn: (id) => cmd("accounts.remove", { id }),
    onSuccess: () => refresh(client, queryKeys.accounts, queryKeys.orgs),
  });
}

/** Hides a model of an account from `auto` picks, or shows it again. */
export function useHideModel() {
  const client = useQueryClient();
  return useMutation<
    CommandOutput<"accounts.hideModel">,
    ApiRequestError,
    { id: string; model: string; hidden: boolean }
  >({
    mutationFn: (input) => cmd("accounts.hideModel", input),
    onSuccess: () => refresh(client, queryKeys.accounts),
  });
}

export function useStartLogin() {
  return useMutation<CommandOutput<"accounts.login.start">, ApiRequestError, string>({
    mutationFn: (id) => cmd("accounts.login.start", { id }),
  });
}

export function useAccountHealth() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"accounts.health">, ApiRequestError, string>({
    mutationFn: (id) => cmd("accounts.health", { id }),
    onSuccess: () => refresh(client, queryKeys.accounts),
  });
}

/** Reads the account's usage windows from the tool now. Spends no model tokens. */
export function useRefreshUsage() {
  const client = useQueryClient();
  return useMutation<AccountUsage | null, ApiRequestError, string>({
    mutationFn: (id) => cmd("accounts.usage", { id, refresh: true }),
    onSuccess: () => refresh(client, queryKeys.accounts),
  });
}

export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"agents.create">, ApiRequestError, CommandInput<"agents.create">>({
    mutationFn: (input) => cmd("agents.create", input),
    onSuccess: () => refresh(client, queryKeys.agents, queryKeys.accounts, queryKeys.orgs),
  });
}

/** Does not refetch on success: the editor keeps its own draft, and the server's change event refreshes the list. */
export function useUpdateAgent() {
  return useMutation<CommandOutput<"agents.update">, ApiRequestError, CommandInput<"agents.update">>({
    mutationFn: (input) => cmd("agents.update", input),
  });
}

export function useDuplicateAgent() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"agents.duplicate">, ApiRequestError, CommandInput<"agents.duplicate">>({
    mutationFn: (input) => cmd("agents.duplicate", input),
    onSuccess: () => refresh(client, queryKeys.agents, queryKeys.accounts, queryKeys.orgs),
  });
}

export function useRemoveAgent() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"agents.remove">, ApiRequestError, string>({
    mutationFn: (id) => cmd("agents.remove", { id }),
    onSuccess: () =>
      refresh(client, queryKeys.agents, queryKeys.accounts, queryKeys.orgs, queryKeys.settings),
  });
}

export function useAgentHealth() {
  return useMutation<CommandOutput<"agents.health">, ApiRequestError, string>({
    mutationFn: (id) => cmd("agents.health", { id }),
  });
}

export function useSetBoss() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"boss.set">, ApiRequestError, string>({
    mutationFn: (id) => cmd("boss.set", { id }),
    onSuccess: () => refresh(client, queryKeys.agents, queryKeys.config),
  });
}

/** Names and references of the saved secrets. Values never reach the browser. */
export function useSecrets() {
  return useQuery({
    queryKey: queryKeys.secrets,
    queryFn: () => cmd("secrets.list", {}),
  });
}

export function useSaveSecret() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"secrets.save">, ApiRequestError, CommandInput<"secrets.save">>({
    mutationFn: (input) => cmd("secrets.save", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.secrets }),
  });
}

/** The accounts this Mac is logged in as per git host (gh, glab, SSH keys). Never holds a token. */
export function useGitLogins() {
  return useQuery<CommandOutput<"git.logins">, ApiRequestError>({
    queryKey: ["git-logins"],
    queryFn: () => cmd("git.logins", {}),
    staleTime: 60_000,
    retry: false,
  });
}

/** Saves a gh or glab login as one org's token for its host. */
export function useUseGitLogin() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"orgs.useGitLogin">, ApiRequestError, CommandInput<"orgs.useGitLogin">>({
    mutationFn: (input) => cmd("orgs.useGitLogin", input),
    onSuccess: () => refresh(client, queryKeys.orgs, queryKeys.secrets, queryKeys.tasks),
  });
}

/** Uses the Mac's saved https login as an org account's token, when the host's API accepts it. */
export function useUseSavedLogin() {
  const client = useQueryClient();
  return useMutation<
    CommandOutput<"orgs.useSavedLogin">,
    ApiRequestError,
    CommandInput<"orgs.useSavedLogin">
  >({
    mutationFn: (input) => cmd("orgs.useSavedLogin", input),
    onSuccess: () => refresh(client, queryKeys.orgs, queryKeys.secrets),
  });
}

/** How a project pushes its MR remote over SSH. */
export function usePushRoute(id: string) {
  return useQuery<CommandOutput<"projects.pushRoute">, ApiRequestError>({
    queryKey: [...queryKeys.projects, "push-route", id],
    queryFn: () => cmd("projects.pushRoute", { id }),
    retry: false,
  });
}

/** Binds or removes an org's git account on a host. */
export function useSetGitAccount() {
  const client = useQueryClient();
  const done = () => refresh(client, queryKeys.orgs, queryKeys.secrets);
  const set = useMutation<
    CommandOutput<"orgs.setGitAccount">,
    ApiRequestError,
    CommandInput<"orgs.setGitAccount">
  >({
    mutationFn: (input) => cmd("orgs.setGitAccount", input),
    onSuccess: done,
  });
  const remove = useMutation<
    CommandOutput<"orgs.removeGitAccount">,
    ApiRequestError,
    CommandInput<"orgs.removeGitAccount">
  >({ mutationFn: (input) => cmd("orgs.removeGitAccount", input), onSuccess: done });
  return { set, remove };
}
