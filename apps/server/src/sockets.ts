import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  EventsClientMessageSchema,
  type RoomServerMessage,
  RoomServerMessageSchema,
  ServerEventSchema,
} from "@majhi/shared";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventHub } from "./events/hub.ts";
import { isLoopbackOrigin } from "./http/origin.ts";
import type { TerminalManager } from "./terminal/manager.ts";
import { serveTerminal } from "./terminal/socket.ts";

/** What the node server gives us: an `upgrade` event. */
export interface UpgradeSource {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

const TERMINAL_PATH = /^\/api\/term\/([A-Za-z0-9-]{1,64})$/;
const ROOM_PATH = /^\/api\/tasks\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]*)\/room$/;
/** A tab's report is a few dozen bytes. Anything longer is not one. */
const MAX_CLIENT_MESSAGE = 1024;

/** What the room socket needs from the task and room services. */
export interface RoomFeed {
  /** The first message for a task, or undefined when there is no such task. */
  snapshot(task: string): Extract<RoomServerMessage, { type: "snapshot" }> | undefined;
  subscribe(task: string, listener: (message: RoomServerMessage) => void): () => void;
}

/**
 * Routes WebSocket upgrades: `/api/events` and `/api/term/<id>`. Like
 * `POST /api/cmd`, only pages served from this machine may connect.
 */
export function attachSockets(
  server: UpgradeSource,
  deps: { events: EventHub; terminals: TerminalManager; rooms: RoomFeed },
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) return reject(socket, 403, "Forbidden");
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/api/events") {
      wss.handleUpgrade(req, socket, head, (ws) => serveEvents(ws, deps.events));
      return;
    }
    const match = TERMINAL_PATH.exec(path);
    if (match?.[1] !== undefined) {
      const terminal = deps.terminals.get(match[1]);
      if (terminal === undefined) return reject(socket, 404, "Not Found");
      wss.handleUpgrade(req, socket, head, (ws) => serveTerminal(ws, terminal));
      return;
    }
    const room = ROOM_PATH.exec(path);
    if (room?.[1] !== undefined) {
      const task = room[1];
      if (deps.rooms.snapshot(task) === undefined) return reject(socket, 404, "Not Found");
      wss.handleUpgrade(req, socket, head, (ws) => serveRoom(ws, task, deps.rooms));
      return;
    }
    reject(socket, 404, "Not Found");
  });

  return {
    close: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

function serveEvents(ws: WebSocket, events: EventHub): void {
  const stop = events.subscribe((event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ServerEventSchema.parse(event)));
  });
  const leave = () => {
    stop();
    events.tabs.drop(ws);
    events.typing.drop(ws);
  };
  ws.on("close", leave);
  ws.on("error", leave);
  // A tab sends whether it can pop browser notifications and which task the owner types in. Anything else is ignored.
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    if (text.length > MAX_CLIENT_MESSAGE) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const message = EventsClientMessageSchema.safeParse(json);
    if (!message.success) return;
    if (message.data.type === "browser-notify") events.tabs.report(ws, message.data.active, Date.now());
    else events.typing.report(ws, message.data.task);
  });
}

/**
 * One task's room: a snapshot, then every item, agent and task change. The listener is attached
 * before the snapshot is built, and items carry a `seq`, so nothing is lost between the two.
 */
function serveRoom(ws: WebSocket, task: string, rooms: RoomFeed): void {
  const send = (message: RoomServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(RoomServerMessageSchema.parse(message)));
  };
  const stop = rooms.subscribe(task, send);
  const snapshot = rooms.snapshot(task);
  if (snapshot === undefined) {
    stop();
    ws.close(1008, "No such task");
    return;
  }
  send(snapshot);
  ws.on("close", stop);
  ws.on("error", stop);
  // Clients send nothing on this channel. Actions go through commands.
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
