import { TerminalClientMessageSchema } from "@majhi/shared";
import type { WebSocket } from "ws";
import type { Terminal } from "./manager.ts";

const POLICY_VIOLATION = 1008;

/** Connects one WebSocket to a terminal: output out, input and resize in. Every client message is checked. */
export function serveTerminal(ws: WebSocket, terminal: Terminal): void {
  const stop = terminal.subscribe((message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  });
  ws.on("message", (raw) => {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      ws.close(POLICY_VIOLATION, "Messages must be JSON");
      return;
    }
    const message = TerminalClientMessageSchema.safeParse(json);
    if (!message.success) {
      ws.close(POLICY_VIOLATION, "Invalid message");
      return;
    }
    if (message.data.type === "input") terminal.write(message.data.data);
    else terminal.resize(message.data.cols, message.data.rows);
  });
  ws.on("close", stop);
  ws.on("error", stop);
}
