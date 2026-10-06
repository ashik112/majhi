import type { CommandInput, CommandOutput, WikiPageId } from "@majhi/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, cmd } from "./api";
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
export function useWikiEstimate(org: string, project: string | undefined, enabled: boolean) {
  return useQuery<CommandOutput<"wiki.estimate">, ApiRequestError>({
    queryKey: [...scopeKey(org, project), "estimate"],
    queryFn: () => cmd("wiki.estimate", { org, ...(project === undefined ? {} : { project }) }),
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

/** What a command that this build of majhi may not have yet answered. */
export type Built = "done" | "not-built";

/**
 * Runs a wiki command another branch is adding (`wiki.answer`, `wiki.setRole`, a page update). When the
 * server has no such command it answers 404 and the result is "not-built", so the screen says so instead of
 * showing a result nothing produced. Any other failure is an error as usual.
 */
export async function runWhenBuilt(name: string, input: object): Promise<Built> {
  let res: Response;
  try {
    res = await fetch(`/api/cmd/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    throw new ApiRequestError(name, 0, "majhi is not responding", [String(cause)]);
  }
  if (res.status === 404) return "not-built";
  if (!res.ok) throw new ApiRequestError(name, res.status, `${name} failed with HTTP ${res.status}`);
  return "done";
}

/** A wiki command that may not exist yet, run as a mutation; the wiki refetches when it is done. */
export function useWikiWhenBuilt(name: string) {
  const client = useQueryClient();
  return useMutation<Built, ApiRequestError, object>({
    mutationFn: (input) => runWhenBuilt(name, input),
    onSuccess: (built) => {
      if (built === "done") return client.invalidateQueries({ queryKey: queryKeys.wiki });
    },
  });
}
