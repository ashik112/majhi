import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ServerEventSchema } from "@majhi/shared";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventHub } from "./events/hub.ts";
import { isLoopbackOrigin } from "./http/app.ts";
import type { TerminalManager } from "./terminal/manager.ts";
import { serveTerminal } from "./terminal/socket.ts";

/** What the node server gives us: an `upgrade` event. */
export interface UpgradeSource {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

const TERMINAL_PATH = /^\/api\/term\/([A-Za-z0-9-]{1,64})$/;

/**
 * Routes WebSocket upgrades: `/api/events` and `/api/term/<id>`. Like
 * `POST /api/cmd`, only pages served from this machine may connect.
 */
export function attachSockets(
  server: UpgradeSource,
  deps: { events: EventHub; terminals: TerminalManager },
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
  ws.on("close", stop);
  ws.on("error", stop);
  // Clients send nothing on this channel. Ignore whatever arrives.
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
