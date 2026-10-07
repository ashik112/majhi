import type { ClientList, CommandOutput } from "@majhi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** `chat.list`: the clients' chats and New chats. The `clients` topic refetches it. */
export function useClients() {
  return useQuery<ClientList, ApiRequestError>({
    queryKey: queryKeys.clients,
    queryFn: () => cmd("chat.list", {}),
  });
}

function useRefetch() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.clients }),
      client.invalidateQueries({ queryKey: queryKeys.conversations }),
      client.invalidateQueries({ queryKey: queryKeys.decisions }),
    ]);
}

export function useLinkChat() {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.link">, ApiRequestError, { room: string; org: string }>({
    mutationFn: (input) => cmd("chat.link", input),
    onSuccess: done,
  });
}

export function useIgnoreChat() {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.ignore">, ApiRequestError, { room: string }>({
    mutationFn: (input) => cmd("chat.ignore", input),
    onSuccess: done,
  });
}

export function useChatHolder() {
  const done = useRefetch();
  return useMutation<
    CommandOutput<"chat.holder">,
    ApiRequestError,
    { room: string; holder: "captain" | "you" }
  >({
    mutationFn: (input) => cmd("chat.holder", input),
    onSuccess: done,
  });
}

export function useChatSend() {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.send">, ApiRequestError, { room: string; text: string }>({
    mutationFn: (input) => cmd("chat.send", input),
    onSuccess: done,
  });
}

/** Send or discard a held reply: the outbound gate's own decision. */
export function useDecideReply() {
  const done = useRefetch();
  return useMutation<
    CommandOutput<"outbound.decide">,
    ApiRequestError,
    { id: number; decision: "send" | "discard" }
  >({
    mutationFn: (input) => cmd("outbound.decide", input),
    onSuccess: done,
  });
}

export function useEditReply() {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.editReply">, ApiRequestError, { draft: number; text: string }>({
    mutationFn: (input) => cmd("chat.editReply", input),
    onSuccess: done,
  });
}

export function useSamePerson() {
  const done = useRefetch();
  return useMutation<
    CommandOutput<"chat.samePerson">,
    ApiRequestError,
    { room: string; item: string; answer: "same" | "not-same" }
  >({
    mutationFn: (input) => cmd("chat.samePerson", input),
    onSuccess: done,
  });
}

export function useUndoMerge() {
  const done = useRefetch();
  return useMutation<CommandOutput<"contacts.undoMerge">, ApiRequestError, { merge: number }>({
    mutationFn: (input) => cmd("contacts.undoMerge", input),
    onSuccess: done,
  });
}

export function useConfirmWebhook() {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.confirmWebhook">, ApiRequestError, { connection: string }>({
    mutationFn: (input) => cmd("chat.confirmWebhook", input),
    onSuccess: done,
  });
}
