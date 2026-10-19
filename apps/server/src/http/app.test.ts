import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import type { EventHub } from "../events/hub.ts";
import { createMajhiApp } from "../server.ts";
import { attachSockets, type UpgradeSource } from "../sockets.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { tempDir, testEnv } from "../testing/fixtures.ts";
import { isLoopbackOrigin, isOwnerOrigin } from "./origin.ts";

describe("HTTP API", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let env: ServerEnv;
  let app: Hono;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    env = testEnv(dir, { version: "1.2.3-test" });
    app = createMajhiApp(env);
  });
  afterEach(() => cleanup());

  const cmd = (name: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/cmd/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? null : JSON.stringify(body),
    });

  it("blocks commands from other websites and unrelated loopback pages", async () => {
    const evil = await cmd("workspaces.set", { workspaces: ["/"] }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const unrelated = await cmd("config.get", {}, { origin: "http://127.0.0.1:5173" });
    expect(unrelated.status).toBe(403);
    const local = await cmd("config.get", {}, { origin: env.origin });
    expect(local.status).toBe(200);

    // A simple POST with no Origin header is not a command.
    const simple = await app.request("/api/cmd/config.get", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(simple.status).toBe(415);
    expect((await cmd("config.get", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);

    // Uploads from another port, and from an opaque origin (a sandboxed agent page sends `Origin: null`).
    for (const origin of ["http://127.0.0.1:9999", "null"]) {
      const upload = await app.request("/api/uploads", {
        method: "POST",
        headers: { origin },
        body: new FormData(),
      });
      expect(upload.status, origin).toBe(403);
    }
    expect((await cmd("config.get", {}, { origin: "null" })).status).toBe(403);
    expect(isLoopbackOrigin("null")).toBe(false);

    // Malformed origins and other schemes or ports are not the owner's page.
    for (const origin of [
      "null",
      "http://127.0.0.1:9999",
      "https://127.0.0.1:7070",
      "http://localhost:9999",
      "https://localhost:7070",
      "http://user@127.0.0.1:7070",
      `${env.origin}/evil`,
    ]) {
      expect(isOwnerOrigin(origin, env.origin), origin).toBe(false);
    }
    expect(isOwnerOrigin(env.origin, env.origin)).toBe(true);
    expect(isOwnerOrigin("http://localhost:7070", "http://127.0.0.1:7070")).toBe(true);
    expect(isOwnerOrigin("http://[::1]:7070", "http://127.0.0.1:7070")).toBe(true);

    // A runner peer is refused on the socket too, even when it forges the owner's origin.
    let upgrade: Parameters<UpgradeSource["on"]>[1] | undefined;
    const sockets = attachSockets(
      {
        on: (_event, listener) => {
          upgrade = listener;
        },
      },
      {
        origin: "http://127.0.0.1:7070",
        isRunner: () => true,
        // The refusal comes before the hub or the terminals are touched.
        events: {} as unknown as EventHub,
        terminals: {} as unknown as TerminalManager,
        rooms: { snapshot: () => undefined, subscribe: () => () => undefined },
      },
    );
    const req = new IncomingMessage(new Socket());
    req.url = "/api/events";
    req.headers.origin = "http://127.0.0.1:7070";
    const socket = new PassThrough();
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    upgrade?.(req, socket, Buffer.alloc(0));
    expect(response).toContain("403 Forbidden");
    sockets.close();
  });
});
