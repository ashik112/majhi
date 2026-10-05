import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventHub } from "../events/hub.ts";
import { attachSockets } from "../sockets.ts";
import { TerminalManager } from "./manager.ts";

const ENV = { PATH: "/usr/bin:/bin" };

describe("login terminals over WebSocket", () => {
  let server: Server;
  let base: string;
  let terminals: TerminalManager;
  let events: EventHub;
  let close: () => void;

  beforeEach(async () => {
    terminals = new TerminalManager({ removeAfterExitMs: 200 });
    events = new EventHub();
    server = createServer();
    ({ close } = attachSockets(server, {
      events,
      terminals,
      rooms: { snapshot: () => undefined, subscribe: () => () => {} },
    }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    terminals.closeAll();
    close();
    await new Promise((r) => server.close(r));
  });

  const start = (script: string) =>
    terminals.start({ key: "k", command: "/bin/sh", args: ["-c", script], env: ENV, cwd: "/tmp" });

  it("rejects foreign origins on both sockets and unknown terminals", async () => {
    const terminal = start("sleep 5");
    const rejected = (path: string, origin?: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${base}${path}`, origin === undefined ? {} : { headers: { origin } });
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => {
          ws.close();
          resolve(101);
        });
      });

    expect(await rejected("/api/events", "https://evil.example")).toBe(403);
    expect(await rejected(`/api/term/${terminal.id}`, "https://evil.example")).toBe(403);
    expect(await rejected("/api/term/unknown-id")).toBe(404);
    expect(await rejected("/api/nothing")).toBe(404);
    expect(await rejected("/api/events", "http://localhost:5173")).toBe(101);
    expect(await rejected(`/api/term/${terminal.id}`, "http://127.0.0.1:7070")).toBe(101);
  });
});
