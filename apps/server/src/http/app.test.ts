import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND_META_HEADER } from "@majhi/shared";
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

  it("answers /health with the version", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "1.2.3-test", commit: "dev" });
  });

  it("rejects invalid input with 400 and readable details", async () => {
    const res = await cmd("workspaces.set", { workspaces: ["Work"], extra: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid input",
      details: ["workspaces[0]: Use an absolute path, or one starting with ~/"],
    });

    const badJson = await app.request("/api/cmd/config.get", { method: "POST", body: "{nope" });
    expect(badJson.status).toBe(400);

    const badMeta = await cmd("config.get", {}, { [COMMAND_META_HEADER]: '{"actor":{"kind":"agent"}}' });
    expect(badMeta.status).toBe(400);
    expect(await badMeta.json()).toMatchObject({ error: "Invalid x-majhi-meta header" });
  });

  it("answers 404 with an ApiError for unknown commands and API paths", async () => {
    const res = await cmd("repos.delete", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown command: repos.delete" });
    expect((await cmd("toString", {})).status).toBe(404);
    expect((await app.request("/api/cmd/config.get")).status).toBe(404);
  });

  it("answers 409 when majhi.yaml cannot be edited safely", async () => {
    await mkdir(env.majhiHome, { recursive: true });
    await writeFile(join(env.majhiHome, "majhi.yaml"), "workspaces: [~/Work\n");
    const res = await cmd("workspaces.set", { workspaces: ["~/Work"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("YAML errors") });
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

  it("says the web app is not built when there is no dist folder", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("web app is not built");
  });

  it("serves the web app with a fallback to index.html for client routes", async () => {
    await mkdir(join(env.webDist, "assets"), { recursive: true });
    await writeFile(join(env.webDist, "index.html"), "<!doctype html><title>majhi</title>");
    await writeFile(join(env.webDist, "assets", "app.js"), "console.log(1)");
    app = createMajhiApp(env);

    expect(await (await app.request("/")).text()).toContain("<title>majhi</title>");
    expect(await (await app.request("/settings/roots")).text()).toContain("<title>majhi</title>");
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toBe("console.log(1)");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/health")).headers.get("content-type")).toMatch(/json/);
  });
});
