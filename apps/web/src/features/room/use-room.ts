import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { cmd } from "@/lib/api";
import { closeSocket, reconnectDelay, wsUrl } from "@/lib/events-model";
import { setTaskInCache } from "@/lib/task-queries";
import {
  emptyRoom,
  newestSeq,
  oldestSeq,
  parseRoomMessage,
  type RoomState,
  roomReducer,
  taskFromMessage,
} from "./model";

/** Rooms already opened this session, so going back to a task shows its messages at once. */
const roomCache = new Map<string, RoomState>();
/** The cache holds a few dozen rooms at most; the oldest is dropped past this. */
const CACHE_LIMIT = 30;

function remember(taskId: string, state: RoomState): void {
  roomCache.delete(taskId);
  roomCache.set(taskId, state);
  if (roomCache.size > CACHE_LIMIT) {
    const first = roomCache.keys().next();
    if (!first.done) roomCache.delete(first.value);
  }
}

/**
 * One task's room: the socket at `/api/tasks/<id>/room` (snapshot, then upserts), reconnecting with
 * backoff. Every reconnect brings a fresh snapshot, which is merged in. State is cached per task.
 */
export function useRoom(taskId: string) {
  const client = useQueryClient();
  const [state, dispatch] = useReducer(roomReducer, taskId, (id) => {
    // A window around a search match is not kept: the room opens at its newest messages again.
    const cached = roomCache.get(id);
    return {
      ...(cached === undefined || cached.newer ? emptyRoom : cached),
      connection: "connecting" as const,
    };
  });
  useEffect(() => remember(taskId, state), [taskId, state]);
  const loadingOlder = useRef(false);
  const loadingNewer = useRef(false);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(wsUrl(`/api/tasks/${encodeURIComponent(taskId)}/room`, window.location));
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
      };
      ws.onmessage = (event) => {
        const message = parseRoomMessage(event.data);
        if (!message) return;
        const task = taskFromMessage(message);
        if (task) setTaskInCache(client, task);
        else dispatch({ type: "message", message });
      };
      ws.onclose = () => {
        if (stopped) return;
        dispatch({ type: "connection", connection: "reconnecting" });
        timer = window.setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (socket) closeSocket(socket);
    };
  }, [taskId, client]);

  /** Loads the page of items before the oldest one held. */
  const loadOlder = useCallback(async () => {
    const current = latest.current;
    if (loadingOlder.current || !current.more) return;
    loadingOlder.current = true;
    try {
      const beforeSeq = oldestSeq(current.items);
      const page = await cmd("room.items", {
        task: taskId,
        limit: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      dispatch({ type: "older", items: page.items, more: page.more });
    } catch {
      // The next scroll to the top tries again.
    } finally {
      loadingOlder.current = false;
    }
  }, [taskId]);

  /** Replaces the room's items with the page around a search match; false when it is not in the room. */
  const loadAround = useCallback(
    async (item: string) => {
      try {
        const page = await cmd("room.around", { task: taskId, item, limit: 100 });
        if (page.items.length === 0) return false;
        dispatch({ type: "window", items: page.items, older: page.older, newer: page.newer });
        return true;
      } catch {
        return false;
      }
    },
    [taskId],
  );

  /** While around a match: the next page of newer items. */
  const loadNewer = useCallback(async () => {
    const current = latest.current;
    if (loadingNewer.current || !current.newer) return;
    const afterSeq = newestSeq(current.items);
    if (afterSeq === undefined) return;
    loadingNewer.current = true;
    try {
      const page = await cmd("room.items", { task: taskId, limit: 100, afterSeq });
      dispatch({ type: "newer", items: page.items, more: page.more });
    } catch {
      // The next scroll to the bottom tries again.
    } finally {
      loadingNewer.current = false;
    }
  }, [taskId]);

  /** Leaves a window around a match for the newest messages. */
  const loadLatest = useCallback(async () => {
    try {
      const page = await cmd("room.items", { task: taskId, limit: 200 });
      dispatch({ type: "latest", items: page.items, more: page.more });
    } catch {
      // The button stays; try again.
    }
  }, [taskId]);

  return { state, dispatch, loadOlder, loadAround, loadNewer, loadLatest };
}
