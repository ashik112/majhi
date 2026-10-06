import type { CommandInput, CommandOutput, WikiPageId } from "@majhi/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** The wiki (docs/design/wiki.md). The `wiki` topic refetches all of them. */

const scopeKey = (org: string, project: string | undefined) => [...queryKeys.wiki, org, project ?? ""];

/** `wiki.get`: whether the wiki is on, its page list and each project's state. */
export function useWiki(org: string | undefined, project: string | undefined) {
  return useQuery<CommandOutput<"wiki.get">, ApiRequestError>({
    queryKey: [...scopeKey(org ?? "", project), "get"],
    queryFn: () => cmd("wiki.get", { org: org ?? "", ...(project === undefined ? {} : { project }) }),
    enabled: org !== undefined,
    // How far behind a project is moves with its repo, which no event reports.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

function pageInput(org: string, project: string | undefined, id: WikiPageId) {
  return { org, id, ...(project === undefined ? {} : { project }) };
}

/** `wiki.page` for every page of a scope: the list shows each page's steps and out-of-date mark, so it reads them all. */
export function useWikiPages(
  org: string | undefined,
  project: string | undefined,
  ids: readonly WikiPageId[],
) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: [...scopeKey(org ?? "", project), "page", id],
      queryFn: () => cmd("wiki.page", pageInput(org ?? "", project, id)),
      enabled: org !== undefined,
    })),
  });
}

/** `wiki.estimate`: what Update would rewrite and cost. Read only when the owner asks. */
export function useWikiEstimate(
  org: string,
  project: string | undefined,
  enabled: boolean,
  page?: WikiPageId,
) {
  return useQuery<CommandOutput<"wiki.estimate">, ApiRequestError>({
    queryKey: [...scopeKey(org, project), "estimate", page ?? ""],
    queryFn: () =>
      cmd("wiki.estimate", {
        org,
        ...(project === undefined ? {} : { project }),
        ...(page === undefined ? {} : { page }),
      }),
    enabled,
    retry: false,
    staleTime: 0,
  });
}

export function useWikiUpdate() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"wiki.update">, ApiRequestError, CommandInput<"wiki.update">>({
    mutationFn: (input) => cmd("wiki.update", input, { reason: "Owner updated the wiki" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.wiki }),
  });
}

/** `wiki.ask`: a question in plain words, answered from the pages. */
export function useWikiAsk() {
  return useMutation<CommandOutput<"wiki.ask">, ApiRequestError, CommandInput<"wiki.ask">>({
    mutationFn: (input) => cmd("wiki.ask", input),
  });
}

/** `wiki.system`: how a workspace's projects connect, the calls that link nowhere and the addresses to ask the owner about. */
export function useWikiSystem(org: string | undefined) {
  return useQuery<CommandOutput<"wiki.system">, ApiRequestError>({
    queryKey: [...scopeKey(org ?? "", undefined), "system"],
    queryFn: () => cmd("wiki.system", { org: org ?? "" }),
    enabled: org !== undefined,
  });
}

/** `wiki.answer`: what the owner says an address or a call is. It answers the new system view, so the lists update at once. */
export function useWikiAnswer() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"wiki.answer">, ApiRequestError, CommandInput<"wiki.answer">>({
    mutationFn: (input) => cmd("wiki.answer", input, { reason: "Owner answered a wiki question" }),
    // The system view is left as it is, so an answered question stays on the page with its Undo until the page is left.
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: queryKeys.wiki,
        predicate: (q) => !q.queryKey.includes("system"),
      }),
  });
}

/** `wiki.setRole`: confirm a guessed role, change it, or take the choice back. */
export function useWikiSetRole() {
  const client = useQueryClient();
  return useMutation<CommandOutput<"wiki.setRole">, ApiRequestError, CommandInput<"wiki.setRole">>({
    mutationFn: (input) => cmd("wiki.setRole", input, { reason: "Owner decided a role in the wiki" }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.wiki }),
  });
}
