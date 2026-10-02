import {
  type CloneJob,
  type CommandInput,
  type CommandOutput,
  type MrHost,
  type OnboardingStatus,
  SIGN_IN_ENDED,
  type SignInStatus,
} from "@majhi/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * The reads and writes of the onboarding journey and git connect (docs/briefs/onboarding-and-git-connect.md).
 * Server events refetch them: `signins`, `clones`, and `config` for the status.
 */

/** `onboarding.status`. Not retried: when the server cannot answer it, the journey works it out itself. */
export function useOnboardingStatus(enabled = true) {
  return useQuery<OnboardingStatus, ApiRequestError>({
    queryKey: queryKeys.onboarding,
    queryFn: () => cmd("onboarding.status", {}),
    enabled,
    retry: false,
  });
}

export function useSignInStart() {
  return useMutation<CommandOutput<"git.signIn.start">, ApiRequestError, CommandInput<"git.signIn.start">>({
    mutationFn: (input) => cmd("git.signIn.start", input, { reason: "Owner signed a workspace in to git" }),
  });
}

/** One sign-in flow, polled every 2 s while it is pending. The `signins` topic refetches it sooner. */
export function useSignInPoll(signIn: string | undefined) {
  return useQuery<SignInStatus, ApiRequestError>({
    queryKey: [...queryKeys.signins, signIn],
    queryFn: () => cmd("git.signIn.poll", { signIn: signIn ?? "" }),
    enabled: signIn !== undefined,
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state !== undefined && SIGN_IN_ENDED.has(state) ? false : 2_000;
    },
  });
}

export function useSignInCancel() {
  return useMutation<CommandOutput<"git.signIn.cancel">, ApiRequestError, string>({
    mutationFn: (signIn) => cmd("git.signIn.cancel", { signIn }),
  });
}

export interface RemoteReposQuery {
  org: string;
  kind: MrHost;
  host?: string | undefined;
  query: string;
  page: number;
}

/** One page of a workspace's remote repos. Keeps the last page on screen while the next loads. */
export function useRemoteRepos(input: RemoteReposQuery | undefined) {
  return useQuery<CommandOutput<"git.remoteRepos">, ApiRequestError>({
    queryKey: [...queryKeys.remoteRepos, input],
    queryFn: () =>
      cmd("git.remoteRepos", {
        org: input?.org ?? "",
        kind: input?.kind ?? "github",
        ...(input?.host ? { host: input.host } : {}),
        ...(input?.query ? { query: input.query } : {}),
        page: input?.page ?? 1,
        perPage: 20,
      }),
    enabled: input !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
}

export function useClone() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.clone">, ApiRequestError, CommandInput<"projects.clone">>({
    mutationFn: (input) => cmd("projects.clone", input, { reason: "Owner cloned a repo during setup" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.clones }),
  });
}

const RUNNING: ReadonlySet<CloneJob["state"]> = new Set(["queued", "cloning", "registering"]);

/** Every clone job of the last hour, polled each second while one runs. */
export function useCloneStatus(enabled = true) {
  return useQuery<CommandOutput<"projects.cloneStatus">, ApiRequestError>({
    queryKey: queryKeys.clones,
    queryFn: () => cmd("projects.cloneStatus", {}),
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.jobs.some((j) => RUNNING.has(j.state)) ? 1_000 : false),
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.create">, ApiRequestError, CommandInput<"projects.create">>({
    mutationFn: (input) => cmd("projects.create", input, { reason: "Owner made a new project during setup" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.projects }),
        client.invalidateQueries({ queryKey: queryKeys.config }),
      ]),
  });
}

export function usePublishProject() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"projects.publish">, ApiRequestError, CommandInput<"projects.publish">>({
    mutationFn: (input) =>
      cmd("projects.publish", input, { reason: "Owner put a new project on a git host" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

/** Checks a pasted token with its host and saves it for one workspace. The token lives only in this call. */
export function useSignInToken() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"git.signIn.token">, ApiRequestError, CommandInput<"git.signIn.token">>({
    mutationFn: (input) =>
      cmd("git.signIn.token", input, { reason: "Owner pasted a git token for a workspace" }),
    onSuccess: (status) => {
      client.setQueryData([...queryKeys.signins, status.signIn], status);
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.config }),
        client.invalidateQueries({ queryKey: queryKeys.orgs }),
      ]);
    },
    gcTime: 0,
  });
}

/** Saves a sign-in whose account other workspaces already use, once the owner said yes. */
export function useSignInConfirm() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"git.signIn.confirm">, ApiRequestError, string>({
    mutationFn: (signIn) => cmd("git.signIn.confirm", { signIn }),
    onSuccess: (status) => client.setQueryData([...queryKeys.signins, status.signIn], status),
  });
}

/** Removes a workspace's signed-in token for one host, revoking it at the host where it can. */
export function useSignOut() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"git.signOut">, ApiRequestError, CommandInput<"git.signOut">>({
    mutationFn: (input) => cmd("git.signOut", input, { reason: "Owner signed a workspace out of git" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.config }),
        client.invalidateQueries({ queryKey: queryKeys.orgs }),
      ]),
  });
}
