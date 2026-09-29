import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { type RoomServerMessage, RoomServerMessageSchema } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
let server: Server | undefined;
afterEach(async () => {
  await w?.cleanup();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

async function listen(): Promise<string> {
  const majhi = w.h.majhi;
  server = serve({
    fetch: majhi.app.fetch,
    hostname: "127.0.0.1",
    port: 0,
    createServer,
  }) as unknown as Server;
  majhi.attach(server);
  await new Promise((r) => server?.once("listening", r));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const messages: RoomServerMessage[] = [];
  ws.on("message", (raw) => messages.push(RoomServerMessageSchema.parse(JSON.parse(raw.toString()))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, messages, opened };
}

async function _until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe("room socket", () => {
  it("refuses unknown tasks, other origins and other paths", async () => {
    w = await taskWorld();
    const base = await listen();
    await expect(connect(`${base}/api/tasks/ACM-9/room`).opened).rejects.toThrow("HTTP 404");
    await w.h.cmd("tasks.create", { text: "fix api", start: false });
    await expect(
      connect(`${base}/api/tasks/ACM-1/room`, { origin: "https://evil.example" }).opened,
    ).rejects.toThrow("HTTP 403");
    await expect(connect(`${base}/api/tasks/nope/room`).opened).rejects.toThrow("HTTP 404");
    const ok = connect(`${base}/api/tasks/ACM-1/room`, { origin: "http://localhost:5173" });
    await ok.opened;
    ok.ws.close();
  });
});
