import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "../env.ts";
import { createMajhiApp } from "../server.ts";
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
  });

  it("rejects simple cross-origin POSTs even without Origin", async () => {
    const res = await app.request("/api/cmd/config.get", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
    expect((await cmd("config.get", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("blocks localhost uploads from another port before reading the body", async () => {
    expect(
      (
        await app.request("/api/uploads", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:9999" },
          body: new FormData(),
        })
      ).status,
    ).toBe(403);
  });

  it("compares scheme, host and port and refuses malformed origin values", () => {
    expect(isOwnerOrigin(env.origin, env.origin)).toBe(true);
    for (const origin of [
      "null",
      "http://127.0.0.1:9999",
      "https://127.0.0.1:7070",
      "http://localhost:9999",
      "https://localhost:7070",
      "http://user@127.0.0.1:7070",
      `${env.origin}/evil`,
    ]) {
      expect(isOwnerOrigin(origin, env.origin)).toBe(false);
    }
    expect(isOwnerOrigin("http://127.0.0.1:5173", "http://127.0.0.1:5173")).toBe(true);
    // Every loopback name on the configured scheme and port is this machine: the owner may open localhost.
    expect(isOwnerOrigin("http://localhost:7070", "http://127.0.0.1:7070")).toBe(true);
    expect(isOwnerOrigin("http://[::1]:7070", "http://127.0.0.1:7070")).toBe(true);
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
