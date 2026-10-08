import type { NoticeList, NoticesMarkReadInput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * `notices.list`: the bell's feed. The events feed refetches it when a task, a client chat, the ops
 * watch or the captain changes (see `topicQueryKeys`), so it needs no timer.
 */
export function useNotices() {
  return useQuery<NoticeList, ApiRequestError>({
    queryKey: queryKeys.notices,
    queryFn: () => cmd("notices.list", {}),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The list as it is once some rows are read: the same rows with their marks, and the counts again. */
function withRead(list: NoticeList, input: NoticesMarkReadInput): NoticeList {
  const notices = list.notices.map((n) =>
    n.read || ("id" in input ? n.id !== input.id : n.at > input.upTo) ? n : { ...n, read: true },
  );
  const unread = notices.filter((n) => !n.read);
  return { notices, unread: unread.length, unreadNeedsYou: unread.filter((n) => n.needsYou).length };
}

/** Marks rows read: the list changes at once, and the server's answer settles it. */
export function useMarkNoticesRead() {
  const client = useQueryClient();
  return useMutation<{ ok: true }, ApiRequestError, NoticesMarkReadInput, { before: NoticeList | undefined }>({
    mutationFn: (input) => cmd("notices.markRead", input, { reason: "Owner read the bell" }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: queryKeys.notices });
      const before = client.getQueryData<NoticeList>(queryKeys.notices);
      if (before !== undefined) client.setQueryData(queryKeys.notices, withRead(before, input));
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before !== undefined) client.setQueryData(queryKeys.notices, context.before);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.notices }),
  });
}
