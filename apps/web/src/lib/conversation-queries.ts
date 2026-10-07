import type { Conversation, ConversationEvent } from "@majhi/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * The chat dock's one list (`conversations.list`): task rooms, captain threads, client chats and agent chats with their unread
 * counts. The events feed patches it row by row (`patchConversation`), so it is read once and again
 * only when the feed was down or lost a frame.
 */
export function useConversations<T = Conversation[]>(select?: (list: Conversation[]) => T) {
  return useQuery<Conversation[], ApiRequestError, T>({
    queryKey: queryKeys.conversations,
    queryFn: () => cmd("conversations.list", {}),
    staleTime: Number.POSITIVE_INFINITY,
    ...(select === undefined ? {} : { select }),
  });
}

const totalUnread = (list: Conversation[]): number =>
  list.reduce((n, c) => (c.archived === true ? n : n + c.unread), 0);

/** The badge: the unread total. A number, so only a change of the number renders the badge. */
export const useUnreadTotal = (): number => useConversations(totalUnread).data ?? 0;

/** Hides a conversation from the list, or brings it back. The feed patches the list. */
export function useArchiveConversation() {
  const client = useQueryClient();
  return useMutation<{ ok: true }, ApiRequestError, { id: string; archived: boolean }>({
    mutationFn: (input) => cmd("conversations.archive", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.conversations }),
  });
}

/** Marks a conversation read up to its newest line (the server never passes the newest agent message). */
export function useMarkConversationRead() {
  const client = useQueryClient();
  return useMutation<{ ok: true }, ApiRequestError, { id: string; upTo: string }>({
    mutationFn: (input) => cmd("conversations.markRead", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.conversations }),
  });
}

/** One conversation's unread count; zero for one that is not listed. */
export function useConversationUnread(id: string): number {
  const pick = useCallback((list: Conversation[]) => list.find((c) => c.id === id)?.unread ?? 0, [id]);
  return useConversations(pick).data ?? 0;
}

/** The list with one row replaced, added or removed, newest message first. */
export function withConversation(
  list: readonly Conversation[],
  id: string,
  row: Conversation | undefined,
): Conversation[] {
  const rest = list.filter((c) => c.id !== id);
  if (row === undefined) return rest;
  const at = rest.findIndex((c) => c.lastAt < row.lastAt);
  return at === -1 ? [...rest, row] : [...rest.slice(0, at), row, ...rest.slice(at)];
}

/** Applies a feed event to the cached list. Nothing is read from the server. */
export function patchConversation(client: QueryClient, event: ConversationEvent): void {
  client.setQueryData<Conversation[]>(queryKeys.conversations, (list) =>
    list === undefined ? list : withConversation(list, event.id, event.conversation),
  );
}

/** What was sent as read per conversation, so one view never sends the same mark twice. */
const sent = new Map<string, string>();

/**
 * Marks a conversation read while the owner looks at its newest message: `newestAt` is the `at` of
 * the newest agent message the screen holds. Used by every place that shows a room (the task page, the
 * captain thread, the dock), through `useRoom`. Does nothing while the tab is hidden, for a
 * conversation with nothing unread, or for one the dock does not list.
 */
export function useMarkRead(id: string, newestAt: string | undefined): void {
  const unread = useConversationUnread(id);
  const mark = useMutation<{ ok: true }, ApiRequestError, string>({
    mutationFn: (upTo) => cmd("conversations.markRead", { id, upTo }),
  });
  const send = mark.mutate;
  const client = useQueryClient();
  useEffect(() => {
    if (unread === 0 || newestAt === undefined) return;
    const go = () => {
      if (document.visibilityState !== "visible" || sent.get(id) === newestAt) return;
      sent.set(id, newestAt);
      send(newestAt, {
        onError: () => {
          // Try again on the next change; read the list once in case it moved on.
          sent.delete(id);
          void client.invalidateQueries({ queryKey: queryKeys.conversations });
        },
      });
    };
    go();
    document.addEventListener("visibilitychange", go);
    return () => document.removeEventListener("visibilitychange", go);
  }, [id, unread, newestAt, send, client]);
}
