import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import { createMajhiApp } from "../server.ts";
import { tempDir, testEnv } from "../testing/fixtures.ts";
import { isLoopbackOrigin } from "./origin.ts";

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

  it("blocks commands from other websites but not from loopback pages", async () => {
    const evil = await cmd("workspaces.set", { workspaces: ["/"] }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const local = await cmd("config.get", {}, { origin: "http://localhost:5173" });
    expect(local.status).toBe(200);
  });

  it("refuses commands, uploads and sockets from an opaque origin, like a sandboxed agent page", async () => {
    // A page served with `Content-Security-Policy: sandbox` sends `Origin: null`.
    const cmdRes = await cmd("config.get", {}, { origin: "null" });
    expect(cmdRes.status).toBe(403);
    const upload = await app.request("/api/uploads", {
      method: "POST",
      headers: { origin: "null" },
      body: new FormData(),
    });
    expect(upload.status).toBe(403);
    expect(isLoopbackOrigin("null")).toBe(false);
  });
});
