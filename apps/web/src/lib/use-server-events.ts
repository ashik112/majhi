import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { showAttention } from "./browser-notify";
import { ALL_TOPICS, parseServerEvent, reconnectDelay, topicQueryKeys, wsUrl } from "./events-model";

/**
 * Keeps one WebSocket to `/api/events` open and refetches the queries of every topic the server
 * reports as changed. Reconnects with backoff; after a reconnect it refetches everything, since
 * events may have been missed while the feed was down. Mount once, in the shell.
 */
export function useServerEvents(): void {
  const client = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let everConnected = false;
    let stopped = false;

    const invalidate = (topics: readonly (typeof ALL_TOPICS)[number][]) => {
      for (const topic of topics) {
        for (const queryKey of topicQueryKeys(topic)) void client.invalidateQueries({ queryKey });
      }
    };

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(wsUrl("/api/events", window.location));
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        if (everConnected) invalidate(ALL_TOPICS);
        everConnected = true;
      };
      ws.onmessage = (message) => {
        const event = parseServerEvent(message.data);
        if (event === null) return;
        if (event.type === "attention") {
          showAttention(event, (path) => router.history.push(path));
          // The item is new: the lists that count it must show it at once.
          invalidate(["tasks"]);
        } else invalidate(event.topics);
      };
      ws.onclose = () => {
        if (stopped) return;
        timer = window.setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [client, router]);
}
