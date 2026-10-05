import { BROWSER_TAB_REPORT_MS, type EventsClientMessage } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { currentPermission, showAttention } from "./browser-notify";
import { setHelloBuild } from "./build-watch";
import {
  ALL_TOPICS,
  closeSocket,
  feedStep,
  parseServerEvent,
  reconnectDelay,
  topicQueryKeys,
  wsUrl,
} from "./events-model";
import { setFeedOpen } from "./feed-status";
import { queryKeys } from "./queries";
import { taskSync } from "./task-sync";
import { throttledInvalidator } from "./throttled-invalidate";
import { bindTypingSender } from "./typing-signal";

/**
 * Keeps one WebSocket to `/api/events` open and refetches the queries of every topic the server
 * reports as changed. An event that names its tasks reads just those tasks and patches the lists.
 * Reconnects with backoff; after a reconnect, or when a frame's number skips (one was lost), it
 * refetches everything once. Mount once, in the shell.
 *
 * The tab also tells the server, on connect and every 20 s, whether it can pop browser
 * notifications. While one can, the server leaves out the desktop banner, so the owner gets one alert.
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

    const report = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const message: EventsClientMessage = {
        type: "browser-notify",
        active: currentPermission() === "granted",
      };
      socket.send(JSON.stringify(message));
    };
    const heartbeat = window.setInterval(report, BROWSER_TAB_REPORT_MS);
    bindTypingSender((message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    });

    const throttled = throttledInvalidator(client);
    const invalidate = (topics: readonly (typeof ALL_TOPICS)[number][]) => {
      for (const topic of topics) {
        for (const queryKey of topicQueryKeys(topic)) throttled.invalidate(queryKey);
      }
    };

    const sync = taskSync(client);
    // The number of the last frame of this connection.
    let lastSeq: number | undefined;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(wsUrl("/api/events", window.location));
      socket = ws;
      // The feed is the first to know the server went away or came back: check the pill now.
      const checkHealth = () => void client.refetchQueries({ queryKey: queryKeys.health });
      ws.onopen = () => {
        setFeedOpen(true);
        attempt = 0;
        lastSeq = undefined;
        checkHealth();
        if (everConnected) invalidate(ALL_TOPICS);
        everConnected = true;
        report();
      };
      ws.onmessage = (message) => {
        const event = parseServerEvent(message.data);
        if (event === null) return;
        if (event.type === "hello") {
          setHelloBuild(event.build);
          return;
        }
        if (event.type === "attention") showAttention(event, (path) => router.history.push(path));
        const step = feedStep(lastSeq, event);
        lastSeq = step.seq;
        if (step.full) {
          invalidate(ALL_TOPICS);
          return;
        }
        for (const key of step.plan.keys) throttled.invalidate(key);
        if (step.plan.tasks.length > 0) sync.touch(step.plan.tasks, step.plan.waits);
      };
      ws.onclose = () => {
        if (stopped) return;
        setFeedOpen(false);
        checkHealth();
        timer = window.setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      throttled.stop();
      sync.stop();
      bindTypingSender(null);
      if (socket) closeSocket(socket);
    };
  }, [client, router]);
}
