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

/** `chat.channels`: the channels of a chat connection's workspace. The `clients` topic refetches it. */
export function useChannels(connection: string, enabled: boolean) {
  return useQuery<CommandOutput<"chat.channels">, ApiRequestError>({
    queryKey: [...queryKeys.clients, "channels", connection],
    queryFn: () => cmd("chat.channels", { connection }),
    enabled,
  });
}

/** Reads the channels from the app again, now. */
export function useRefreshChannels(connection: string) {
  const client = useQueryClient();
  return useMutation<CommandOutput<"chat.channels">, ApiRequestError, void>({
    mutationFn: () => cmd("chat.channels", { connection, refresh: true }),
    onSuccess: (data) => client.setQueryData([...queryKeys.clients, "channels", connection], data),
  });
}

export function useLinkChannel(connection: string) {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.channelLink">, ApiRequestError, { channel: string; org: string }>({
    mutationFn: (input) => cmd("chat.channelLink", { connection, ...input }),
    onSuccess: done,
  });
}

export function useIgnoreChannel(connection: string) {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.channelIgnore">, ApiRequestError, { channel: string }>({
    mutationFn: (input) => cmd("chat.channelIgnore", { connection, ...input }),
    onSuccess: done,
  });
}

/** `contacts.list`: the contacts of a workspace. The `clients` topic refetches it. */
export function useContacts(org: string | undefined) {
  return useQuery<CommandOutput<"contacts.list">, ApiRequestError>({
    queryKey: [...queryKeys.clients, "contacts", org],
    queryFn: () => cmd("contacts.list", { org: org ?? "" }),
    enabled: org !== undefined,
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

/** Stops a linked chat: its history stays, read only; it can be linked again as a fresh room. */
export function useUnlinkChat() {
  const done = useRefetch();
  const client = useQueryClient();
  return useMutation<CommandOutput<"chat.unlink">, ApiRequestError, { room: string }>({
    mutationFn: (input) => cmd("chat.unlink", input),
    onSuccess: async () => {
      await done();
      await client.invalidateQueries({ queryKey: [...queryKeys.clients, "channels"] });
    },
  });
}

/** Watch an ignored chat again. */
export function useUnignoreChat() {
  const done = useRefetch();
  return useMutation<CommandOutput<"chat.unignore">, ApiRequestError, { room: string }>({
    mutationFn: (input) => cmd("chat.unignore", input),
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

export function useMarkUs() {
  const done = useRefetch();
  return useMutation<
    CommandOutput<"chat.markUs">,
    ApiRequestError,
    { room: string; item: string; us: boolean }
  >({
    mutationFn: (input) => cmd("chat.markUs", input),
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
